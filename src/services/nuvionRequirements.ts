// services/nuvionRequirements.ts
//
// WHY THIS EXISTS
//
// We spent a day measuring what Nuvion requires on an NG counterparty, got a
// precise answer (line1 + city + country + email), and then faced the obvious
// question: what about Kenya? Ghana? the US? Measuring all of them is a day
// per corridor, and a hardcoded table is wrong the moment Nuvion changes a
// rule.
//
// But Nuvion already answers the question, in machine-readable form, on every
// refusal:
//
//   [{"address.city": {
//       "type": "error_validation_required_field_missing",
//       "message": "The 'address.city' field is required. Please include it and try again."
//   }}]
//
// Measured three times, on two different error shapes (a single field, and
// legal_name + registered_address together), so it reports ALL missing fields
// in one response rather than the first.
//
// So the design is: ask for what we know, and when Nuvion says it needs more,
// read which fields, ask the user exactly those, retry, and REMEMBER the
// answer so the next person in that corridor is asked up front.
//
// Nothing is guessed. A corridor nobody has used before costs its first user
// one extra question and everyone after them nothing.
//
// THE PROPERTY THAT MAKES THIS SAFE: a required-field refusal happens at
// createCounterparty / createPaymentDetail, which run before the amount is
// confirmed and before any funds are frozen. The worst case is a question,
// never a misdirected payment.

import logger from '../config/logger';

// ── Nuvion's field paths → our own field names ──────────────────────────
// Left side is exactly what Nuvion puts in the validation key. Right side is
// the name the parse result and the review screen use.
//
// A path that is NOT in here is still reported to the caller by its raw
// Nuvion name, so an unmapped requirement surfaces as "Nuvion needs
// address.sub_locality" rather than disappearing. Add it here when it shows up.
const FIELD_MAP: Record<string, string> = {
    // counterparty
    'email': 'email',
    'address': 'recipientAddressLine1',               // the whole block missing
    'address.line1': 'recipientAddressLine1',
    'address.line2': 'recipientAddressLine2',
    'address.city': 'recipientAddressCity',
    'address.state_or_province': 'recipientAddressState',
    'address.postal_code': 'recipientAddressPostal',
    'address.country': 'recipientCountry',
    'first_name': 'accountName',
    'last_name': 'accountName',
    'legal_name': 'accountName',
    'registered_address': 'recipientAddressLine1',

    // payment detail
    'account_number': 'accountNumber',
    'account_holder_name': 'accountName',
    'account_type': 'accountType',
    'bank_name': 'bankName',
    'bank_code': 'bankCode',
    'routing_number': 'routingNumber',
    'sort_code': 'sortCode',
    'iban': 'iban',
    'swift_bic': 'swiftCode',
    'scheme': 'scheme',
    'phone_number': 'accountNumber',
    'bank_address': 'bankAddressLine1',
    'bank_address.line1': 'bankAddressLine1',
    'bank_address.city': 'bankAddressCity',
    'bank_address.state': 'bankAddressState',
    'bank_address.postal_code': 'bankAddressPostal',
    'bank_address.country': 'bankAddressCountry',
};

// When Nuvion says the whole `address` object is missing, it has not told us
// which sub-fields it wants — we only learn that by sending one and being
// refused again. Rather than make the user answer twice, asking for a line1
// and a city together is the smallest set that has ever been accepted
// anywhere, so it is the opening bid.
const BLOCK_EXPANSIONS: Record<string, string[]> = {
    'address': ['recipientAddressLine1', 'recipientAddressCity'],
    'registered_address': ['recipientAddressLine1', 'recipientAddressCity'],
    'bank_address': ['bankAddressLine1', 'bankAddressCity', 'bankAddressCountry'],
};

export interface MissingField {
    /** our field name, or the raw Nuvion path when unmapped */
    field: string;
    /** Nuvion's own sentence, worth showing when we have no better wording */
    message: string;
    /** the raw path, kept for logging and for adding to FIELD_MAP later */
    nuvionPath: string;
}

// ── Reading Nuvion's refusal ────────────────────────────────────────────
//
// The shape, confirmed on live responses:
//   rawData.validations = [ { "<path>": { type, message } }, ... ]
//
// Only `error_validation_required_field_missing` means "ask the user for
// this". Everything else — a duplicate, an invalid account number — is a
// different problem and must NOT be turned into a question, or the user is
// asked to re-enter a field that was never the issue.
const REQUIRED_MISSING = 'error_validation_required_field_missing';

