// ─────────────────────────────────────────────────────────────────────────────
// scripts/live-activity/check-key.ts
//
//   npx ts-node scripts/live-activity/check-key.ts
//
// Validates the APNs credentials locally. No network, no device, nothing sent.
// It proves the key parses and can sign an ES256 JWT of the exact shape Apple
// expects, and that the three ids alongside it are plausible.
//
// Why bother: a mangled .p8 and a wrong key file produce the SAME opaque error
// from OpenSSL — `error:1E08010C:DECODER routines::unsupported`. If you only
// find that out from a failed push, you cannot tell a newline problem from a
// credential problem, and the next thing you do is rebuild the app for no
// reason. Measured: of the four plausible ways to put a .p8 in a .env, two
// work and two fail with that same message.
//
// Run this BEFORE 01-send.ts and before any device test.
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import crypto from 'crypto';
import config from '../../config/env.config';

let passed = 0;
let failed = 0;
const notes: string[] = [];

function check(name: string, ok: boolean, detail?: string): boolean {
    if (ok) {
        passed++;
        console.log(`  pass  ${name}`);
    } else {
        failed++;
        console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
    }
    return ok;
}

console.log('\n1. presence');

const haveKey = check(
    'APNS_KEY_CONTENT is set',
    !!config.apns?.keyContent,
    'empty — base64 the .p8: base64 -i AuthKey_XXXXXXXXXX.p8 | tr -d "\\n"',
);
const haveKeyId = check('APNS_KEY_ID is set', !!config.apns?.keyId);
const haveTeam = check('APNS_TEAM_ID is set', !!config.apns?.teamId);
check(
    'APNS_BUNDLE_ID is set',
    !!config.apns?.bundleId,
    'without it the topic becomes "undefined.push-type.liveactivity"',
);

console.log('\n2. ids');

// Apple's key and team ids are both 10 characters. Not a hard rule anywhere in
// the docs, but every one issued is, and a mismatch here is almost always
// someone having pasted the filename or an app id by mistake.
if (haveKeyId) {
    check(
        'APNS_KEY_ID looks like a key id (10 chars)',
        /^[A-Z0-9]{10}$/.test(config.apns!.keyId!),
        `got "${config.apns!.keyId}" — expected the 10 chars from AuthKey_XXXXXXXXXX.p8`,
    );
}
if (haveTeam) {
    check(
        'APNS_TEAM_ID looks like a team id (10 chars)',
        /^[A-Z0-9]{10}$/.test(config.apns!.teamId!),
        `got "${config.apns!.teamId}" — it is on the portal's Membership page`,
    );
}
if (config.apns?.bundleId) {
    check(
        'APNS_BUNDLE_ID has no push-type suffix',
        !config.apns.bundleId.includes('push-type'),
        'the service appends ".push-type.liveactivity" itself — do not include it',
    );
}

console.log('\n3. key material');

let key: crypto.KeyObject | null = null;

if (haveKey) {
    const content = config.apns!.keyContent!;

    // These two inspect the RAW env var, not config.apns.keyContent — by the
    // time it reaches config it has already been decoded, so testing the
    // decoded value would report "PEM" for every input, base64 included.
    const rawEnv = process.env.APNS_KEY_CONTENT ?? '';

    notes.push(
        rawEnv.includes('-----BEGIN')
            ? 'APNS_KEY_CONTENT is PEM in the env. If pasted with literal \\n, env.config must un-escape it.'
            : 'APNS_KEY_CONTENT is base64 in the env, decoded by env.config.',
    );

    check(
        'no stray surrounding quotes',
        !/^["'].*["']$/s.test(rawEnv.trim()),
        'the value is wrapped in quotes — some .env loaders keep them, which breaks the decode',
    );

    try {
        key = crypto.createPrivateKey(content);
        check('key parses', true);
    } catch (err: any) {
        check(
            'key parses',
            false,
            `${err.message.split('\n')[0]} — this same error means EITHER mangled newlines OR the wrong file`,
        );
    }
}

if (key) {
    check(
        'key is EC, not RSA',
        key.asymmetricKeyType === 'ec',
        `got ${key.asymmetricKeyType} — an APNs auth key is EC. An RSA key means you downloaded a certificate, not a key`,
    );
    check(
        'curve is prime256v1 (P-256)',
        (key.asymmetricKeyDetails as any)?.namedCurve === 'prime256v1',
        `got ${(key.asymmetricKeyDetails as any)?.namedCurve}`,
    );
}

console.log('\n4. ES256 signing');

// Gated on EC deliberately. crypto.sign('sha256', …) succeeds for an RSA key
// too — it just signs RSA-SHA256 — so without this gate the line below reports
// "signs an ES256 provider token" for a key that cannot produce ES256 at all.
if (key && key.asymmetricKeyType === 'ec' && haveKeyId && haveTeam) {
    try {
        // The exact JWT node-apn builds. If this signs, the provider will too.
        const header = { alg: 'ES256', kid: config.apns!.keyId };
        const claims = { iss: config.apns!.teamId, iat: Math.floor(Date.now() / 1000) };
        const b64 = (o: object) =>
            Buffer.from(JSON.stringify(o)).toString('base64url');
        const signingInput = `${b64(header)}.${b64(claims)}`;

        const der = crypto.sign('sha256', Buffer.from(signingInput), {
            key,
            dsaEncoding: 'der',
        });
        check('signs an ES256 provider token', der.length > 0, `${der.length} bytes`);

        // Round-trip against the public half. Proves the signature is real and
        // not merely that sign() returned bytes.
        const pub = crypto.createPublicKey(key);
        const ok = crypto.verify(
            'sha256',
            Buffer.from(signingInput),
            { key: pub, dsaEncoding: 'der' },
            der,
        );
        check('signature verifies against its own public key', ok);
    } catch (err: any) {
        check('signs an ES256 provider token', false, err.message.split('\n')[0]);
    }
} else if (key && key.asymmetricKeyType !== 'ec') {
    console.log(`  skip  (key is ${key.asymmetricKeyType}, not EC — ES256 is impossible, see above)`);
} else {
    console.log('  skip  (needs a parsed EC key plus APNS_KEY_ID and APNS_TEAM_ID)');
}

console.log('\n5. gateway');

const production = Boolean(config.apns?.production);
console.log(
    `  note  APNS_PRODUCTION=${String(config.apns?.production)} → ${production ? 'PRODUCTION' : 'sandbox'} gateway`,
);
console.log(
    production
        ? '        Correct for TestFlight and App Store builds.\n' +
          '        WRONG for a local or EAS development build: those register against\n' +
          '        sandbox, and a sandbox token on this gateway returns BadDeviceToken\n' +
          '        for every push.'
        : '        Correct for a development build, which is what you are testing on.\n' +
          '        Flip to true for TestFlight and App Store.',
);

console.log('\n' + '─'.repeat(72));
for (const n of notes) console.log(`  note  ${n}`);
console.log(`  ${passed + failed} checks · ${failed} failed`);
if (failed === 0) {
    console.log('\n  Credentials are sound. Nothing here proves Apple ACCEPTS them —');
    console.log('  that needs 01-send.ts and a real token — but a failure now would');
    console.log('  have looked exactly like a bad device token.');
}
console.log('─'.repeat(72) + '\n');

process.exit(failed > 0 ? 1 : 0);