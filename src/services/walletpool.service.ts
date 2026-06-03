// src/services/walletpool.service.ts
import prisma from '../config/prisma.client';
import logger from '../config/logger';
import walletService from './wallet.service';
import { Queue } from 'bullmq';
import connection from '../config/redis.config';

class WalletPoolService {

    // ── Cleanup queue ─────────────────────────────────────────
    private cleanupQueue = new Queue('general-process', {
        connection
    });

    // ── Queue cleanup after trade completes ───────────────────
    async queueCleanup(awaitingId: string) {
        await this.cleanupQueue.add(
            'cleanup-trade-wallets',
            { awaitingId },
            {
                jobId:    `cleanup-${awaitingId}`,  // prevent duplicates
                delay:    5000,                      // 5 second delay — let tx settle
                attempts: 3,
                backoff:  { type: 'exponential', delay: 5000 }
            }
        );

        logger.info('Wallet cleanup queued', { awaitingId });
    }

    // ── Process cleanup job ───────────────────────────────────
    async cleanupTradeWallets(awaitingId: string) {
        logger.info('Processing wallet cleanup', { awaitingId });

        const awaiting = await prisma.awaiting.findUnique({
            where: { id: awaitingId },
            select: {
                id:       true,
                walletId: true,
                userId:   true,
                status:   true,
                wallet: {
                    select: {
                        id:              true,
                        accountBalance:  true,
                        availableBalance: true,
                        subscriptionId:  true,
                        user: {
                            select: { isAnonymous: true }
                        }
                    }
                }
            }
        });

        if (!awaiting) {
            logger.warn('Cleanup — awaiting not found', { awaitingId });
            return;
        }

        // ── Only cleanup completed/expired trades ─────────────
        if (!['COMPLETED', 'EXPIRED', 'CANCELLED'].includes(awaiting.status)) {
            logger.info('Cleanup — trade not completed yet, skipping', {
                awaitingId,
                status: awaiting.status
            });
            return;
        }

        // ── Return wallet to pool ─────────────────────────────
        if (awaiting.walletId) {
            await this.returnToPool(awaiting.walletId);
        }

        // ── Deactivate anonymous user ─────────────────────────
        if (awaiting.userId) {
            const user = await prisma.user.findUnique({
                where: { id: awaiting.userId },
                select: { isAnonymous: true }
            });

            if (user?.isAnonymous) {
                await prisma.user.update({
                    where: { id: awaiting.userId },
                    data: {
                        isDeactivated:      true,
                        deactivationReason: 'Anonymous trade completed'
                    }
                }).catch(err => 
                    logger.warn('Failed to deactivate anon user', { error: err.message })
                );

                logger.info('Anonymous user deactivated', { userId: awaiting.userId });
            }
        }

        logger.info('Wallet cleanup completed', { awaitingId });
    }

    // ── Get a wallet from the pool or create a new one ────────
    async getOrCreateWallet(payload: {
        userId:     string;
        currencyId: string;
    }) {
        const { userId, currencyId } = payload;

        // ── Try to claim an idle pooled wallet ────────────────
        // Use FOR UPDATE SKIP LOCKED to prevent race conditions
        // Multiple concurrent trades won't claim the same wallet
        const claimed = await prisma.$transaction(async (tx) => {

            const idle = await tx.$queryRaw<any[]>`
                SELECT id, "depositAddress", "subscriptionId"
                FROM "Wallet"
                WHERE "currencyId" = ${currencyId}
                AND status = 'IDLE'
                AND pooled = true
                AND "accountBalance" = 0
                AND "availableBalance" = 0
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            `;

            if (!idle.length) return null;

            const wallet = idle[0];

            // ── Claim it — assign to new user ─────────────────
            await tx.wallet.update({
                where: { id: wallet.id },
                data: {
                    userId,
                    status:    'ACTIVE',
                    pooled:    false,
                    lastUsedAt: new Date()
                }
            });

            return wallet;
        });

        if (claimed) {
            logger.info('Wallet claimed from pool', {
                walletId:       claimed.id,
                depositAddress: claimed.depositAddress,
                userId,
                currencyId
            });
            return claimed;
        }

        // ── No idle wallet found — create fresh ───────────────
        logger.info('No idle wallet in pool — creating fresh', {
            userId,
            currencyId
        });
        return null; // caller creates fresh wallet
    }

    // ── Return wallet to pool after trade completes ───────────
    async returnToPool(walletId: string) {
        const wallet = await prisma.wallet.findUnique({
            where: { id: walletId },
            select: {
                id:             true,
                accountBalance: true,
                availableBalance: true,
                userId:         true,
                user: {
                    select: { isAnonymous: true }
                }
            }
        });

        if (!wallet) return;

        // ── Only pool anonymous user wallets ──────────────────
        if (!wallet.user?.isAnonymous) return;

        // ── Only pool zero balance wallets ────────────────────
        if (
            Number(wallet.accountBalance)   > 0 ||
            Number(wallet.availableBalance) > 0
        ) {
            logger.warn('Wallet has balance — not returning to pool', {
                walletId,
                balance: wallet.accountBalance
            });
            return;
        }

        // ── Return to pool ────────────────────────────────────
        await prisma.wallet.update({
            where: { id: walletId },
            data: {
                userId:    null,  // ← detach from user
                status:    'IDLE',
                pooled:    true,
                lastUsedAt: new Date()
            }
        });

        logger.info('Wallet returned to pool', { walletId });
    }

    // ── Pre-warm pool — create wallets in advance ─────────────
    // Run as a cron job or manually
    // async prewarmPool(payload: {
    //     currencyId: string;
    //     chain:      string;
    //     ISO:        string;
    //     count:      number;  // how many wallets to pre-create
    // }) {
    //     const { currencyId, chain, ISO, count } = payload;

    //     // Check current pool size
    //     const currentPool = await prisma.wallet.count({
    //         where: {
    //             currencyId,
    //             status: 'IDLE',
    //             pooled: true
    //         }
    //     });

    //     const needed = count - currentPool;

    //     if (needed <= 0) {
    //         logger.info('Pool already has enough wallets', {
    //             currencyId,
    //             currentPool,
    //             target: count
    //         });
    //         return;
    //     }

    //     logger.info(`Pre-warming pool — creating ${needed} wallets`, {
    //         currencyId,
    //         ISO,
    //         chain
    //     });

    //     // Create wallets with a dummy system user ID
    //     // They have no userId until claimed
    //     for (let i = 0; i < needed; i++) {
    //         try {
    //             // Create wallet using existing wallet service
    //             // Pass a system pool user ID
    //             await walletService.createWallet({
    //                 userId:     process.env.POOL_USER_ID!, // system user
    //                 currencyId,
    //                 pooled:     true
    //             });

    //             logger.info(`Pool wallet ${i + 1}/${needed} created`);

    //         } catch (err: any) {
    //             logger.error('Failed to create pool wallet', { error: err.message });
    //         }
    //     }

    //     logger.info('Pool pre-warming complete', { currencyId, added: needed });
    // }
}

export default new WalletPoolService();