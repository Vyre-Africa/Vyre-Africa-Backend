// scripts/build-fee-table.ts
//
//   npx ts-node --transpile-only -r dotenv/config src/scripts/build-fee-table.ts
//
// Builds the concrete fee table from fees Nuvion has ALREADY charged you.
//
// ── WHY YOU MAY NOT NEED TO TEST EVERY CORRIDOR ─────────────────────────
//
// Nuvion returns `applicable_fee` on the transfer response — both
// same-currency and cross-currency. nuvionpayout.service.ts already reads it,
// refunds the user the difference against the estimate, and writes it to
// `TransferRequest.actualFeeUsd`.
//
// So every completed payout has measured its own corridor. The numbers you
// were about to go and buy are already in the database. This reads them.
//
// What it cannot tell you is a corridor nobody has used yet — those still
// need one real transfer each, or a written fee schedule from Nuvion.
//
// ── WHAT IT CHECKS BEYOND THE AVERAGE ───────────────────────────────────
//
// A single number per rail is only honest if the fee IS a single number. So
// for each rail this reports:
//
//   spread          min and max. A rail that charged $0.04 once and $6.90
//                   another time does not have "a fee" — it has a formula,
//                   and one number would be wrong in both directions.
//   fee ÷ amount    near-constant means the fee is a PERCENTAGE, and a flat
//                   entry in the table will overcharge small transfers and
//                   undercharge large ones.
//   recency         a fee measured in August is not evidence about today.
//
// Read-only. Touches nothing.

import prisma from '../config/prisma.client';
import { feeSchemeFor } from '../services/railRequirements';
import { NUVION_FEE_ESTIMATES_USD } from '../services/nuvionpayout.service';

function line(n = 78) { console.log('─'.repeat(n)); }
const usd = (n: number) => `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.00')}`;

interface Obs { fee: number; amount: number; at: Date; currency: string; id: string }

