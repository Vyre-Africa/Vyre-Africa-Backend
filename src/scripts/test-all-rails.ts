// scripts/test-all-rails.ts
//
//   npx ts-node --transpile-only -r dotenv/config src/scripts/test-all-rails.ts
//   npx ts-node --transpile-only -r dotenv/config src/scripts/test-all-rails.ts --confirm
//   npx ts-node --transpile-only -r dotenv/config src/scripts/test-all-rails.ts --confirm --only NGN,GHS,USD
//
// AIM: prove every rail and country in Nuvion's table is actually wired —
// before anyone opens the frontend.
//
// THREE PHASES, and the first needs nothing but the code:
//
//   1  CONSISTENCY   the map vs Nuvion's table, the Prisma schema, the parse
//                    contract and the UI labels.        offline, no API, no risk
//   2  COUNTERPARTY  what Nuvion requires per country.  real API (--confirm)
//   3  PAYMENT DETAIL whether each rail's field set is
//                    complete.                          real API (--confirm)
//
// Phase 1 is where most integration mistakes live, and it costs nothing. Run
// it on every change.
//
// ── HOW PHASE 3 WORKS, because it is not obvious ──────────────────────
// Testing a rail properly needs a real account in that country, which we do
// not have for twenty countries. But we do not need one to answer the question
// we actually care about — "does our field set satisfy this rail?" — because
// Nuvion distinguishes the two failures:
//
//   error_validation_required_field_missing   → our field set is INCOMPLETE,
//                                               and it names what is missing
//   error_counterparty_account_number_invalid → every required field was
//                                               ACCEPTED, and only the dummy
//                                               value was rejected
//
// So a refusal naming only the account number is a PASS. That is the whole
// trick, and it tests all twenty rails without a single real account.
//
// ── WHAT IT CREATES ───────────────────────────────────────────────────
// No money moves. Phase 2 and 3 create one counterparty per country, all
// deactivated at the end. Payment details CANNOT be deleted at Nuvion, so
// phase 3 uses deliberately invalid account numbers to make success unlikely —
// a rail that accepts one anyway leaves a payment detail behind, attached to a
// deactivated counterparty. That is the known cost of this phase and it is why
// it is behind --confirm.

import fs from 'fs';
import path from 'path';
import prisma from '../config/prisma.client';
import {
    RAILS, SWIFT_RAILS, MOMO_RAILS, VALID_SCHEMES, NUVION_FIELD,
    railsFor, railRequiredFields, schemeToSend, bankCountryFor, feeSchemeFor,
    BANK_DIRECTORY_COUNTRIES, hasBankDirectory, momoSchemeFor,
} from '../services/railRequirements';

