// scripts/test-quick-send-flow.ts
//
//   npx ts-node --transpile-only -r dotenv/config src/scripts/test-quick-send-flow.ts
//   npx ts-node --transpile-only -r dotenv/config src/scripts/test-quick-send-flow.ts --confirm
//   npx ts-node --transpile-only -r dotenv/config src/scripts/test-quick-send-flow.ts --confirm --user <userId>
//   npx ts-node --transpile-only -r dotenv/config src/scripts/test-quick-send-flow.ts --confirm --keep
//
//   # with a real account, so stage 2 can do a real name enquiry:
//   ... --confirm --account 0012345678 --bankname "Kuda Microfinance Bank"
//   ... --confirm --account 0012345678 --bankname "GTBank" --bank 058
//
// AIM: run the Quick Send chain the way it will actually run, and find out
// where it breaks — rather than reasoning about whether it will.
//
//   0  PREFLIGHT   schema, env, Nuvion bank list          read-only
//   1  PARSE       a realistic paste → fields              read-only, 1 OpenAI call
//   2  VERIFY      the bank's own name for that account    read-only
//   3  DEDUPE      the exact query the match route runs    read-only
//   4  CREATE      beneficiary + payment detail rows       WRITE (--confirm)
//   5  NUVION      counterparty + payment detail           WRITE at Nuvion (--confirm)
//   6  GUARD       would blockCryptoPayout let this send?   read-only
//
// NO MONEY MOVES. Stage 5 is the furthest it goes, and a counterparty plus a
// payment detail is an identity record plus an address book entry — without a
// transfer there is nothing to send to. blockCryptoPayout is deliberately NOT
// called: it freezes user funds, and the one thing it would tell us that
// stage 5 does not is already checked arithmetically in stage 6.
//
// STAGE 5 IS THE POINT OF THIS SCRIPT. Everything before it we can reason
// about. Whether Nuvion accepts a counterparty with no address block on a
// Naira rail is the single assumption the whole quick-send saving rests on,
// and it is the one thing that can only be settled by asking Nuvion.
//
// Cleanup runs in `finally`, so a crash mid-run still deactivates the Nuvion
// counterparty and removes the local rows. `--keep` skips it when you want to
// go and look at what it made.

import fs from 'fs';
import path from 'path';
import prisma from '../config/prisma.client';
import config from '../config/env.config';

import { parseRecipient, nubanCheckDigitValid, addressRequiredFor } from '../services/recipientparse.service';

const CONFIRMED = process.argv.includes('--confirm');
const KEEP = process.argv.includes('--keep');
const USER_INDEX = process.argv.indexOf('--user');
const USER_ID = USER_INDEX > -1 ? process.argv[USER_INDEX + 1] : (config as any).Admin_Id;

// ── The fixture ─────────────────────────────────────────────────────────
// A WhatsApp-shaped paste, which is how details actually arrive. The account
// number is NUBAN-VALID for bank code 058 (GTBank) — computed, not invented.
// A round number like 0123456789 fails its check digit, which would make a
// later stage fail for a reason that has nothing to do with the flow.
//
// DO NOT "tidy" this number. Stage 0 re-checks it and will tell you off.
//
// BUT IT IS STILL AN INVENTED ACCOUNT. It passes the checksum; it almost
// certainly does not exist at GTBank. So stage 2 — which now calls
// Flutterwave for real — will refuse it, and that refusal says nothing about
// the flow.
//
// To make stage 2 meaningful, point it at an account you are happy to resolve:
//
//   --account 0012345678 --bankname "Kuda Microfinance Bank"
//   --account 0012345678 --bankname "GTBank" --bank 058
//
// A name enquiry is a read. It returns the account holder's name, which is
// the one piece of personal data it touches, so use your own account or a
// business account rather than a stranger's.
const argAfter = (flag: string): string | null => {
    const i = process.argv.indexOf(flag);
    return i > -1 ? process.argv[i + 1] ?? null : null;
};

const REAL_ACCOUNT = argAfter('--account');
const REAL_BANKNAME = argAfter('--bankname');
const REAL_BANKCODE = argAfter('--bank');
const USING_REAL = Boolean(REAL_ACCOUNT && REAL_BANKNAME);

const PASTE = USING_REAL
    ? `Good morning 🙏
please send to
${REAL_BANKNAME}
${REAL_ACCOUNT}
Ade Okafor
thank you`
    : `Good morning 🙏
please send to
GTBank
0115063566
Ade Okafor
thank you`;

// With a real account the bank code is only asserted if you supplied one —
// otherwise it is reported and left to you to eyeball, since the whole point
// is that the parser resolved it from the name.
const EXPECT: { currency: string; bankCode: string | null; accountNumber: string } = USING_REAL
    ? { currency: 'NGN', bankCode: REAL_BANKCODE, accountNumber: REAL_ACCOUNT! }
    : { currency: 'NGN', bankCode: '058', accountNumber: '0115063566' };

// Everything this run created, so cleanup knows what is ours. Nothing else is
// ever touched.
const created = {
    beneficiaryId: null as string | null,
    paymentDetailId: null as string | null,
    nuvionCounterpartyId: null as string | null,
    // Stage 5b creates a few probe counterparties on purpose. Every one is
    // deactivated in cleanup.
    probeCounterparties: [] as string[],
};

// ── Stage bookkeeping ───────────────────────────────────────────────────
type Verdict = 'PASS' | 'FAIL' | 'SKIP' | 'INFO';

// What Nuvion actually said, so stage 6 cannot speak for a stage that did not
// run. The first --confirm run printed "Nuvion is fine with it (stage 5)"
// while stage 5 had failed to even find the function — a harness asserting
// something it had not measured, which is the one thing a harness must never
// do.
let nuvionVerdict: 'accepted' | 'refused' | 'not tested' = 'not tested';

// Set when the dedupe found the account already saved. Stages 4–5c are then
// skipped ON PURPOSE, and the summary must say so rather than claiming Nuvion
// was never reached — which is a different thing with a different fix.
let reusedExisting = false;
const results: { stage: string; verdict: Verdict; note: string }[] = [];

function record(stage: string, verdict: Verdict, note: string) {
    results.push({ stage, verdict, note });
    const icon = { PASS: '✅', FAIL: '❌', SKIP: '⏭️ ', INFO: 'ℹ️ ' }[verdict];
    console.log(`  ${icon} ${note}`);
}

function header(n: number | string, title: string) {
    console.log(`\n${'─'.repeat(72)}`);
    console.log(`STAGE ${n} — ${title}`);
}

// Prisma's messages begin with a newline, which made the first run print
// "the lookup threw:" with nothing after it — the one error that mattered,
// swallowed by my own formatting.
function firstLine(e: any): string {
    const msg = String(e?.message ?? e ?? 'unknown');
    return msg.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? 'unknown';
}

