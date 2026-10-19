// scripts/test-momo-phone-format.ts
//
//   npx ts-node --transpile-only -r dotenv/config src/scripts/test-momo-phone-format.ts
//   npx ts-node --transpile-only -r dotenv/config src/scripts/test-momo-phone-format.ts --confirm
//
// AIM: find out what Nuvion wants in `phone_number` on a mobile-money payment
// detail, before the first real momo payout rather than after it.
//
// WHY THIS EXISTS
//   nuvionpayout.service.ts sends mobile money as:
//
//     railPayload = { scheme, phone_number: paymentMethod.accountNumber }
//
//   — a straight passthrough of whatever is in the column. Nothing normalises
//   it anywhere in the stack, and Nuvion's expected format has never been
//   measured. The UI currently builds E.164 with a leading + (`+254712345678`)
//   because that is the usual answer, but "usual" is not "measured", and a
//   refused payout on a live transfer is an expensive way to find out.
//
// THE TRICK (same as phase 3 of test-all-rails.ts)
//   We cannot test with a real wallet we do not have. We do not need to: the
//   two outcomes are distinguishable.
//
//     error_validation_* naming `phone_number`  → the FORMAT is wrong
//     anything else (including "no such wallet") → the format was ACCEPTED
//
//   A refusal that complains about the VALUE rather than the FIELD proves the
//   shape was right and only the number was fictional.
//
// IT CREATES A REAL COUNTERPARTY and real payment details at Nuvion. Nothing
// happens without --confirm. No money can move: a payment detail is a
// destination record, and without a transfer nothing is sent to it.

import { createCounterparty, createPaymentDetail, deactivateCounterparty } from '../services/nuvion.service';

const CONFIRMED = process.argv.includes('--confirm');

// Kenya / M-Pesa is the probe corridor: the largest momo market Nuvion lists
// and the one most likely to be used first. Change CURRENCY + SCHEME +
// COUNTRY together to measure Ghana or Tanzania.
const CURRENCY = 'KES';
const SCHEME = 'mpesa';
const COUNTRY = 'KE';
const DIAL = '254';

// A subscriber number that is well-formed and belongs to nobody. Safaricom's
// 0700-level range is real, so this will not be a live wallet, but it has the
// right shape — which is the only thing under test.
const LOCAL = '712345678';

const FORMATS: { id: string; label: string; value: string }[] = [
    { id: 'A', label: 'E.164 with +', value: `+${DIAL}${LOCAL}` },
    { id: 'B', label: 'E.164 without +', value: `${DIAL}${LOCAL}` },
    { id: 'C', label: 'local with trunk 0', value: `0${LOCAL}` },
    { id: 'D', label: 'local without trunk 0', value: LOCAL },
    { id: 'E', label: 'E.164 with spaces', value: `+${DIAL} ${LOCAL.slice(0, 3)} ${LOCAL.slice(3, 6)} ${LOCAL.slice(6)}` },
];

const STAMP = `VYRETEST-${Date.now()}`;

/**
 * Three outcomes, not two.
 *
 * The first version of this collapsed "refused for some other reason" into
 * "accepted", which is how a run where EVERY probe failed on a missing
 * `account_holder_name` reported all five formats as fine. A refusal that
 * names a field other than phone_number now reports as INCONCLUSIVE, because
 * it means Nuvion never got as far as the thing under test.
 */
type Verdict = 'accepted' | 'rejected' | 'inconclusive';

