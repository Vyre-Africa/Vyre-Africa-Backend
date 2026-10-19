// services/railRequirements.ts
//
// Nuvion's rail-fields table, as code. This is the map.
//
// Source: Nuvion's own documentation, supplied 13 Oct. That makes it
// authoritative in a way my earlier guesses were not — but NOT infallible:
// your own schema already records `bankAddress*` as "required by Nuvion for at
// least the SWIFT (Acct No.) rail, confirmed via a real 422, not documented in
// their rail-fields table". So the table below is the starting point and
// nuvionRequirements.ts remains the correction mechanism: anything Nuvion
// demands that this map misses gets learned on first contact.
//
// WHAT THIS REPLACES
// The per-currency switch statements scattered across recipientparse.service
// (requiredFor / allowedFields) and ensureNuvionCounterpartyAndPaymentDetail.
// One table, one place to correct.
//
// Field names on the left of each list are OUR names — the ones the parser
// produces and the review screen asks for. `nuvionField` maps them to the
// payload key Nuvion wants.

// ── Our field name → Nuvion's payload key ───────────────────────────────
export const NUVION_FIELD: Record<string, string> = {
    accountNumber: 'account_number',
    accountName: 'account_holder_name',
    accountType: 'account_type',
    bankName: 'bank_name',
    bankCode: 'bank_code',
    branchCode: 'branch_code',
    institutionNumber: 'bank_institution_number',
    transitNumber: 'transit_number',
    routingNumber: 'routing_number',
    sortCode: 'sort_code',
    iban: 'iban',
    swiftCode: 'swift_bic',
    scheme: 'scheme',
    phoneNumber: 'phone_number',
    interacEmail: 'email',
};

export interface Rail {
    /** Nuvion's scheme value, or null where the currency has only one rail and needs none */
    scheme: string | null;
    /**
     * Set false where Nuvion REFUSES the scheme on createPaymentDetail even
     * though its enum lists it.
     *
     * MEASURED 14 Oct: EUR/sepa came back
     *   scheme: error_validation_value_not_supported
     * while every other single-rail currency accepted its scheme happily. So
     * "required only when a currency supports multiple schemes" turns out to
     * mean "and rejected for at least one that does not".
     */
    sendScheme?: boolean;
    /**
     * What to key the FEE estimate on when the scheme is not sent. Without
     * this, EUR would fall through to NUVION_FEE_ESTIMATES_USD.default (7)
     * purely because we are not allowed to name its rail.
     */
    feeScheme?: string;
    /** shown to the user when a currency has more than one rail */
    label?: string;
    /** what the user must end up supplying, in OUR field names */
    required: string[];
    /** the bank's country, where it is fixed by the rail */
    country?: string;
    /** a note worth showing or logging — digit counts and the like */
    note?: string;
}

