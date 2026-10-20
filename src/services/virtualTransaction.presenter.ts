// services/virtualTransaction.presenter.ts
//
// ONE place that turns a VirtualTransaction into the record a user reads.
//
// WHY THIS EXISTS
//
// The app has two transaction tables and has been showing the wrong one.
//
//   Transaction          — the legacy table behind transactionService
//                          .getUserRecords / .getwalletRecords, which is what
//                          /wallet/transactions returns today. Nothing in
//                          virtualAccount.service.ts writes to it.
//   VirtualTransaction   — written and UPDATED IN PLACE by every real money
//                          movement: p2pTransfer, initiateBankWithdrawal →
//                          complete/fail, initiateGlobalPayoutBlock →
//                          complete/fail, cryptoDeposit, exchangeCurrency and
//                          transferCryptoToExternal.
//
// Only the second one carries live status. A payout sits PENDING while the
// funds are frozen in a Block and flips to COMPLETED or FAILED when Nuvion's
// webhook lands — so reading VirtualTransaction is what makes "the latest
// status" true rather than a snapshot from whenever a row was written.
//
// THREE THINGS A NAIVE LIST GETS WRONG, and the reason this is a presenter
// rather than a `select`:
//
//   1. DIRECTION IS NOT A PROPERTY OF THE ROW. The same CURRENCY_EXCHANGE row
//      is money leaving the NGN wallet and money arriving in the USD wallet.
//      Direction only exists relative to the account doing the looking, so
//      every function here takes the viewing account(s).
//
//      (The current Recent.vue infers direction from a hardcoded type list —
//      CREDIT_PAYMENT, FIAT_DEPOSIT, EXCHANGE_BUY, WALLET_TRANSFER_IN — and
//      not one of those is a VirtualTransaction type. Every row therefore
//      falls through both isCredit and isDebit and renders uncoloured.)
//
//   2. WHO PAYS THE FEE CHANGES BY TYPE. Measured in virtualAccount.service:
//
//        p2pTransfer          sender debited `amount`, receiver credited
//                             `netAmount` → the RECEIVER pays the fee
//        bank withdrawal      totalDebit = amount + fee → the SENDER pays
//        crypto withdrawal    totalDebit = amount + fee → the SENDER pays
//        currency exchange    totalDebit = amount + fee → the SENDER pays
//
//      So "what did my balance actually move by" is not `amount` in four of
//      the six types, and showing `amount` understates what a withdrawal
//      really cost.
//
//   3. THE ROW'S `currency` IS THE **FROM** CURRENCY. On a CURRENCY_EXCHANGE,
//      `currency` and `amount` describe the money that LEFT. Render those in
//      the receiving wallet and you show the wrong number in the wrong
//      currency — 50,000 NGN sitting in a USD wallet. The arriving side has
//      to read `convertedAmount` and `toCurrency`.

import { Decimal } from 'decimal.js';

// ── The shape the app renders ───────────────────────────────────────────

export type TxDirection = 'IN' | 'OUT' | 'INTERNAL';
export type TxState = 'PENDING' | 'COMPLETED' | 'FAILED' | 'UNKNOWN';

export interface UserTransaction {
    id: string;
    reference: string;

    /** Relative to the account being viewed. Never read off the row alone. */
    direction: TxDirection;
    /** The raw VirtualTransaction.type, kept for filtering and debugging. */
    type: string;

    /** One line, already in the user's terms. */
    title: string;
    /** The rail, e.g. "Bank transfer" or "Ethereum". */
    subtitle: string;

    // ── Money ───────────────────────────────────────────────────────────
    /** The currency THIS side of the transaction moved in. */
    currency: string;
    /** What the balance actually moved by, fee included where the user paid it. */
    amount: string;
    /** `amount` with a leading + or −, or '' when INTERNAL. */
    signedAmount: string;
    /** The headline figure before fees. */
    grossAmount: string;
    fee: string;
    /** True when the fee came out of this side. */
    feePaidByViewer: boolean;

    // ── Status ──────────────────────────────────────────────────────────
    status: TxState;
    statusLabel: string;
    /** One sentence a person can act on, for every state. */
    statusHint: string;
    /** PENDING means money is committed but not settled — a frozen Block. */
    isPending: boolean;
    isFailed: boolean;
    /** Plain language. What a person is shown. */
    failureReason?: string | null;
    /** The provider's original wording, for support and debugging only. */
    failureReasonRaw?: string | null;

    // ── Where it went ───────────────────────────────────────────────────
    counterparty?: {
        kind: 'BANK' | 'WALLET' | 'ADDRESS' | 'EXCHANGE' | 'UNKNOWN';
        name?: string;
        detail?: string;
        masked?: string;
    };

    blockchain?: string | null;
    txHash?: string | null;
    walletAddress?: string | null;
    externalRef?: string | null;

    /** Present only on CURRENCY_EXCHANGE. */
    exchange?: {
        fromCurrency: string;
        toCurrency: string;
        rate: string;
        fromAmount: string;
        toAmount: string;
    };

    createdAt: string;
    completedAt?: string | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────

type Numeric = string | number | Decimal | null | undefined;

const dec = (v: Numeric): Decimal => {
    if (v === null || v === undefined) return new Decimal(0);
    try { return new Decimal(v.toString()); } catch { return new Decimal(0); }
};

/** Trailing zeros removed, so 100.00000000 reads as 100. */
const str = (v: Decimal): string => v.toDecimalPlaces(8).toString();

/** Last four of an account number or address, never the whole thing. */
function maskTail(value?: string | null, keep = 4): string | undefined {
    if (!value) return undefined;
    const s = String(value);
    if (s.length <= keep) return s;
    return `••••${s.slice(-keep)}`;
}

/**
 * The fee comes out of the SENDER on every rail except P2P, where
 * virtualAccount.service credits the receiver `netAmount` and so charges it
 * to the receiving side. Measured, not assumed — see the header.
 */
function feeIsPaidBy(type: string): 'SENDER' | 'RECEIVER' {
    return type === 'P2P_TRANSFER' ? 'RECEIVER' : 'SENDER';
}

const STATUS_LABELS: Record<TxState, string> = {
    PENDING: 'Pending',
    COMPLETED: 'Completed',
    FAILED: 'Failed',
    UNKNOWN: 'Unknown',
};

/**
 * Anything not written by virtualAccount.service today maps to UNKNOWN rather
 * than being forced into one of the three. A status this code has never seen
 * is a reason to look, not to guess — and silently showing it as "Completed"
 * would be the worst possible guess.
 */
/**
 * What each state means, in words that assume nothing.
 *
 * PENDING is the one that needs saying out loud: the money has left the
 * available balance but has not settled, and without an explanation that
 * reads as "it vanished".
 */
const STATUS_HINTS: Record<TxState, string> = {
    PENDING: 'This is still on its way. The money is set aside and will either arrive or come back to your balance.',
    COMPLETED: 'This went through.',
    FAILED: 'This did not go through. Any money set aside has been returned to your balance.',
    UNKNOWN: 'We are still confirming this one. Nothing is lost — check back shortly, or contact support with the receipt number.',
};

/**
 * Providers write errors for engineers. People read them in an app.
 *
 * Each entry matches on the provider's wording and replaces it with something
 * a person can act on. The original is always kept as `failureReasonRaw` —
 * support still needs the real text, and a user who asks for details should
 * be able to see it rather than be told a sanitised half-truth.
 *
 * Anything unmatched falls through to the original. A wrong plain-English
 * guess is worse than an awkward technical sentence.
 */
const FAILURE_PATTERNS: { match: RegExp; say: string }[] = [
    { match: /insufficient|balance/i, say: 'There was not enough in the balance to cover this.' },
    { match: /required_field_missing|validation.*required/i, say: 'Some of the recipient\'s details were missing, so the transfer could not be completed.' },
    { match: /error_validation|invalid.*(account|bank|phone|address)/i, say: 'The recipient\'s account details were not accepted. Check them and try again.' },
    { match: /not_supported|unsupported/i, say: 'This bank or account type cannot be paid at the moment.' },
    { match: /timeout|timed out|unreachable|unavailable|ECONN/i, say: 'The provider could not be reached. Nothing was taken from your balance.' },
    { match: /limit|exceed/i, say: 'This is over a transfer limit.' },
    { match: /duplicate|already exists/i, say: 'This looks like a repeat of a transfer that already went through.' },
    { match: /cancell?ed|reversed/i, say: 'This was cancelled and the money returned to your balance.' },
];

function humanFailure(raw?: string | null): string | null {
    if (!raw) return null;
    const text = String(raw);
    for (const p of FAILURE_PATTERNS) if (p.match.test(text)) return p.say;
    return text;
}

function toState(status?: string | null): TxState {
    const s = String(status ?? '').toUpperCase();
    if (s === 'PENDING' || s === 'PROCESSING') return 'PENDING';
    if (s === 'COMPLETED' || s === 'SUCCESS' || s === 'SUCCESSFUL') return 'COMPLETED';
    if (s === 'FAILED' || s === 'CANCELLED' || s === 'CANCELED' || s === 'REVERSED') return 'FAILED';
    return 'UNKNOWN';
}

// ── Naming ──────────────────────────────────────────────────────────────

const RAIL_LABELS: Record<string, string> = {
    P2P_TRANSFER: 'Vyre transfer',
    BANK_WITHDRAWAL: 'Bank transfer',
    GLOBAL_PAYOUT: 'International transfer',
    CRYPTO_DEPOSIT: 'Crypto deposit',
    CRYPTO_WITHDRAWAL: 'Crypto withdrawal',
    CURRENCY_EXCHANGE: 'Currency exchange',
};

/**
 * The one line that has to carry the whole transaction at a glance.
 *
 * Always says WHAT moved, and WHERE when that is known. A bare "Received"
 * tells a person nothing they could not already see from the amount, so the
 * currency is named whenever there is no counterparty to name instead.
 */
function describe(
    type: string,
    direction: TxDirection,
    currency: string,
    counterparty: UserTransaction['counterparty'],
    exchange: UserTransaction['exchange'],
): { title: string; subtitle: string } {
    const subtitle = RAIL_LABELS[type] ?? type.replace(/_/g, ' ').toLowerCase();

    // `detail` is only a stand-in for a name when it names an INSTITUTION —
    // "Sent to GTBank" reads fine. On a crypto transfer `detail` is the
    // network, and falling back to it produces "Received from BTC", which
    // sounds like Bitcoin itself paid you. There, the address is the who, and
    // if there is no address the currency is named instead.
    const who = counterparty?.kind === 'BANK'
        ? (counterparty.name ?? counterparty.detail ?? counterparty.masked)
        : (counterparty?.name ?? counterparty?.masked);

    if (type === 'CURRENCY_EXCHANGE' && exchange) {
        if (direction === 'INTERNAL') {
            return { title: `Exchanged ${exchange.fromCurrency} to ${exchange.toCurrency}`, subtitle };
        }
        return direction === 'OUT'
            ? { title: `Exchanged ${exchange.fromCurrency} to ${exchange.toCurrency}`, subtitle }
            : { title: `Received from ${exchange.fromCurrency} exchange`, subtitle };
    }

    if (direction === 'IN') {
        return { title: who ? `Received from ${who}` : `Received ${currency}`, subtitle };
    }
    return { title: who ? `Sent to ${who}` : `Sent ${currency}`, subtitle };
}

function readCounterparty(tx: any, direction: TxDirection): UserTransaction['counterparty'] {
    const type = String(tx.type ?? '');

    if (type === 'BANK_WITHDRAWAL' && tx.bankDetails) {
        const b = tx.bankDetails as any;
        return {
            kind: 'BANK',
            name: b.accountName ?? b.bankName ?? undefined,
            detail: b.bankName ?? undefined,
            masked: maskTail(b.accountNumber),
        };
    }

    if (type === 'CRYPTO_WITHDRAWAL' || type === 'CRYPTO_DEPOSIT') {
        return {
            kind: 'ADDRESS',
            detail: tx.blockchain ?? undefined,
            masked: maskTail(tx.walletAddress, 6),
        };
    }

    if (type === 'CURRENCY_EXCHANGE') return { kind: 'EXCHANGE' };

    // GLOBAL_PAYOUT and P2P_TRANSFER carry whatever the caller put in
    // metadata. Its shape is not guaranteed, so this reads the keys that are
    // commonly present and stays quiet rather than inventing a name.
    const m = (tx.metadata ?? {}) as any;
    const name = m.accountName ?? m.beneficiaryName ?? m.recipientName ?? m.counterpartyName;
    const account = m.accountNumber ?? m.iban ?? m.phoneNumber;
    if (name || account) {
        return {
            kind: type === 'GLOBAL_PAYOUT' ? 'BANK' : 'WALLET',
            name: name ?? undefined,
            detail: m.bankName ?? m.currency ?? undefined,
            masked: maskTail(account),
        };
    }

    return undefined;
}

// ── The presenter ───────────────────────────────────────────────────────

/**
 * @param tx       a VirtualTransaction row
 * @param viewing  the account id(s) being looked at. One wallet, or every
 *                 account the user owns for a combined history.
 */
export function presentTransaction(tx: any, viewing: Set<string> | string[]): UserTransaction {
    const mine = viewing instanceof Set ? viewing : new Set(viewing);

    const type = String(tx.type ?? 'UNKNOWN');
    const isFrom = Boolean(tx.fromAccountId && mine.has(tx.fromAccountId));
    const isTo = Boolean(tx.toAccountId && mine.has(tx.toAccountId));

    // Both sides mine — a currency exchange between the user's own wallets,
    // seen from a combined history. Neither side: should not happen, since
    // the query filters on these columns, but defaulting to OUT would invent
    // a debit, so it is reported as INTERNAL and shown without a sign.
    const direction: TxDirection = isFrom && isTo ? 'INTERNAL' : isFrom ? 'OUT' : isTo ? 'IN' : 'INTERNAL';

    const gross = dec(tx.amount);
    const fee = dec(tx.fee);
    const net = tx.netAmount === null || tx.netAmount === undefined ? gross : dec(tx.netAmount);
    const converted = dec(tx.convertedAmount);

    const feeSide = feeIsPaidBy(type);
    const feePaidByViewer =
        (direction === 'OUT' && feeSide === 'SENDER') ||
        (direction === 'IN' && feeSide === 'RECEIVER');

    const exchange: UserTransaction['exchange'] | undefined =
        type === 'CURRENCY_EXCHANGE' && tx.fromCurrency && tx.toCurrency
            ? {
                fromCurrency: String(tx.fromCurrency),
                toCurrency: String(tx.toCurrency),
                rate: str(dec(tx.exchangeRate)),
                fromAmount: str(gross),
                toAmount: str(converted),
            }
            : undefined;

    // ── Currency and amount, from THIS side ─────────────────────────────
    //
    // The row's `currency` is the currency the money LEFT in. On the
    // receiving leg of an exchange that is the wrong currency AND the wrong
    // number, so both are taken from the converted side instead.
    let currency = String(tx.currency ?? '');
    let amount: Decimal;

    if (type === 'CURRENCY_EXCHANGE' && direction === 'IN' && exchange) {
        currency = exchange.toCurrency;
        amount = converted;
    } else if (direction === 'OUT') {
        // The sender's balance moved by amount + fee wherever the sender pays
        // it; on P2P the fee is the receiver's, so the sender moved `amount`.
        amount = feeSide === 'SENDER' ? gross.plus(fee) : gross;
    } else if (direction === 'IN') {
        // The receiver got `netAmount` where they carried the fee, and the
        // full amount where they did not.
        amount = feeSide === 'RECEIVER' ? net : gross;
    } else {
        amount = gross;
    }

    const counterparty = readCounterparty(tx, direction);
    const { title, subtitle } = describe(type, direction, currency, counterparty, exchange);
    const status = toState(tx.status);

    const sign = direction === 'IN' ? '+' : direction === 'OUT' ? '−' : '';

    return {
        id: String(tx.id),
        reference: String(tx.reference ?? ''),
        direction,
        type,
        title,
        subtitle,

        currency,
        amount: str(amount),
        signedAmount: sign ? `${sign}${str(amount)}` : str(amount),
        grossAmount: str(gross),
        fee: str(fee),
        feePaidByViewer,

        status,
        statusLabel: STATUS_LABELS[status],
        statusHint: STATUS_HINTS[status],
        isPending: status === 'PENDING',
        isFailed: status === 'FAILED',
        failureReason: humanFailure(tx.failureReason),
        failureReasonRaw: tx.failureReason ?? null,

        counterparty,
        blockchain: tx.blockchain ?? null,
        txHash: tx.txHash ?? null,
        walletAddress: tx.walletAddress ?? null,
        externalRef: tx.externalRef ?? null,
        exchange,

        createdAt: tx.createdAt instanceof Date ? tx.createdAt.toISOString() : String(tx.createdAt),
        completedAt: tx.completedAt
            ? (tx.completedAt instanceof Date ? tx.completedAt.toISOString() : String(tx.completedAt))
            : null,
    };
}

export function presentTransactions(rows: any[], viewing: Set<string> | string[]): UserTransaction[] {
    const mine = viewing instanceof Set ? viewing : new Set(viewing);
    return rows.map((r) => presentTransaction(r, mine));
}