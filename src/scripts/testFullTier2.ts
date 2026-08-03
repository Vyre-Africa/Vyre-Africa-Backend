// scripts/testFullTier2.ts
//
// Tests the ACTUAL consolidated Tier 2 flow: one ID photo, one selfie, one
// proof-of-address photo. Fires all three Dojah calls concurrently — the
// same way the real backend will do it.
//
// The utility bill photo has an extra step first: unlike the ID document
// endpoint, utility_bill REJECTS base64 and requires a real fetchable URL
// (confirmed live). So the bill gets uploaded to GCS and signed BEFORE the
// concurrent Dojah calls fire — this matches exactly what the real
// submission flow will need to do too.
//
// Usage:
//   npx ts-node --transpile-only -r dotenv/config scripts/testFullTier2.ts \
//     --id=/path/to/id-front.jpg \
//     --selfie=/path/to/selfie.jpg \
//     --bill=/path/to/utility-bill.jpg \
//     [--idback=/path/to/id-back.jpg] \
//     [--keep]

import fs from 'fs';
import path from 'path';
import { verifyTier2, analyzeDocument, analyzeUtilityBill } from '../services/dojah.service';
import { uploadToStorage, getSignedDownloadUrl, deleteFromStorage } from '../services/storage.service';

function arg(name: string): string | undefined {
    const match = process.argv.find(a => a.startsWith(`--${name}=`));
    return match?.split('=')[1];
}
const KEEP = process.argv.includes('--keep');

function step(label: string) {
    console.log(`\n─── ${label} ${'─'.repeat(Math.max(0, 55 - label.length))}`);
}

function fileToBase64(filePath: string): string {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
    return fs.readFileSync(resolved).toString('base64');
}

async function main() {
    const idPath = arg('id');
    const idBackPath = arg('idback');
    const selfiePath = arg('selfie');
    const billPath = arg('bill');

    if (!idPath || !selfiePath || !billPath) {
        console.error('Usage: --id=... --selfie=... --bill=... [--idback=...] [--keep]');
        process.exit(1);
    }

    step('1. Reading and encoding ID + selfie images (base64 — accepted by these endpoints)');
    const idImageBase64 = fileToBase64(idPath);
    const idBackImageBase64 = idBackPath ? fileToBase64(idBackPath) : undefined;
    const selfieImageBase64 = fileToBase64(selfiePath);

    console.log(`ID front: ${(idImageBase64.length / 1024).toFixed(0)} KB base64`);
    if (idBackImageBase64) console.log(`ID back: ${(idBackImageBase64.length / 1024).toFixed(0)} KB base64`);
    console.log(`Selfie: ${(selfieImageBase64.length / 1024).toFixed(0)} KB base64`);

    step('2. Uploading bill photo to GCS + generating signed URL (utility_bill rejects base64)');
    const billResolved = path.resolve(billPath);
    const billBuffer = fs.readFileSync(billResolved);
    const billExt = path.extname(billResolved) || '.jpg';
    const billObjectPath = `test/tier2-bill-test-${Date.now()}${billExt}`;

    await uploadToStorage(billBuffer, billObjectPath);
    const billSignedUrl = await getSignedDownloadUrl(billObjectPath, 10);
    console.log('Bill uploaded and signed URL generated.');

    step('3. Firing all three Dojah calls CONCURRENTLY (matches real flow)');
    const start = Date.now();

    const [faceMatchResult, documentResult, billResult] = await Promise.allSettled([
        verifyTier2({ selfieImageBase64, idImageBase64 }),
        analyzeDocument({ imageFrontBase64: idImageBase64, imageBackBase64: idBackImageBase64 }),
        analyzeUtilityBill({ imageUrl: billSignedUrl }),
    ]);

    console.log(`All three completed (or failed) in ${Date.now() - start}ms total`);

    // ── Face match ───────────────────────────────────────────────────────
    step('4. Face match (photoid/verify)');
    if (faceMatchResult.status === 'fulfilled' && faceMatchResult.value.success) {
        console.log('✅ Match:', faceMatchResult.value.match, `(confidence: ${faceMatchResult.value.confidence}%)`);
    } else {
        console.error('❌ Failed:', faceMatchResult.status === 'fulfilled' ? faceMatchResult.value.error : faceMatchResult.reason);
    }

    // ── Document analysis ────────────────────────────────────────────────
    step('5. Document analysis (field extraction)');
    if (documentResult.status === 'fulfilled' && documentResult.value.success) {
        const d = documentResult.value;
        console.log('✅ Valid:', d.isValid, `(${d.documentName}, ${d.documentCountry})`);
        const extracted = d.fields.filter(f => f.status === 1);
        console.log(`   Extracted ${extracted.length}/${d.fields.length} fields:`);
        extracted.forEach(f => console.log(`     ${f.field_key.padEnd(20)} = "${f.value}"`));
    } else {
        console.error('❌ Failed:', documentResult.status === 'fulfilled' ? documentResult.value.error : documentResult.reason);
    }

    // ── Utility bill ─────────────────────────────────────────────────────
    step('6. Utility bill analysis (address extraction)');
    if (billResult.status === 'fulfilled' && billResult.value.success) {
        const b = billResult.value;
        console.log('✅ Address:', [b.addressStreet, b.addressCity, b.addressState, b.addressCountry].filter(Boolean).join(', ') || '(not extracted)');
        console.log('   Is recent:', b.isRecent);
    } else {
        console.error('❌ Failed:', billResult.status === 'fulfilled' ? billResult.value.error : billResult.reason);
    }

    // ── Overall gate decision ────────────────────────────────────────────
    step('7. Would this pass the consolidated Tier 2 gate?');
    const faceMatchPassed = faceMatchResult.status === 'fulfilled' && faceMatchResult.value.match;
    const documentValid = documentResult.status === 'fulfilled' && documentResult.value.isValid;
    const billOk = billResult.status === 'fulfilled' && billResult.value.success;

    console.log('Face match passed:', faceMatchPassed);
    console.log('Document valid:', documentValid);
    console.log('Bill processed:', billOk);
    console.log('\nOVERALL:', (faceMatchPassed && documentValid && billOk) ? '✅ WOULD PASS' : '❌ WOULD BE REJECTED');

    step('8. Cleanup');
    if (KEEP) {
        console.log('Bill left in GCS at:', `gs://${process.env.KYC_DOCUMENTS_BUCKET}/${billObjectPath}`, '(--keep was passed)');
    } else {
        await deleteFromStorage(billObjectPath);
        console.log('Test bill object deleted from GCS.');
    }
}

main().catch((e) => {
    console.error('Script crashed:', e);
    process.exit(1);
});