// ── The table ───────────────────────────────────────────────────────────
// Keyed by currency. A currency with more than one entry is one where the user
// has to choose, which is exactly what "scheme" means: Nuvion says it is
// "required only when a currency supports multiple schemes".
export const RAILS: Record<string, Rail[]> = {
    // ── Africa: bank code + account number, one rail each ──
    NGN: [{
        scheme: 'nip', country: 'NG',
        required: ['bankCode', 'accountNumber', 'bankName'],
        // The ONLY NGN rail, so Nuvion does not require the scheme key. We
        // send it anyway — see SCHEME_ALWAYS_SENT below, it is what makes the
        // fee estimate correct.
    }],
    GHS: [{ scheme: 'gh_eft', country: 'GH', required: ['bankCode', 'accountNumber', 'bankName'] }],
    KES: [{ scheme: 'ke_eft', country: 'KE', required: ['bankCode', 'accountNumber', 'bankName'] }],
    UGX: [{ scheme: 'ug_eft', country: 'UG', required: ['bankCode', 'accountNumber', 'bankName'], note: 'Ugandan bank codes are 6 digits' }],
    TZS: [{ scheme: 'tz_eft', country: 'TZ', required: ['bankCode', 'accountNumber', 'bankName'] }],
    ZAR: [{ scheme: 'rtc', country: 'ZA', required: ['bankCode', 'accountNumber', 'bankName'] }],

    // ── UK / Europe ──
    GBP: [{ scheme: 'fps', country: 'GB', required: ['sortCode', 'accountNumber', 'bankName'] }],
    EUR: [{
        scheme: 'sepa',
        // MEASURED 14 Oct: Nuvion REFUSES scheme 'sepa' on a payment detail —
        // error_validation_value_not_supported. It is in their scheme enum and
        // it is the name of the rail, and it is still rejected. So EUR sends
        // no scheme and prices off feeScheme instead.
        sendScheme: false,
        feeScheme: 'sepa',
        required: ['iban', 'bankName', 'swiftCode'],
        note: 'SEPA member country',
        // NOTE swiftCode is REQUIRED here. Our earlier EUR list had only
        // iban + bankName, so a SEPA payout would have been refused for a
        // missing swift_bic.
    }],

    // ── US: three rails, same fields, different speed and fee ──
    USD: [
        { scheme: 'wire', label: 'Wire — same day, costs more', country: 'US', required: ['routingNumber', 'accountNumber', 'bankName', 'bankAddressLine1'] },
        { scheme: 'ach', label: 'ACH — 1-3 days, cheapest', country: 'US', required: ['routingNumber', 'accountNumber', 'bankName', 'bankAddressLine1'] },
        { scheme: 'rtp', label: 'Instant (RTP) — where the bank supports it', country: 'US', required: ['routingNumber', 'accountNumber', 'bankName', 'bankAddressLine1'] },
    ],

    // ── Canada: three rails, and interac_email is radically different ──
    CAD: [
        { scheme: 'eft', label: 'Bank transfer (EFT)', country: 'CA', required: ['institutionNumber', 'transitNumber', 'accountNumber', 'bankName'], note: 'institution number is 3 digits, transit number 5' },
        { scheme: 'interac_email', label: 'Interac e-Transfer to an email', country: 'CA', required: ['interacEmail'], note: 'an email address is the whole destination — no account number at all' },
        { scheme: 'interac_account', label: 'Interac to a bank account', country: 'CA', required: ['institutionNumber', 'transitNumber', 'accountNumber', 'bankName'] },
    ],

    // ── Asia-Pacific ──
    AUD: [{ scheme: 'becs', country: 'AU', required: ['bankCode', 'branchCode', 'accountNumber', 'bankName'] }],
    SGD: [{ scheme: 'fast', country: 'SG', required: ['swiftCode', 'accountNumber', 'bankName'] }],
    HKD: [{ scheme: 'hk_chats', country: 'HK', required: ['bankCode', 'accountNumber', 'branchCode', 'bankName'] }],
    CNY: [{ scheme: 'swift', country: 'CN', label: 'CNY wire', required: ['swiftCode', 'accountNumber', 'bankName'] }],
    PHP: [
        // bankName is NOT in Nuvion's published table for either PHP rail, and
        // Nuvion requires it anyway — measured 14 Oct, both rails refused with
        // bank_name: error_validation_required_field_missing. Second time their
        // table has been incomplete; your own schema records the first (a real
        // 422 for bank_address on SWIFT).
        { scheme: 'pesonet', label: 'PESONet — next day', country: 'PH', required: ['bankCode', 'accountNumber', 'bankName'] },
        { scheme: 'insta_pay', label: 'InstaPay — instant', country: 'PH', required: ['bankCode', 'accountNumber', 'bankName'] },
    ],

    // ── Middle East / Latin America ──
    AED: [{ scheme: 'uae_local', country: 'AE', required: ['iban', 'swiftCode', 'bankName'], note: 'UAE IBANs are 23 characters' }],
    MXN: [{ scheme: 'clabe', country: 'MX', required: ['accountNumber'], note: 'the account number is an 18-digit CLABE' }],
};

