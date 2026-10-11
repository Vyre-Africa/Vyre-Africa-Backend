// scripts/test-webhook-flow.ts
//
//   npx ts-node --transpile-only -r dotenv/config src/scripts/test-webhook-flow.ts
//
// AIM: prove the whole webhook-driven half of the replenishment works, against
// the REAL server, the REAL database and the REAL queue, without moving any
// crypto and without a customer transfer.
//
// It POSTs synthetic payloads to your own /webhook/nuvion endpoint, waits for
// the worker, then asserts what landed in the database. So it exercises the
// controller, the dedup check, the queue, the worker case, and every branch of
// handleNuvionEvent, exactly as a real Nuvion delivery would.
//
// WHAT IS REAL AND WHAT IS NOT
//   real: the HTTP endpoint, dedup, BullMQ, the handlers, Postgres
//   fake: the payload bodies, and the TransferRequest rows they refer to
//   NOT COVERED: the on-chain send (blockchain_Transfer). That cannot be
//     faked, and is what test-replenishment-send.ts is for.
//
// Payload shapes are the REAL ones captured on 8 Oct for inflows.completed.
// outflows.completed and outflows.failed have never been seen, so those are
// constructed from the fields the handler reads, and marked below.
//
// SAFE TO RUN: every row it creates is prefixed TESTWH- and deleted at the end.
// Pass --keep to leave them for inspection.

import prisma from '../config/prisma.client';
import config from '../config/env.config';
import axios from 'axios';
import eventService from '../services/event.service';
import { STABLECOIN_TREASURY, resolveTreasury, thresholdFor } from '../config/nuvionTreasury.config';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:3000';
const WEBHOOK_PATH = process.env.TEST_WEBHOOK_PATH ?? '/api/v1/webhook/nuvion';
const KEEP = process.argv.includes('--keep');

// --in-process calls handleNuvionEvent directly instead of going over HTTP.
// Needs no running server and no worker, and is synchronous, so there is
// nothing to wait for.
//
// The trade: it skips the controller and the dedup check, so test 2 (the same
// webhook twice) cannot pass in this mode and is reported as skipped. Use HTTP
// for the real run; use this to get the other six green quickly.
const IN_PROCESS = process.argv.includes('--in-process');

// How long to wait for the worker after each POST. The handler does a handful
// of queries plus, for a deposit, one Nuvion call.
const SETTLE_MS = Number(process.env.TEST_SETTLE_MS ?? 4000);

// Enum columns the fixture cannot invent. A placeholder string is rejected by
// Postgres, so a real member is needed. The resolver below reads them out of
// the generated Prisma client at runtime, which works without this map; set an
// entry only to force a particular member (or if the resolver cannot find the
// enum, in which case it prints the exact line to add here).
const ENUM_OVERRIDE: Record<string, string> = {
    // 'VirtualTransaction.type': 'TRANSFER',
};

const tag = `TESTWH-${Date.now()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, IN_PROCESS ? 0 : ms));

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`   ${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n        ${detail}`}`);
};

async function post(payload: any) {
    if (IN_PROCESS) {
        // Same shape the worker hands to the handler.
        await eventService.handleNuvionEvent({
            eventType: payload.event,
            data: payload.data,
            rawBody: payload,
        });
        return { status: 200, data: { received: true } } as any;
    }
    try {
        return await axios.post(`${BASE_URL}${WEBHOOK_PATH}`, payload, {
            validateStatus: () => true, // any HTTP status is a result, not a throw
            timeout: 15000,
        });
    } catch (err: any) {
        // A socket-level failure never reaches validateStatus, so it has to be
        // caught here or it surfaces as a stack trace instead of a message.
        if (['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT'].includes(err?.code)) {
            console.error(`\n❌ Could not reach ${BASE_URL}${WEBHOOK_PATH} (${err.code}).`);
            console.error('   The server has to be RUNNING: this harness drives it over HTTP,');
            console.error('   so the controller, the dedup check and the worker are all exercised.');
            console.error('');
            console.error('   Start it in another terminal, then re-run. If it listens somewhere else:');
            console.error('     TEST_BASE_URL=http://localhost:8080 npx ts-node ... test-webhook-flow.ts');
            console.error('     TEST_WEBHOOK_PATH=/webhook/nuvion npx ts-node ... test-webhook-flow.ts');
            console.error('');
            console.error('   The port is whatever your server logs at boot, or PORT in .env.');
            process.exit(1);
        }
        throw err;
    }
}