function verdictFor(raw: any): { v: Verdict; note: string } {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
    if (/phone_number/i.test(text)) {
        return { v: 'rejected', note: 'FORMAT REJECTED — Nuvion named phone_number' };
    }
    // Some other required field is missing, so the payload never reached the
    // phone check. That is a bug in this script, not a result.
    if (/required_field_missing/i.test(text)) {
        const m = text.match(/"([a-z_]+)":\{"type":"error_validation_required_field_missing/);
        return {
            v: 'inconclusive',
            note: `INCONCLUSIVE — refused on ${m?.[1] ?? 'another required field'}, phone never checked`,
        };
    }
    return { v: 'accepted', note: 'format accepted (refusal was about the wallet, not the shape)' };
}

async function main() {
    console.log(CONFIRMED ? 'Running in LIVE mode.\n' : 'Running in DRY RUN mode.\n');
    console.log(`Probing phone_number format on ${CURRENCY} / ${SCHEME} (${COUNTRY}).`);
    console.log('A payment detail is a destination record — no money can move through one.\n');

    for (const f of FORMATS) {
        console.log(`  ${f.id}  ${f.label.padEnd(26)} ${f.value}`);
    }
    console.log('');

    if (!CONFIRMED) {
        console.log('Dry run. Re-run with --confirm to send these requests.');
        return;
    }

    // One counterparty, reused for every format — the counterparty is not what
    // is under test and creating five would just be litter in the dashboard.
    const cp: any = await createCounterparty({
        nickname: STAMP,
        type: 'individual',
        profile: {
            first_name: 'Vyre',
            last_name: `MomoProbe ${Date.now().toString().slice(-6)}`,
            relationship: 'vendor',
            email: `probe+${STAMP.toLowerCase()}@vyre.africa`,
            address: {
                line1: '1 Test Road', city: 'Nairobi',
                state_or_province: 'Nairobi', postal_code: '00100', country: COUNTRY,
            },
        },
    } as any);

    const counterpartyId = cp?.counterparty?.id ?? cp?.id;
    if (!counterpartyId) {
        console.log('Could not create the probe counterparty — nothing else can run.');
        console.log(JSON.stringify(cp, null, 2));
        return;
    }
    console.log(`Probe counterparty ${counterpartyId}\n`);

    const accepted: string[] = [];
    const inconclusive: string[] = [];

    for (const f of FORMATS) {
        const res: any = await createPaymentDetail({
            counterparty_id: counterpartyId,
            currency: CURRENCY,
            payment_method: 'momo-transfer',
            scheme: SCHEME,
            phone_number: f.value,
            // REQUIRED, and its absence invalidated the first run of this
            // script: every probe died on `account_holder_name` before
            // Nuvion ever looked at the phone number, and the verdict logic
            // read "no mention of phone_number" as "format accepted". The
            // payload has to be otherwise COMPLETE or the one field under
            // test is never reached.
            account_holder_name: 'Vyre Probe',
            // ALSO required, and its absence invalidated the SECOND run the
            // same way. Rather than keep finding required fields one re-run at
            // a time, this payload is now exactly what
            // `ensureNuvionCounterpartyAndPaymentDetail` sends on the momo
            // rail — basePayload (payment_method, currency,
            // account_holder_name, counterparty_id, country) plus the momo
            // railPayload (scheme, phone_number) — and nothing more. The
            // production code gets this right already: `bankCountryFor` reads
            // MOMO_RAILS, where every rail carries its own country, so this
            // was only ever a hole in the probe.
            country: COUNTRY,
        } as any);

        if (res?.success) {
            console.log(`  ✅ ${f.id}  ${f.label} — CREATED (${f.value})`);
            accepted.push(f.id);
            continue;
        }

        const v = verdictFor(res?.rawData ?? res?.error ?? res);
        const icon = v.v === 'accepted' ? '🟡' : v.v === 'rejected' ? '❌' : '⚠️ ';
        console.log(`  ${icon} ${f.id}  ${f.label} — ${v.note}`);
        console.log(`        ${JSON.stringify(res?.rawData ?? res?.error ?? res).slice(0, 300)}`);
        if (v.v === 'accepted') accepted.push(f.id);
        if (v.v === 'inconclusive') inconclusive.push(f.id);
    }

    console.log('');
    console.log('════════════════════════════════════════════════════════════════════');
    if (inconclusive.length) {
        console.log(`INCONCLUSIVE for ${inconclusive.join(', ')} — the payload is still`);
        console.log('missing a required field, so Nuvion never validated the phone');
        console.log('number. Add whatever it named above and re-run; this is a bug in');
        console.log('the probe, not a finding about the format.');
        console.log('');
    }
    if (!accepted.length && inconclusive.length === FORMATS.length) {
        // Every probe was inconclusive, so there is no result either way.
        // The previous version printed the INCONCLUSIVE notice and "NONE of
        // the five formats was accepted" one after the other, which reads as
        // a finding about Nuvion when it is only a finding about this script.
        console.log('No format was measured. Fix the payload above and re-run.');
    } else if (!accepted.length) {
        console.log('NONE of the five formats was accepted. Nuvion wants something else —');
        console.log('read the refusals above and add the shape they imply as format F.');
    } else {
        console.log(`Accepted: ${accepted.join(', ')}`);
        console.log('');
        console.log('Set `momoPhoneE164` in QuickSend.vue to build the narrowest accepted');
        console.log('format. If A passed, the current UI is already correct and nothing');
        console.log('needs to change.');
    }
    console.log('');
    console.log(`Note this measured ${CURRENCY}/${SCHEME} only. Ghana and Tanzania are`);
    console.log('separate corridors — change CURRENCY, SCHEME, COUNTRY and DIAL and re-run.');

    console.log(`\nDeactivating probe counterparty ${counterpartyId}...`);
    const d: any = await deactivateCounterparty(counterpartyId);
    console.log(d?.success ? `  ✅ ${counterpartyId}` : `  ⚠️  could not deactivate — remove ${STAMP} by hand`);
    console.log('\nDeactivated, not deleted — Nuvion has no delete. Probe records stay');
    console.log(`visible in the dashboard under the nickname ${STAMP}.`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});