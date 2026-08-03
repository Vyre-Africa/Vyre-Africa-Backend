// scripts/testNuvionDocument.ts
//
// Tests real Nuvion document upload (POST /documents) against the entity
// already created for the test user. Uploads the identity document photo
// and/or proof-of-address photo, and logs the full raw response — same
// discipline as every other test in this project: don't trust
// nuvion.service.ts's assumed field names (documentId extraction) until
// we've seen what Nuvion actually returns.
//
// Usage:
//   npx ts-node --transpile-only -r dotenv/config scripts/testNuvionDocument.ts \
//     --userId=user_38OI3Y47pS0u4gKiRoee5GySGiV \
//     --key=identity \
//     --front=/path/to/id-front.jpg \
//     [--back=/path/to/id-back.jpg]
//
//   OR for proof of address:
//
//   npx ts-node --transpile-only -r dotenv/config scripts/testNuvionDocument.ts \
//     --userId=user_38OI3Y47pS0u4gKiRoee5GySGiV \
//     --key=address \
//     --front=/path/to/utility-bill.jpg

import fs from 'fs';
import path from 'path';
import prisma from '../config/prisma.client';
import { uploadNuvionDocument } from '../services/nuvion.service';

function arg(name: string): string | undefined {
    const match = process.argv.find(a => a.startsWith(`--${name}=`));
    return match?.split('=')[1];
}

function step(label: string) {
    console.log(`\n─── ${label} ${'─'.repeat(Math.max(0, 55 - label.length))}`);
}

function fileToBase64(filePath: string): string {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
    return fs.readFileSync(resolved).toString('base64');
}

function inferMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.pdf') return 'application/pdf';
    return 'image/jpeg'; // fallback
}

async function main() {
    const userId = arg('userId');
    const key = arg('key') as 'identity' | 'address' | undefined;
    const frontPath = arg('front');
    const backPath = arg('back');

    if (!userId || !key || !frontPath) {
        console.error('Usage: --userId=<id> --key=identity|address --front=/path/to/image.jpg [--back=/path/to/image.jpg]');
        process.exit(1);
    }
    if (key !== 'identity' && key !== 'address') {
        console.error('--key must be "identity" or "address"');
        process.exit(1);
    }

    step('1. Loading user — need existing Nuvion entity + person id');
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
        console.error(`❌ No user found with id ${userId}`);
        process.exit(1);
    }
    if (!user.nuvionEntityId || !user.nuvionPersonId) {
        console.error(`❌ User has no Nuvion entity yet. Run testNuvionEntity.ts --confirm first.`);
        process.exit(1);
    }
    console.log('entityId:', user.nuvionEntityId);
    console.log('personId:', user.nuvionPersonId);

    step('2. Reading and encoding image(s)');
    const fileBase64 = fileToBase64(frontPath);
    const fileBackBase64 = backPath ? fileToBase64(backPath) : undefined;
    console.log(`Front: ${(fileBase64.length / 1024).toFixed(0)} KB base64`);
    if (fileBackBase64) console.log(`Back: ${(fileBackBase64.length / 1024).toFixed(0)} KB base64`);

    step(`3. Uploading document [key=${key}] to Nuvion`);
    const start = Date.now();
    const result = await uploadNuvionDocument({
        entityId: user.nuvionEntityId,
        personId: user.nuvionPersonId,
        key,
        description: key === 'identity'
            ? `${user.idDocumentType ?? 'identity document'} for ${user.legalFirstName} ${user.legalLastName}`
            : 'Proof of address',
        fileBase64,
        fileBackBase64,
        mimeType: inferMimeType(frontPath),
    });
    console.log(`Completed in ${Date.now() - start}ms`);

    if (!result.success) {
        console.error('\n❌ FAILED:', result.error);
        console.error('Raw response:', JSON.stringify(result.rawData, null, 2));
        await prisma.$disconnect();
        return;
    }

    step('4. Result');
    console.log('✅ documentId:', result.documentId ?? '(not extracted — check raw response below)');

    step('5. FULL raw response — ground truth for field names');
    console.log(JSON.stringify(result.rawData, null, 2));
    console.log('\n👉 Compare against what nuvion.service.ts assumes (res.data?.id ?? res.data?.document_id).');
    console.log('   Fix the extraction if the real shape differs, same as entity creation needed.');

    await prisma.$disconnect();
}

main().catch((e) => {
    console.error('Script crashed:', e);
    process.exit(1);
});