// ONE definition of the dedupe query, used by both the preflight and stage 3.
// In the first run they were written separately: the preflight probed the
// WHERE clause, passed, and stage 3 then died on the SELECT. A preflight that
// is not the same query is not a preflight.
function dedupeQuery(accountNumber: string, bankCode?: string, currency = 'NGN') {
    return {
        where: {
            currency,
            beneficiary: { userId: USER_ID },
            OR: bankCode ? [{ accountNumber, bankCode }] : [{ accountNumber }],
        },
        orderBy: { createdAt: 'desc' as const },
        select: { id: true, beneficiaryId: true, accountName: true },
    };
}

// Some symbols I am guessing the location of. A wrong guess should name
// itself, not take the whole run down with it.
function tryRequire(modulePath: string, symbol: string): any | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(modulePath);

        if (typeof mod?.[symbol] === 'function') return mod[symbol];

        // BIND IT. `export default new SomeService()` means the symbol is a
        // METHOD, and pulling it off the instance by name loses `this`.
        //
        // This cost two wrong diagnoses. Called unbound under ts-node's
        // CommonJS output, `this` falls back to globalThis rather than
        // throwing, so `this.flw` was quietly undefined and the error read
        // "Cannot read properties of undefined (reading 'Misc')" — which I
        // reported as "the Flutterwave keys are not configured". Then the
        // hardened version failed with "this.unavailable is not a function",
        // which is the same bug finally naming itself.
        const owner = mod?.default;
        if (owner && typeof owner[symbol] === 'function') return owner[symbol].bind(owner);

        return mod?.[symbol] ?? owner?.[symbol] ?? null;
    } catch {
        return null;
    }
}

// ── Stop guessing where things live ─────────────────────────────────────
// Two runs were spent guessing module paths: verifyBankAccount missed ten
// candidates, then ensureNuvionCounterpartyAndPaymentDetail missed its one.
// Guessing does not converge. Searching does — the source tree is right here.
//
// Walks src/, finds the file that DECLARES the symbol, requires that file.
const SRC_ROOT = path.resolve(__dirname, '..');

function walkTs(dir: string, out: string[] = []): string[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        if (e.name === 'node_modules' || e.name === 'scripts' || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walkTs(full, out);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(full);
    }
    return out;
}

let TS_FILES: string[] | null = null;

// ONE shape, not a union.
//
// This was `{ fn: any; at: string } | { fn: null; mentions: string[] }`, which
// reads nicely and does not narrow: `if (!found.fn) return;` tells TypeScript
// nothing, because `fn: any` is not a discriminant it can test for falsiness.
// So `found.at` afterwards was an error on the null branch — invisible under
// ts-node --transpile-only and a hard stop for `tsc --watch`, which is how it
// turned up: as a broken dev build rather than a failing script.
//
// Optional fields instead. `at` is `string | undefined`, which is true either
// way and needs no narrowing.
interface FoundFunction {
    fn: any | null;
    at?: string;
    /** every file that mentioned the name, when none of them declared it */
    mentions?: string[];
}

// Returns the function plus where it was found, or null plus every file that
// mentioned the name — which is a useful answer in itself.
//
// excludeControllers matters: a controller takes (req, res) and calling one
// from a script produces a misleading error about req.body rather than an
// answer. Asking for a service function and getting a controller is itself
// the finding — that the logic has no reusable form.
function findFunction(
    names: string[],
    opts: { excludeControllers?: boolean } = {},
): FoundFunction {
    if (!TS_FILES) TS_FILES = walkTs(SRC_ROOT);

    const files = opts.excludeControllers
        ? TS_FILES.filter((f) => !/controller/i.test(path.basename(f)) && !/[\/\\]controllers[\/\\]/.test(f))
        : TS_FILES;

    const mentions: string[] = [];

    for (const name of names) {
        // A declaration, not a call: `export const x =`, `function x(`,
        // `async x(` (a class method), or `x:` on an exported object.
        const declares = new RegExp(
            `(export\\s+(const|let|var|async\\s+function|function)\\s+${name}\\b)` +
            `|(^\\s*(public\\s+|private\\s+)?(async\\s+)?${name}\\s*\\()` +
            `|(^\\s*${name}\\s*[:=]\\s*(async\\s*)?\\()`,
            'm',
        );

        for (const file of files) {
            let src = '';
            try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
            if (!src.includes(name)) continue;
            mentions.push(path.relative(SRC_ROOT, file));
            if (!declares.test(src)) continue;

            const fn = tryRequire(file, name);
            if (typeof fn === 'function') {
                return { fn, at: `${name} in ${path.relative(SRC_ROOT, file)}` };
            }
            // Declared but not reachable as a named export — most often a
            // class method. Try the default export's prototype.
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const mod = require(file);
                const inst = mod?.default;
                if (inst && typeof inst[name] === 'function') {
                    return { fn: inst[name].bind(inst), at: `${name} on the default export of ${path.relative(SRC_ROOT, file)}` };
                }
            } catch { /* keep looking */ }
        }
    }

    return { fn: null, mentions: [...new Set(mentions)] };
}

