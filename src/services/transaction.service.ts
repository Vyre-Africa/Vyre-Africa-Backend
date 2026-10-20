import { Request, Response } from 'express';
import prisma from '../config/prisma.client';
import { generateRefCode } from '../utils'
import { TransactionStatus, TransactionType } from '@prisma/client';
import { endOfDay, startOfDay } from 'date-fns';
import { presentTransactions, UserTransaction } from './virtualTransaction.presenter';

// ── Reading the ledger the rest of the system actually writes to ────────
//
// The methods at the bottom of this file (getUserRecords, getwalletRecords,
// filterBy*) read the legacy `Transaction` table. Nothing in
// virtualAccount.service.ts writes to that table — every real money movement
// creates and then UPDATES a `VirtualTransaction`:
//
//   p2pTransfer                                    COMPLETED immediately
//   initiateBankWithdrawal → complete / fail       PENDING → COMPLETED/FAILED
//   initiateGlobalPayoutBlock → complete / fail    PENDING → COMPLETED/FAILED
//   cryptoDeposit                                  COMPLETED immediately
//   transferCryptoToExternal                       PENDING → COMPLETED/FAILED
//   exchangeCurrency                               COMPLETED immediately
//
// So the legacy table cannot show a live status — it has no row to update.
// The readers below are the ones the user-facing history should use.
//
// `Wallet.id === VirtualAccount.id`. That is not an assumption: see
// initiateGlobalPayoutBlock, which looks a wallet up by userId + currencyId
// and then fetches `virtualAccount.findUnique({ where: { id: wallet.id } })`.
// It means a walletId from the route can be used directly as an account id.
//
// `VirtualTransaction` has NO userId column. A combined history therefore has
// to resolve the user's account ids first and filter on fromAccountId /
// toAccountId — which is also what makes ownership checkable.

export interface LedgerQuery {
    limit?: number;
    page?: number;
    status?: string;
    type?: string;
    /** Inclusive, by createdAt. */
    dateFrom?: Date;
    dateTo?: Date;
}

export interface LedgerPage {
    transactions: UserTransaction[];
    pagination: { page: number; limit: number; total: number; pages: number };
}

const MAX_LIMIT = 100;

function buildWhere(accountIds: string[], q: LedgerQuery) {
    const where: any = {
        OR: [
            { fromAccountId: { in: accountIds } },
            { toAccountId: { in: accountIds } },
        ],
    };
    if (q.type) where.type = q.type;
    if (q.status) where.status = q.status;
    if (q.dateFrom || q.dateTo) {
        where.createdAt = {
            ...(q.dateFrom ? { gte: startOfDay(q.dateFrom) } : {}),
            ...(q.dateTo ? { lte: endOfDay(q.dateTo) } : {}),
        };
    }
    return where;
}

async function readLedger(accountIds: string[], q: LedgerQuery): Promise<LedgerPage> {
    const limit = Math.min(Math.max(Number(q.limit) || 20, 1), MAX_LIMIT);
    const page = Math.max(Number(q.page) || 1, 1);

    if (!accountIds.length) {
        return { transactions: [], pagination: { page, limit, total: 0, pages: 0 } };
    }

    const where = buildWhere(accountIds, q);

    const [rows, total] = await Promise.all([
        prisma.virtualTransaction.findMany({
            where,
            // createdAt alone is not a stable sort: several rows inside one
            // $transaction share a timestamp, and an unstable sort makes a
            // paginated list drop or repeat rows between pages.
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.virtualTransaction.count({ where }),
    ]);

    return {
        transactions: presentTransactions(rows, accountIds),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
}

class TransactionService
{
    // ── The ledger, scoped to one wallet ────────────────────────────────
    //
    // Takes userId as well as walletId and verifies ownership. The previous
    // reader took a walletId straight off the query string with no check at
    // all, so any id could be used to read someone else's history.
    async getWalletLedger(userId: string, walletId: string, q: LedgerQuery = {}): Promise<LedgerPage | null> {
        const account = await prisma.virtualAccount.findUnique({
            where: { id: walletId },
            select: { id: true, userId: true },
        });

        // Not found and not-yours are the same answer on purpose: a different
        // message would confirm the id exists.
        if (!account || account.userId !== userId) return null;

        return await readLedger([account.id], q);
    }

    // ── The ledger, across every wallet the user owns ───────────────────
    async getUserLedger(userId: string, q: LedgerQuery = {}): Promise<LedgerPage> {
        const accounts = await prisma.virtualAccount.findMany({
            where: { userId },
            select: { id: true },
        });

        return await readLedger(accounts.map((a: { id: string }) => a.id), q);
    }

    // ── One transaction, in full ────────────────────────────────────────
    async getLedgerEntry(userId: string, transactionId: string): Promise<UserTransaction | null> {
        const tx = await prisma.virtualTransaction.findUnique({ where: { id: transactionId } });
        if (!tx) return null;

        const accounts = await prisma.virtualAccount.findMany({
            where: { userId },
            select: { id: true },
        });
        const mine = accounts.map((a: { id: string }) => a.id);

        // The row has to touch one of the caller's accounts, or it is not
        // theirs to read.
        const touchesMine =
            (tx.fromAccountId && mine.includes(tx.fromAccountId)) ||
            (tx.toAccountId && mine.includes(tx.toAccountId));

        if (!touchesMine) return null;

        return presentTransactions([tx], mine)[0];
    }

    // ════════════════════════════════════════════════════════════════════
    // LEGACY — the `Transaction` table.
    //
    // Kept because other callers may still read it, but it is NOT the
    // user-facing history any more: nothing writes to it, so nothing in it
    // can carry a live status. Use getWalletLedger / getUserLedger instead.
    // ════════════════════════════════════════════════════════════════════

    async getUserRecords(
        userId:string|null,
        limit: number,
    )
    {
        return await prisma.transaction.findMany({
            where: {
              userId
            },
            take: limit ? limit : 20,
            orderBy: { createdAt: "desc" }
        });
    }

    async getwalletRecords(
        walletId:string|null,
        limit: number,
    )
    {
        return await prisma.transaction.findMany({
            where: {
              walletId
            },
            take: limit ? limit : 20,
            orderBy: { createdAt: "desc" }
        });
    }

    async filterByDate(
        userId:string|null,
        limit: string,
        dateFrom: Date,
        dateTo: Date
    )
    {
        return await prisma.transaction.findMany({
            where: {
                userId,
                createdAt: {
                    gte: startOfDay(dateFrom),
                    lte: endOfDay(dateTo)
                }
            },
            include:{
                user: true
            },
            take: limit ? parseInt(limit as string) : 20,
            orderBy: { createdAt: "desc" }
        });
    }

    async filterByStatus(
        userId:string|null,
        limit: string,
        status: string,
    )
    {
        return await prisma.transaction.findMany({
            where: {
                userId,
                status: status as TransactionStatus
            },
            include:{
                user: true
            },
            take: limit ? parseInt(limit as string) : 20,
            orderBy: { createdAt: "desc" }
        });
    }

    async filterByType(
        userId:string|null,
        limit: string,
        type: string,
    )
    {
        return await prisma.transaction.findMany({
            where: {
                userId,
                type: type as TransactionType
            },
            take: limit ? parseInt(limit as string) : 20,
            orderBy: { createdAt: "desc" }
        });
    }
}

export default new TransactionService()