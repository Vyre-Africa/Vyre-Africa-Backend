// scripts/testDocumentAnalysis.ts
//
// Uploads a real document image (front, optionally back) to Dojah's
// /api/v1/document/analysis endpoint and prints exactly what comes back —
// which fields actually extracted, which didn't, and whether the document
// was considered valid. This is the ground truth for building the KYC
// onboarding step's pre-fill logic — don't design the UI around the
// generic sample response in the docs, design it around what this
// endpoint actually returns for the document types your users will
// realistically submit (Nigerian passport, NIN slip, driver's licence...).
//
// Usage:
//   npx ts-node --transpile-only -r dotenv/config scripts/testDocumentAnalysis.ts \
//     --front=/path/to/front.jpg [--back=/path/to/back.jpg]

import fs from 'fs';
import path from 'path';
import { analyzeDocument } from '../services/dojah.service';

function arg(name: string): string | undefined {
    const match = process.argv.find(a => a.startsWith(`--${name}=`));
    return match?.split('=')[1];
}

function step(label: string) {
    console.log(`\n─── ${label} ${'─'.repeat(Math.max(0, 55 - label.length))}`);
}

function fileToBase64(filePath: string): string {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
        throw new Error(`File not found: ${resolved}`);
    }
    const buffer = fs.readFileSync(resolved);
    return buffer.toString('base64');
}

async function main() {
    const frontPath = arg('front');
    const backPath = arg('back');

    if (!frontPath) {
        console.error('Usage: --front=/path/to/front.jpg [--back=/path/to/back.jpg]');
        process.exit(1);
    }

    step('1. Reading and encoding image(s)');
    const imageFrontBase64 = fileToBase64(frontPath);
    console.log(`Front image loaded: ${frontPath} (${(imageFrontBase64.length / 1024).toFixed(0)} KB base64)`);

    let imageBackBase64: string | undefined;
    if (backPath) {
        imageBackBase64 = fileToBase64(backPath);
        console.log(`Back image loaded: ${backPath} (${(imageBackBase64.length / 1024).toFixed(0)} KB base64)`);
    } else {
        console.log('No back image provided — testing front-only (fine for passports, incomplete for most other ID types).');
    }

    step('2. Calling Dojah /api/v1/document/analysis');
    const result = await analyzeDocument({ imageFrontBase64, imageBackBase64 });

    if (!result.success) {
        console.error('❌ Call failed:', result.error);
        console.error('Raw response:', JSON.stringify(result.rawData, null, 2));
        return;
    }

    step('3. Document identification');
    console.log('Document name:', result.documentName ?? '(not identified)');
    console.log('Document country:', result.documentCountry ?? '(not identified)');
    console.log('Overall valid:', result.isValid, `(reason: ${result.reason})`);

    if (!result.isValid) {
        console.warn('\n⚠️  Dojah marked this document as NOT VALID.');
        console.warn('   Decide now whether your onboarding flow should block on this and');
        console.warn('   force a re-capture, or just flag it for manual review — don\'t leave');
        console.warn('   this undecided once the real UI is built.');
    }

    step('4. Field-by-field extraction results');
    const extracted = result.fields.filter(f => f.status === 1);
    const uncertain = result.fields.filter(f => f.status === 2);
    const missing = result.fields.filter(f => f.status === 0);

    console.log(`\n✅ Extracted (${extracted.length}):`);
    extracted.forEach(f => console.log(`   ${f.field_key.padEnd(20)} = "${f.value}"`));

    if (uncertain.length) {
        console.log(`\n⚠️  Uncertain (${uncertain.length}) — treat as NOT reliably pre-fillable:`);
        uncertain.forEach(f => console.log(`   ${f.field_key.padEnd(20)} = "${f.value}"`));
    }

    console.log(`\n❌ Not found (${missing.length}) — these fields must stay empty/manual in the UI:`);
    missing.forEach(f => console.log(`   ${f.field_key}`));

    step('5. Portrait image');
    console.log(result.portraitImage
        ? `Extracted — ${(result.portraitImage.length / 1024).toFixed(0)} KB base64 (not saved to disk by this script)`
        : 'Not extracted for this document.');

    step('6. Full raw response (for reference)');
    console.log(JSON.stringify(result.rawData, null, 2));
}

main().catch((e) => {
    console.error('Script crashed:', e);
    process.exit(1);
});