// ── Payload builders ────────────────────────────────────────────────────

// CONSTRUCTED, not captured. We have never seen a real outflows.completed.
// Built from exactly the fields the handler reads: id, unique_reference,
// applicable_fee, status_reason.
const outflowCompleted = (uniqueReference: string, fee = 0) => ({
    event: 'outflows.completed',
    data: {
        id: `${tag}-OUT-${Math.random().toString(36).slice(2, 8)}`,
        unique_reference: uniqueReference,
        status: 'successful',
        type: 'outflow',
        applicable_fee: fee, // minor units
        currency: 'USD',
    },
});

const outflowFailed = (uniqueReference: string, reason = 'insufficient_funds') => ({
    event: 'outflows.failed',
    data: {
        id: `${tag}-OUT-${Math.random().toString(36).slice(2, 8)}`,
        unique_reference: uniqueReference,
        status: 'failed',
        status_reason: reason,
        type: 'outflow',
        currency: 'USD',
    },
});

// REAL shape, captured 8 Oct. amount is in MINOR units; the chain hash is in
// meta.provider_reference, NOT unique_reference.
const inflowCompleted = (o: { accountId: string; amountMinor: number; txHash?: string | null; eventId?: string }) => ({
    event: 'inflows.completed',
    data: {
        id: o.eventId ?? `${tag}-IN-${Math.random().toString(36).slice(2, 8)}`,
        amount: o.amountMinor,
        currency: 'USC',
        unique_reference: Math.random().toString(16).slice(2).padEnd(64, '0'),
        counterparty_id: `acct-${o.accountId}`,
        account_id: o.accountId,
        entity_id: config.NUVION_ENTITY_ID,
        status: 'successful',
        status_reason: 'payment_aml_evaluation_approved',
        narration: 'Transaction from 0xb45f7163acb6f3191799f5f6a0401ca01e1743f0',
        type: 'inflow',
        payment_type: 'stablecoin-transfer',
        applicable_fee: 3,
        meta: { provider_reference: o.txHash ?? null },
        account: { meta: { asset_type: 'stablecoin', network: 'base' }, id: o.accountId, display_name: 'Master-Base' },
        created: Date.now(),
        updated: Date.now(),
    },
});

// ── Fixtures ────────────────────────────────────────────────────────────
// A TransferRequest + VirtualTransaction shaped exactly as blockCryptoPayout
// leaves them, so outflows.completed takes the same path a real payout does.
//
// NOTE: no VirtualAccount block is created, so completeGlobalPayoutBlock will
// fail for these. That is intentional and expected: this harness tests the
// REPLENISHMENT branch, which runs after. The handler logs the block problem
// and continues. Anything that depends on the block itself is out of scope.

async function makePayout(o: { amount: string; fee: string; cryptoCurrencyId: string; usdTreasuryId: string }) {
    const key = `${tag}-${Math.random().toString(36).slice(2, 8)}`;
    const usdCurrency = await prisma.currency.findFirst({ where: { ISO: 'USD' } });

    const tr = await createWithLearning('transferRequest', {
            idempotencyKey: key,
            type: 'CRYPTO',
            currencyId: usdCurrency!.id,
            amount: o.amount,
            estimatedFeeUsd: o.fee,
            actualFeeUsd: o.fee,
            userId: config.Admin_Id,
        status: 'PROCESSING', // the state outflows.completed expects
    }, 'TransferRequest');

    const total = String(Number(o.amount) + Number(o.fee) + 2);
    await createWithLearning('virtualTransaction', {
        reference: key,
        // the full frozen total, as blockCryptoPayout writes it
        amount: total,
        netAmount: total,
        currency: 'USD',
        metadata: {
            payoutProvider: 'NUVION',
            treasuryAccountId: o.usdTreasuryId,
            cryptoCurrencyId: o.cryptoCurrencyId,
            sendAmount: o.amount,
            estimatedNuvionFee: Number(o.fee),
            vyreFee: 2,
        },
    }, 'VirtualTransaction');

    return { transferRequestId: tr.id, uniqueReference: key };
}

// Prisma generates every enum as a runtime object as well as a type, so the
// members can be read without knowing the schema. Which module holds it varies
// by client version and by a custom generator output path, so each likely one
// is tried. Returns the members in declaration order.
function enumMembers(enumName: string): string[] {
    const candidates = ['@prisma/client', '../../prisma/generated/client', '../generated/prisma', '../generated/client'];
    for (const mod of candidates) {
        try {
            const m: any = require(mod);
            const found = m?.[enumName] ?? m?.Prisma?.[enumName] ?? m?.$Enums?.[enumName];
            if (found && typeof found === 'object') {
                const values = Object.values(found).filter((v) => typeof v === 'string') as string[];
                if (values.length) return values;
            }
        } catch {
            // module not present at that path; try the next
        }
    }
    return [];
}

