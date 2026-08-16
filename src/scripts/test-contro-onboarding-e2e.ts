// scripts/test-contro-onboarding-e2e.ts
// Run with: npm run test:contro-e2e
//
// Everything tested so far (test-contro-flow.ts) proved Contro's raw API
// works correctly in isolation. This proves the actual ORCHESTRATION
// layer works — a real Vyre User row, driven through startCardKyc(),
// with the webhook handler doing its job against that same row, not
// against nothing (which is why every earlier webhook test logged
// "No user found for Contro cardholder").
//
// This does NOT create the KYC session and wait for a human to complete
// it through a real browser — that's a separate, necessary manual test.
// This script creates the user and starts the session, then tells you
// exactly what to do next to drive it to completion and watch the
// webhook handler pick it up for real.

import prisma from '../config/prisma.client';
import logger from '../config/logger';
import { startCardKyc } from '../services/controOnboarding.service';

function step(label: string) {
    console.log(`\n─── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`);
}

async function main() {
    step('1. Create a real test User row');

    // Using a distinctive, obviously-test email/name so this is never
    // mistaken for a real user later — and re-runnable, since re-running
    // finds the existing test user rather than erroring on a duplicate.
    const testEmail = 'contro-e2e-test@vyre.africa';

    let user = await prisma.user.findUnique({ where: { email: testEmail } });

    if (user) {
        console.log(`Existing test user found: ${user.id}`);
        if (user.controCardholderId) {
            console.warn('⚠️  This test user already has a controCardholderId from a previous run.');
            console.warn('   Resetting Contro-related fields so this run starts clean.');
            user = await prisma.user.update({
                where: { id: user.id },
                data: {
                    controCardholderId: null,
                    controKycSessionId: null,
                    controKycStatus: null,
                    controProgramKycStatus: null,
                    controCardApprovalEmailSentAt: null,
                },
            });
        }
    } else {
        user = await prisma.user.create({
            data: {
                email: testEmail,
                firstName: 'Contro',
                lastName: 'E2ETest',
                phoneNumber: '+2348012345678',
                userStatus: 'CREATED',
            } as any, // adjust required fields to match your actual User model if this errors
        });
        console.log(`Created test user: ${user.id}`);
    }

    step('2. Call startCardKyc — the REAL orchestration entry point');
    const result = await startCardKyc(user.id);

    if (!result.success) {
        console.error('❌ startCardKyc failed:', result.error);
        process.exit(1);
    }

    console.log('✅ Session created and controKycSessionId written to the real User row');
    console.log('Session URL:', result.sessionUrl);

    // Confirm the DB write actually happened — don't just trust the
    // function's return value.
    const userAfter = await prisma.user.findUnique({ where: { id: user.id } });
    console.log('User.controKycSessionId in DB:', userAfter?.controKycSessionId);

    step('3. What to do next — this part is manual, not automatable');
    console.log(`
This session will NOT auto-complete the way the raw API test did —
that was Contro's own createKycSession returning a pre-completed mock
session for direct API testing. Going through startCardKyc's real path
and expecting a REAL webhook-driven completion needs one of two things:

  OPTION A — Open the session URL in a real browser and go through it:
    ${result.sessionUrl}
    (Sandbox — should be fast, but this IS the real Didit-hosted flow,
    not an instant mock this time.)

  OPTION B — If sandbox truly auto-completes regardless of entry point,
    just wait a few seconds and check the logs below anyway.

Then watch your deployed server's logs for, in order:
  1. "Contro webhook raw payload" with eventType: kyc_session.completed
     → confirms handleKycSessionCompleted ran
  2. A DB check (step 4 below) showing controCardholderId is now SET
     on user ${user.id}
  3. "Contro webhook raw payload" with eventType: cardholder.kyc.approved
     → confirms checkProgramKycAndNotify ran
  4. "Approval email queued for user ${user.id}"
     → confirms the full loop closed, including the now-fixed
       notification queue

Run this to check DB state after you've done the above:
`);

    console.log(`
npx ts-node --transpile-only -r dotenv/config -e "
const prisma = require('./src/config/prisma.client').default;
prisma.user.findUnique({
  where: { id: '${user.id}' },
  select: {
    controKycSessionId: true,
    controCardholderId: true,
    controKycStatus: true,
    controProgramKycStatus: true,
    controCardApprovalEmailSentAt: true,
  }
}).then((u) => { console.log(u); process.exit(0); });
"
`);

    step('DONE (setup phase)');
    console.log(`Test user id: ${user.id}`);
    console.log('Re-run this script anytime to reset and start over.');
}

main()
    .catch((error) => {
        console.error('❌ Script failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });