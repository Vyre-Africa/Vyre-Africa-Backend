// controllers/recipientParse.controller.ts
//
// Two endpoints, both READ-ONLY. Neither one writes a row, creates a
// counterparty, or moves money. That is deliberate: a paste the user abandons
// must leave nothing behind (spec §5), so creation happens later, through the
// routes that already exist, at the moment the user actually sends.
//
//   POST /transfers/parse-recipient      { text, hintCurrency? }  → ParseResult
//   GET  /transfers/quick-send/match     ?currency=&accountNumber=&bankCode=&iban=
//                                                                → existing recipient or null
//
// ── Routes (add to wherever /payouts/nuvion is mounted) ────────────────
//
//   import recipientParseController from '../controllers/recipientParse.controller';
//
//   router.post('/transfers/parse-recipient',
//       authenticate,                 // same middleware as /payouts/nuvion
//       parseRateLimiter,             // SEE BELOW — this one is not optional
//       recipientParseController.parse);
//
//   router.get('/transfers/quick-send/match',
//       authenticate,
//       recipientParseController.match);
//
// NO requireTransactionPin on either. A PIN protects money movement, and
// neither of these moves any; asking for one here would train users to enter
// their PIN at a point where it buys nothing.
//
// ── The rate limiter is a real requirement, not boilerplate ───────────
// Every parse call is a paid OpenAI call made on behalf of a logged-in user.
// Without a per-user limit, one scripted loop against this endpoint is a
// direct charge on your OpenAI account with no transfer at the end of it.
// MAX_TEXT below caps the cost of a single call; the limiter caps the number
// of them. Use whatever limiter the app already has — 20/minute per user is
// generous for a human pasting bank details.
//
// ── PII note, which belongs in your data-processing disclosures ────────
// This endpoint sends recipient names and bank account numbers to OpenAI.
// That makes OpenAI a subprocessor for customer payment data. Minimum bar
// before this ships: zero-retention / no-training on the API key in use. The
// logging below is written to keep that boundary visible — it records shapes
// and counts, never the pasted text and never an account number.

import { Request, Response } from 'express';
import prisma from '../config/prisma.client';
import logger from '../config/logger';
import { parseRecipient, addressRequiredFor, ParseResult } from '../services/recipientparse.service';
import { requirementsFor, dumpRequirements } from '../services/nuvionRequirements';
import { railRequiredFields, railsFor } from '../services/railRequirements';

// Currency → the recipient country we tell Nuvion. Same mapping the payout
// path uses; here only to key the requirements cache.
const CURRENCY_TO_COUNTRY: Record<string, string> = {
    NGN: 'NG', GHS: 'GH', KES: 'KE', ZAR: 'ZA', UGX: 'UG', TZS: 'TZ',
    USD: 'US', GBP: 'GB', EUR: 'EU', CAD: 'CA', HKD: 'HK', CNY: 'CN',
};

// Long enough for a screenshot retyped with chatter around it, short enough
// that a single call cannot run away in tokens. The longest real case in
// test-recipient-parse.ts is 180 characters.
const MAX_TEXT = 2000;

// OPEN QUESTION, deliberately a flag rather than a decision (spec §7 Q1).
// createCounterparty's signature marks `email` mandatory, but it marked the
// whole address block mandatory too and that turned out not to be Nuvion's
// rule — so the signature is not evidence. Until
// test-counterparty-minimal.ts --confirm settles it, we ask for the email:
// over-collecting one field costs a question, under-collecting it kills the
// payout after the user has committed.
//
// When the probe comes back saying Nuvion does not need it, set
// QUICK_SEND_EMAIL_REQUIRED=false and the review screen stops asking. The UI
// reads `missing` generically, so nothing else changes.
const EMAIL_REQUIRED = process.env.QUICK_SEND_EMAIL_REQUIRED !== 'false';

// Returned when the model cannot be reached AND when this controller itself
// throws. The UI treats both identically: fall back to the manual form. A 500
// here would put a blank screen between a user and their own money for a
// reason that has nothing to do with the transfer.
function degradedResult(hintCurrency?: string): ParseResult {
    const currency = hintCurrency ?? null;
    return {
        currency,
        paymentMethod: 'bank-transfer',
        confidence: 0,
        fields: {},
        missing: [],
        ambiguous: [],
        unmatchedText: [],
        warnings: [],
        addressRequired: addressRequiredFor(currency ?? undefined),
        degraded: true,
    };
}

