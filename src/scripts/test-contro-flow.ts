// scripts/test-contro-flow.ts
//
// Updated after the first real sandbox run surfaced three genuine
// findings worth tracking explicitly:
//   1. KYC provider is DIDIT (verification.didit.me), not Sumsub as every
//      doc page claimed — needs confirming directly with Contro, since it
//      may reopen the whole "can we reuse existing KYC" question.
//   2. Card status uses "pending" as a real value, which isn't in the
//      documented OpenAPI enum (created|active|frozen|cancelled) at all.
//   3. Sandbox does NOT implement spend-control updates
//      ("Provider sandbox does not implement spend-control updates") —
//      confirmed by a real 400-style error, not inferred. This means the
//      mechanism our whole ledger design depends on can't be validated
//      in sandbox at all — worth raising with Contro directly.

import axios, { AxiosInstance } from 'axios';

function arg(name: string): string | undefined {
    const match = process.argv.find(a => a.startsWith(`--${name}=`));
    return match?.split('=')[1];
}

function step(label: string) {
    console.log(`\n─── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`);
}

function logRaw(label: string, data: any) {
    console.log(`[RAW ${label}]`, JSON.stringify(data, null, 2));
}

function describeError(error: any): { message: string; code?: string; existingCardholderId?: string } {
    const body = error?.response?.data ?? error;
    if (typeof body?.error === 'string') {
        return { message: body.error };
    }
    if (typeof body?.error === 'object' && body?.error !== null) {
        return {
            message: body.error.message ?? 'Unknown error',
            code: body.error.code,
            existingCardholderId: body.error.existingCardholderId,
        };
    }
    return { message: error?.message ?? 'Unknown error (unrecognized shape)' };
}