// ═══════════════════════════════════════════════════════════════════════
// STAGE 0 — preflight
// ═══════════════════════════════════════════════════════════════════════
async function stage0() {
    header(0, 'preflight');

    // The fixture, before it can mislead a later stage.
    if (USING_REAL) {
        record('0.fixture', 'INFO',
            `using the account you passed (${EXPECT.accountNumber} at "${REAL_BANKNAME}") instead of the ` +
            'built-in fixture, so stage 2 can do a real name enquiry');
    }

    if (!EXPECT.bankCode) {
        record('0.fixture', 'INFO',
            'no --bank given, so the bank code is reported rather than asserted — resolving it from the ' +
            'name is the thing being tested anyway');
    } else if (nubanCheckDigitValid(EXPECT.bankCode, EXPECT.accountNumber)) {
        record('0.fixture', 'PASS', `account ${EXPECT.accountNumber} is NUBAN-valid for ${EXPECT.bankCode}`);
    } else {
        record('0.fixture', USING_REAL ? 'INFO' : 'FAIL',
            `account ${EXPECT.accountNumber} FAILS the NUBAN check digit for bank ${EXPECT.bankCode}. ` +
            (USING_REAL
                ? 'Either the bank code is not the one that account belongs to, or a digit is off. ' +
                  'Worth knowing before Flutterwave tells you the same thing.'
                : 'Someone has edited the built-in fixture. Later stages will report false failures ' +
                  'until it is put back.'));
    }

    if (!USER_ID) {
        record('0.user', 'FAIL', 'No user id. Pass --user <id>, or set Admin_Id in config.');
        return false;
    }
    const user = await prisma.user.findUnique({ where: { id: USER_ID }, select: { id: true, email: true } });
    if (!user) {
        record('0.user', 'FAIL', `No user with id ${USER_ID}`);
        return false;
    }
    record('0.user', 'PASS', `acting as ${user.email ?? user.id}`);

    // THE SCHEMA QUESTION, and the reason it is stage 0 rather than stage 3:
    // the match route reads accountNumber / bankCode / iban as real columns on
    // BeneficiaryPaymentDetail, inferred from the addPaymentMethod payload.
    // If they live inside a JSON column instead, dedupe silently never
    // matches and every paste creates a new recipient.
    try {
        // The EXACT query the match route runs, with a throwaway account.
        await prisma.beneficiaryPaymentDetail.findFirst(dedupeQuery('0000000000', '000') as any);
        record('0.schema', 'PASS', 'the dedupe query is valid against your schema — accountNumber / bankCode / accountName all exist');
    } catch (e: any) {
        record('0.schema', 'FAIL',
            'the dedupe query is INVALID against your schema, so /transfers/quick-send/match will ' +
            'always answer "no match" and every paste will create a duplicate recipient. ' +
            `Prisma said: ${firstLine(e)}`);
    }

    if (process.env.OPENAI_API_KEY) {
        record('0.openai', 'PASS', `OPENAI_API_KEY set, model ${process.env.OPENAI_PARSE_MODEL ?? 'gpt-4o-mini'}`);
    } else {
        record('0.openai', 'INFO', 'OPENAI_API_KEY not set — stage 1 will come back degraded, which is itself worth seeing');
    }

    // The exemption this whole flow is built on, printed so a changed list is
    // visible rather than assumed.
    // FLIPPED after the 13 Oct measurement. This used to assert NGN was
    // exempt; Nuvion says otherwise, so now the test fails if anyone puts a
    // currency back on that list without a measurement to justify it.
    const ngnNeedsAddress = addressRequiredFor('NGN');
    record('0.exemption', ngnNeedsAddress ? 'PASS' : 'FAIL',
        ngnNeedsAddress
            ? "addressRequiredFor('NGN') = true, matching what Nuvion actually enforces"
            : "addressRequiredFor('NGN') = false — ADDRESS_EXEMPT_CURRENCIES still contains NGN. " +
              'Live Nuvion refuses an NG counterparty with no address block, so every payout to a NEW ' +
              'Naira beneficiary fails at createCounterparty. Empty that list.');

    const getBankCodes = tryRequire('../services/nuvion.service', 'getBankCodes');
    if (!getBankCodes) {
        record('0.banks', 'FAIL', 'getBankCodes is not exported from services/nuvion.service — fix the import path in this script');
    } else {
        const res = await getBankCodes('NG');
        if (res?.success && res.banks?.length) {
            record('0.banks', 'PASS', `Nuvion returned ${res.banks.length} Nigerian banks`);
        } else {
            record('0.banks', 'FAIL', `could not load the NG bank list: ${res?.error ?? 'no banks returned'} — stage 1 cannot resolve a bank code without it`);
        }
    }

    return true;
}

// ═══════════════════════════════════════════════════════════════════════
// STAGE 1 — parse
// ═══════════════════════════════════════════════════════════════════════
async function stage1() {
    header(1, 'parse the paste');

    const t0 = Date.now();
    const result = await parseRecipient(PASTE);
    const ms = Date.now() - t0;

    if (result.degraded) {
        record('1.parse', 'SKIP', `degraded after ${ms}ms — the model could not be reached. The UI falls back to manual entry, which is correct, but this run tested nothing downstream of the parse.`);
        return result;
    }

    record('1.latency', ms < 10000 ? 'PASS' : 'INFO', `took ${ms}ms (a user is watching a spinner for this)`);

    const checks: [string, boolean, string][] = [
        ['currency', result.currency === EXPECT.currency, `currency ${result.currency} (want ${EXPECT.currency})`],
        EXPECT.bankCode
            ? ['bankCode', result.fields.bankCode === EXPECT.bankCode, `bankCode ${result.fields.bankCode ?? 'none'} (want ${EXPECT.bankCode})`] as [string, boolean, string]
            : ['bankCode', Boolean(result.fields.bankCode), `bankCode resolved to ${result.fields.bankCode ?? 'NOTHING — check the bank name you passed'}`] as [string, boolean, string],
        ['accountNumber', result.fields.accountNumber === EXPECT.accountNumber, `accountNumber ${result.fields.accountNumber ?? 'none'}`],
        ['method', result.paymentMethod === 'bank-transfer', `paymentMethod ${result.paymentMethod}`],
        ['address', result.addressRequired === true, `addressRequired ${result.addressRequired} (measured: NGN DOES need one)`],
    ];
    for (const [k, ok, note] of checks) record(`1.${k}`, ok ? 'PASS' : 'FAIL', note);

    // The checksum against the bank code the PARSER resolved, not the one the
    // fixture expected. On the last run no --bank was given, so stage 0 had
    // nothing to check and an invented account number sailed through to
    // Nuvion, which rejected it at createPaymentDetail. Checking it here,
    // against whatever was resolved, catches it four stages earlier.
    const code = result.fields.bankCode;
    const acct = result.fields.accountNumber;
    if (result.currency === 'NGN' && code && acct) {
        if (/^\d{3}$/.test(code)) {
            const ok = nubanCheckDigitValid(code, acct);
            record('1.nuban', ok ? 'PASS' : 'FAIL',
                ok
                    ? `${acct} passes the NUBAN check digit for bank ${code}`
                    : `${acct} FAILS the NUBAN check digit for bank ${code}. Either the account number ` +
                      'is wrong or it belongs to a different bank — and Nuvion validates the pair too, ' +
                      'so this will be refused at createPaymentDetail in stage 5.');
        } else {
            // Microfinance banks carry 6-digit codes and NUBAN's 3-digit
            // algorithm does not apply, so there is no local check available.
            record('1.nuban', 'INFO',
                `bank code ${code} is ${code.length} digits, so the NUBAN check digit does not apply ` +
                '(it is defined for 3-digit commercial bank codes). Nothing locally verifies this ' +
                'account number — Nuvion is the first thing that will.');
        }
    }

    // The guard is the safety property, so a fabrication is a failure of the
    // run even when every field above is right.
    const fabricated = result.warnings.filter((w) => /not in the pasted text/i.test(w));
    record('1.fabrication', 'INFO',
        fabricated.length
            ? `${fabricated.length} invented value(s) caught and dropped: ${fabricated.join('; ')}`
            : 'no invented values');

    if (result.unmatchedText.length) {
        record('1.ignored', 'INFO', `ignored: ${result.unmatchedText.join(' · ')} (the review screen shows these)`);
    }

    // What the PASTE covered on its own. The address and email still have to
    // be asked for — that is Nuvion's requirement, not a parser failure — so
    // this measures the part Quick Send actually saves.
    const asked = result.missing.filter((m) => m !== 'email');
    record('1.fromPaste', asked.length === 0 ? 'PASS' : 'INFO',
        asked.length === 0
            ? 'bank, account number and name all came out of the paste — the fiddly part is done'
            : `the paste did not cover: ${asked.join(', ')}`);

    return result;
}

