// scripts/test-counterparty-minimal.ts
//
//   npx ts-node --transpile-only -r dotenv/config src/scripts/test-counterparty-minimal.ts
//   npx ts-node --transpile-only -r dotenv/config src/scripts/test-counterparty-minimal.ts --confirm
//
// AIM: find out what Nuvion actually requires on a counterparty, instead of
// trusting our own TypeScript signature.
//
// WHY THIS EXISTS
//   createCounterparty's signature marks BOTH email and the full address as
//   mandatory:
//
//     profile: { first_name, last_name, relationship?, email,
//                address: { line1, city, state_or_province, postal_code, country } }
//
//   That signature records what its author assumed, not what Nuvion enforces.
//
// WHAT THIS ALREADY FOUND — 13 Oct, three runs, country NG
//   Probes A, B and C ALL FAILED. Only D succeeded. Nuvion required BOTH
//   `address` and `email` on a counterparty, NG included. The "address is not
//   required for local currencies" exemption that this script was written to
//   confirm DOES NOT EXIST.
//
//   The minimum address accepted was line1 + city + country. `line1 +
//   country` was refused naming `address.city`; `state_or_province` and
//   `postal_code` were both accepted as absent.
//
// WHY YOU MIGHT BE RUNNING IT AGAIN
//   To find out whether Nuvion has changed since. If A or B passes now, the
//   address can be dropped ENTIRELY for that corridor: add the currency to
//   ADDRESS_EXEMPT_CURRENCIES and stop sending one. That is the only correct
//   way to skip the question — omit the field, never fill it with somebody
//   else's address. A counterparty record is what Nuvion screens and reports
//   on, so a recipient filed at the sender's address is a false statement
//   about a third party, and it buys nothing that omitting does not.
//
//   Read the OUTPUT, not this comment block. Both have been wrong before.
//
// FOUR PROBES, narrowest first:
//   A  no address, no email
//   B  no address, with email
//   C  with address, no email
//   D  with address, with email        (the control — this is what runs today)
//
// Whichever of A–C succeeds is a field the quick-send flow can stop asking
// for. If only D succeeds, the current form is already minimal and we know it
// rather than assuming it.
//
// IT CREATES REAL COUNTERPARTIES at Nuvion. Nothing happens without --confirm,
// and each one created is deactivated again at the end.
//
// No money can move: a counterparty is an identity record. Without a payment
// detail and a transfer there is nothing to send to.

import { createCounterparty, deactivateCounterparty } from '../services/nuvion.service';

const CONFIRMED = process.argv.includes('--confirm');

// Deliberately obvious as a test record, so a leftover is recognisable in
// Nuvion's dashboard.
const STAMP = `VYRETEST-${Date.now()}`;

const NAME = { first_name: 'Vyre', last_name: `Probe ${STAMP.slice(-6)}` };
const EMAIL = `probe+${STAMP.toLowerCase()}@vyre.africa`;
const ADDRESS = {
    line1: '1 Test Road',
    city: 'Lagos',
    state_or_province: 'Lagos',
    postal_code: '100001',
    country: 'NG',
};

const PROBES = [
    { id: 'A', label: 'no address, no email', email: false, address: false },
    { id: 'B', label: 'no address, WITH email', email: true, address: false },
    { id: 'C', label: 'WITH address, no email', email: false, address: true },
    { id: 'D', label: 'WITH address, WITH email  (control — today)', email: true, address: true },
];

async function main() {
    console.log(`Running in ${CONFIRMED ? 'LIVE' : 'DRY RUN'} mode.\n`);
    console.log('Probing what Nuvion requires on POST /counterparties.');
    console.log('A counterparty is an identity record only — no money can move through one.\n');

    if (!CONFIRMED) {
        for (const p of PROBES) {
            console.log(`  ${p.id}  ${p.label}`);
            console.log(`      profile: ${JSON.stringify({
                ...NAME,
                relationship: 'vendor',
                ...(p.email ? { email: EMAIL } : {}),
                ...(p.address ? { address: ADDRESS } : {}),
            })}`);
        }
        console.log('\nDry run. Re-run with --confirm to send these four requests.');
        return;
    }

    const created: string[] = [];
    const results: { id: string; label: string; ok: boolean; detail: string }[] = [];

    for (const p of PROBES) {
        // Cast past our own signature on purpose — the point is to send less
        // than it claims is required.
        const payload: any = {
            type: 'individual',
            nickname: `${STAMP}-${p.id}`,
            profile: {
                ...NAME,
                relationship: 'vendor',
                ...(p.email ? { email: EMAIL } : {}),
                ...(p.address ? { address: ADDRESS } : {}),
            },
        };

        const res = await createCounterparty(payload);

        if (res.success && res.id) {
            created.push(res.id);
            results.push({ id: p.id, label: p.label, ok: true, detail: res.id });
            console.log(`  ✅ ${p.id}  ${p.label}  → created ${res.id}`);
        } else {
            // The validation detail is the useful part: it names the field.
            const detail = JSON.stringify(res.rawData?.validations ?? res.error ?? res.rawData ?? {});
            results.push({ id: p.id, label: p.label, ok: false, detail });
            console.log(`  ❌ ${p.id}  ${p.label}`);
            console.log(`        ${detail}`);
        }
    }

    // ── What it means ───────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(68)}`);
    const ok = (id: string) => results.find((r) => r.id === id)?.ok;

    if (ok('A')) {
        console.log('Neither address NOR email is required.');
        console.log('→ The Naira quick-send path is TWO inputs: bank + account number.');
        console.log('  The name comes from verifyBankAccount. Nothing else is asked.');
    } else if (ok('B')) {
        console.log('Email IS required; address is not.');
        console.log('→ Naira quick-send is bank + account number + email. Three inputs.');
        console.log('  Ask for the email, never fabricate one and never silently reuse');
        console.log("  the sender's — it is the recipient's record.");
    } else if (ok('C')) {
        console.log('Address IS required; email is not. The opposite of what we assumed.');
        console.log('→ Revisit ADDRESS_EXEMPT_CURRENCIES before building on the exemption.');
    } else if (ok('D')) {
        console.log('Both are required, at least for an NG counterparty.');
        console.log('→ The address exemption does NOT hold here. The spec needs correcting');
        console.log('  and the quick-send saving is smaller than planned.');
    } else {
        console.log('All four failed — something unrelated is wrong (auth, entity id, name');
        console.log('format). Read the validation detail above before concluding anything');
        console.log('about required fields.');
    }

    console.log('');
    console.log('Note the country used was NG. If a rail outside the exempt list behaves');
    console.log('differently, re-run with ADDRESS.country changed to US or GB.');

    // ── Clean up ────────────────────────────────────────────────────────
    if (created.length) {
        console.log(`\nDeactivating ${created.length} probe counterparty(ies)...`);
        for (const id of created) {
            const res: any = await deactivateCounterparty(id);
            console.log(`  ${res?.success ? '✅' : '⚠️ '} ${id}${res?.alreadyInactive ? ' (already inactive)' : ''}`);
        }
        console.log('\nDeactivated, not deleted — Nuvion has no delete. They stay visible');
        console.log(`in the dashboard under the nickname prefix ${STAMP}.`);
    }
}

main().catch((err) => {
    console.error('Script crashed:', err);
    process.exitCode = 1;
});