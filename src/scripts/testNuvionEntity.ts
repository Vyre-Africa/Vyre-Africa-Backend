// scripts/testNuvionEntity.ts
//
// Tests real Nuvion entity creation against a test user. Since the actual
// onboarding UI (address form, document metadata confirm screen) doesn't
// exist yet — and this particular test user hasn't been through a real
// Tier 1 BVN upgrade in this database either — this script accepts every
// required field as a CLI override, applies them to the test user first,
// then calls createIndividualEntity() for real — the exact same function
// the production controller will use.
//
// The whole point is to see Nuvion's ACTUAL response and lock in real
// field names/validation rules, since their own docs admit the entity
// schema is unconfirmed. Every response gets logged in full, deliberately.
//
// Usage:
//   npx ts-node --transpile-only -r dotenv/config scripts/testNuvionEntity.ts \
//     --userId=user_38OI3Y47pS0u4gKiRoee5GySGiV \
//     --legalFirstName="HARVEY ONYEKA" \
//     --legalLastName=ANAFUWE \
//     --legalDateOfBirth=2000-03-15 \
//     --legalGender=male \
//     --phoneNumber=+2348012345678 \
//     --dojahBvnRef=22222222222 \
//     --nationality=NG \
//     --addressLine1="4 Lawal Street" \
//     --addressCity=Ikorodu \
//     --addressState=Lagos \
//     --addressPostalCode=100001 \
//     --addressCountryCode=NG \
//     --idDocumentType=passport \
//     --idDocumentNumber=B00562859 \
//     --idDocumentIssueDate=2021-10-13 \
//     --idDocumentExpiryDate=2026-10-12 \
//     --idDocumentIssuingCountry=NG \
//     [--confirm]
//
//   Dry run by default. Add --confirm to actually call Nuvion.
//
// NOTE: --legalGender's accepted values aren't confirmed from Nuvion's
// docs — 'male' is a first guess, informed by their own validation error
// pattern ("'' is not supported... please use a supported value"). If
// this specific value also errors, their response should name what IS
// accepted — use that, don't keep guessing blind.

import prisma from '../config/prisma.client';
import { createIndividualEntity } from '../services/nuvion.service';

function arg(name: string): string | undefined {
    const match = process.argv.find(a => a.startsWith(`--${name}=`));
    return match?.split('=')[1];
}
const CONFIRMED = process.argv.includes('--confirm');

function step(label: string) {
    console.log(`\n─── ${label} ${'─'.repeat(Math.max(0, 55 - label.length))}`);
}

async function main() {
    const userId = arg('userId');
    if (!userId) {
        console.error('Usage: --userId=<id> [field overrides] [--confirm]');
        process.exit(1);
    }

    step('1. Loading current user record');
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
        console.error(`❌ No user found with id ${userId}`);
        process.exit(1);
    }
    console.log({
        legalFirstName: user.legalFirstName,
        legalLastName: user.legalLastName,
        legalDateOfBirth: user.legalDateOfBirth,
        legalGender: user.legalGender,
        phoneNumber: user.phoneNumber,
        dojahBvnRef: user.dojahBvnRef,
        nationality: user.nationality,
        addressLine1: user.addressLine1,
        nuvionEntityId: user.nuvionEntityId,
    });

    if (user.nuvionEntityId) {
        console.warn(`\n⚠️  This user already has a Nuvion entity (${user.nuvionEntityId}).`);
        console.warn('   createIndividualEntity() will short-circuit and return the existing');
        console.warn('   one rather than creating a new one — that\'s the idempotency guard');
        console.warn('   working as intended, not a bug in this script.');
    }

    step('2. Applying CLI overrides');
    const overrides: Record<string, any> = {};
    const fieldMap: Record<string, string> = {
        legalFirstName: 'legalFirstName',
        legalLastName: 'legalLastName',
        legalGender: 'legalGender',
        phoneNumber: 'phoneNumber',
        dojahBvnRef: 'dojahBvnRef',
        nationality: 'nationality',
        addressLine1: 'addressLine1',
        addressLine2: 'addressLine2',
        addressCity: 'addressCity',
        addressState: 'addressState',
        addressPostalCode: 'addressPostalCode',
        addressCountryCode: 'addressCountryCode',
        idDocumentType: 'idDocumentType',
        idDocumentNumber: 'idDocumentNumber',
        idDocumentIssuingCountry: 'idDocumentIssuingCountry',
    };
    for (const [cliName, dbField] of Object.entries(fieldMap)) {
        const value = arg(cliName);
        if (value) overrides[dbField] = value;
    }

    const legalDob = arg('legalDateOfBirth');
    if (legalDob) overrides.legalDateOfBirth = new Date(legalDob);

    const issueDate = arg('idDocumentIssueDate');
    const expiryDate = arg('idDocumentExpiryDate');
    if (issueDate) overrides.idDocumentIssueDate = new Date(issueDate);
    if (expiryDate) overrides.idDocumentExpiryDate = new Date(expiryDate);

    if (Object.keys(overrides).length > 0) {
        console.log('Overrides to apply:', overrides);
    } else {
        console.log('No CLI overrides provided — using whatever\'s already on the user record.');
    }

    step('3. Checking for anything still missing after overrides');
    const merged = { ...user, ...overrides };
    const required = {
        legalFirstName: merged.legalFirstName,
        legalLastName: merged.legalLastName,
        legalDateOfBirth: merged.legalDateOfBirth,
        legalGender: merged.legalGender,
        phoneNumber: merged.phoneNumber,
        dojahBvnRef: merged.dojahBvnRef,
        nationality: merged.nationality,
        addressLine1: merged.addressLine1,
    };
    const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length > 0) {
        console.error(`\n❌ Still missing after overrides: ${missing.join(', ')}`);
        console.error('   Pass these as CLI flags (see usage example at the top of this file).');
        process.exit(1);
    }
    console.log('✅ All required fields present.');

    if (!CONFIRMED) {
        console.log('\n🛑 Dry run only — nothing sent to Nuvion, nothing written to the DB.');
        console.log('   Re-run with --confirm to actually apply overrides and create the entity.');
        await prisma.$disconnect();
        return;
    }

    step('4. Applying overrides to the DB');
    if (Object.keys(overrides).length > 0) {
        await prisma.user.update({ where: { id: userId }, data: overrides });
        console.log('✅ User record updated.');
    }

    step('5. Calling Nuvion — createIndividualEntity()');
    const start = Date.now();
    const result = await createIndividualEntity(userId);
    console.log(`Completed in ${Date.now() - start}ms`);

    if (!result.success) {
        console.error('\n❌ FAILED:', result.error);
        console.error('Raw response:', JSON.stringify(result.rawData, null, 2));
        await prisma.$disconnect();
        return;
    }

    step('6. Result');
    console.log('✅ Entity created (or already existed)');
    console.log('entityId:', result.entityId);
    console.log('personId:', result.personId);
    console.log('status:', result.status);

    step('7. FULL raw response — this is the ground truth for field names');
    console.log(JSON.stringify(result.rawData, null, 2));
    console.log('\n👉 Compare the field names above against what nuvion.service.ts assumes');
    console.log('   (res.data?.id, res.data?.person_id, res.data?.status). Fix any mismatches');
    console.log('   now, before building anything further on top of this.');

    await prisma.$disconnect();
}

main().catch((e) => {
    console.error('Script crashed:', e);
    process.exit(1);
});