class RecipientParseController {
    // POST /transfers/parse-recipient
    async parse(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        const hintCurrency = typeof req.body?.hintCurrency === 'string' ? req.body.hintCurrency : undefined;
        const raw = req.body?.text;

        if (typeof raw !== 'string' || !raw.trim()) {
            return res.status(400).json({ success: false, msg: 'Paste the recipient details first' });
        }

        const text = raw.trim().slice(0, MAX_TEXT);
        const truncated = raw.trim().length > MAX_TEXT;

        try {
            const result = await parseRecipient(text, hintCurrency);

            // Email is a beneficiary-record requirement, not something the
            // parser knows about — it lives here because this is where the
            // flag lives. `missing` is the single list the review screen
            // renders as inputs, so adding to it is all that is needed.
            // WHAT TO ASK THE RECIPIENT FOR — from what Nuvion has actually
            // demanded in this corridor, not from a table we maintain.
            //
            // A corridor nobody has used starts from the conservative
            // baseline (full address + email), which is a superset of
            // anything Nuvion has ever been seen to require — so a new
            // country cannot fail mid-flow for a missing field. As corridors
            // get used, the cache narrows the ask to what is really needed.
            //
            // This replaces the per-currency address guessing entirely: the
            // parser still reports which RAIL fields it could not find, and
            // the requirement cache owns the person-level ones.
            if (!result.degraded) {
                const corridor = {
                    currency: result.currency,
                    country: result.currency ? CURRENCY_TO_COUNTRY[result.currency] : null,
                    paymentMethod: result.paymentMethod,
                };
                const { fields, learned } = requirementsFor(corridor);

                const PERSON_LEVEL = /^(recipientAddress|email$|recipientCountry$)/;
                const railOnly = result.missing.filter((m) => !PERSON_LEVEL.test(m));
                const stillNeeded = fields.filter((f) => !(result.fields as any)[f]);

                result.missing = [...new Set([...railOnly, ...stillNeeded])];

                logger.info('[QuickSend] recipient requirements', {
                    corridor, learned, asking: stillNeeded,
                });
            }

            // Shapes and counts only. No text, no account numbers, no names.
            logger.info('[QuickSend] parsed a recipient paste', {
                userId: user?.id,
                chars: text.length,
                truncated,
                currency: result.currency,
                paymentMethod: result.paymentMethod,
                confidence: result.confidence,
                fieldsFound: Object.keys(result.fields).length,
                missingCount: result.missing.length,
                ambiguousCount: result.ambiguous.length,
                warningCount: result.warnings.length,
                degraded: result.degraded,
            });

            return res.status(200).json({ success: true, result, truncated });
        } catch (error: any) {
            // Deliberately 200. See degradedResult.
            logger.error('[QuickSend] parse failed, returning degraded result', {
                userId: user?.id,
                chars: text.length,
                error: error?.message,
            });
            return res.status(200).json({ success: true, result: degradedResult(hintCurrency), truncated });
        }
    }

    // GET /transfers/quick-send/requirements
    //
    // What a recipient in this corridor has to supply, as Nuvion has shown
    // us. The review screen calls this when the user changes the currency —
    // picking a MoMo network, say — because the ask changes with the corridor
    // and the parse's answer is then stale.
    async requirements(req: Request & Record<string, any>, res: Response) {
        const currency = req.query.currency ? String(req.query.currency).toUpperCase() : null;
        const paymentMethod = req.query.paymentMethod ? String(req.query.paymentMethod) : 'bank-transfer';
        const country = req.query.country
            ? String(req.query.country).toUpperCase()
            : (currency ? CURRENCY_TO_COUNTRY[currency] ?? null : null);

        const { fields, learned } = requirementsFor({ currency, country, paymentMethod });

        // NEW — the RAIL's fields too, which depend on the chosen scheme.
        //
        // A currency with several rails (USD, CAD, PHP) asks for the choice
        // first, because the fields follow from it: Interac e-Transfer wants
        // an email and no account number, EFT wants two numbers and no email.
        // So without a scheme this returns `scheme` alone, and once the user
        // picks one it returns that rail's fields.
        //
        // The review screen must therefore call this again after a scheme is
        // chosen — the same way it already does after a currency change.
        // Without that, a USD recipient is asked which rail and then never
        // asked for the routing number. test-all-rails.ts check 1d is what
        // surfaced this.
        const scheme = req.query.scheme ? String(req.query.scheme) : null;
        const rail = railRequiredFields(currency, scheme, paymentMethod);
        const rails = railsFor(currency, paymentMethod);

        return res.status(200).json({
            success: true,
            // Person-level plus rail-level, which is what the screen asks for.
            fields: [...new Set([...fields, ...rail])],
            personFields: fields,
            railFields: rail,
            // So the screen can render a picker with real labels rather than
            // raw scheme codes.
            railOptions: rails.length > 1
                ? rails.map((r) => ({ scheme: r.scheme, label: r.label ?? r.scheme, note: r.note }))
                : [],
            schemeChosen: scheme,
            // `false` means nobody has completed a payout in this corridor
            // yet, so the list is the conservative baseline rather than a
            // measurement. Useful for an ops view; the UI does not need it.
            learned,
        });
    }