// ── Anything not in the table ───────────────────────────────────────────
// SWIFT, which Nuvion offers for any currency and any country, in two shapes.
// Used as the fallback so an unlisted currency degrades to something real
// rather than to a guess.
//
// bankAddress is included on the strength of your own schema comment — a real
// 422 on the SWIFT (Acct No.) rail, which their table omits. Keeping it is the
// conservative direction: an extra field costs the user an input, a missing
// one costs a refusal after they have committed.
export const SWIFT_RAILS: Rail[] = [
    { scheme: 'swift', label: 'International (SWIFT) — with IBAN', required: ['swiftCode', 'iban', 'bankName', 'bankAddressLine1'] },
    { scheme: 'swift', label: 'International (SWIFT) — with account number', required: ['swiftCode', 'accountNumber', 'bankName', 'bankAddressLine1'] },
];

// ── Mobile money ────────────────────────────────────────────────────────
// A phone number, a network, and a country. Nuvion lists it for KES, GHS and
// TZS; the network values come from the scheme enum.
//
// PHONE FORMAT, MEASURED 19 Oct 2026 on KES/mpesa (test-momo-phone-format.ts):
// Nuvion accepts E.164 WITH the leading + and nothing else. `+254712345678`
// created the payment detail; `254712345678`, `0712345678`, `712345678` and
// `+254 712 345 678` were all refused with error_validation_phone_invalid.
// So the +, the country code and the absence of spaces are each load-bearing.
// nuvionpayout.service.ts passes the accountNumber column straight through
// without normalising, so whatever writes that column owns the format.
// GHS and TZS are separate corridors and have not been measured.
//
// `required: ['phoneNumber']` below is the ACCOUNT-side field list — what the
// user has to supply. `country` is also required on the payload, and it comes
// from each rail's own `country` below via bankCountryFor(); it is not missing.
export const MOMO_RAILS: Record<string, Rail[]> = {
    KES: [
        { scheme: 'mpesa', label: 'M-Pesa', country: 'KE', required: ['phoneNumber'] },
        { scheme: 'airtel', label: 'Airtel Money', country: 'KE', required: ['phoneNumber'] },
        { scheme: 'telkom', label: 'T-Kash (Telkom)', country: 'KE', required: ['phoneNumber'] },
    ],
    GHS: [
        { scheme: 'mtn', label: 'MTN MoMo', country: 'GH', required: ['phoneNumber'] },
        { scheme: 'vodafone', label: 'Telecel / Vodafone Cash', country: 'GH', required: ['phoneNumber'] },
        { scheme: 'airtel', label: 'AirtelTigo — Airtel', country: 'GH', required: ['phoneNumber'] },
        { scheme: 'tigo', label: 'AirtelTigo — Tigo', country: 'GH', required: ['phoneNumber'] },
    ],
    TZS: [
        { scheme: 'vodacom', label: 'M-Pesa (Vodacom)', country: 'TZ', required: ['phoneNumber'] },
        { scheme: 'airtel', label: 'Airtel Money', country: 'TZ', required: ['phoneNumber'] },
        { scheme: 'tigo', label: 'Mixx by Yas (Tigo)', country: 'TZ', required: ['phoneNumber'] },
        { scheme: 'halotel', label: 'Halopesa', country: 'TZ', required: ['phoneNumber'] },
    ],
};

// Every scheme Nuvion accepts. Used to reject anything else before it is sent
// — including whatever a paste happened to say.
export const VALID_SCHEMES = new Set([
    'fps', 'sepa', 'ach', 'wire', 'rtp', 'becs', 'eft', 'interac_email', 'interac_account',
    'nip', 'rtc', 'fast', 'pesonet', 'insta_pay', 'hk_chats', 'uae_local',
    'ke_eft', 'ug_eft', 'gh_eft', 'tz_eft', 'clabe', 'swift',
    'mpesa', 'mtn', 'airtel', 'telkom', 'vodafone', 'vodacom', 'halotel', 'tigo',
    'nuvion_direct',
]);

