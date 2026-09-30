import prisma from '../config/prisma.client';
import config from '../config/env.config';
import logger from '../config/logger';
import { ulid } from 'ulid';
import Decimal from 'decimal.js';
import liquidityRampService from './liquidityRamp.service';
import virtualAccountService from './virtualAccount.service';
import walletService from './wallet.service';
import { getChainKey } from '../config/blockchain.config';

class InternalOfframpService {

    // ── Settlement account — single read point ────────────────────────
    // Deliberately a function, not a constant, so the source can change
    // (env → DB table → remote config) without touching any call site.
    private async getSettlementAccount(fiatCurrency: string): Promise<{
        bankCode: string;
        accountNumber: string;
    }> {
        // Currently NGN-only. When a second fiat corridor opens, branch
        // here rather than scattering currency checks through the flow.
        if (fiatCurrency.toUpperCase() !== 'NGN') {
            throw new Error(`No settlement account configured for ${fiatCurrency}`);
        }

        const bankCode = config.OFFRAMP_SETTLEMENT_BANK_CODE;
        const accountNumber = config.OFFRAMP_SETTLEMENT_ACCOUNT_NUMBER;

        if (!bankCode || !accountNumber) {
            throw new Error('Offramp settlement account is not configured');
        }

        return { bankCode, accountNumber };
    }

    // ── Guard: does admin actually hold enough on-chain to fulfil? ────
    // Quidax expects real crypto at the address it returns. If admin's
    // balance on that chain is short, the user's funds would be frozen
    // against a payout that can never complete.
    private async assertAdminLiquidity(payload: {
        cryptoISO: string;
        chain: string;
        amount: Decimal;
    }) {
        const { cryptoISO, chain, amount } = payload;

        const adminAccount = await virtualAccountService.getAccount(
            config.Admin_Id,
            cryptoISO,
            'STANDARD',
            chain
        );

        if (new Decimal(adminAccount.available).lt(amount)) {
            logger.error('Admin liquidity insufficient for offramp', {
                cryptoISO,
                chain,
                required: amount.toString(),
                available: adminAccount.available.toString(),
            });
            throw new Error(
                'This withdrawal is temporarily unavailable. Please try a smaller amount or try again later.'
            );
        }

        return adminAccount;
    }