// ═══════════════════════════════════════════════════════════════════════
// STAGE 2 — the bank's own answer
// ═══════════════════════════════════════════════════════════════════════
async function stage2(bankCode?: string, accountNumber?: string) {
    header(2, "the bank's name for that account");

    if (!bankCode || !accountNumber) {
        record('2.verify', 'SKIP', 'no bankCode/accountNumber from stage 1');
        return null;
    }

    // CORRECTED. The verify route is user.controller.verifyAccountDetail, and
    // reading it settles two things I had wrong:
    //
    //   1. It accepts `bankCode` directly — there is an explicit branch for it,
    //      added for the global-payout flow, that skips the local Bank table
    //      entirely. The composable posting { bankCode, accountNumber } is
    //      CORRECT. My "it wants bankId" conclusion came from calling the
    //      controller with a plain object, so `req.body` was undefined and the
    //      destructuring threw. That error was my script's, not a contract
    //      mismatch.
    //   2. The provider is flutterwaveService.resolveAccount(bankCode,
    //      accountNumber) — a real name-enquiry service, and one that is
    //      callable from here, unlike the controller.
    //
    // So this stage now tests the thing that actually runs.
    const localNgCount = await prisma.bank.count({ where: { country: 'NG' } });
    record('2.bankTable', 'INFO',
        `the local Bank table holds ${localNgCount} NG rows. Irrelevant to THIS path — the bankCode ` +
        'branch never touches it — but the bankId branch, used by the domestic transfer flow, cannot ' +
        'resolve any Nigerian bank while it is empty.');

    const found = findFunction(['resolveAccount'], { excludeControllers: true });
    if (!found.fn) {
        record('2.verify', 'SKIP',
            'flutterwaveService.resolveAccount not reachable from here. The route still works in the ' +
            'app; this stage just cannot exercise it.');
        return null;
    }
    record('2.found', 'INFO', `using ${found.at}`);

    try {
        const res = await found.fn(bankCode, accountNumber);

        if (res?.status === 'unavailable') {
            record('2.verify', 'FAIL',
                `verification is UNAVAILABLE, not refused: ${res?.message}. That is an infra problem — ` +
                'most likely FLW_PUBLIC_KEY / FLW_SECRET_KEY are not set in this environment. The ' +
                'controller must answer 503 for this, never 400, or a user is told their correct ' +
                'account number is wrong.');
            return null;
        }

        if (res?.status !== 'success') {
            record('2.verify', 'FAIL',
                `Flutterwave did not resolve the account: ${JSON.stringify(res ?? {}).slice(0, 300)}. ` +
                'The controller turns this into a 400 "wrong account details", so the review screen ' +
                'falls back to the pasted name and warns. Note the fixture account is invented, so a ' +
                'refusal here may simply mean the built-in fixture account does not exist. Re-run with ' +
                '--account <number> --bankname "<bank>" to test this stage properly.');
            return null;
        }

        const name = res?.data?.account_name ?? null;
        record('2.verify', 'PASS', `Flutterwave says "${name}"`);

        // The field names matter: Flutterwave answers snake_case
        // (account_name), the controller re-wraps it as camelCase
        // (data.accountName). A composable reading the wrong one gets a
        // silent null and no verified name ever appears.
        record('2.shape', 'INFO',
            'Flutterwave returns data.account_name; the controller re-emits it as data.accountName. ' +
            'useQuickSend must read res.data.accountName — it read the snake_case form at first and ' +
            'would have found nothing on every call.');

        // The paste always carries "Ade Okafor" as the name, so with a real
        // account this SHOULD differ — and that difference is the feature:
        // the screen shows the bank's version and says the pasted one was
        // different.
        const same = String(name).replace(/[^a-z]/gi, '').toLowerCase() === 'adeokafor';
        record('2.mismatch', 'INFO', same
            ? 'matches the pasted name'
            : `differs from the pasted "Ade Okafor" — exactly the case the review screen exists for: ` +
              `it shows "${name}" as the headline and states that the paste said something else`);
        return name;
    } catch (e: any) {
        record('2.verify', 'INFO', `resolveAccount threw: ${firstLine(e)}. Degrades to the pasted name.`);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// STAGE 3 — dedupe
// ═══════════════════════════════════════════════════════════════════════
async function stage3(bankCode?: string, accountNumber?: string) {
    header(3, 'have we paid this account before?');

    if (!accountNumber) {
        record('3.dedupe', 'SKIP', 'nothing to look up');
        return null;
    }

    try {
        // CORRECTED after the first run: Beneficiary has no `accountName`
        // column, so the name comes off the payment detail — which is the
        // better source anyway, being the name on the account rather than a
        // label on the person.
        const hit = await prisma.beneficiaryPaymentDetail.findFirst(dedupeQuery(accountNumber, bankCode) as any);

        if (hit) {
            record('3.dedupe', 'PASS',
                `already saved as "${hit.accountName}" (beneficiary ${hit.beneficiaryId}) — ` +
                'the flow reuses this instead of creating a second copy');
            return { beneficiaryId: hit.beneficiaryId, paymentDetailId: hit.id };
        }

        record('3.dedupe', 'PASS', 'no existing match — a new recipient would be created');
        return null;
    } catch (e: any) {
        record('3.dedupe', 'FAIL', `the lookup threw: ${firstLine(e)}`);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// STAGE 4 — create the local rows
//
// REWRITTEN after the first run. My version wrote `accountName`, `email` and
// `country` onto Beneficiary. None of the three is a column. The real fields
// are: userId, ISO, chain, type, bank, crypto, nuvionCounterpartyId,
// nuvionRecipientCountry, nuvionRecipientEmail, nuvionRecipientAddressLine1 /
// City / State / Postal, userData. The name and email the UI shows are
// assembled by the API — most likely out of `bank`.
//
// So instead of guessing the shape of `bank`, this stage LEARNS it from one
// of the user's existing recipients and fills the same keys with our values.
// Same trick as the webhook harness, and for the same reason: a schema I
// infer is a schema I get wrong.
// ═══════════════════════════════════════════════════════════════════════

// Fill a template's KEYS with our values. Never copies the template's data —
// an unmapped key comes out null, so a leftover row can never carry somebody
// else's account number.
//
// MEASURED, and it changed this function: the live `bank` JSON holds exactly
// ONE key, `accountName`. My first version then bolted on accountNumber,
// bankCode, bankName, email and country "because a missing key is silent data
// loss" — which would have written a second copy of the account number into a
// place nothing reads. Two sources of truth for an account number is how you
// end up paying the stale one.
//
// So: when a real template exists, its keys are the whole shape and nothing is
// added. The guessed extras only apply when there is no template to learn
// from, where an extra key is better than a missing one.
function shapeFrom(template: any, values: Record<string, any>) {
    const hasTemplate = template && typeof template === 'object' && Object.keys(template).length > 0;
    if (!hasTemplate) return values;

    const out: Record<string, any> = {};
    for (const key of Object.keys(template)) {
        const match = Object.keys(values).find((v) => v.toLowerCase() === key.toLowerCase());
        out[key] = match ? values[match] : null;
    }
    return out;
}

async function stage4(fields: any, accountName: string) {
    header(4, 'create the recipient (local rows)');

    const email = `quicksend-test+${Date.now()}@vyre.africa`;

    // Learn the JSON shapes from a real row of this user's.
    const template: any = await prisma.beneficiary.findFirst({
        where: { userId: USER_ID, type: 'BANK' as any },
        orderBy: { createdAt: 'desc' },
        include: { paymentDetails: { take: 1, orderBy: { createdAt: 'desc' } } },
    });

    if (template) {
        const keys = Object.keys(template.bank ?? {});
        record('4.template', 'INFO',
            `learning the shape from beneficiary ${template.id} — bank keys: ` +
            `[${keys.join(', ') || 'bank is empty or not an object'}]`);
        // Where each piece of a recipient actually lives, now that we know:
        //   name    → bank.accountName
        //   email   → nuvionRecipientEmail   (NOT in bank)
        //   country → nuvionRecipientCountry (NOT in bank)
        //   account → the payment detail, and only there
        if (keys.length === 1 && keys[0] === 'accountName') {
            record('4.shape', 'INFO',
                'bank holds the name and nothing else — so the account number lives on the payment ' +
                'detail only, which is the right way round. Writing it in both places would create a ' +
                'second source of truth.');
        }
    } else {
        record('4.template', 'INFO',
            'this user has no existing BANK recipient to learn from, so `bank` is built from the ' +
            'names the frontend posts. If the create below fails on a column, that column is the answer.');
    }

    const bankJson = shapeFrom(template?.bank, {
        accountName,
        accountNumber: fields.accountNumber,
        bankCode: fields.bankCode,
        bankName: fields.bankName ?? fields.bankNameRaw,
        email,
        country: 'NG',
    });

    // CHANGED after the 13 Oct measurement. This used to write NO address at
    // all, to prove the exemption worked. Nuvion refused, so writing none now
    // only reproduces a failure we already understand.
    //
    // A full address makes stage 5 a test of the REAL production path:
    // a counterparty created with a complete address block, through the same
    // function every live payout uses. It is also the only way to exercise the
    // postal-code column fix, since the broken version dropped the key
    // silently rather than erroring.
    //
    // Obvious test data, and the row is deleted in cleanup either way.
    const beneficiaryData: any = {
        userId: USER_ID,
        type: 'BANK',
        ISO: 'NGN',
        bank: bankJson,
        nuvionRecipientCountry: 'NG',
        nuvionRecipientEmail: email,
        nuvionRecipientAddressLine1: '12 Allen Avenue, Ikeja',
        nuvionRecipientAddressCity: 'Lagos',
        nuvionRecipientAddressState: 'Lagos',
        // Postal, not PostalCode. Reading it the wrong way is what sent every
        // counterparty out with no postal code at all.
        nuvionRecipientAddressPostal: '100271',
    };

    const detailData: any = {
        currency: 'NGN',
        paymentMethod: 'bank-transfer',
        bankCode: fields.bankCode,
        bankName: fields.bankName ?? fields.bankNameRaw,
        accountNumber: fields.accountNumber,
        accountName,
    };

    if (!CONFIRMED) {
        record('4.create', 'SKIP', 'dry run — re-run with --confirm to write these rows');
        console.log('      beneficiary:    ' + JSON.stringify(beneficiaryData));
        console.log('      paymentDetail:  ' + JSON.stringify(detailData));
        console.log('      NOTE a FULL address, because Nuvion was measured to require one. Stage 5 now');
        console.log('           tests the real production path rather than the withdrawn exemption.');
        return null;
    }

    try {
        const beneficiary = await prisma.beneficiary.create({ data: beneficiaryData });
        created.beneficiaryId = beneficiary.id;
        record('4.beneficiary', 'PASS', `created beneficiary ${beneficiary.id} with a full address`);

        const detail = await prisma.beneficiaryPaymentDetail.create({
            data: { ...detailData, beneficiaryId: beneficiary.id },
        });
        created.paymentDetailId = detail.id;
        record('4.paymentDetail', 'PASS', `created payment detail ${detail.id}`);

        return { beneficiary, detail };
    } catch (e: any) {
        record('4.create', 'FAIL',
            `could not create the rows: ${firstLine(e)}. ` +
            'A named missing column here is also a column the quick-send POST body has to carry, ' +
            'so this message is the spec for that payload.');
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// STAGE 5 — Nuvion. The one that actually settles the question.
// ═══════════════════════════════════════════════════════════════════════
async function stage5(beneficiary: any, detail: any) {
    header(5, 'Nuvion counterparty + payment detail, with no address');

    if (!CONFIRMED) {
        record('5.nuvion', 'SKIP', 'dry run — this is the stage worth running. Re-run with --confirm.');
        return;
    }
    if (!beneficiary || !detail) {
        record('5.nuvion', 'SKIP', 'stage 4 produced nothing to send');
        return;
    }

    const found = findFunction([
        'ensureNuvionCounterpartyAndPaymentDetail',
        'ensureCounterpartyAndPaymentDetail',
        'ensureNuvionCounterparty',
    ]);

    if (!found.fn) {
        const mentions = found.mentions ?? [];
        record('5.nuvion', 'FAIL',
            'could not reach ensureNuvionCounterpartyAndPaymentDetail. ' +
            (mentions.length
                ? `It is mentioned in: ${mentions.slice(0, 6).join(', ')} — most likely a module-private ` +
                  'function inside the payout file, not exported. Export it (it has no side effects of its ' +
                  'own worth hiding) and re-run.'
                : 'Nothing in src/ declares it under that name.') +
            ' Until this stage runs, the address exemption is STILL AN ASSUMPTION.');
        return;
    }
    record('5.found', 'INFO', `using ${found.at}`);
    const ensure = found.fn;

    try {
        const res = await ensure(beneficiary, detail);

        // Beneficiary HAS a nuvionCounterpartyId column (measured), so read
        // the id back off the row instead of guessing the return shape. This
        // also proves the id was persisted — if it was not, every later
        // payout to this recipient creates another counterparty.
        const row: any = await prisma.beneficiary.findUnique({ where: { id: beneficiary.id } });
        const counterpartyId = row?.nuvionCounterpartyId
            ?? res?.counterpartyId ?? res?.counterparty_id ?? res?.id ?? null;
        if (counterpartyId) created.nuvionCounterpartyId = counterpartyId;

        record('5.persisted', row?.nuvionCounterpartyId ? 'PASS' : 'FAIL',
            row?.nuvionCounterpartyId
                ? `counterparty id stored on the beneficiary row (${row.nuvionCounterpartyId})`
                : 'the counterparty was created but nuvionCounterpartyId was NOT written back — ' +
                  'every payout to this recipient would create a fresh counterparty at Nuvion');

        nuvionVerdict = 'accepted';
        record('5.nuvion', 'PASS',
            'the real production path works end to end: counterparty created with a full address block ' +
            `through ensureNuvionCounterpartyAndPaymentDetail. counterparty ${counterpartyId ?? '(id not returned)'}. ` +
            'Read 5c below for whether the postal code it sent was actually required.');
        record('5.returned', 'INFO', JSON.stringify(res).slice(0, 300));
    } catch (e: any) {
        nuvionVerdict = 'refused';

        // ensureNuvionCounterpartyAndPaymentDetail throws
        //   Object.assign(new Error(msg), { rawData: paymentDetail.rawData })
        // so the validation array is ON THE ERROR and my first version threw
        // it away, printing only "Validation failed for one or more fields" —
        // the exact unhelpful sentence this script exists to get past.
        const validations = e?.rawData?.validations ?? e?.response?.data?.validations ?? null;
        const detailText = validations
            ? JSON.stringify(validations)
            : e?.response?.data
                ? JSON.stringify(e.response.data)
                : firstLine(e);

        // Which of the two calls failed changes what to look at entirely.
        const atPaymentDetail = /payment detail/i.test(String(e?.message ?? ''));
        if (atPaymentDetail) {
            record('5.nuvion', 'FAIL',
                'the COUNTERPARTY was created fine — this failed at createPaymentDetail, which is about ' +
                'the ACCOUNT, not the person. The usual cause is an account number Nuvion will not ' +
                'accept for that bank code: it validates the pair, so an invented NUBAN fails here even ' +
                `though our own checksum passed or was skipped. Nuvion said: ${detailText}`);
        } else {
            record('5.nuvion', 'FAIL',
                'the COUNTERPARTY itself was refused, carrying a full address. Check in this order: ' +
                '(1) postal_code named → the column fix is not deployed (nuvionRecipientAddressPostal, ' +
                'not ...PostalCode); (2) address named → addressRequiredFor returned false, so ' +
                'ADDRESS_EXEMPT_CURRENCIES still has NGN; (3) anything else is new. ' +
                `Nuvion said: ${detailText}`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// STAGE 5b — WHICH FIELD did Nuvion object to?
//
// "Validation failed for one or more fields" names no field, and the service
// wrapper swallows the detail (the log line came out as
// "Nuvion call failed [createCounterparty]: " with nothing after the colon).
// So ask Nuvion the same question three ways and let the pattern answer it.
//
// This is test-counterparty-minimal.ts, inline, using the real name and email
// from this run:
//
//   B  no address, with email     ← what quick send wants to send
//   C  with address, no email
//   D  with address, with email   ← the control: what production sends today
//
// Whichever succeeds names the required field. If D also fails, the problem is
// not address or email at all and the exemption is not what is broken.
// ═══════════════════════════════════════════════════════════════════════
async function stage5b(accountName: string): Promise<Record<string, boolean>> {
    header('5b', 'which field is Nuvion rejecting? (regression check)');

    const found = findFunction(['createCounterparty'], { excludeControllers: true });
    if (!found.fn) {
        record('5b.probe', 'SKIP', 'createCounterparty not reachable — run test-counterparty-minimal.ts instead');
        return {};
    }
    const createCounterparty = found.fn;

    const [first, ...rest] = accountName.split(/\s+/);
    const NAME = { first_name: first || 'Vyre', last_name: rest.join(' ') || 'Probe' };
    const STAMP = `VYRETEST-${Date.now()}`;
    const EMAIL = `probe+${STAMP.toLowerCase()}@vyre.africa`;
    const ADDRESS = {
        line1: '1 Test Road', city: 'Lagos', state_or_province: 'Lagos',
        postal_code: '100001', country: 'NG',
    };

    const PROBES = [
        { id: 'B', label: 'no address, WITH email   (what quick send sends)', email: true, address: false },
        { id: 'C', label: 'WITH address, no email', email: false, address: true },
        { id: 'D', label: 'WITH address, WITH email (production today)', email: true, address: true },
    ];

    const outcome: Record<string, boolean> = {};

    for (const p of PROBES) {
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

        try {
            const res = await createCounterparty(payload);
            if (res?.success && res?.id) {
                outcome[p.id] = true;
                created.probeCounterparties.push(res.id);
                record(`5b.${p.id}`, 'PASS', `${p.label} → accepted (${res.id})`);
            } else {
                outcome[p.id] = false;
                // THE VALIDATION DETAIL IS THE WHOLE POINT. Print everything
                // the wrapper kept hold of, because the message alone said
                // nothing useful.
                const detail = JSON.stringify(
                    res?.rawData?.validations ?? res?.rawData ?? res?.error ?? res ?? {},
                ).slice(0, 600);
                // Same reasoning as 5c: B and C are MEANT to be refused. Only
                // D, the control, failing would be a real problem.
                record(`5b.${p.id}`, p.id === 'D' ? 'FAIL' : 'INFO', `${p.label} → refused: ${detail}`);
            }
        } catch (e: any) {
            outcome[p.id] = false;
            const detail = e?.response?.data
                ? JSON.stringify(e.response.data).slice(0, 600)
                : firstLine(e);
            record(`5b.${p.id}`, p.id === 'D' ? 'FAIL' : 'INFO', `${p.label} → threw: ${detail}`);
        }
    }

    // ── What the pattern means ──────────────────────────────────────────
    console.log('');
    if (outcome.B) {
        record('5b.verdict', 'PASS',
            'Address is NOT required and email IS enough — so the exemption holds and stage 5 failed for ' +
            'some OTHER reason in ensureNuvionCounterpartyAndPaymentDetail. Compare the payload it builds ' +
            'against probe B: the difference is the bug.');
    } else if (outcome.D && !outcome.B) {
        record('5b.verdict', 'PASS',
            'as expected: address and email are both required on an NG counterparty. This now ' +
            'CONFIRMS the 13 Oct measurement rather than discovering it — 5c says how much address, ' +
            'and the answer so far is line1 + city only.');
    } else if (outcome.D && outcome.C && !outcome.B) {
        record('5b.verdict', 'FAIL', 'address required, email optional — the opposite of what the spec assumed');
    } else if (!outcome.D) {
        record('5b.verdict', 'INFO',
            'EVEN THE CONTROL FAILED. Production sends exactly probe D, so this is not about address or ' +
            'email — look at auth, the entity id, the name format, or `type: individual`. Read the ' +
            'validation detail on D above; nothing about the exemption can be concluded from this run.');
    }

    return outcome;
}

// ═══════════════════════════════════════════════════════════════════════
// STAGE 5c — HOW MUCH address does Nuvion actually need?
//
// MEASURED 13 Oct: Nuvion requires both `address` and `email` on an NG
// individual counterparty. It returned one error for the whole `address`
// object, so WHICH sub-fields it insists on is still unknown — and that
// difference is the entire remaining saving. Four fields a sender does not
// know is a dead flow; one line is a question they can answer.
//
// It also asks whether a different counterparty `type` has lighter
// requirements, because that would be the clean answer rather than a
// workaround.
//
// NOTE ON WHAT THIS DOES NOT TEST: whether Nuvion would accept a placeholder
// or the sender's own address in place of the recipient's. That is not a
// technical question. Nuvion requires the field, and it is the kind of field a
// payment provider screens and reports on — so filling it with something we
// invented is misrepresentation to a regulated counterparty, whatever their
// validation does or does not catch. If the recipient's real address cannot be
// collected, the question goes to Nuvion in writing: "what do you expect in
// `profile.address` for a domestic NGN payout where the sender does not hold
// the beneficiary's address?" Their answer is the design. Not ours to guess.
// ═══════════════════════════════════════════════════════════════════════
async function stage5c(accountName: string) {
    header('5c', 'how much address does Nuvion need?');

    const found = findFunction(['createCounterparty'], { excludeControllers: true });
    if (!found.fn) {
        record('5c.probe', 'SKIP', 'createCounterparty not reachable');
        return;
    }
    const createCounterparty = found.fn;

    const [first, ...rest] = accountName.split(/\s+/);
    const NAME = { first_name: first || 'Vyre', last_name: rest.join(' ') || 'Probe' };
    const STAMP = `VYRESHAPE-${Date.now()}`;
    const EMAIL = `probe+${STAMP.toLowerCase()}@vyre.africa`;

    const SHAPES = [
        { id: 'L1', label: 'line1 + country only', address: { line1: '12 Allen Avenue, Ikeja', country: 'NG' } },
        { id: 'L2', label: '+ city', address: { line1: '12 Allen Avenue, Ikeja', city: 'Lagos', country: 'NG' } },
        { id: 'L3', label: '+ state', address: { line1: '12 Allen Avenue, Ikeja', city: 'Lagos', state_or_province: 'Lagos', country: 'NG' } },
        { id: 'L4', label: 'full, incl. postal code (control)', address: { line1: '12 Allen Avenue, Ikeja', city: 'Lagos', state_or_province: 'Lagos', postal_code: '100271', country: 'NG' } },
    ];

    let minimal: string | null = null;

    for (const shape of SHAPES) {
        try {
            const res = await createCounterparty({
                type: 'individual',
                nickname: `${STAMP}-${shape.id}`,
                profile: { ...NAME, relationship: 'vendor', email: EMAIL, address: shape.address },
            });

            if (res?.success && res?.id) {
                created.probeCounterparties.push(res.id);
                record(`5c.${shape.id}`, 'PASS', `${shape.label} → accepted`);
                if (!minimal) minimal = shape.label;
            } else {
                const detail = JSON.stringify(res?.rawData?.validations ?? res?.rawData ?? res?.error ?? {}).slice(0, 400);
                // A refusal here is a MEASUREMENT, not a failure. These probes
                // exist to find the boundary by crossing it: L1 being refused
                // for address.city is precisely how we learn city is required.
                // Only the control (L4) failing would be a real problem, and
                // the verdict below catches that.
                record(`5c.${shape.id}`, 'INFO', `${shape.label} → refused, which is the answer: ${detail}`);
            }
        } catch (e: any) {
            const detail = e?.response?.data ? JSON.stringify(e.response.data).slice(0, 400) : firstLine(e);
            record(`5c.${shape.id}`, 'INFO', `${shape.label} → threw: ${detail}`);
        }
    }

    // Does a different counterparty type carry lighter requirements?
    try {
        const res = await createCounterparty({
            type: 'business',
            nickname: `${STAMP}-BIZ`,
            profile: { business_name: accountName || 'Vyre Probe Ltd', email: EMAIL, relationship: 'vendor' },
        });
        if (res?.success && res?.id) {
            created.probeCounterparties.push(res.id);
            record('5c.business', 'PASS',
                'type: business was accepted with NO address. Worth a conversation before using it: a ' +
                'market trader is not a business, and misdeclaring the counterparty type to dodge a field ' +
                'is the same misrepresentation by another route. But it does mean the requirement is ' +
                'per-type, not per-rail, which is useful to know when asking Nuvion.');
        } else {
            const detail = JSON.stringify(res?.rawData?.validations ?? res?.rawData ?? res?.error ?? {}).slice(0, 400);
            record('5c.business', 'INFO', `type: business, no address → refused: ${detail}`);
        }
    } catch (e: any) {
        record('5c.business', 'INFO', `type: business → ${e?.response?.data ? JSON.stringify(e.response.data).slice(0, 400) : firstLine(e)}`);
    }

    console.log('');
    if (minimal) {
        record('5c.verdict', 'PASS',
            `the smallest address Nuvion accepted is: ${minimal}. That is what Quick Send should ask ` +
            'for — one question, not four. Set the review screen to collect exactly those and no more.');
    } else {
        record('5c.verdict', 'FAIL',
            'even the full address was refused, so the problem is not the address shape. Re-read the ' +
            'validation details above — something else in the payload is wrong, and 5b/5c cannot tell ' +
            'you anything about the exemption until it is fixed.');
    }
}

// ═══════════════════════════════════════════════════════════════════════
// STAGE 6 — would the payout guard let this through?
// ═══════════════════════════════════════════════════════════════════════
async function stage6(beneficiaryId: string | null) {
    header(6, 'the blockCryptoPayout guard');

    if (!beneficiaryId) {
        record('6.guard', 'SKIP', 'no beneficiary to check');
        return;
    }

    const b: any = await prisma.beneficiary.findUnique({ where: { id: beneficiaryId } });
    if (!b) {
        record('6.guard', 'SKIP', 'beneficiary disappeared');
        return;
    }

    const hasCountry = Boolean(b.nuvionRecipientCountry);
    const hasEmail = Boolean(b.nuvionRecipientEmail);
    const hasAddress = Boolean(b.nuvionRecipientAddressLine1);

    // The OLD guard, which is what is live until edit 2b is applied.
    const oldWouldThrow = !hasCountry || !hasEmail || !hasAddress;
    // The NEW guard, rail-aware, keyed on the PAYMENT DETAIL's currency.
    const newWouldThrow = !hasCountry || !hasEmail || (addressRequiredFor('NGN') && !hasAddress);

    record('6.old', oldWouldThrow ? 'INFO' : 'INFO',
        `the guard as written today would ${oldWouldThrow ? 'THROW' : 'pass'} for this recipient`);
    // Both guards should now PASS, because stage 4 writes a full address. A
    // throw here means a field did not get written — which is also exactly
    // what would stop a real payout.
    record('6.new', newWouldThrow ? 'FAIL' : 'PASS',
        `the rail-aware guard would ${newWouldThrow ? 'THROW' : 'pass'}` +
        (newWouldThrow
            ? ` — missing: ${[!hasCountry && 'country', !hasEmail && 'email', !hasAddress && 'addressLine1']
                  .filter(Boolean).join(', ')}`
            : ''));

    if (oldWouldThrow && !newWouldThrow) {
        const apply =
            'Apply edit 2b in quick-send-integration.md — in BOTH blockCryptoPayout and blockNuvionPayout — ' +
            'or every Naira quick send dies at this guard, after the user has committed.';

        record('6.verdict', 'INFO',
            'Your guard would reject a recipient with no address while Nuvion accepted one. That ' +
            `combination only makes sense if an exemption has been measured. ${apply}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════
async function cleanup() {
    if (KEEP) {
        console.log('\n--keep: leaving everything in place.');
        console.log(JSON.stringify(created, null, 2));
        return;
    }
    if (!created.beneficiaryId && !created.nuvionCounterpartyId && !created.probeCounterparties.length) return;

    console.log(`\n${'─'.repeat(72)}`);
    console.log('CLEANUP');

    if (created.nuvionCounterpartyId) {
        // Searched, not guessed: this one deactivates a REAL Nuvion record, so
        // a wrong module path here leaves a live counterparty behind.
        const d = findFunction(['deactivateCounterparty', 'deleteCounterparty', 'disableCounterparty']);
        const deactivate = d.fn;
        if (deactivate) {
            try {
                const res = await deactivate(created.nuvionCounterpartyId);
                console.log(`  ${res?.success ? '✅' : '⚠️ '} deactivated Nuvion counterparty ${created.nuvionCounterpartyId}`);
            } catch (e: any) {
                console.log(`  ⚠️  could not deactivate ${created.nuvionCounterpartyId}: ${e?.message}`);
            }
        } else {
            console.log(`  ⚠️  deactivateCounterparty not found — deactivate ${created.nuvionCounterpartyId} by hand`);
        }
        console.log('      Nuvion has no delete, so it stays visible in the dashboard. That is expected.');
    }

    if (created.probeCounterparties.length) {
        const d = findFunction(['deactivateCounterparty', 'deleteCounterparty', 'disableCounterparty']);
        for (const id of created.probeCounterparties) {
            if (!d.fn) { console.log(`  ⚠️  deactivate probe counterparty ${id} by hand`); continue; }
            try {
                const res: any = await d.fn(id);
                console.log(`  ${res?.success ? '✅' : '⚠️ '} deactivated probe counterparty ${id}`);
            } catch (e: any) {
                console.log(`  ⚠️  probe counterparty ${id} not deactivated: ${firstLine(e)}`);
            }
        }
    }

    // Local rows, child first.
    if (created.paymentDetailId) {
        try {
            await prisma.beneficiaryPaymentDetail.delete({ where: { id: created.paymentDetailId } });
            console.log(`  ✅ deleted payment detail ${created.paymentDetailId}`);
        } catch (e: any) {
            console.log(`  ⚠️  payment detail ${created.paymentDetailId} not deleted: ${firstLine(e)}`);
        }
    }
    if (created.beneficiaryId) {
        try {
            await prisma.beneficiary.delete({ where: { id: created.beneficiaryId } });
            console.log(`  ✅ deleted beneficiary ${created.beneficiaryId}`);
        } catch (e: any) {
            console.log(`  ⚠️  beneficiary ${created.beneficiaryId} not deleted: ${firstLine(e)}`);
            console.log('      A foreign key usually means a payout references it. Leave it.');
        }
    }
}

async function main() {
    console.log(`Quick Send, end to end — ${CONFIRMED ? 'LIVE' : 'DRY RUN'}`);
    console.log('No money moves in either mode. Stage 5 is as far as it goes.');

    const ok = await stage0();
    if (!ok) {
        console.log('\nPreflight failed. Fix the above before reading anything into later stages.');
        return;
    }

    const parsed = await stage1();
    if (parsed.degraded) {
        console.log('\nThe parse came back degraded, so stages 2–6 would be testing the fallback, not the flow.');
        return;
    }

    const verifiedName = await stage2(parsed.fields.bankCode, parsed.fields.accountNumber);
    const accountName = verifiedName ?? parsed.fields.accountName ?? 'Ade Okafor';

    const existing = await stage3(parsed.fields.bankCode, parsed.fields.accountNumber);

    if (existing) {
        reusedExisting = true;
        record('4.create', 'SKIP', 'dedupe found this account already — reusing it, and creating nothing');
        await stage6(existing.beneficiaryId);
    } else {
        const made = await stage4(parsed.fields, accountName);
        if (made) {
            await stage5(made.beneficiary, made.detail);
            // 5b only when something was refused — it exists to name the
            // field. 5c runs REGARDLESS, because the minimum address shape is
            // the open question that decides how many inputs Quick Send has to
            // ask for, and a passing stage 5 says nothing about it.
            if (nuvionVerdict === 'refused') await stage5b(accountName);
            if (CONFIRMED) await stage5c(accountName);
            await stage6(made.beneficiary.id);
        } else {
            await stage5(null, null);
            await stage6(null);
        }
    }

    // ── Verdict ─────────────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(72)}`);
    const failed = results.filter((r) => r.verdict === 'FAIL');
    const skipped = results.filter((r) => r.verdict === 'SKIP');
    console.log(`${results.filter((r) => r.verdict === 'PASS').length} passed · ${failed.length} failed · ${skipped.length} skipped`);

    if (failed.length) {
        console.log('\nFailures, in the order they matter:');
        for (const f of failed) console.log(`  ❌ ${f.stage} — ${f.note}`);
    }

    if (!CONFIRMED) {
        console.log('\nThis was a dry run, so the two stages that can actually surprise you —');
        console.log('creating the rows and Nuvion accepting them — did not run. Re-run with');
        console.log('--confirm. It still moves no money.');
    } else if (nuvionVerdict === 'refused') {
        console.log('\nNuvion refused the counterparty. Stage 5b names the field; stage 5c says how');
        console.log('much address it wants. Read those verdict lines, not the pass/fail count.');
    } else if (reusedExisting) {
        console.log('\nStages 4–5c were skipped because this account is ALREADY a saved recipient, and');
        console.log('reusing it instead of creating a second copy is the dedupe working. Nothing was');
        console.log('created, so there was nothing to send to Nuvion — not a gap in the test.');
        console.log('');
        console.log('To exercise creation and the Nuvion calls, pass an account you have not saved');
        console.log('before. Those stages already passed on an earlier run, so this is optional.');
    } else if (nuvionVerdict === 'not tested') {
        console.log('\nStage 5 did not reach Nuvion, and the dedupe did not skip it either — so');
        console.log('something upstream stopped it. Read the stage 4 and 5 lines above.');
    } else if (!failed.length) {
        console.log('\nThe chain holds end to end: a paste becomes a resolved bank and account, a');
        console.log('deduped lookup, two local rows, and a Nuvion counterparty created through the');
        console.log('same function every live payout uses. The payout itself is untested here and');
        console.log('does not need to be — it is existing code already running in production.');
        console.log('');
        console.log('Now read 5c: it decides how many address inputs Quick Send has to ask for.');
    }
}

main()
    .catch((err) => {
        console.error('\nScript crashed:', err);
        process.exitCode = 1;
    })
    .finally(async () => {
        // In `finally` on purpose: a crash in the middle of stage 5 is exactly
        // when leftovers get created, and that is the run most likely to crash.
        try {
            await cleanup();
        } catch (e: any) {
            console.error('Cleanup itself failed:', e?.message);
            console.error('Left behind:', JSON.stringify(created));
        }
        await prisma.$disconnect();
    });