// Picks a member for a column. Preference is by name so the fixture reads
// sensibly (a payout row should not be typed DEPOSIT), but any member lets the
// row be created, which is all the harness needs.
function pickEnumValue(label: string, column: string, enumName: string): string {
    const forced = ENUM_OVERRIDE[`${label}.${column}`];
    if (forced) return forced;

    const members = enumMembers(enumName);
    if (!members.length) {
        throw new Error(
            `Column ${label}.${column} is the enum ${enumName}, and this script could not find that enum in the ` +
            `generated Prisma client to read its members.\n` +
            `Add one line near the top of this file and re-run:\n` +
            `    const ENUM_OVERRIDE = { '${label}.${column}': '<a real ${enumName} member>' };`
        );
    }

    const prefer = ['TRANSFER', 'WITHDRAW', 'DEBIT', 'PAYOUT', 'PENDING', 'SUCCESS'];
    for (const want of prefer) {
        const hit = members.find((m) => m.toUpperCase().includes(want));
        if (hit) return hit;
    }
    return members[0];
}

// Creates a row, learning the model's required columns from Prisma itself.
//
// VirtualTransaction has required fields this harness has no opinion about
// (amount, netAmount, currency, and whatever else), and discovering them one
// failed run at a time is slow. Prisma.dmmf would list them, but it is not
// exposed on every client version, so this does not rely on it: it attempts
// the create, reads the missing column and its type out of the validation
// error, fills a neutral value, and tries again.
//
// Prisma's message looks like:
//     Argument `currency` is missing.
// and the rendered payload above it shows the type:
//     +   currency: String
//
// Only scalars can be invented. A required relation will run out of attempts
// and report plainly, because a foreign key cannot be guessed.
async function createWithLearning(
    model: 'virtualTransaction' | 'transferRequest',
    data: Record<string, any>,
    label: string,
): Promise<any> {
    const filled: string[] = [];

    for (let attempt = 0; attempt < 15; attempt++) {
        try {
            return await (prisma as any)[model].create({ data: data as any });
        } catch (err: any) {
            const msg = String(err?.message ?? '');

            // A placeholder that turned out to be an enum. Prisma says:
            //     Invalid value for argument `type`. Expected TransactionType.
            // Replace it with a real member rather than giving up.
            const badEnum = /Invalid value for argument `(\w+)`\. Expected (\w+)\./.exec(msg);
            if (badEnum) {
                const [, column, enumName] = badEnum;
                const value = pickEnumValue(label, column, enumName);
                data[column] = value;
                filled.push(`${column}:${enumName}=${value}`);
                console.log(`   (fixture: ${label}.${column} is ${enumName}, using ${value})`);
                continue;
            }

            const name = /Argument `(\w+)` is missing/.exec(msg)?.[1];
            if (!name) {
                // Not a missing column. Most likely one that was filled with a
                // placeholder is a relation or has a constrained type, so say
                // what had been filled rather than leaving a bare Prisma error.
                if (filled.length) {
                    throw new Error(
                        `Building the ${label} fixture failed after filling ${filled.join(', ')}.\n` +
                        `The fixture can only invent plain scalars, so a relation or a constrained column needs a real value.\n\n${msg}`
                    );
                }
                throw err;
            }

            // the type is on the "+   name: Type" line of the rendered payload
            const type = new RegExp(`\\+\\s+${name}: (\\w+)`).exec(msg)?.[1] ?? 'String';

            switch (type) {
                case 'Int': case 'Float': case 'Decimal': case 'BigInt': data[name] = 0; break;
                case 'Boolean': data[name] = false; break;
                case 'DateTime': data[name] = new Date(); break;
                case 'Json': data[name] = {}; break;
                case 'String': data[name] = `fixture-${name}`; break;
                default:
                    // Anything else is a relation or an enum. Prisma renders a
                    // relation as `...CreateNestedOneWithout...Input`, which
                    // cannot be invented; a bare name is an enum.
                    if (/Input$/.test(type)) {
                        throw new Error(
                            `${label}.${name} is a required RELATION (${type}). A foreign key cannot be invented, ` +
                            `so this fixture needs a real row. Filled so far: ${filled.join(', ') || 'none'}.`
                        );
                    }
                    data[name] = pickEnumValue(label, name, type);
                    console.log(`   (fixture: ${label}.${name} is ${type}, using ${data[name]})`);
                    break;
            }
            filled.push(`${name}:${type}`);
        }
    }

    throw new Error(
        `Could not build a ${label} fixture after 15 attempts. Filled so far: ${filled.join(', ')}. ` +
        'The next missing column is probably a required RELATION, which cannot be invented.'
    );
}