    // GET /transfers/quick-send/requirements/all — ops only. Everything the
    // system has learned, so a corridor's real requirements can be read off
    // without digging through logs.
    async allRequirements(_req: Request, res: Response) {
        return res.status(200).json({ success: true, corridors: dumpRequirements() });
    }

    // GET /transfers/quick-send/match
    //
    // "Have I paid this account before?" Answering it is what stops paying Ade
    // four times from creating four Ades — and four counterparties at Nuvion,
    // each one a billable call (spec §5).
    //
    // Always scoped to req.user.id. A payment detail belonging to another user
    // can never come back from here, which is also why it is safe to answer a
    // query containing an account number: you can only ever learn about
    // accounts you already saved.
    async match(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        const currency = String(req.query.currency ?? '').toUpperCase();
        const accountNumber = req.query.accountNumber ? String(req.query.accountNumber) : null;
        const bankCode = req.query.bankCode ? String(req.query.bankCode) : null;
        const iban = req.query.iban ? String(req.query.iban).replace(/\s/g, '').toUpperCase() : null;

        if (!currency) {
            return res.status(400).json({ success: false, msg: 'currency is required' });
        }

        // The identity of an account, per rail:
        //   bank rails  (bankCode, accountNumber)  — the account number alone
        //                                            is not unique across banks
        //   SEPA        iban                       — globally unique by design
        const identity: any[] = [];
        if (accountNumber && bankCode) identity.push({ accountNumber, bankCode });
        else if (accountNumber) identity.push({ accountNumber });
        if (iban) identity.push({ iban });

        if (!identity.length) {
            return res.status(400).json({ success: false, msg: 'accountNumber or iban is required' });
        }

        try {
            // MEASURED 13 Oct, by test-quick-send-flow.ts stage 3:
            //   accountNumber / bankCode / iban ARE real columns here — the
            //   dedupe works.
            //   Beneficiary has NO `accountName` column. Its real fields are
            //   userId, ISO, chain, type, bank, crypto, nuvionCounterpartyId,
            //   nuvionRecipient*. The name the UI shows is assembled by the
            //   API, not stored flat.
            //
            // So the name comes off the PAYMENT DETAIL, which does carry
            // accountName. That is the better source anyway: it is the name on
            // the account being paid, not a label on the person, and for NGN
            // it is the bank's own answer.
            const hit = await prisma.beneficiaryPaymentDetail.findFirst({
                where: {
                    currency,
                    beneficiary: { userId: user.id },
                    OR: identity,
                },
                orderBy: { createdAt: 'desc' },
                select: { id: true, beneficiaryId: true, accountName: true },
            });

            logger.info('[QuickSend] recipient match lookup', {
                userId: user.id,
                currency,
                by: iban ? 'iban' : bankCode ? 'bankCode+accountNumber' : 'accountNumber',
                found: Boolean(hit),
            });

            if (!hit) return res.status(200).json({ success: true, match: null });

            return res.status(200).json({
                success: true,
                match: {
                    beneficiaryId: hit.beneficiaryId,
                    paymentDetailId: hit.id,
                    accountName: hit.accountName ?? null,
                },
            });
        } catch (error: any) {
            // Failing soft on purpose: a dedupe lookup that errors must not
            // stop the send. The cost of returning null is a duplicate
            // recipient row, which is untidy. The cost of a 500 is a user who
            // cannot pay anyone.
            logger.error('[QuickSend] match lookup failed — treating as no match', {
                userId: user.id,
                currency,
                error: error?.message,
            });
            return res.status(200).json({ success: true, match: null, lookupFailed: true });
        }
    }
}

export default new RecipientParseController();