// ── What a paste calls a network → what Nuvion calls it ─────────────────
// THIS CLOSES THE LAST OPEN QUESTION in the flow. The parser used to pass the
// network through as written ("MTN MoMo"), which Nuvion would have refused,
// because its enum wants `mtn`. Now it is a lookup, not a hope.
//
// Deliberately NOT guessing on AirtelTigo: it is two networks under one brand
// and Nuvion has separate `airtel` and `tigo` values, so a paste saying
// "AirtelTigo" is ambiguous and the user picks. Resolving it ourselves would
// be a coin flip on where the money goes.
const MOMO_ALIASES: Record<string, string> = {
    mpesa: 'mpesa', mpesakenya: 'mpesa', safaricom: 'mpesa', safaricommpesa: 'mpesa',
    mtn: 'mtn', mtnmomo: 'mtn', mtnmobilemoney: 'mtn', momo: 'mtn',
    airtel: 'airtel', airtelmoney: 'airtel',
    telkom: 'telkom', tkash: 'telkom', telkomkenya: 'telkom',
    vodafone: 'vodafone', vodafonecash: 'vodafone', telecel: 'vodafone', telecelcash: 'vodafone',
    vodacom: 'vodacom', vodacommpesa: 'vodacom',
    halotel: 'halotel', halopesa: 'halotel',
    tigo: 'tigo', tigopesa: 'tigo', mixx: 'tigo', mixxbyyas: 'tigo',
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * "MTN MoMo" → "mtn". Returns null when the text names no network we know, or
 * names an ambiguous brand — both of which mean "ask the user".
 */
export function momoSchemeFor(rawProvider?: string | null): string | null {
    if (!rawProvider) return null;
    const key = squash(rawProvider);

    // AirtelTigo covers two Nuvion schemes. Never resolved automatically.
    if (key.includes('airteltigo')) return null;

    if (MOMO_ALIASES[key]) return MOMO_ALIASES[key];
    // A longer phrase containing a known name, e.g. "send to my mtn wallet".
    for (const [alias, scheme] of Object.entries(MOMO_ALIASES)) {
        if (alias.length >= 4 && key.includes(alias)) return scheme;
    }
    return null;
}

// ── Lookups ─────────────────────────────────────────────────────────────

export function railsFor(currency?: string | null, paymentMethod = 'bank-transfer'): Rail[] {
    if (!currency) return [];
    const code = currency.toUpperCase();
    if (paymentMethod === 'momo-transfer') return MOMO_RAILS[code] ?? [];
    return RAILS[code] ?? SWIFT_RAILS;
}

/** True when the user has to choose a rail, which is when `scheme` is asked for. */
export function needsSchemeChoice(currency?: string | null, paymentMethod = 'bank-transfer'): boolean {
    return railsFor(currency, paymentMethod).length > 1;
}

/**
 * The rail in force: the chosen scheme, or the only one there is.
 * Null when a choice is pending.
 */
export function railFor(currency?: string | null, scheme?: string | null, paymentMethod = 'bank-transfer'): Rail | null {
    const rails = railsFor(currency, paymentMethod);
    if (!rails.length) return null;
    if (rails.length === 1) return rails[0];
    if (!scheme) return null;
    return rails.find((r) => r.scheme === scheme) ?? null;
}

/** The account-side fields this rail cannot go without, in OUR names. */
export function railRequiredFields(currency?: string | null, scheme?: string | null, paymentMethod = 'bank-transfer'): string[] {
    const rail = railFor(currency, scheme, paymentMethod);
    if (!rail) {
        // A choice is pending, so ask for the choice and nothing else yet —
        // asking for fields that may belong to a rail the user does not pick
        // is how a form gets long for no reason. Interac e-Transfer needs an
        // email and no account number at all; EFT needs two numbers and no
        // email.
        return ['scheme'];
    }
    const fields = [...rail.required];
    if (needsSchemeChoice(currency, paymentMethod) && !fields.includes('scheme')) fields.unshift('scheme');
    return fields;
}

// The bank's country, which is a property of the rail and not of the person.
export function bankCountryFor(currency?: string | null, scheme?: string | null, paymentMethod = 'bank-transfer'): string | null {
    return railFor(currency, scheme, paymentMethod)?.country ?? null;
}

// ── The fee consequence, worth acting on ────────────────────────────────
// `estimateNuvionFee(undefined)` returns default: 7, which is why every Naira
// payout has been quoted ~$7 against a real ~$0.04 and then refunded ~$6.96.
//
// The table says NGN's rail is `nip`, and NUVION_FEE_ESTIMATES_USD already has
// `nip: 0.5` — an entry that has never once been used, because nothing ever
// set the scheme. Sending the scheme even where Nuvion does not require it
// makes the fee lookup hit the right row.
//
// So: always send the scheme when the rail is unambiguous.
export const SCHEME_ALWAYS_SENT = true;

export function schemeToSend(currency?: string | null, chosen?: string | null, paymentMethod = 'bank-transfer'): string | undefined {
    const rails = railsFor(currency, paymentMethod);

    if (chosen && VALID_SCHEMES.has(chosen)) {
        // Even a chosen scheme is withheld where Nuvion rejects it.
        const rail = rails.find((r) => r.scheme === chosen);
        if (rail?.sendScheme === false) return undefined;
        return chosen;
    }

    if (!SCHEME_ALWAYS_SENT) return undefined;
    if (rails.length !== 1) return undefined;
    if (rails[0].sendScheme === false) return undefined;
    return rails[0].scheme ?? undefined;
}

/**
 * What the FEE estimate should be keyed on, which is not always what gets
 * sent. EUR is the case: no scheme goes to Nuvion, but the rail is still SEPA
 * and should be priced as SEPA rather than falling through to default: 7.
 */
export function feeSchemeFor(currency?: string | null, chosen?: string | null, paymentMethod = 'bank-transfer'): string | undefined {
    const rail = railFor(currency, chosen, paymentMethod);
    return rail?.feeScheme ?? rail?.scheme ?? undefined;
}

// ── Where a bank picker is possible at all ──────────────────────────────
//
// GET /bank-codes/{country} has directory data for these nine countries only.
// Everywhere else it answers 200 with an empty `data` array — not an error, so
// it must not be logged as one, and the UI must not offer a picker that would
// come back empty.
//
// Nuvion's own words: "For those corridors, obtain routing identifiers from
// the account holder." Which is exactly what the parse already does — a sort
// code, a routing number, an IBAN or a SWIFT/BIC comes out of the paste or is
// typed, and no list is involved.
export const BANK_DIRECTORY_COUNTRIES = ['NG', 'HK', 'CN', 'TZ', 'CA', 'GH', 'KE', 'UG', 'ZA'];

export const hasBankDirectory = (country?: string | null) =>
    !!country && BANK_DIRECTORY_COUNTRIES.includes(country.toUpperCase());

// WHICH FIELD THE PICKER FILLS, which is not always bank_code.
//
// getBankCodes returns { bank_code, bank_name, swift_bic } per bank, and the
// rail decides which of those is the routing identifier:
//
//   NG, GH, KE, UG, TZ, ZA   bank_code    — the directory's reason for existing
//   HK                       bank_code    plus branch_code, which the
//                                         directory does NOT supply — the user
//                                         still types that one
//   CN                       swift_bic    — the CNY rail is SWIFT, so the code
//                                         is useless and the BIC is the point
//   CA                       UNVERIFIED   — the EFT rail wants a 3-digit
//                                         institution number and a 5-digit
//                                         transit number. Whether the
//                                         directory's bank_code IS the
//                                         institution number has not been
//                                         checked. Look at one row before
//                                         relying on it; if it is 3 digits it
//                                         almost certainly is.
export function pickerFieldFor(country?: string | null): 'bankCode' | 'swiftCode' | null {
    if (!hasBankDirectory(country)) return null;
    return country!.toUpperCase() === 'CN' ? 'swiftCode' : 'bankCode';
}