    // ══════════════════════════════════════════════════════════════════
    // INITIATE
    // ══════════════════════════════════════════════════════════════════
    async initiate(payload: {
        userId: string;
        cryptoCurrencyId: string;
        amount: string;              // crypto amount the user is selling
        fiatCurrency?: string;       // defaults NGN
        userEmail: string;
        legalFirstName: string;
        legalLastName: string;
    }) {
        const {
            userId, cryptoCurrencyId, amount,
            fiatCurrency = 'NGN', userEmail, legalFirstName, legalLastName,
        } = payload;
 
        const decimalAmount = new Decimal(amount);
        if (decimalAmount.lte(0)) throw new Error('Amount must be greater than 0');
 
        // ── Resolve currency + chain ──────────────────────────────────
        const currency = await prisma.currency.findUnique({ where: { id: cryptoCurrencyId } });
        if (!currency) throw new Error('Currency not found');
        if (!currency.isStablecoin) throw new Error('Only stablecoins can be offramped this way');
        if (!currency.chain) throw new Error(`${currency.ISO} has no chain configured`);
 
        // ── Both send-side preconditions, checked UP FRONT ────────────
        // These are two genuinely different things and both must hold:
        //
        //   getNetwork  — does QUIDAX accept this chain?
        //   getChainKey — can VYRE actually broadcast on it?
        //
        // Previously only the first was checked here and the second was
        // discovered inside the background worker, minutes later, after
        // the user's funds were frozen and Quidax had already created a
        // transaction and issued a deposit address. Failing here instead
        // means nothing is committed.
        const network = liquidityRampService.getNetwork(currency.chain);
 
        const chainKey = getChainKey(currency.chain, currency.ISO);
        if (!chainKey) {
            throw new Error(
                `${currency.ISO} on ${currency.chain} is not supported for withdrawal yet.`
            );
        }
 
        // ── Resolve the user's wallets ────────────────────────────────
        const cryptoWallet = await prisma.wallet.findFirst({
            where: { userId, currencyId: cryptoCurrencyId },
        });
        if (!cryptoWallet) throw new Error(`No ${currency.ISO} wallet found`);
 
        const fiatCurrencyRecord = await prisma.currency.findFirst({
            where: { ISO: fiatCurrency, type: 'FIAT' },
        });
        if (!fiatCurrencyRecord) throw new Error(`${fiatCurrency} currency not configured`);
 
        const fiatWallet = await prisma.wallet.findFirst({
            where: { userId, currencyId: fiatCurrencyRecord.id },
        });
        if (!fiatWallet) throw new Error(`No ${fiatCurrency} wallet found — create one first`);
 
        // ── Admin wallet must exist too ───────────────────────────────
        // assertAdminLiquidity below checks the admin VIRTUAL ACCOUNT,
        // but sendToQuidax needs the admin WALLET record. Confirm it
        // exists now rather than failing in the worker.
        const adminWallet = await prisma.wallet.findFirst({
            where: { userId: config.Admin_Id, currencyId: cryptoCurrencyId },
        });
        if (!adminWallet) {
            logger.error('Admin wallet missing for offramp currency', {
                cryptoCurrencyId, currency: currency.ISO, chain: currency.chain,
            });
            throw new Error('This withdrawal is temporarily unavailable. Please try again later.');
        }
 
        // ── Minimum check ─────────────────────────────────────────────
        // Stablecoins are ~1:1 USD, so the crypto amount IS the USD value.
        //
        // ⚠️ NOTE: the default here is now 5, down from 20. Worth being
        // deliberate about that — Vyre absorbs the on-chain gas, so a $5
        // withdrawal on ETHEREUM could cost more in gas than the amount
        // being moved. Base/Polygon/Optimism are cheap enough for $5;
        // Ethereum mainnet is not. Consider a per-chain minimum rather
        // than one global figure.
        const minUsd = new Decimal(config.OFFRAMP_MIN_USD ?? '5');
        if (decimalAmount.lt(minUsd)) {
            throw new Error(`Minimum withdrawal is ${minUsd.toString()} ${currency.ISO}`);
        }
 
        // ── User balance check ────────────────────────────────────────
        // initiateGlobalPayoutBlock checks this too, but failing here
        // gives a clearer error before a request record is created.
        const userAccount = await prisma.virtualAccount.findUnique({
            where: { id: cryptoWallet.id },
        });
        if (!userAccount) throw new Error('Wallet account not found');
        if (new Decimal(userAccount.available).lt(decimalAmount)) {
            throw new Error(
                `Insufficient balance. Available: ${userAccount.available} ${currency.ISO}`
            );
        }
 
        // ── Admin liquidity guard — BEFORE freezing the user's funds ──
        await this.assertAdminLiquidity({
            cryptoISO: currency.ISO,
            chain: currency.chain,
            amount: decimalAmount,
        });
 
        const merchantReference = `WALLETOFFRAMP_${ulid()}`;
        const settlement = await this.getSettlementAccount(fiatCurrency);
 
        // ── Create the request record first ───────────────────────────
        const request = await prisma.internalOfframpRequest.create({
            data: {
                userId,
                cryptoCurrencyId,
                cryptoCurrency: currency.ISO,
                chain: currency.chain,
                cryptoAmount: decimalAmount,
                fiatCurrency,
                merchantReference,
                status: 'PENDING',
            },
        });
 
        try {
            // ── Freeze the user's crypto ──────────────────────────────
            // Frozen, NOT debited. If anything downstream fails the user
            // is made whole by releasing the block.
            const { transaction, block } = await virtualAccountService.initiateGlobalPayoutBlock({
                userId,
                currencyId: cryptoCurrencyId,
                amount: decimalAmount.toString(),
                reference: merchantReference,
                metadata: { internalOfframpId: request.id, fiatCurrency },
            });
 
            await prisma.internalOfframpRequest.update({
                where: { id: request.id },
                data: { blockId: block.id, virtualTransactionId: transaction.id },
            });
 
            // ── Quidax: initiate ──────────────────────────────────────
            const offrampInit = await liquidityRampService.initiateOfframp({
                merchantReference,
                fromCurrency: currency.ISO.toLowerCase(),
                toCurrency: fiatCurrency.toLowerCase(),
                fromAmount: decimalAmount.toString(),
                network,
                customerEmail: userEmail,
                customerFirstName: legalFirstName,
                customerLastName: legalLastName,
            });
 
            // ── Quidax: attach VYRE'S settlement account ──────────────
            // The NGN lands in Vyre's own account, then gets credited
            // internally to the user. The user never sees this account.
            await liquidityRampService.addOfframpPayoutAccount({
                merchantReference,
                bankCode: settlement.bankCode,
                accountNumber: settlement.accountNumber,
            });
 
            // ── Quidax: confirm → returns the deposit address ─────────
            const offrampConfirm = await liquidityRampService.confirmOfframp(merchantReference);
 
            const depositAddress = offrampConfirm?.address;
            if (!depositAddress) {
                throw new Error('Quidax did not return a deposit address');
            }
 
            await prisma.internalOfframpRequest.update({
                where: { id: request.id },
                data: {
                    status: 'AWAITING_DEPOSIT',
                    quidaxReference: offrampInit?.reference,
                    expectedFiatAmount: offrampInit?.to_amount ? new Decimal(offrampInit.to_amount) : null,
                    depositAddress,
                },
            });
 
            logger.info('Internal offramp initiated', {
                requestId: request.id,
                merchantReference,
                chainKey,
                depositAddress,
                expectedFiat: offrampInit?.to_amount,
            });
 
            return {
                requestId: request.id,
                merchantReference,
                cryptoAmount: decimalAmount.toString(),
                cryptoCurrency: currency.ISO,
                expectedFiatAmount: offrampInit?.to_amount ?? null,
                fiatCurrency,
                depositAddress,
            };
 
        } catch (error: any) {
            // Anything failed after the block was created — release it so
            // the user's funds aren't stranded.
            await this.failRequest(request.id, error?.message ?? 'Offramp initiation failed');
            throw error;
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // SEND — the on-chain transfer from admin to Quidax
    // ══════════════════════════════════════════════════════════════════
    // Called by a worker after initiate() succeeds. Separated because it
    // is the slowest and most failure-prone step, and should be retried
    // independently rather than inside the request/response cycle.
    async sendToQuidax(requestId: string) {
        const request = await prisma.internalOfframpRequest.findUnique({
            where: { id: requestId },
        });
 
        if (!request) throw new Error('Offramp request not found');
 
        if (request.status !== 'AWAITING_DEPOSIT') {
            logger.warn('sendToQuidax called on a request not awaiting deposit', {
                requestId, status: request.status,
            });
            return;
        }
 
        if (request.txHash) {
            logger.warn('sendToQuidax called but txHash already set — refusing to double-send', {
                requestId, txHash: request.txHash,
            });
            return;
        }
 
        if (!request.depositAddress) throw new Error('No deposit address on request');
 
        try {
            const adminWallet = await prisma.wallet.findFirst({
                where: { userId: config.Admin_Id, currencyId: request.cryptoCurrencyId },
            });
            if (!adminWallet) throw new Error('Admin wallet not found for this currency');
 
            // FIXED — was `${request.cryptoCurrency}_${request.chain}`, which
            // assumed the CHAIN_CONFIG key is always CURRENCY_CHAIN. It isn't:
            //
            //   POLYGON  → key is USDC_MATIC, not USDC_POLYGON
            //   ARBITRUM → key is USDC_ARB,   not USDC_ARBITRUM
            //   OPTIMISM → key is USDC_OP,    not USDC_OPTIMISM
            //
            // Those three would have thrown "Unsupported chain" at send
            // time — AFTER the user's funds were frozen and Quidax had
            // already issued a deposit address. getChainKey resolves by
            // blockchain + currency instead of guessing the key format.
            const chainKey = getChainKey(request.chain, request.cryptoCurrency);
 
            if (!chainKey) {
                throw new Error(
                    `No CHAIN_CONFIG entry for ${request.cryptoCurrency} on ${request.chain}`
                );
            }
 
            const result = await virtualAccountService.transferCryptoToExternal({
                virtualAccountId: adminWallet.id,
                toAddress: request.depositAddress,
                amount: request.cryptoAmount.toString(),
                chainKey,
                metadata: { internalOfframpId: request.id, merchantReference: request.merchantReference },
            });
 
            await prisma.internalOfframpRequest.update({
                where: { id: request.id },
                data: { status: 'PROCESSING', txHash: result.txHash },
            });
 
            logger.info('Internal offramp — crypto sent to Quidax', {
                requestId, txHash: result.txHash, chainKey, address: request.depositAddress,
            });
 
            return result;
 
        } catch (error: any) {
            logger.error('Internal offramp — on-chain send FAILED', {
                requestId, error: error.message,
            });
 
            // Crypto never left. Release the user's funds.
            await this.failRequest(
                request.id,
                `On-chain send failed: ${error.message}`
            );
 
            throw error;
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // COMPLETE — called by the webhook when Quidax confirms NGN paid
    // ══════════════════════════════════════════════════════════════════
    async complete(payload: { merchantReference: string; actualFiatAmount?: string }) {
        const { merchantReference, actualFiatAmount } = payload;

        // Idempotency: lock the row and re-check status inside the
        // transaction, so a duplicate webhook can't double-credit.
        return await prisma.$transaction(async (tx) => {

            const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
                SELECT id, status FROM "InternalOfframpRequest"
                WHERE "merchantReference" = ${merchantReference}
                FOR UPDATE
            `;

            if (!rows.length) {
                logger.warn('Internal offramp complete — request not found', { merchantReference });
                return null;
            }

            if (rows[0].status === 'COMPLETED') {
                logger.info('Internal offramp already completed — skipping', { merchantReference });
                return null;
            }

            const request = await tx.internalOfframpRequest.findUnique({
                where: { merchantReference },
            });
            if (!request) return null;

            return request;

        }, { isolationLevel: 'Serializable' }).then(async (request) => {

            if (!request) return null;

            // The two calls below are the real money movement. They use
            // their own internal transactions, so they sit outside the
            // lock above — the status guard already prevents double-run.

            // 1. User's frozen crypto → admin's crypto account
            if (request.blockId && request.virtualTransactionId) {
                await virtualAccountService.completeGlobalPayoutBlock({
                    transactionId: request.virtualTransactionId,
                    blockId: request.blockId,
                    externalRef: request.quidaxReference ?? undefined,
                });
            }

            // 2. Credit the user's fiat wallet
            const fiatAmount = actualFiatAmount ?? request.expectedFiatAmount?.toString();
            if (!fiatAmount) {
                throw new Error('No fiat amount available to credit');
            }

            const fiatCurrencyRecord = await prisma.currency.findFirst({
                where: { ISO: request.fiatCurrency, type: 'FIAT' },
            });
            if (!fiatCurrencyRecord) throw new Error('Fiat currency record not found');

            const fiatWallet = await prisma.wallet.findFirst({
                where: { userId: request.userId, currencyId: fiatCurrencyRecord.id },
            });
            if (!fiatWallet) throw new Error('User fiat wallet not found');

            await virtualAccountService.creditAccount({
                accountId: fiatWallet.id,
                amount: fiatAmount,
                description: `Offramp from ${request.cryptoAmount} ${request.cryptoCurrency}`,
                metadata: { internalOfframpId: request.id, merchantReference },
            });

            await prisma.internalOfframpRequest.update({
                where: { id: request.id },
                data: {
                    status: 'COMPLETED',
                    actualFiatAmount: new Decimal(fiatAmount),
                    completedAt: new Date(),
                },
            });

            // Sync both wallets so balances reflect immediately
            await Promise.all([
                walletService.getAccount(fiatWallet.id).catch(() => {}),
            ]);

            logger.info('Internal offramp COMPLETED', {
                requestId: request.id,
                merchantReference,
                fiatAmount,
            });

            return request;
        });
    }

    // ══════════════════════════════════════════════════════════════════
    // FAIL — release the block, mark failed
    // ══════════════════════════════════════════════════════════════════
    async failRequest(requestId: string, reason: string) {
        const request = await prisma.internalOfframpRequest.findUnique({
            where: { id: requestId },
        });

        if (!request) return;
        if (request.status === 'COMPLETED') {
            logger.error('Refusing to fail an already-COMPLETED offramp', { requestId, reason });
            return;
        }
        if (request.status === 'FAILED') return;

        // Release the user's frozen crypto
        if (request.blockId && request.virtualTransactionId) {
            try {
                await virtualAccountService.failGlobalPayoutBlock({
                    transactionId: request.virtualTransactionId,
                    blockId: request.blockId,
                    reason,
                });
            } catch (err: any) {
                // ⚠️ REAL RISK: if this throws, the user's funds stay
                // frozen with no automatic recovery. Logged loudly so it
                // surfaces rather than failing silently.
                logger.error('CRITICAL — failed to release offramp block, user funds may be stranded', {
                    requestId,
                    blockId: request.blockId,
                    error: err.message,
                });
            }
        }

        await prisma.internalOfframpRequest.update({
            where: { id: requestId },
            data: { status: 'FAILED', failureReason: reason },
        });

        logger.error('Internal offramp FAILED', { requestId, reason });
    }
}

export default new InternalOfframpService();