const CONFIRMED = process.argv.includes('--confirm');
const ONLY_INDEX = process.argv.indexOf('--only');
const ONLY = ONLY_INDEX > -1
    ? (process.argv[ONLY_INDEX + 1] ?? '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)
    : null;

const SRC_ROOT = path.resolve(__dirname, '..');

type Verdict = 'PASS' | 'FAIL' | 'WARN' | 'INFO';
const results: { id: string; verdict: Verdict; note: string }[] = [];

function record(id: string, verdict: Verdict, note: string) {
    results.push({ id, verdict, note });
    console.log(`  ${{ PASS: '✅', FAIL: '❌', WARN: '⚠️ ', INFO: 'ℹ️ ' }[verdict]} ${id.padEnd(22)} ${note}`);
}

function header(title: string) {
    console.log(`\n${'─'.repeat(74)}`);
    console.log(title);
}

const firstLine = (e: any) =>
    String(e?.message ?? e ?? 'unknown').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? 'unknown';

function tryRequire(modulePath: string, symbol: string): any | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(modulePath);
        if (typeof mod?.[symbol] === 'function') return mod[symbol];
        const owner = mod?.default;
        if (owner && typeof owner[symbol] === 'function') return owner[symbol].bind(owner);
        return mod?.[symbol] ?? owner?.[symbol] ?? null;
    } catch {
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// NUVION'S TABLE, transcribed independently of railRequirements.ts
//
// Deliberately a SECOND copy, typed from the documentation rather than read
// from the map. A test that imports the thing it is checking proves only that
// the file parses. Two transcriptions disagreeing means one of them is wrong,
// which is the point.
// ═══════════════════════════════════════════════════════════════════════
const TABLE: Record<string, { scheme: string; country?: string; fields: string[] }[]> = {
    GBP: [{ scheme: 'fps', country: 'GB', fields: ['sort_code', 'account_number', 'bank_name'] }],
    EUR: [{ scheme: 'sepa', fields: ['iban', 'bank_name', 'swift_bic'] }],
    USD: [
        { scheme: 'ach', country: 'US', fields: ['scheme', 'routing_number', 'account_number', 'bank_name', 'bank_address'] },
        { scheme: 'wire', country: 'US', fields: ['scheme', 'routing_number', 'account_number', 'bank_name', 'bank_address'] },
        { scheme: 'rtp', country: 'US', fields: ['scheme', 'routing_number', 'account_number', 'bank_name', 'bank_address'] },
    ],
    AUD: [{ scheme: 'becs', country: 'AU', fields: ['bank_code', 'branch_code', 'account_number', 'bank_name'] }],
    CAD: [
        { scheme: 'eft', country: 'CA', fields: ['bank_institution_number', 'transit_number', 'account_number', 'bank_name'] },
        { scheme: 'interac_email', country: 'CA', fields: ['scheme', 'email'] },
        { scheme: 'interac_account', country: 'CA', fields: ['scheme', 'bank_institution_number', 'transit_number', 'account_number', 'bank_name'] },
    ],
    NGN: [{ scheme: 'nip', country: 'NG', fields: ['bank_code', 'account_number', 'bank_name'] }],
    ZAR: [{ scheme: 'rtc', country: 'ZA', fields: ['bank_code', 'account_number', 'bank_name'] }],
    SGD: [{ scheme: 'fast', country: 'SG', fields: ['swift_bic', 'account_number', 'bank_name'] }],
    PHP: [
        // bank_name added from MEASUREMENT, not from the table — Nuvion
        // requires it on both PHP rails and does not document it.
        { scheme: 'pesonet', country: 'PH', fields: ['scheme', 'bank_code', 'account_number', 'bank_name'] },
        { scheme: 'insta_pay', country: 'PH', fields: ['scheme', 'bank_code', 'account_number', 'bank_name'] },
    ],
    HKD: [{ scheme: 'hk_chats', country: 'HK', fields: ['bank_code', 'account_number', 'branch_code', 'bank_name'] }],
    AED: [{ scheme: 'uae_local', country: 'AE', fields: ['iban', 'swift_bic', 'bank_name'] }],
    KES: [{ scheme: 'ke_eft', country: 'KE', fields: ['bank_code', 'account_number', 'bank_name'] }],
    UGX: [{ scheme: 'ug_eft', country: 'UG', fields: ['bank_code', 'account_number', 'bank_name'] }],
    GHS: [{ scheme: 'gh_eft', country: 'GH', fields: ['bank_code', 'account_number', 'bank_name'] }],
    TZS: [{ scheme: 'tz_eft', country: 'TZ', fields: ['bank_code', 'account_number', 'bank_name'] }],
    MXN: [{ scheme: 'clabe', country: 'MX', fields: ['account_number'] }],
    CNY: [{ scheme: 'swift', country: 'CN', fields: ['swift_bic', 'account_number', 'bank_name'] }],
};

const MOMO_TABLE: Record<string, string[]> = {
    KES: ['mpesa', 'airtel', 'telkom'],
    GHS: ['mtn', 'vodafone', 'airtel', 'tigo'],
    TZS: ['vodacom', 'airtel', 'tigo', 'halotel'],
};

// ═══════════════════════════════════════════════════════════════════════
// PHASE 1 — consistency. Offline.
// ═══════════════════════════════════════════════════════════════════════
async function phase1() {
    header('PHASE 1 — the map against everything it has to agree with (offline)');

    // ── 1a. The map vs the table ──
    for (const [currency, rows] of Object.entries(TABLE)) {
        if (ONLY && !ONLY.includes(currency)) continue;

        const mapped = railsFor(currency);
        if (!mapped.length || mapped === SWIFT_RAILS) {
            record(`1a.${currency}`, 'FAIL', `not in RAILS at all — falls back to SWIFT, which is not what the table says`);
            continue;
        }

        if (mapped.length !== rows.length) {
            record(`1a.${currency}`, 'FAIL',
                `the table lists ${rows.length} rail(s) (${rows.map((r) => r.scheme).join(', ')}), the map has ` +
                `${mapped.length} (${mapped.map((r) => r.scheme).join(', ')})`);
            continue;
        }

        let ok = true;
        for (const row of rows) {
            const rail = mapped.find((r) => r.scheme === row.scheme);
            if (!rail) {
                record(`1a.${currency}.${row.scheme}`, 'FAIL', `scheme missing from the map`);
                ok = false;
                continue;
            }

            // Compare in NUVION's names, since that is what the table uses.
            const ourNuvionNames = rail.required
                .map((f) => NUVION_FIELD[f] ?? f)
                // our bankAddressLine1 stands for the whole bank_address block
                .map((f) => (f === 'bank_address.line1' || f === 'bankAddressLine1' ? 'bank_address' : f));

            const expected = row.fields.filter((f) => f !== 'scheme'); // scheme is added by needsSchemeChoice
            const missing = expected.filter((f) => !ourNuvionNames.includes(f));
            const extra = ourNuvionNames.filter((f) => !expected.includes(f) && f !== 'scheme');

            if (missing.length) {
                record(`1a.${currency}.${row.scheme}`, 'FAIL', `the map omits ${missing.join(', ')} — Nuvion will refuse this rail`);
                ok = false;
            } else if (extra.length) {
                record(`1a.${currency}.${row.scheme}`, 'WARN', `the map asks for ${extra.join(', ')}, which the table does not list (over-collecting, not a failure)`);
            }

            if (row.country && rail.country !== row.country) {
                record(`1a.${currency}.${row.scheme}`, 'FAIL', `country should be ${row.country}, map says ${rail.country ?? 'none'}`);
                ok = false;
            }
            if (!VALID_SCHEMES.has(row.scheme)) {
                record(`1a.${currency}.${row.scheme}`, 'FAIL', `"${row.scheme}" is not in VALID_SCHEMES, so the payout service will reject it`);
                ok = false;
            }
        }
        if (ok) record(`1a.${currency}`, 'PASS', `${mapped.length} rail(s) match the table`);
    }

    // ── 1b. Mobile money networks ──
    for (const [currency, schemes] of Object.entries(MOMO_TABLE)) {
        if (ONLY && !ONLY.includes(currency)) continue;
        const mapped = railsFor(currency, 'momo-transfer').map((r) => r.scheme);
        const missing = schemes.filter((s) => !mapped.includes(s));
        record(`1b.${currency}`, missing.length ? 'FAIL' : 'PASS',
            missing.length ? `momo networks missing: ${missing.join(', ')}` : `${mapped.length} networks wired`);
    }

    // A paste says "MTN MoMo", Nuvion wants "mtn".
    const MOMO_PHRASES: [string, string | null][] = [
        ['MTN MoMo', 'mtn'], ['mtn mobile money', 'mtn'],
        ['M-Pesa', 'mpesa'], ['Safaricom M-PESA', 'mpesa'],
        ['Vodafone Cash', 'vodafone'], ['Telecel Cash', 'vodafone'],
        ['Airtel Money', 'airtel'], ['Halopesa', 'halotel'],
        ['Tigo Pesa', 'tigo'], ['T-Kash', 'telkom'],
        ['AirtelTigo', null],   // two networks, one brand — must NOT be guessed
        ['some random wallet', null],
    ];
    let momoOk = true;
    for (const [phrase, expected] of MOMO_PHRASES) {
        const got = momoSchemeFor(phrase);
        if (got !== expected) {
            record('1b.alias', 'FAIL', `"${phrase}" → ${got ?? 'null'}, expected ${expected ?? 'null'}`);
            momoOk = false;
        }
    }
    if (momoOk) record('1b.alias', 'PASS', `${MOMO_PHRASES.length} network phrases map correctly, AirtelTigo correctly refuses to guess`);

    // ── 1c. The map vs the Prisma schema ──
    // Every field a rail requires has to have somewhere to live. Read from
    // Prisma's own DMMF, so it is the real schema and not my memory of it.
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require('@prisma/client');
        const model = (Prisma as any).dmmf?.datamodel?.models?.find((m: any) => m.name === 'BeneficiaryPaymentDetail');
        if (!model) {
            record('1c.schema', 'WARN', 'could not read BeneficiaryPaymentDetail from Prisma DMMF — checked nothing');
        } else {
            const columns = new Set<string>(model.fields.map((f: any) => f.name));

            // Fields that are stored elsewhere on purpose, with the reason.
            const STORED_ELSEWHERE: Record<string, string> = {
                phoneNumber: 'momo uses accountNumber — the number IS the account',
                interacEmail: 'interac_email uses accountNumber — the email IS the account',
                recipientAddressLine1: 'lives on beneficiary.nuvionRecipientAddressLine1',
                recipientAddressCity: 'lives on beneficiary.nuvionRecipientAddressCity',
                recipientAddressState: 'lives on beneficiary.nuvionRecipientAddressState',
                recipientAddressPostal: 'lives on beneficiary.nuvionRecipientAddressPostal',
                email: 'lives on beneficiary.nuvionRecipientEmail',
            };

            const everyRailField = new Set<string>();
            for (const rows of [...Object.values(RAILS), ...Object.values(MOMO_RAILS), [SWIFT_RAILS]].flat()) {
                for (const f of (rows as any).required ?? []) everyRailField.add(f);
            }

            const homeless = [...everyRailField].filter((f) => !columns.has(f) && !STORED_ELSEWHERE[f]);

            if (homeless.length) {
                record('1c.schema', 'FAIL',
                    `no column for: ${homeless.join(', ')}. A rail needing one of these CANNOT be stored, so the ` +
                    'payout fails at the Prisma create before Nuvion is reached. Add them as optional String? columns.');
                // Name which currencies that breaks, so the blast radius is clear.
                for (const [currency, rails] of Object.entries(RAILS)) {
                    const hit = rails.filter((r) => r.required.some((f) => homeless.includes(f)));
                    if (hit.length) {
                        record(`1c.${currency}`, 'FAIL', `blocked — needs ${hit.flatMap((r) => r.required.filter((f) => homeless.includes(f))).join(', ')}`);
                    }
                }
            } else {
                record('1c.schema', 'PASS', `every rail field has a column or a documented home (${columns.size} columns read from the live schema)`);
            }
        }
    } catch (e: any) {
        record('1c.schema', 'WARN', `could not inspect the schema: ${firstLine(e)}`);
    }

    // ── 1d. The map vs the parse contract ──
    //
    // CORRECTED. The first version compared the wrong two things: it asked the
    // map "what does the wire rail need?" and the parser "what do you ask for
    // before a rail is chosen?" — then called the difference a failure. For
    // USD, CAD and PHP that difference is the whole design: a currency with
    // several rails asks for the CHOICE first, because the fields depend on
    // it. Interac e-Transfer needs an email and no account number; EFT needs
    // two numbers and no email. Asking for both sets would be a worse form,
    // not a better one.
    //
    // So the comparison is now like-for-like:
    //   one rail   → the parser must ask for that rail's fields
    //   many rails → the parser must ask for `scheme` and nothing rail-specific
    const parseMod = (() => { try { return require('../services/recipientparse.service'); } catch { return null; } })();

    if (!parseMod?.__requiredForTest) {
        record('1d.parse', 'WARN', 'recipientparse.service does not export __requiredForTest — nothing checked');
    } else {
        let allOk = true;
        for (const currency of Object.keys(TABLE)) {
            if (ONLY && !ONLY.includes(currency)) continue;

            const rails = railsFor(currency);
            const reported: string[] = parseMod.__requiredForTest('bank-transfer', currency);

            if (rails.length > 1) {
                // Must ask for the choice, and must NOT pre-ask rail fields.
                const asksScheme = reported.includes('scheme');
                const railSpecific = rails.flatMap((r) => r.required).filter((f) => reported.includes(f));
                if (!asksScheme) {
                    record(`1d.${currency}`, 'FAIL',
                        `${rails.length} rails, so the user must choose — but the parser does not ask for scheme`);
                    allOk = false;
                } else if (railSpecific.length) {
                    record(`1d.${currency}`, 'WARN',
                        `asks for ${railSpecific.join(', ')} before the rail is chosen — those may belong to a rail the user does not pick`);
                } else {
                    record(`1d.${currency}`, 'PASS', `${rails.length} rails — asks for the choice first, correctly`);
                }
                continue;
            }

            const needed = railRequiredFields(currency, rails[0]?.scheme ?? null);
            const gap = needed.filter((f) => f !== 'scheme' && !reported.includes(f));
            if (gap.length) {
                record(`1d.${currency}`, 'FAIL', `single rail, but the parser never asks for ${gap.join(', ')}`);
                allOk = false;
            } else {
                record(`1d.${currency}`, 'PASS', 'asks for every field this rail needs');
            }
        }

        // THE SECOND HALF, and the one that found a real gap: once a scheme IS
        // chosen, the rail's fields must become askable. If nothing recomputes
        // them, a USD recipient is asked for the rail and then never for the
        // routing number.
        for (const currency of ['USD', 'CAD', 'PHP']) {
            if (ONLY && !ONLY.includes(currency)) continue;
            for (const rail of railsFor(currency)) {
                const afterChoice = railRequiredFields(currency, rail.scheme);
                const expected = rail.required;
                const gap = expected.filter((f) => !afterChoice.includes(f));
                record(`1d.${currency}.${rail.scheme}`, gap.length ? 'FAIL' : 'PASS',
                    gap.length
                        ? `after choosing ${rail.scheme}, the map still omits ${gap.join(', ')}`
                        : `after choosing ${rail.scheme}, its ${expected.length} fields become required`);
            }
        }
        if (allOk) record('1d.parse', 'PASS', 'the parse contract and the rail map agree, before and after a rail choice');
    }

    // ── 1e. The map vs the UI ──
    // A field with no label renders as its variable name. Cheap to check, and
    // it is the difference between "Transit number" and "transitNumber".
    const vueCandidates = [
        path.join(SRC_ROOT, '..', 'components', 'QuickSend.vue'),
        path.join(SRC_ROOT, 'components', 'QuickSend.vue'),
    ];
    const vuePath = vueCandidates.find((p) => fs.existsSync(p));
    if (!vuePath) {
        record('1e.labels', 'INFO', 'QuickSend.vue not found from here (it lives in the frontend repo) — check labels there');
    } else {
        const vue = fs.readFileSync(vuePath, 'utf8');
        const everyField = new Set<string>();
        for (const rows of [...Object.values(RAILS), ...Object.values(MOMO_RAILS), [SWIFT_RAILS]].flat()) {
            for (const f of (rows as any).required ?? []) everyField.add(f);
        }
        const unlabelled = [...everyField].filter((f) => !new RegExp(`\\b${f}\\s*:`).test(vue));
        record('1e.labels', unlabelled.length ? 'WARN' : 'PASS',
            unlabelled.length
                ? `no label in QuickSend.vue for: ${unlabelled.join(', ')} — these render as variable names`
                : 'every rail field has a label');
    }

    // ── 1f. Bank directory coverage ──
    const directoryBacked = Object.entries(RAILS)
        .filter(([, rails]) => rails.some((r) => r.required.includes('bankCode')))
        .map(([currency, rails]) => ({ currency, country: rails[0].country }));

    for (const { currency, country } of directoryBacked) {
        if (ONLY && !ONLY.includes(currency)) continue;
        record(`1f.${currency}`, hasBankDirectory(country) ? 'PASS' : 'WARN',
            hasBankDirectory(country)
                ? `bank_code comes from the directory (${country})`
                : `needs a bank_code but ${country} has NO directory — the user must type it, and the parser cannot resolve it from a bank name`);
    }
    record('1f.countries', 'INFO', `directories: ${BANK_DIRECTORY_COUNTRIES.join(', ')}`);

    // ── 1g. The scheme actually sent ──
    for (const currency of Object.keys(TABLE)) {
        if (ONLY && !ONLY.includes(currency)) continue;
        const rails = railsFor(currency);
        const sent = schemeToSend(currency, null);
        if (rails.length === 1) {
            const rail = rails[0];
            if (rail.sendScheme === false) {
                // Measured as rejected, so withholding it is correct — and the
                // fee must then come from feeScheme or it falls to default: 7.
                const priced = feeSchemeFor(currency, null);
                record(`1g.${currency}`, sent === undefined && priced ? 'PASS' : 'FAIL',
                    sent !== undefined
                        ? `sends "${sent}" although Nuvion rejects it on this rail`
                        : priced
                            ? `correctly sends no scheme (Nuvion rejects it) and prices as "${priced}"`
                            : 'correctly sends no scheme, but has no feeScheme either — the fee falls to default: 7');
                continue;
            }
            record(`1g.${currency}`, sent === rail.scheme ? 'PASS' : 'FAIL',
                sent === rail.scheme
                    ? `sends scheme "${sent}" unprompted, so the fee estimate lands on the right row`
                    : `should send "${rail.scheme}" and sends ${sent ?? 'nothing'} — the fee falls through to default: 7`);
        } else {
            record(`1g.${currency}`, sent === undefined ? 'PASS' : 'FAIL',
                sent === undefined
                    ? `${rails.length} rails, so the user picks — correctly sends nothing until they do`
                    : `sent "${sent}" without the user choosing between ${rails.length} rails`);
        }
    }

    // ── 1h. The fee table ──
    const feeMod = (() => { try { return require('../services/nuvionpayout.service'); } catch { return null; } })();
    if (feeMod?.NUVION_FEE_ESTIMATES_USD) {
        const fees = feeMod.NUVION_FEE_ESTIMATES_USD;
        const schemesInUse = new Set<string>();
        for (const rows of [...Object.values(RAILS), ...Object.values(MOMO_RAILS)].flat()) {
            if ((rows as any).scheme) schemesInUse.add((rows as any).scheme);
        }
        const unpriced = [...schemesInUse].filter((s) => fees[s] === undefined);
        record('1h.fees', unpriced.length ? 'WARN' : 'PASS',
            unpriced.length
                ? `no fee estimate for: ${unpriced.join(', ')} — each falls through to default: ${fees.default}, ` +
                  'which is what made every Naira payout quote ~$7 against a real ~$0.04'
                : 'every scheme in use has a fee estimate');
    }
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 2 — what Nuvion requires on a counterparty, per country
// ═══════════════════════════════════════════════════════════════════════
const created: { counterparties: string[] } = { counterparties: [] };

async function phase2() {
    header('PHASE 2 — counterparty requirements, per country (live Nuvion)');

    if (!CONFIRMED) {
        record('2', 'INFO', 'skipped — needs --confirm. Creates one counterparty per country, all deactivated after.');
        return;
    }

    const createCounterparty = tryRequire('../services/nuvion.service', 'createCounterparty');
    if (!createCounterparty) {
        record('2', 'FAIL', 'createCounterparty not reachable');
        return;
    }

    const countries = [...new Set(
        Object.values(RAILS).flat().map((r) => r.country).filter(Boolean) as string[],
    )].sort();

    const ADDRESS = { line1: '12 Test Street', city: 'Testville', state_or_province: 'Test Region', postal_code: '00001' };

    for (const country of countries) {
        const stamp = `VYRERAIL-${country}-${Date.now()}`;
        try {
            const res = await createCounterparty({
                type: 'individual',
                nickname: stamp,
                profile: {
                    first_name: 'Rail', last_name: 'Audit', relationship: 'vendor',
                    email: `probe+${stamp.toLowerCase()}@vyre.africa`,
                    address: { ...ADDRESS, country },
                },
            });

            if (res?.success && res?.id) {
                created.counterparties.push(res.id);
                record(`2.${country}`, 'PASS', 'full address + email accepted');
            } else {
                const detail = JSON.stringify(res?.rawData?.validations ?? res?.error ?? {}).slice(0, 280);
                record(`2.${country}`, 'FAIL', `refused even with a full address: ${detail}`);
            }
        } catch (e: any) {
            record(`2.${country}`, 'FAIL', firstLine(e));
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 3 — is each rail's field set complete?
// ═══════════════════════════════════════════════════════════════════════
async function phase3() {
    header('PHASE 3 — rail field sets (live Nuvion, no real accounts needed)');

    if (!CONFIRMED) {
        record('3', 'INFO',
            'skipped — needs --confirm. Reads whether Nuvion complains about a MISSING field (our set is wrong) ' +
            'or only about the dummy account number (our set is right).');
        return;
    }

    const createCounterparty = tryRequire('../services/nuvion.service', 'createCounterparty');
    const createPaymentDetail = tryRequire('../services/nuvion.service', 'createPaymentDetail');
    if (!createCounterparty || !createPaymentDetail) {
        record('3', 'FAIL', 'createCounterparty / createPaymentDetail not reachable');
        return;
    }

    // Plausibly SHAPED but deliberately invalid, so a rail is unlikely to
    // accept one and leave an undeletable payment detail behind.
    const DUMMY: Record<string, string> = {
        account_number: '0000000000',
        bank_code: '000',
        branch_code: '000',
        bank_institution_number: '000',
        transit_number: '00000',
        routing_number: '000000000',
        sort_code: '000000',
        iban: 'DE00000000000000000000',
        swift_bic: 'TESTXX00',
        bank_name: 'Test Bank',
        email: 'probe+interac@vyre.africa',
    };

    for (const [currency, rails] of Object.entries(RAILS)) {
        if (ONLY && !ONLY.includes(currency)) continue;

        for (const rail of rails) {
            const country = rail.country ?? bankCountryFor(currency, rail.scheme) ?? 'US';
            const stamp = `VYRERAIL-${currency}-${rail.scheme}-${Date.now()}`;

            // A payment detail needs a counterparty to hang off.
            let counterpartyId: string | null = null;
            try {
                const cp = await createCounterparty({
                    type: 'individual',
                    nickname: stamp,
                    profile: {
                        first_name: 'Rail', last_name: 'Audit', relationship: 'vendor',
                        email: `probe+${stamp.toLowerCase()}@vyre.africa`,
                        address: { line1: '12 Test Street', city: 'Testville', state_or_province: 'Test Region', postal_code: '00001', country },
                    },
                });
                if (cp?.success && cp?.id) { counterpartyId = cp.id; created.counterparties.push(cp.id); }
            } catch { /* reported below */ }

            if (!counterpartyId) {
                record(`3.${currency}.${rail.scheme}`, 'FAIL', 'could not create a counterparty to test against');
                continue;
            }

            // Build the payload from OUR map, in Nuvion's names.
            // THE SCHEME MUST COME FROM schemeToSend, not from the rail.
            //
            // This had `scheme: rail.scheme` directly, which meant the test
            // sent a payload production never sends. EUR kept failing on
            // scheme: error_validation_value_not_supported even after
            // sendScheme: false was added, because the app withholds `sepa`
            // and the test did not. A test that builds its own payload is
            // testing its own payload.
            const scheme = schemeToSend(currency, rail.scheme, 'bank-transfer');

            const payload: Record<string, any> = {
                payment_method: 'bank-transfer',
                currency,
                account_holder_name: 'Rail Audit',
                counterparty_id: counterpartyId,
                country,
                ...(scheme ? { scheme } : {}),
            };
            for (const field of rail.required) {
                const nuvionName = NUVION_FIELD[field] ?? field;
                if (nuvionName === 'bank_address' || field === 'bankAddressLine1') {
                    payload.bank_address = { line1: '1 Bank Street', city: 'Testville', state: 'Test Region', postal_code: '00001', country };
                    continue;
                }
                if (DUMMY[nuvionName] !== undefined) payload[nuvionName] = DUMMY[nuvionName];
            }

            try {
                const res = await createPaymentDetail(payload as any);

                if (res?.success) {
                    record(`3.${currency}.${rail.scheme}`, 'PASS',
                        'accepted — field set is complete. NOTE a payment detail was created and cannot be deleted.');
                    continue;
                }

                const validations = res?.rawData?.validations ?? [];
                const types = validations.flatMap((v: any) => Object.entries(v ?? {}).map(([k, d]: any) => ({ field: k, type: d?.type })));
                const missing = types.filter((t: any) => t.type === 'error_validation_required_field_missing');

                // A REJECTED SCHEME VALUE is a failure too, and the first
                // version of this script called it a pass because it was not a
                // missing-field error. EUR/sepa came back
                //   scheme: error_validation_value_not_supported
                // and was reported green. A real EUR payout would have been
                // refused for a value we chose to send.
                const badScheme = types.find((t: any) =>
                    t.field === 'scheme' && /not_supported|invalid/.test(String(t.type)));

                if (missing.length) {
                    record(`3.${currency}.${rail.scheme}`, 'FAIL',
                        `our field set is INCOMPLETE — Nuvion wants: ${missing.map((m: any) => m.field).join(', ')}`);
                } else if (badScheme) {
                    record(`3.${currency}.${rail.scheme}`, 'FAIL',
                        scheme
                            ? `Nuvion REFUSES scheme "${scheme}" on this rail (${badScheme.type}) even though its enum ` +
                              'lists it. Set sendScheme: false on that rail and give it a feeScheme so the fee still prices.'
                            : `Nuvion objected to the scheme field even though we sent none (${badScheme.type}) — ` +
                              'read the raw validations, something else is setting it.');
                } else {
                    // Rejected the dummy VALUES, not the field set. That is the
                    // outcome we are hoping for.
                    record(`3.${currency}.${rail.scheme}`, 'PASS',
                        `field set complete — refused only on values: ${types.map((t: any) => `${t.field}:${t.type}`).join(', ').slice(0, 200)}`);
                }
            } catch (e: any) {
                record(`3.${currency}.${rail.scheme}`, 'FAIL', firstLine(e));
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
async function cleanup() {
    if (!created.counterparties.length) return;
    header('CLEANUP');
    const deactivate = tryRequire('../services/nuvion.service', 'deactivateCounterparty');
    if (!deactivate) {
        console.log(`  ⚠️  deactivateCounterparty not reachable — ${created.counterparties.length} counterparties left active`);
        console.log(`      ${created.counterparties.join('\n      ')}`);
        return;
    }
    let done = 0;
    for (const id of created.counterparties) {
        try { await deactivate(id); done++; } catch { console.log(`  ⚠️  ${id} not deactivated`); }
    }
    console.log(`  ✅ deactivated ${done}/${created.counterparties.length} probe counterparties`);
    console.log('      Nuvion has no delete, so they stay visible under the VYRERAIL- prefix.');
}

async function main() {
    console.log(`Rail and country audit — ${CONFIRMED ? 'LIVE (phases 1-3)' : 'OFFLINE (phase 1 only)'}`);
    if (ONLY) console.log(`Limited to: ${ONLY.join(', ')}`);
    console.log('No money moves in either mode.');

    await phase1();
    await phase2();
    await phase3();

    console.log(`\n${'═'.repeat(74)}`);
    const fail = results.filter((r) => r.verdict === 'FAIL');
    const warn = results.filter((r) => r.verdict === 'WARN');
    console.log(`${results.filter((r) => r.verdict === 'PASS').length} passed · ${fail.length} failed · ${warn.length} warnings`);

    if (fail.length) {
        console.log('\nFAILURES — each one is a rail that cannot work:');
        for (const f of fail) console.log(`  ❌ ${f.id} — ${f.note}`);
    }
    if (warn.length) {
        console.log('\nWarnings — work, but worth knowing:');
        for (const w of warn) console.log(`  ⚠️  ${w.id} — ${w.note}`);
    }
    if (!CONFIRMED) {
        console.log('\nPhase 1 only. It checks the map against Nuvion\'s table, your Prisma schema,');
        console.log('the parse contract and the UI labels — which is where integration mistakes');
        console.log('actually live. Add --confirm to ask Nuvion itself.');
    }
}

main()
    .catch((err) => { console.error('\nScript crashed:', err); process.exitCode = 1; })
    .finally(async () => {
        try { await cleanup(); } catch (e: any) { console.error('Cleanup failed:', firstLine(e)); }
        await prisma.$disconnect();
    });