async function main() {
    const programId = arg('programId');
    if (!programId) {
        console.error('Usage: --programId=<your Contro card program id>');
        process.exit(1);
    }

    const apiKey = process.env.CONTRO_API_KEY;
    if (!apiKey?.startsWith('sk_test_')) {
        console.error('❌ CONTRO_API_KEY is not set, or does not start with sk_test_.');
        process.exit(1);
    }

    const CONTRO_BASE_URL = process.env.CONTRO_BASE_URL || 'https://stg-api.contro.dev/v1'; // confirmed correct via live curl test

    console.log(`Using base URL: ${CONTRO_BASE_URL}`);

    const contro: AxiosInstance = axios.create({
        baseURL: CONTRO_BASE_URL,
        headers: {
            'x-contro-api-key': apiKey,
            'Content-Type': 'application/json',
        },
        timeout: 30000,
    });

    const testUserId = `vyre_test_${Date.now()}`;
    const testEmail = `vyre-test-${Date.now()}@example.com`;
    const testPhone = '+2348012345678';

    // STEP 1 — Create a KYC session
    step('1. Create KYC session');
    let session: any;
    try {
        const res = await contro.post('/partner/kyc-sessions', { externalUserId: testUserId });
        session = res.data;
        logRaw('kyc-session create', session);
        // CONFIRMED live: session.url points at verification.didit.me, not
        // Sumsub — flagging loudly here since it contradicts every doc page.
        if (session.url && !session.url.includes('sumsub')) {
            console.warn(`⚠️  KYC provider appears to be something other than Sumsub: ${session.url}`);
            console.warn('   Confirm with Contro directly which provider is actually used in production.');
        }
    } catch (error: any) {
        console.error('❌ Failed to create KYC session:', describeError(error).message);
        process.exit(1);
    }

    console.log('Session id:', session.id, '| status:', session.status);

    // STEP 2 — Confirm session status (was already "completed" instantly last run)
    step('2. Confirm KYC session status');
    let sessionStatus = session.status;
    let attempts = 0;
    while (sessionStatus !== 'completed' && attempts < 10) {
        await new Promise(r => setTimeout(r, 1000));
        const { data: refreshed } = await contro.get(`/partner/kyc-sessions/${session.id}`);
        sessionStatus = refreshed.status;
        attempts++;
    }
    if (sessionStatus !== 'completed') {
        console.error(`❌ Session never reached "completed" (stuck at "${sessionStatus}").`);
        process.exit(1);
    }
    console.log('✅ Session completed');

    // STEP 3 — Create cardholder
    step('3. Create cardholder');
    let cardholder: any;
    try {
        const res = await contro.post('/partner/cardholders', {
            externalUserId: testUserId,
            kycSource: 'web',
            kycSessionId: session.id,
            email: testEmail,
            phoneNumber: testPhone,
        });
        cardholder = res.data;
        logRaw('cardholder create', cardholder);
    } catch (error: any) {
        const { message, code, existingCardholderId } = describeError(error);
        if (code === 'EMAIL_ALREADY_REGISTERED' && existingCardholderId) {
            console.warn(`⚠️  Cardholder already exists — self-healing to: ${existingCardholderId}`);
            const { data } = await contro.get(`/partner/cardholders/${existingCardholderId}`);
            cardholder = data;
        } else {
            console.error('❌ Failed to create cardholder:', message);
            process.exit(1);
        }
    }
    console.log('Cardholder id:', cardholder.id, '| kycStatus:', cardholder.kycStatus);

    // STEP 4-5 — Program-level KYC
    step('4. Initiate KYC for card program');
    const { data: kycInit } = await contro.post(`/partner/cardholders/${cardholder.id}/kyc`, {
        cardProgramId: programId,
    });
    logRaw('initiate program KYC', kycInit);

    step('5. Confirm program KYC status (took 6 attempts last run — not instant despite "sandbox auto-approves")');
    let programKycStatus = kycInit.status;
    attempts = 0;
    while (programKycStatus !== 'approved' && attempts < 15) {
        await new Promise(r => setTimeout(r, 1000));
        const { data: kycCheck } = await contro.get(
            `/partner/cardholders/${cardholder.id}/kyc`,
            { params: { cardProgramId: programId } }
        );
        programKycStatus = kycCheck.kycStatus;
        attempts++;
        process.stdout.write('.');
    }
    console.log('');
    if (programKycStatus !== 'approved') {
        console.error(`❌ Program KYC never reached "approved" (stuck at "${programKycStatus}") after ${attempts}s.`);
        process.exit(1);
    }
    console.log(`✅ Program KYC approved (took ~${attempts}s)`);

    // STEP 6 — Issue card
    step('6. Issue card');
    const { data: card } = await contro.post('/partner/cards', {
        cardholderId: cardholder.id,
        programId: programId,
        idempotencyKey: `test_issue_${testUserId}`,
    });
    logRaw('card create', card);
    console.log('Card id:', card.id, '| status:', card.status);
    if (card.status === 'pending') {
        console.warn('⚠️  Status is "pending" — NOT in the documented OpenAPI enum (created|active|frozen|cancelled).');
        console.warn('   Worth flagging to Contro directly — either undocumented, or unexpected.');
    }

    // STEP 7 — Activate
    step('7. Activate card');
    const { data: activateResult } = await contro.post(`/partner/cards/${card.id}/activate`);
    logRaw('card activate', activateResult);

    // STEP 8 — POLL for status after activation, don't just check once —
    // program KYC taught us this API has real async delays even in
    // sandbox, so a single immediate check isn't a fair test.
    step('8. Poll for card status after activation (learned from step 5: don\'t assume instant)');
    let cardStatus = card.status;
    attempts = 0;
    let finalCard: any;
    while (cardStatus !== 'active' && attempts < 15) {
        await new Promise(r => setTimeout(r, 1000));
        const { data } = await contro.get(`/partner/cards/${card.id}`);
        finalCard = data;
        cardStatus = data.status;
        attempts++;
        process.stdout.write('.');
    }
    console.log('');
    logRaw('card retrieve (final)', finalCard);
    if (cardStatus === 'active') {
        console.log(`✅ Card reached "active" after ~${attempts}s of polling — activation IS async, not broken.`);
    } else {
        console.warn(`⚠️  Card status still "${cardStatus}" after ${attempts}s — genuinely worth asking Contro`);
        console.warn('   whether this is expected sandbox behavior or a real issue.');
    }

    // STEP 9 — Spend control — CONFIRMED unsupported in sandbox, don't
    // crash the rest of the script over it, just note it clearly.
    step('9. Set spend control (CONFIRMED: sandbox does not implement this)');
    try {
        const { data: spendControlResult } = await contro.patch(`/partner/cards/${card.id}/limits`, {
            spendControl: {
                sales: { perTransaction: 50, daily: 200, allTime: 1000 },
                cash: { allTime: 0 },
            },
        });
        logRaw('spend control update', spendControlResult);
    } catch (error: any) {
        const { message } = describeError(error);
        console.warn(`⚠️  Spend control update failed (expected, confirmed sandbox limitation): ${message}`);
        console.warn('   This is the mechanism our whole per-user ledger design depends on — ask Contro');
        console.warn('   directly whether there is ANY way to test this before going live, since sandbox');
        console.warn('   apparently cannot validate it at all.');
    }

    // STEP 10 — Transactions (should still work regardless of spend control)
    step('10. List transactions (expect empty)');
    try {
        const { data: transactions } = await contro.get(`/partner/cards/${card.id}/transactions`);
        logRaw('list transactions', transactions);
    } catch (error: any) {
        console.warn('⚠️  Could not list transactions:', describeError(error).message);
    }

    step('DONE');
    console.log('✅ Flow completed (with noted findings above).');
    console.log(`   Cardholder: ${cardholder.id}`);
    console.log(`   Card: ${card.id}`);
    console.log('\n   Open questions for Contro, in priority order:');
    console.log('   1. Is the real KYC provider Sumsub or Didit? (sandbox showed Didit)');
    console.log('   2. What does card status "pending" mean — undocumented enum value?');
    console.log('   3. How can spend-control be tested before production, given sandbox rejects it?');
}

main().catch((error) => {
    console.error('\n❌ Script crashed:');
    console.error(describeError(error));
    console.error('\nFull raw error:');
    console.error(error?.response?.data ?? error);
    process.exit(1);
});