async function main() {
    line();
    console.log('Fee table, built from what Nuvion has actually charged');
    line();

    const rows: any[] = await prisma.transferRequest.findMany({
        where: { actualFeeUsd: { not: null } } as any,
        orderBy: { createdAt: 'desc' },
        take: 2000,
    });

    if (!rows.length) {
        console.log('\nNo TransferRequest has actualFeeUsd set yet.');
        console.log('Either no payout has completed, or this field predates the');
        console.log('fee-reconciliation code. Nothing to build from — every corridor');
        console.log('would need measuring by hand.\n');
        return;
    }

    console.log(`\n${rows.length} payouts carry a real fee from Nuvion.\n`);

    // Resolve each payout to the RAIL it actually priced off, which is what
    // the table is keyed on — not the currency, since a currency can have
    // several rails at different prices.
    const detailIds = [...new Set(rows.map((r) => r.beneficiaryPaymentDetailId).filter(Boolean))];
    const details = await prisma.beneficiaryPaymentDetail.findMany({
        where: { id: { in: detailIds as string[] } },
    });
    const detailById = new Map(details.map((d: any) => [d.id, d]));

    const byRail = new Map<string, Obs[]>();
    let unresolved = 0;

    for (const r of rows) {
        const d: any = r.beneficiaryPaymentDetailId ? detailById.get(r.beneficiaryPaymentDetailId) : null;
        if (!d) { unresolved++; continue; }

        const rail = feeSchemeFor(d.currency, d.scheme, d.paymentMethod) ?? d.scheme ?? 'unknown';
        const obs: Obs = {
            fee: Number(r.actualFeeUsd),
            amount: Number(r.amount),
            at: r.createdAt,
            currency: d.currency,
            id: r.id,
        };
        if (!byRail.has(rail)) byRail.set(rail, []);
        byRail.get(rail)!.push(obs);
    }

    if (unresolved) {
        console.log(`(${unresolved} payouts could not be matched to a payment detail and were skipped.)\n`);
    }

    const suggestions: Array<{ rail: string; value: number; confident: boolean; why: string }> = [];

    for (const [rail, obs] of [...byRail.entries()].sort((a, b) => b[1].length - a[1].length)) {
        const fees = obs.map((o) => o.fee);
        const min = Math.min(...fees);
        const max = Math.max(...fees);
        const mean = fees.reduce((a, b) => a + b, 0) / fees.length;
        const distinct = [...new Set(fees.map((f) => f.toFixed(4)))];
        const newest = obs[0].at;
        const ageDays = Math.floor((Date.now() - newest.getTime()) / 86400000);

        // Flat or proportional? If fee ÷ amount is near-constant while the fee
        // itself is not, the rail charges a percentage and no single number
        // can represent it.
        const ratios = obs.filter((o) => o.amount > 0).map((o) => o.fee / o.amount);
        const rMin = ratios.length ? Math.min(...ratios) : 0;
        const rMax = ratios.length ? Math.max(...ratios) : 0;
        const feeVaries = max - min > 0.01;
        const ratioStable = ratios.length > 1 && rMax - rMin < 0.002;

        line();
        console.log(`${rail}   ${obs.length} observation${obs.length === 1 ? '' : 's'}   (${[...new Set(obs.map((o) => o.currency))].join(', ')})`);
        line();
        console.log(`  table says      ${usd(NUVION_FEE_ESTIMATES_USD[rail] ?? NUVION_FEE_ESTIMATES_USD.default)}${rail in NUVION_FEE_ESTIMATES_USD ? '' : '   (falls through to default)'}`);
        console.log(`  actually paid   ${usd(min)}${min === max ? '' : ` to ${usd(max)}`}   mean ${usd(mean)}`);
        console.log(`  distinct values ${distinct.length <= 6 ? distinct.map((d) => usd(Number(d))).join(', ') : `${distinct.length} different values`}`);
        console.log(`  most recent     ${ageDays} day${ageDays === 1 ? '' : 's'} ago`);

        let value = mean;
        let confident = true;
        let why = '';

        if (!feeVaries) {
            value = max;
            why = 'flat — every observation agreed';
            console.log(`  → FLAT at ${usd(max)}. Safe to put in the table.`);
        } else if (ratioStable) {
            const pct = ((rMin + rMax) / 2) * 100;
            value = max;
            confident = false;
            why = `PERCENTAGE ≈ ${pct.toFixed(3)}% — a flat entry will be wrong`;
            console.log(`  → ⚠️  PROPORTIONAL, about ${pct.toFixed(3)}% of the amount.`);
            console.log('     A single number cannot represent this. It will overcharge small');
            console.log('     transfers and undercharge large ones. The table needs a percentage');
            console.log('     for this rail, not a constant.');
        } else {
            value = max;
            confident = false;
            why = 'varies with no stable ratio — needs more observations';
            console.log(`  → ⚠️  VARIES (${usd(min)}–${usd(max)}) with no stable ratio.`);
            console.log('     Neither flat nor a clean percentage. Use the MAX as a ceiling');
            console.log('     until there are more observations — undercharging is absorbed');
            console.log('     by Vyre, overcharging is refunded to the user.');
        }

        if (ageDays > 60) {
            confident = false;
            console.log(`  → ⚠️  Newest observation is ${ageDays} days old. Prices change.`);
        }

        suggestions.push({ rail, value, confident, why });
    }

    // ── What is still unmeasured ────────────────────────────────────────
    const measured = new Set(byRail.keys());
    const tableRails = Object.keys(NUVION_FEE_ESTIMATES_USD).filter((k) => k !== 'default');
    const neverUsed = tableRails.filter((r) => !measured.has(r));

    line();
    console.log('STILL UNMEASURED');
    line();
    if (neverUsed.length) {
        console.log(`  ${neverUsed.join(', ')}`);
        console.log('');
        console.log('  No payout has ever gone through these, so nothing here can price');
        console.log('  them. Each needs one real transfer — or one written fee schedule');
        console.log('  from Nuvion, which settles all of them at once and costs nothing.');
    } else {
        console.log('  None — every rail in the table has at least one real observation.');
    }

    // ── Paste-ready ─────────────────────────────────────────────────────
    line();
    console.log('SUGGESTED TABLE');
    line();
    console.log('');
    console.log('export const NUVION_FEE_ESTIMATES_USD: Record<string, number> = {');
    for (const s of suggestions.sort((a, b) => a.rail.localeCompare(b.rail))) {
        const pad = `${s.rail}:`.padEnd(18);
        console.log(`    ${pad}${String(s.value)},${' '.repeat(Math.max(1, 8 - String(s.value).length))}// ${s.confident ? 'MEASURED' : '⚠️'} ${s.why}`);
    }
    for (const r of neverUsed) {
        const pad = `${r}:`.padEnd(18);
        console.log(`    ${pad}${NUVION_FEE_ESTIMATES_USD[r]},${' '.repeat(Math.max(1, 8 - String(NUVION_FEE_ESTIMATES_USD[r]).length))}// ⚠️ UNMEASURED — never used`);
    }
    console.log(`    default:          ${NUVION_FEE_ESTIMATES_USD.default},       // ceiling for anything unlisted`);
    console.log('};');
    console.log('');
    console.log('And set NUVION_FEE_CONFIRMED true only for the rails marked MEASURED.');
    console.log('');
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); });