const repl = (transferRequestId: string) =>
    prisma.treasuryReplenishment.findUnique({ where: { transferRequestId } });

// ── The run ─────────────────────────────────────────────────────────────

async function main() {
    console.log(IN_PROCESS
        ? 'Calling handleNuvionEvent directly (--in-process: no server or worker needed)'
        : `Posting to ${BASE_URL}${WEBHOOK_PATH}`);
    console.log(`Rows tagged ${tag}${KEEP ? ' (--keep: they will be left behind)' : ''}\n`);

    if (!IN_PROCESS) {
        // Reachability first, so a wrong URL is not reported as a logic failure.
        const ping = await post({ event: 'accounts.updated', data: { id: `${tag}-PING` } });
        if (ping.status !== 200) {
            console.error(`❌ The endpoint answered ${ping.status}. Check TEST_BASE_URL and TEST_WEBHOOK_PATH.`);
            process.exit(1);
        }
        console.log('Endpoint reachable.\n');
    }

    const usdTreasury = await prisma.nuvionTreasuryAccount.findFirst({ where: { currency: 'USD', isActive: true } });
    if (!usdTreasury) {
        console.error('❌ No active USD treasury row.');
        process.exit(1);
    }

    // The crypto currency and the stablecoin treasury have to be the SAME pair,
    // and that pair has to be in STABLECOIN_TREASURY. Picking each separately
    // gives something like USDT-on-TRON with a UST-on-sol treasury, which fails
    // for a reason that has nothing to do with what is being tested.
    let cryptoCurrency: any = null;
    let stablecoin: any = null;

    for (const key of Object.keys(STABLECOIN_TREASURY)) {
        const [iso, chain] = key.split(':');
        const candidates = await prisma.currency.findMany({ where: { ISO: iso } });
        const currency = candidates.find((c: any) => String(c.chain ?? '').toUpperCase().startsWith(chain.slice(0, 4)));
        if (!currency) continue;

        const target = await resolveTreasury(iso, currency.chain);
        if (!target.ok || !target.treasuryRowId) continue;

        cryptoCurrency = currency;
        stablecoin = await prisma.nuvionTreasuryAccount.findUnique({ where: { id: target.treasuryRowId } });
        break;
    }

    if (!cryptoCurrency || !stablecoin) {
        console.error('❌ No usable pair. Every entry in STABLECOIN_TREASURY needs:');
        console.error('     a Currency record with that ISO and chain, and');
        console.error('     a NuvionTreasuryAccount row the map resolves to (active, with a walletAddress).');
        console.error('');
        console.error(`   Map entries: ${Object.keys(STABLECOIN_TREASURY).join(', ') || '(empty)'}`);
        for (const key of Object.keys(STABLECOIN_TREASURY)) {
            const [iso, chain] = key.split(':');
            const target = await resolveTreasury(iso, chain);
            console.error(`     ${key}: ${target.ok ? 'resolves' : target.reason}`);
        }
        process.exit(1);
    }

    console.log(`USD treasury   ${usdTreasury.id}`);
    console.log(`Stablecoin     ${stablecoin.id} (${stablecoin.currency} on ${stablecoin.chain}, ${stablecoin.nuvionAccountId})`);
    console.log(`Crypto         ${cryptoCurrency.ISO} on ${cryptoCurrency.chain} (${cryptoCurrency.id})`);
    console.log(`Threshold      ${thresholdFor(cryptoCurrency.chain)} on ${cryptoCurrency.chain}\n`);

    // ─────────────────────────────────────────────────────────────
    console.log('1. A payout completes, ABOVE the threshold');
    console.log('   Testing: outflows.completed calls scheduleReplenishmentForPayout,');
    console.log('   the map resolves, and a request is created and queued.');
    const threshold = thresholdFor(cryptoCurrency.chain);
    const bigAmount = String(threshold * 5);        // comfortably above
    const bigFee = '5';
    const big = await makePayout({ amount: bigAmount, fee: bigFee, cryptoCurrencyId: cryptoCurrency.id, usdTreasuryId: usdTreasury.id });
    await post(outflowCompleted(big.uniqueReference, Number(bigFee) * 100));
    await sleep(SETTLE_MS);
    const r1 = await repl(big.transferRequestId);
    check('a replenishment row exists', !!r1, 'nothing was created: is scheduleReplenishmentForPayout wired into outflows.completed?');
    check('its status is PENDING', r1?.status === 'PENDING', `got ${r1?.status}`);
    const expectBig = String(Number(bigAmount) + Number(bigFee));
    check(`the amount is send + actual fee (${expectBig})`, String(r1?.amount) === expectBig, `got ${r1?.amount}`);
    check('it is aimed at the right stablecoin treasury', (r1?.payload as any)?.treasuryAccountId === stablecoin.id, JSON.stringify(r1?.payload));
    check('it has a wallet address to send to', !!(r1?.payload as any)?.treasuryWalletAddress);
    console.log('');

    // ─────────────────────────────────────────────────────────────
    console.log('2. The SAME webhook delivered twice');
    console.log('   Testing: the controller dedup stops the second from doing anything.');
    if (IN_PROCESS) {
        console.log('   ⏭  skipped: dedup lives in the controller, which --in-process bypasses.');
    } else {
        const dupPayload = outflowCompleted(big.uniqueReference, 500);
        const d1 = await post(dupPayload);
        const d2 = await post(dupPayload);
        await sleep(SETTLE_MS);
        check('the second delivery is reported as a duplicate', d2.data?.duplicate === true, JSON.stringify({ first: d1.data, second: d2.data }));
        const all = await prisma.treasuryReplenishment.findMany({ where: { transferRequestId: big.transferRequestId } });
        check('still exactly ONE replenishment row', all.length === 1, `got ${all.length}`);
    }
    console.log('');

    // ─────────────────────────────────────────────────────────────
    console.log('3. A payout completes, BELOW the threshold');
    console.log('   Testing: no request is created, and the amount goes on');
    console.log('   pendingManualTopupUsd instead so nothing is unaccounted for.');
    const beforeCounter = Number((await prisma.nuvionTreasuryAccount.findUnique({ where: { id: usdTreasury.id } }))?.pendingManualTopupUsd ?? 0);
    const smallAmount = String(Math.max(1, Math.floor(threshold / 10)));
    const smallFee = '1';
    const small = await makePayout({ amount: smallAmount, fee: smallFee, cryptoCurrencyId: cryptoCurrency.id, usdTreasuryId: usdTreasury.id });
    await post(outflowCompleted(small.uniqueReference, Number(smallFee) * 100));
    await sleep(SETTLE_MS);
    const r3 = await repl(small.transferRequestId);
    const afterCounter = Number((await prisma.nuvionTreasuryAccount.findUnique({ where: { id: usdTreasury.id } }))?.pendingManualTopupUsd ?? 0);
    check('NO replenishment row was created', !r3, `got status ${r3?.status}`);
    const expectSmall = Number(smallAmount) + Number(smallFee);
    check(`the counter went up by ${expectSmall}`, Math.abs(afterCounter - beforeCounter - expectSmall) < 0.01, `${beforeCounter} -> ${afterCounter}`);
    console.log('');

    // ─────────────────────────────────────────────────────────────
    console.log('4. A payout whose metadata has no cryptoCurrencyId');
    console.log('   Testing: old payouts (created before that field existed) are');
    console.log('   flagged rather than silently skipped.');
    const legacyKey = `${tag}-LEGACY`;
    const usdCurrency = await prisma.currency.findFirst({ where: { ISO: 'USD' } });
    const legacy = await createWithLearning('transferRequest', {
        idempotencyKey: legacyKey, type: 'CRYPTO', currencyId: usdCurrency!.id, amount: bigAmount,
        estimatedFeeUsd: '5', userId: config.Admin_Id, status: 'PROCESSING',
    }, 'TransferRequest');
    await createWithLearning('virtualTransaction', {
        reference: legacyKey, amount: '207', netAmount: '207', currency: 'USD',
        metadata: { payoutProvider: 'NUVION', treasuryAccountId: usdTreasury.id, sendAmount: bigAmount, estimatedNuvionFee: 5 },
    }, 'VirtualTransaction');
    await post(outflowCompleted(legacyKey, 500));
    await sleep(SETTLE_MS);
    const r4 = await repl(legacy.id);
    check('it is recorded as FAILED, not ignored', r4?.status === 'FAILED', `got ${r4?.status}`);
    check('the note says what was missing', /crypto currency/i.test(r4?.note ?? ''), r4?.note ?? '');
    console.log('');

    // ─────────────────────────────────────────────────────────────
    console.log('5. A deposit arrives for a waiting replenishment');
    console.log('   Testing: inflows.completed maps the payload, matches it by');
    console.log('   hash, and queues the conversion.');
    const hash = `0x${tag.replace(/[^a-f0-9]/gi, '').padEnd(64, '0').slice(0, 64)}`;
    await prisma.treasuryReplenishment.update({
        where: { transferRequestId: big.transferRequestId },
        data: { status: 'SUBMITTED', txRef: hash, sentAt: new Date(), nuvionCurrency: 'USC' },
    });
    await post(inflowCompleted({ accountId: stablecoin.nuvionAccountId, amountMinor: Number(expectBig) * 100, txHash: hash }));
    await sleep(SETTLE_MS + 3000); // this one also makes a Nuvion call
    const r5 = await repl(big.transferRequestId);
    check('the deposit was matched', ['DEPOSITED', 'CONVERTING', 'CONVERTED', 'CONVERT_RETRY', 'CONVERT_FAILED', 'CONVERT_UNVERIFIED'].includes(r5?.status ?? ''), `got ${r5?.status}`);
    check(`the amount was read as ${expectBig}, not ${Number(expectBig) * 100}`, String(r5?.depositedAmount) === expectBig, `got ${r5?.depositedAmount} — minor units not converted?`);
    check('the deposit event id was recorded', !!r5?.depositEventId);
    if (r5?.status === 'CONVERTED') console.log('   (it converted too: the USD treasury is whole)');
    else console.log(`   (status ${r5?.status} — fine here, the conversion is the live-tested step)`);
    console.log('');

    // ─────────────────────────────────────────────────────────────
    console.log('6. A deposit with NOTHING waiting for it');
    console.log('   Testing: a manual top-up is ignored quietly, with no alert.');
    const before6 = await prisma.treasuryReplenishment.count();
    const res6 = await post(inflowCompleted({ accountId: stablecoin.nuvionAccountId, amountMinor: 999900, txHash: null }));
    await sleep(SETTLE_MS);
    check('the webhook was accepted', res6.status === 200);
    check('no replenishment row was touched or created', (await prisma.treasuryReplenishment.count()) === before6);
    console.log('   (check the logs: it should say "not a tracked..." or log quietly, NOT raise an alert)');
    console.log('');

    // ─────────────────────────────────────────────────────────────
    console.log('7. A payout FAILS after submission');
    console.log('   Testing: the failed branch releases funds, re-syncs the');
    console.log('   treasury float, and never creates a replenishment.');
    const doomed = await makePayout({ amount: bigAmount, fee: bigFee, cryptoCurrencyId: cryptoCurrency.id, usdTreasuryId: usdTreasury.id });
    await post(outflowFailed(doomed.uniqueReference));
    await sleep(SETTLE_MS + 2000);
    const tr7 = await prisma.transferRequest.findUnique({ where: { id: doomed.transferRequestId } });
    const r7 = await repl(doomed.transferRequestId);
    check('the payout is FAILED', tr7?.status === 'FAILED', `got ${tr7?.status}`);
    check('NO replenishment was created for it', !r7, `got ${r7?.status}`);
    console.log('   (check the logs for "re-synced after a failed payout")');
    console.log('');

    // ─────────────────────────────────────────────────────────────
    console.log(`\n${pass} passed, ${fail} failed`);

    if (!KEEP) {
        console.log('\nCleaning up...');
        const keys = { startsWith: tag };
        const trs = await prisma.transferRequest.findMany({ where: { idempotencyKey: keys }, select: { id: true } });
        await prisma.treasuryReplenishment.deleteMany({ where: { transferRequestId: { in: trs.map((t: { id: string }) => t.id) } } });
        await prisma.virtualTransaction.deleteMany({ where: { reference: keys } });
        await prisma.transferRequest.deleteMany({ where: { idempotencyKey: keys } });
        await prisma.nuvionWebhookEvent.deleteMany({ where: { eventId: { contains: tag } } });
        await prisma.nuvionDepositEvent.deleteMany({ where: { id: { contains: tag } } });
        console.log(`Removed everything tagged ${tag}.`);
        console.log('NOTE: pendingManualTopupUsd was incremented by test 3 and is NOT reset. Adjust it if the figure matters.');
    }

    process.exit(fail ? 1 : 0);
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });