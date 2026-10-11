// config/nuvionTreasury.config.ts
//
// The ONLY place that decides where a stablecoin replenishment is sent.
//
// Deliberately a static map rather than a database query. Sending to an address
// on the wrong chain loses the money with no way back, so this must never be
// the result of a lookup that could match two rows, or zero, or the right row
// with a stale address.
//
// It maps to the Nuvion ACCOUNT ID, not the address. A wrong id fails loudly on
// lookup; a wrong address sends real money into nowhere and nobody finds out
// until a deposit never arrives. The address itself is read from the row, where
// Nuvion's own account_details.created webhook wrote it.

import prisma from './prisma.client';
import logger from './logger';

// ── Which chain is which ────────────────────────────────────────────────
// The same chain is spelled three ways across this system: Vyre's names
// (BASE), Nuvion's short codes (base) and its issuer codes (BASE_MAINNET).
// Everything is normalised to Vyre's name before a key is built.
const CHAIN_ALIASES: Record<string, string> = {
    ETH: 'ETHEREUM', ETHEREUM: 'ETHEREUM', ETH_MAINNET: 'ETHEREUM',
    BASE: 'BASE', BASE_MAINNET: 'BASE',
    MATIC: 'POLYGON', POLYGON: 'POLYGON', POLYGON_MAINNET: 'POLYGON',
    SOL: 'SOLANA', SOLANA: 'SOLANA', SOLANA_MAINNET: 'SOLANA',
};

export function normaliseChain(chain?: string | null): string {
    const key = String(chain ?? '').trim().toUpperCase();
    return CHAIN_ALIASES[key] ?? key;
}

export const treasuryKey = (iso: string, chain?: string | null) =>
    `${iso.toUpperCase()}:${normaliseChain(chain)}`;

// ── The map ─────────────────────────────────────────────────────────────
// "<ISO>:<CHAIN>" -> the Nuvion account id that holds that stablecoin.
//
// A pair that is NOT here cannot be replenished automatically. That is the
// point: Nuvion only issues stablecoin wallets on eth, base, matic and sol, so
// USDT on Tron, for instance, has nowhere to go and must stay out of this map.
export const STABLECOIN_TREASURY: Record<string, string> = {
    'USDC:BASE': '01M0T7QZHBRAMKY93TC38Y3EJS', // Master-Base
    'USDC:ETHEREUM': '01M4F0J9FPD5SAX5P4ZVX8EZ29', // Master-Ethereum
    'USDC:POLYGON':  '01M4F19FW39CD5TEENHKR8PW9C', // Master-Matic
    'USDC:SOLANA':   '01M4F11KWYYRQXMEP3MN7N24BF', // Master-Solana

    'USDT:BASE':     '01M4F1KXBK0FAFZ1SDWDDMMFBM', // Master-Usdt-Base
    'USDT:ETHEREUM': '01M4F3HYFF9ZZJN427C640M64S',
    'USDT:POLYGON': '01M4F1TZGSAJTZCJHNDXECXFBK',
    'USDT:SOLANA': '01M4F3D7ZVB4X8NCGXAE8YH8XE',
};

// ── When it is worth sending ────────────────────────────────────────────
// Below the threshold, the crypto stays with the admin and the amount goes on
// pendingManualTopupUsd instead, so nothing is unaccounted for.
//
// Two reasons this is per chain. An Ethereum send can cost more in gas than a
// small replenishment is worth, while Base costs cents. And blockchain_Transfer
// calls transferfeeService.isValidWithdrawal, which THROWS below a per-chain
// minimum, so a threshold under that minimum would only produce failures.
//
// ⚠️ Set each of these at or above the real chain minimum in transferfeeService.
export const REPLENISH_THRESHOLD: Record<string, number> = {
    BASE: 5,
    POLYGON: 5,
    SOLANA: 5,
    ETHEREUM: 100,
};

export const DEFAULT_THRESHOLD = 100; // for any chain not listed

export const thresholdFor = (chain?: string | null): number =>
    REPLENISH_THRESHOLD[normaliseChain(chain)] ?? DEFAULT_THRESHOLD;

// ── Resolving a destination ─────────────────────────────────────────────
// A plain shape rather than a discriminated union. Narrowing a union on a
// literal `ok` only works with strictNullChecks on, and this has to compile
// the same way whatever the project's tsconfig says.
export interface TreasuryTarget {
    ok: boolean;
    key: string;
    reason?: string;          // set when ok is false
    nuvionAccountId?: string; // set when ok is true
    treasuryRowId?: string;
    address?: string;
}

// The map gives the account; the row gives the address. Both have to agree with
// the pair being sent, or nothing is sent.
export async function resolveTreasury(iso: string, chain?: string | null): Promise<TreasuryTarget> {
    const key = treasuryKey(iso, chain);
    const nuvionAccountId = STABLECOIN_TREASURY[key];

    if (!nuvionAccountId) {
        return { ok: false, key, reason: `No Nuvion treasury is configured for ${key}. Automatic replenishment is not possible for this pair.` };
    }

    const row = await prisma.nuvionTreasuryAccount.findUnique({ where: { nuvionAccountId } });
    if (!row) {
        return { ok: false, key, reason: `${key} maps to Nuvion account ${nuvionAccountId}, but no NuvionTreasuryAccount row has it.` };
    }
    if (!row.isActive) {
        return { ok: false, key, reason: `The treasury for ${key} (${row.id}) is not active.` };
    }
    if (!row.walletAddress) {
        return { ok: false, key, reason: `The treasury for ${key} (${row.id}) has no walletAddress. account_details.created may not have arrived.` };
    }
    if (row.walletStatus && row.walletStatus !== 'active') {
        return { ok: false, key, reason: `The wallet for ${key} is "${row.walletStatus}", not active.` };
    }

    // The row must be for the chain the key claims. A map entry pointing at the
    // wrong account is exactly the mistake this whole file exists to prevent.
    const rowChain = normaliseChain(row.chain);
    const wantChain = normaliseChain(chain);
    if (rowChain !== wantChain) {
        return { ok: false, key, reason: `${key} maps to ${nuvionAccountId}, but that account is on ${row.chain}, not ${wantChain}. Check the map.` };
    }

    return { ok: true, key, nuvionAccountId, treasuryRowId: row.id, address: row.walletAddress };
}

// ── Checked once at boot ────────────────────────────────────────────────
// Walks every entry so a wrong paste is caught on deploy, not mid-payout.
// Returns the problems rather than throwing, so a bad entry does not stop the
// whole service: only that one pair cannot be replenished.
export async function validateTreasuryMap(): Promise<string[]> {
    const problems: string[] = [];

    for (const [key, nuvionAccountId] of Object.entries(STABLECOIN_TREASURY)) {
        const [iso, chain] = key.split(':');
        if (!iso || !chain) {
            problems.push(`"${key}" is not in the form ISO:CHAIN`);
            continue;
        }
        if (!nuvionAccountId) {
            problems.push(`${key} has an empty account id`);
            continue;
        }

        const target = await resolveTreasury(iso, chain);
        if (!target.ok) {
            problems.push(target.reason ?? `${key} could not be resolved`);
            continue;
        }

        const row = await prisma.nuvionTreasuryAccount.findUnique({ where: { nuvionAccountId } });
        // Nuvion records the currency as USC / UST; Vyre as USDC / USDT.
        const nuvionCode = iso === 'USDC' ? 'USC' : iso === 'USDT' ? 'UST' : iso;
        if (row && ![iso, nuvionCode].includes(row.currency)) {
            problems.push(`${key} maps to an account holding ${row.currency}, not ${iso}`);
        }
    }

    // Two keys pointing at the same account means one of them is a copy-paste slip.
    const seen = new Map<string, string>();
    for (const [key, id] of Object.entries(STABLECOIN_TREASURY)) {
        if (!id) continue;
        const first = seen.get(id);
        if (first) problems.push(`${key} and ${first} both map to ${id}. One of them is wrong.`);
        else seen.set(id, key);
    }

    if (problems.length === 0) {
        logger.info(`[Treasury] Map checked: ${Object.keys(STABLECOIN_TREASURY).length} pair(s), all resolve`);
    } else {
        problems.forEach((p) => logger.error(`[Treasury] Map problem: ${p}`));
    }
    return problems;
}