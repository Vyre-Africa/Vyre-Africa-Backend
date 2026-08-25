// scripts/replay-didit-event.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/replay-didit-event.ts
//
// Updated with the COMPLETE real payload (the earlier version had a
// truncated id_verifications array from Node's console collapsing
// nested arrays as [Array]). This is now the full, real, confirmed data.

import prisma from '../config/prisma.client';
import eventService from '../services/event.service';

const realBody = {
    application_id: '71dff4a8-cb5d-4058-b452-e3e12ed96944',
    created_at: 1787228466,
    decision: {
        aml_screenings: [
            {
                entity_type: 'person',
                hits: [],
                node_id: 'feature_aml',
                status: 'Approved',
                total_hits: 0,
                warnings: [],
            },
        ],
        callback: 'https://app.vyre.africa/kyc/tier2/callback',
        environment: 'live',
        expires_at: '2026-08-27T12:17:05.888585Z',
        face_matches: [
            { node_id: 'feature_face_match', score: 96.7, status: 'Approved', warnings: [] },
        ],
        features: ['ID_VERIFICATION', 'NFC', 'LIVENESS', 'FACE_MATCH', 'AML', 'IP_ANALYSIS'],
        // CONFIRMED real values — this is what the earlier truncated log
        // hid. first_name groups BOTH given names (matches the passport
        // MRZ format), last_name is the surname alone.
        id_verifications: [
            {
                age: 26,
                date_of_birth: '2000-03-15',
                date_of_issue: '2021-10-13',
                document_number: 'B00562859',
                document_subtype: 'EPASSPORT',
                document_type: 'Passport',
                expiration_date: '2026-10-12',
                first_name: 'Harvey Onyeka',
                full_name: 'Harvey Onyeka Anafuwe',
                gender: 'M',
                issuing_state: 'NGA',
                issuing_state_name: 'Nigeria',
                last_name: 'Anafuwe',
                nationality: 'NGA',
                node_id: 'feature_ocr',
                place_of_birth: 'Lagos',
                status: 'Approved',
                warnings: [],
            },
        ],
        liveness_checks: [
            { age_estimation: 24.22, method: 'FLASHING', node_id: 'feature_liveness', score: 99.56, status: 'Approved', warnings: [] },
        ],
        metadata: { purpose: 'tier2_upgrade' },
        session_id: '3aaa473d-1b7a-40eb-96dd-ef9695d58251',
        session_kind: 'user',
        status: 'Approved',
        vendor_data: 'user_38OI3Y47pS0u4gKiRoee5GySGiV',
        workflow_id: 'ba34438d-1a87-4ab5-86c7-f7cee1b11ebf',
    },
    environment: 'live',
    event_id: '48005415-e42f-48c4-af9e-df24777736aa',
    metadata: { purpose: 'tier2_upgrade' },
    session_id: '3aaa473d-1b7a-40eb-96dd-ef9695d58251',
    status: 'Approved',
    timestamp: 1787228467,
    vendor_data: 'user_38OI3Y47pS0u4gKiRoee5GySGiV',
    webhook_type: 'status.updated',
    workflow_id: 'ba34438d-1a87-4ab5-86c7-f7cee1b11ebf',
    workflow_version: 1,
};

async function main() {
    console.log('Before:');
    const before = await prisma.user.findUnique({
        where: { id: 'user_38OI3Y47pS0u4gKiRoee5GySGiV' },
        select: { kycTier: true, kycTier2At: true, diditKycStatus: true, legalFirstName: true, legalLastName: true },
    });
    console.log(before);

    console.log('\nReplaying real event through handleDiditEvent...\n');
    await eventService.handleDiditEvent({ body: realBody });

    console.log('\nAfter:');
    const after = await prisma.user.findUnique({
        where: { id: 'user_38OI3Y47pS0u4gKiRoee5GySGiV' },
        select: { kycTier: true, kycTier2At: true, diditKycStatus: true, legalFirstName: true, legalLastName: true },
    });
    console.log(after);

    if (after?.kycTier === 2) {
        console.log('\n✅ Fixed — kycTier is now 2.');
        console.log(`   legalFirstName: "${after.legalFirstName}", legalLastName: "${after.legalLastName}"`);
        console.log('   Note: legalFirstName will be "Harvey Onyeka" (both given names combined) — that\'s the real');
        console.log('   OCR extraction from the passport MRZ, not a bug. Worth deciding if that\'s the display');
        console.log('   format you want, or whether it should be split further before storing.');
    } else {
        console.log('\n⚠️  kycTier still not 2 — check handleDiditEvent for another issue.');
    }
}

main()
    .catch((err) => console.error('Script failed:', err))
    .finally(async () => { await prisma.$disconnect(); });