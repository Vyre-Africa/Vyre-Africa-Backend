// scripts/testPhotoIdVerify.ts
//
// Tests Dojah's photoid/verify endpoint (face-match between a selfie and
// an ID photo) with real images. Uses the existing verifyTier2() function
// from dojah.service.ts — this script doesn't add new logic, it just
// gives us a real result to look at before trusting it in the flow.
//
// Usage:
//   npx ts-node --transpile-only -r dotenv/config scripts/testPhotoIdVerify.ts \
//     --id=/path/to/id-front.jpg --selfie=/path/to/selfie.jpg

import fs from 'fs';
import path from 'path';
import { verifyTier2 } from '../services/dojah.service';

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

async function main() {
    const idPath = arg('id');
    const selfiePath = arg('selfie');

    if (!idPath || !selfiePath) {
        console.error('Usage: --id=/path/to/id-front.jpg --selfie=/path/to/selfie.jpg');
        process.exit(1);
    }

    step('1. Reading and encoding images');
    const idImageBase64 = fileToBase64(idPath);
    const selfieImageBase64 = fileToBase64(selfiePath);
    console.log(`ID image: ${(idImageBase64.length / 1024).toFixed(0)} KB base64`);
    console.log(`Selfie image: ${(selfieImageBase64.length / 1024).toFixed(0)} KB base64`);

    step('2. Calling Dojah photoid/verify');
    const start = Date.now();
    const result = await verifyTier2({ selfieImageBase64, idImageBase64 });
    console.log(`Completed in ${Date.now() - start}ms`);

    if (!result.success) {
        console.error('\n❌ Call failed:', result.error);
        console.error('Raw response:', JSON.stringify(result.rawData, null, 2));
        return;
    }

    step('3. Result');
    console.log('Match:', result.match);
    console.log('Confidence:', result.confidence, '%');
    console.log('(Dojah treats confidence >= 90 as a match)');

    if (!result.match) {
        console.warn('\n⚠️  No match. If you used a genuine matching selfie+ID pair, this is worth');
        console.warn('   investigating (bad image quality, lighting, ID photo too old, etc.) before');
        console.warn('   assuming the endpoint itself is unreliable.');
    }

    step('4. Full raw response');
    console.log(JSON.stringify(result.rawData, null, 2));
}

main().catch((e) => {
    console.error('Script crashed:', e);
    process.exit(1);
});