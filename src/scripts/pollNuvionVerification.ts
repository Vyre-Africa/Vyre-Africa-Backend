// scripts/pollNuvionVerification.ts
//
// Polls document/proof-of-address verification status for any user whose
// Nuvion onboarding has been submitted but not yet resolved. This exists
// because Nuvion's documented webhook event catalog (accounts.created,
// account_details.*, inflows/outflows, payment_intent/refund,
// funding_sessions_updated) does NOT include an event for identity or
// document verification status changes — confirmed by checking their
// full event list, not assumed. Until Nuvion confirms otherwise (or a
// relevant event surfaces we haven't seen), polling is the reliable path.
//
// Run this on a schedule (cron, or your existing background job runner)
// — e.g. every 15-30 minutes for users in "pending" status.
//
// Usage:
//   npx ts-node --transpile-only -r dotenv/config scripts/pollNuvionVerification.ts

import prisma from '../config/prisma.client';
import { getEntityStatus } from '../services/nuvion.service';
import logger from '../config/logger';

async function main() {
    const pendingUsers = await prisma.user.findMany({
        where: {
            nuvionEntityId: { not: null },
            nuvionEntityStatus: { in: ['incomplete', 'pending'] },
        },
        select: { id: true, nuvionEntityId: true, nuvionEntityStatus: true },
    });

    console.log(`Checking ${pendingUsers.length} user(s) with pending Nuvion verification...`);

    for (const user of pendingUsers) {
        if (!user.nuvionEntityId) continue;

        try {
            const result = await getEntityStatus(user.nuvionEntityId);

            if (!result.success) {
                logger.warn(`Failed to check Nuvion status for user ${user.id}`, { error: result.error });
                continue;
            }

            // Field names based on the confirmed entity-creation response
            // shape (data.entity.status, data.identification.document/
            // proof_of_address.verification_status) — re-verify these
            // against a real GET response the first time this runs, same
            // discipline as everything else in this integration.
            const entityStatus = result.rawData?.data?.entity?.status;
            const documentStatus = result.rawData?.data?.identification?.document?.verification_status;
            const addressStatus = result.rawData?.data?.identification?.proof_of_address?.verification_status;

            console.log(`${user.id}: entity=${entityStatus}, document=${documentStatus}, address=${addressStatus}`);

            if (entityStatus && entityStatus !== user.nuvionEntityStatus) {
                await prisma.user.update({
                    where: { id: user.id },
                    data: { nuvionEntityStatus: entityStatus },
                });
                logger.info(`Updated Nuvion status for user ${user.id}: ${user.nuvionEntityStatus} → ${entityStatus}`);

                // Wire in notificationService here once the field mapping
                // above is confirmed correct against a real response.
            }

        } catch (error: any) {
            logger.error(`Error polling Nuvion status for user ${user.id}`, { error: error.message });
        }
    }

    console.log('Done.');
    await prisma.$disconnect();
}

main().catch((e) => {
    console.error('Script crashed:', e);
    process.exit(1);
});