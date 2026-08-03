// scripts/testUtilityBillAnalysis.ts
//
// Tests Dojah's utility bill analysis endpoint. Unlike the ID document
// analysis endpoint, this one requires a real fetchable URL — base64 is
// rejected (confirmed live). This script uploads the bill photo to GCS
// first (private), generates a short-lived signed URL, and hands that to
// Dojah — exactly the pattern the real backend will use, so this test
// doubles as a smoke test of the storage layer too.
//
// Usage:
//   npx ts-node --transpile-only -r dotenv/config scripts/testUtilityBillAnalysis.ts \
//     --bill=/path/to/utility-bill.jpg [--keep]
//
//   --keep leaves the test object in GCS afterward (default: deletes it,
//   since this is just a throwaway test upload, not a real user's document)

import fs from 'fs';
import path from 'path';
import { analyzeUtilityBill } from '../services/dojah.service';
import { uploadToStorage, getSignedDownloadUrl, deleteFromStorage } from '../services/storage.service';

function arg(name: string): string | undefined {
    const match = process.argv.find(a => a.startsWith(`--${name}=`));
    return match?.split('=')[1];
}
const KEEP = process.argv.includes('--keep');

function step(label: string) {
    console.log(`\n─── ${label} ${'─'.repeat(Math.max(0, 55 - label.length))}`);
}

async function main() {
    const billPath = arg('bill');

    if (!billPath) {
        console.error('Usage: --bill=/path/to/utility-bill.jpg [--keep]');
        process.exit(1);
    }

    step('1. Reading local file');
    const resolved = path.resolve(billPath);
    if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
    const buffer = fs.readFileSync(resolved);
    console.log(`File: ${resolved} (${(buffer.length / 1024).toFixed(0)} KB raw)`);

    const ext = path.extname(resolved) || '.jpg';
    const objectPath = `test/utility-bill-test-${Date.now()}${ext}`;

    step('2. Uploading to GCS (private)');
    const uploadResult = await uploadToStorage(buffer, objectPath);
    console.log('Uploaded to:', uploadResult.url);

    step('3. Generating short-lived signed URL');
    const signedUrl = await getSignedDownloadUrl(objectPath, 10); // 10 minutes — plenty for one Dojah fetch
    console.log('Signed URL generated (expires in 10 min)');

    step('4. Calling Dojah utility_bill analysis with the signed URL');
    const start = Date.now();
    const result = await analyzeUtilityBill({ imageUrl: signedUrl });
    console.log(`Completed in ${Date.now() - start}ms`);

    if (!result.success) {
        console.error('\n❌ Call failed or not successful:', result.error);
        console.error('Raw response:', JSON.stringify(result.rawData, null, 2));
    } else {
        step('5. Extracted address fields');
        console.log('Full name:', result.fullName ?? '(not extracted)');
        console.log('Street:', result.addressStreet ?? '(not extracted)');
        console.log('City:', result.addressCity ?? '(not extracted)');
        console.log('State:', result.addressState ?? '(not extracted)');
        console.log('Country:', result.addressCountry ?? '(not extracted)');

        step('6. Bill metadata');
        console.log('Provider:', result.providerName ?? '(not extracted)');
        console.log('Issue date:', result.billIssueDate ?? '(not extracted)');
        console.log('Amount paid:', result.amountPaid ?? '(not extracted)');
        console.log('Is recent:', result.isRecent);

        if (result.isRecent === false) {
            console.warn('\n⚠️  Dojah flagged this bill as NOT recent enough — decide now whether');
            console.warn('   your flow should block on this.');
        }

        step('7. Full raw response');
        console.log(JSON.stringify(result.rawData, null, 2));
    }

    step('8. Cleanup');
    if (KEEP) {
        console.log('Left in GCS at:', uploadResult.url, '(--keep was passed)');
    } else {
        await deleteFromStorage(objectPath);
        console.log('Test object deleted from GCS.');
    }
}

main().catch((e) => {
    console.error('Script crashed:', e);
    process.exit(1);
});