export function missingFieldsFrom(rawData: any): MissingField[] {
    const validations = rawData?.validations;
    if (!Array.isArray(validations)) return [];

    const out: MissingField[] = [];

    for (const entry of validations) {
        if (!entry || typeof entry !== 'object') continue;
        for (const [path, detail] of Object.entries<any>(entry)) {
            if (detail?.type !== REQUIRED_MISSING) continue;

            const expansion = BLOCK_EXPANSIONS[path];
            if (expansion) {
                for (const field of expansion) {
                    out.push({ field, message: detail.message ?? '', nuvionPath: path });
                }
                continue;
            }

            const mapped = FIELD_MAP[path];
            if (!mapped) {
                // Surfaced rather than swallowed. An unmapped requirement is a
                // one-line addition to FIELD_MAP, but only if we can see it.
                logger.warn('[NuvionRequirements] unmapped required field', { path, message: detail?.message });
            }
            out.push({ field: mapped ?? path, message: detail?.message ?? '', nuvionPath: path });
        }
    }

    // Same field can arrive twice (first_name and last_name both map to
    // accountName), and asking twice for one answer is worse than useless.
    const seen = new Set<string>();
    return out.filter((m) => (seen.has(m.field) ? false : (seen.add(m.field), true)));
}

/** Did this refusal happen because a field was missing, as opposed to wrong? */
export function isMissingFieldError(rawData: any): boolean {
    return missingFieldsFrom(rawData).length > 0;
}

// ── What we have learned, per corridor ──────────────────────────────────
//
// Keyed on what actually determines the rules: the recipient's country, the
// currency, and the rail. In-memory on purpose — it is a cache, not a record.
// A restart costs one user one extra question, which is the same cost as a
// corridor nobody has used yet, so persistence buys very little.
//
// If you do want it to survive restarts, this is the one place to change:
// a two-column table keyed by `key` holding a string[], read on miss and
// written on learn. Everything else stays as it is.
type Corridor = { country?: string | null; currency?: string | null; paymentMethod?: string | null };

const corridorKey = (c: Corridor) =>
    `${(c.country ?? '??').toUpperCase()}|${(c.currency ?? '???').toUpperCase()}|${c.paymentMethod ?? 'bank-transfer'}`;

const LEARNED = new Map<string, Set<string>>();

// MEASURED, 13 Oct, live Nuvion, country NG:
//   no address        → refused, 'address' required
//   no email          → refused, 'email' required
//   line1 + country   → refused, 'address.city' required
//   line1 + city      → accepted
//   state, postal     → NOT required
//
// This is the only corridor with a measured answer, so it is the only one
// seeded. Everything else starts from the conservative baseline below and
// narrows itself the first time it is used.
// NOTE the seed is the FULL address, not the measured minimum.
// Nuvion accepts line1 + city, but beneficiaryController.createBeneficiary
// requires all four and that guard stays — so asking for less would be
// rejected by our own backend before Nuvion saw it. The cache's job is to
// stop us GUESSING, not to shave inputs past what the rest of the system
// accepts.
const SEED: Record<string, string[]> = {
    'NG|NGN|bank-transfer': [
        'recipientAddressLine1', 'recipientAddressCity',
        'recipientAddressState', 'recipientAddressPostal',
        'email',
    ],
};

for (const [key, fields] of Object.entries(SEED)) LEARNED.set(key, new Set(fields));

// The opening ask for a corridor we have never seen. Deliberately the FULL
// address rather than the short NG form: over-collecting costs the user two
// inputs, under-collecting costs a refusal mid-flow. Once the corridor has
// been used successfully this is replaced by what Nuvion actually demanded.
const BASELINE = [
    'recipientAddressLine1', 'recipientAddressCity',
    'recipientAddressState', 'recipientAddressPostal',
    'email',
];

export function requirementsFor(c: Corridor): { fields: string[]; learned: boolean } {
    const hit = LEARNED.get(corridorKey(c));
    return hit ? { fields: [...hit], learned: true } : { fields: [...BASELINE], learned: false };
}

/**
 * Record what Nuvion demanded, so the next person in this corridor is asked
 * up front. Additive only: a field it asked for once stays asked for, because
 * a single success proves a set is SUFFICIENT, never that it was minimal.
 */
export function learnRequirements(c: Corridor, fields: string[]) {
    if (!fields.length) return;
    const key = corridorKey(c);
    const set = LEARNED.get(key) ?? new Set<string>();
    let added = false;
    for (const f of fields) if (!set.has(f)) { set.add(f); added = true; }
    LEARNED.set(key, set);
    if (added) {
        logger.info('[NuvionRequirements] learned a requirement', { corridor: key, fields: [...set] });
    }
}

/**
 * Record that a set WORKED. Does not narrow anything — see learnRequirements.
 * Kept separate so the log tells the two apart when reading back what
 * happened in a corridor.
 */
export function confirmRequirements(c: Corridor, fieldsSent: string[]) {
    const key = corridorKey(c);
    if (!LEARNED.has(key)) {
        LEARNED.set(key, new Set(fieldsSent));
        logger.info('[NuvionRequirements] first success in a new corridor', { corridor: key, fields: fieldsSent });
    }
}

/** For an ops endpoint or a script: everything learned so far. */
export function dumpRequirements(): Record<string, string[]> {
    return Object.fromEntries([...LEARNED.entries()].map(([k, v]) => [k, [...v]]));
}