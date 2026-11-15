// ─────────────────────────────────────────────────────────────────────────────
// src/scripts/live-activity/00-payload.ts
//
//   npx ts-node src/scripts/live-activity/00-payload.ts
//
// Offline. No APNs key, no device, no network, no database. It builds every
// notification kind in both render modes and asserts what node-apn actually
// SERIALISES.
//
// Why this exists: every Live Activity field is set through `(n as any)`,
// because node-apn's typings do not know `event`, `contentState`, `timestamp`,
// `staleDate`, `dismissalDate` or `attributes`. Nothing type-checks that they
// reach the wire. If the installed version does not map one of them, the field
// is a plain JS property and compile() drops it — producing a push APNs
// ACCEPTS and the device ignores. From the phone that is indistinguishable from
// "nothing happened", which is the most expensive kind of bug to chase.
//
// Verified on @parse/node-apn 8.2.0: all of them map correctly. Run this after
// any bump of that package.
//
// What it does NOT catch: whether Voltra's native side understands the
// content-state, whether the token is valid, or whether Apple accepts the
// topic. Those need 01-send.ts and a device.
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import {
    buildStartNotification,
    buildUpdateNotification,
    buildEndNotification,
    dynamicAttributesType,
    payloadBytes,
    MAX_PAYLOAD_BYTES,
    MAX_LAYOUT_BYTES,
} from '../../services/apns.service';
import config from '../../config/env.config';

// ─── Harness ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string): void {
    if (ok) {
        passed++;
    } else {
        failed++;
        failures.push(detail ? `${name} — ${detail}` : name);
        console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
        return;
    }
    console.log(`  pass  ${name}`);
}

function apsOf(n: any): Record<string, any> {
    return JSON.parse(n.compile()).aps ?? {};
}

// Must match ACTIVITY_NAME and DEFINITION_ID in liveActivity.service.ts.
const ACTIVITY_NAME = 'VyreActivity';
const DEFINITION_ID = 'vyre_activity';

/**
 * STATIC content-state: the whole rendered view tree.
 *
 * 696 bytes of base64 — the size Voltra 2.4.0 actually produces for
 * VyreActivity's 4-step card, measured with renderLiveActivityToString. A short
 * placeholder here would make the static payload look smaller than the dynamic
 * one and turn the size comparison below into a check that passes while
 * asserting the opposite of the truth.
 */
const STATIC_STATE = {
    uiJsonData: 'G0sFAICqqqrq9XQ1YL+kAwiYq6iZeZjJLSPAI+8LZEJCQBxUzdTcDULN3EBVwT0zDRQgIU/HPOT5EANwMBZEYpIY4E6baNxwgzDBR8iGBOGO0NOgWcwLSqIWrcBKG99+fD6BsEI2RIjKmTbtxdYapdMFAhPC9V6mMJnl7F2py34KvXerSRcQUg/BTn3kU/UEQuwhiLPxHgYXau4CfLouNxfStJytQCnn/KqkCmo8BL1bkgsgRIhWb6rKBAX4fUqXIZi78YCpag0L/P3vf90oUkqVSpGkaoLz6eujWd6K9z//RA62baX1Anc02MFZwKwV+AcDVZC2JW1npawcgHRm3QyyBKF2UKBfklsLXVzHorZqM2Enaig1Srwzg1vSOkK4ylmDxDy4mCC4/QpODocUzBJNn6brcuj97+5NxDQmHlhL0rkTQdHKpF3AyZmYc3OTgTRi4oVJIS9mYgRGVtyjPiVahMtUb0vc9YF2aDsEZcqPmqlb4tOuRyQbZbHJgQWFToKbpsMAUYLRXgGWzLhUTrAQaYyF1sHJTDWwUTrNWpYtPkIEHLYJt3xyH3PqZm9eIUjV0JPzAQ5nWI0VlUyFTQy1YGB',
};

/** DYNAMIC content-state: plain props against the app's bundled definition. */
const DYNAMIC_STATE = {
    props: {
        title: 'Withdrawal',
        amount: '₦250,000.00',
        detail: 'GTBank ••••8832',
        stepIndex: 1,
        stepCount: 4,
        stepLabel: 'Converting',
        state: 'in_progress',
        deepLink: 'vyre://transaction/clz9k2m4x0001abcd',
    },
};

// ─── 1. Config ──────────────────────────────────────────────────────────────

console.log('\n1. config');

check(
    'APNS_BUNDLE_ID is set',
    typeof config.apns?.bundleId === 'string' && config.apns.bundleId.length > 0,
    `got ${JSON.stringify(config.apns?.bundleId)} — without it the topic is "undefined.push-type.liveactivity"`,
);

// Not a failure either way, but say it out loud. A development-signed build
// registers against SANDBOX; a sandbox token on the production gateway returns
// BadDeviceToken for every single push.
console.log(
    `  note  APNS_PRODUCTION=${String(config.apns?.production)} → ` +
    `${config.apns?.production ? 'PRODUCTION' : 'sandbox'} gateway. ` +
    `A dev/EAS development build needs sandbox; TestFlight and App Store need production.`,
);

// ─── 2. start, STATIC ───────────────────────────────────────────────────────

console.log('\n2. event: start — STATIC (server-rendered UI)');

const start = buildStartNotification({
    identity: { mode: 'static', activityName: ACTIVITY_NAME },
    contentState: STATIC_STATE,
    alert: { title: 'Withdrawal started', body: '₦250,000.00 on its way', sound: 'default' },
    options: { staleDate: 1800000000, dismissalDate: 1800003600 },
});
const startAps = apsOf(start);

check('topic ends .push-type.liveactivity', start.topic === `${config.apns?.bundleId}.push-type.liveactivity`, start.topic);
check('pushType is liveactivity', (start as any).pushType === 'liveactivity', String((start as any).pushType));
check('aps.event === "start"', startAps.event === 'start', JSON.stringify(startAps.event));
check('aps["content-state"] survives compile', !!startAps['content-state']);
check('content-state carries uiJsonData', !!startAps['content-state']?.uiJsonData);
check('aps.timestamp is an integer', Number.isInteger(startAps.timestamp), String(startAps.timestamp));
check('aps["attributes-type"] === VoltraAttributes', startAps['attributes-type'] === 'VoltraAttributes', JSON.stringify(startAps['attributes-type']));
check('aps.attributes.name === activityName', startAps.attributes?.name === ACTIVITY_NAME, JSON.stringify(startAps.attributes));
check('static attributes carry NO deepLinkUrl', startAps.attributes?.deepLinkUrl === undefined, JSON.stringify(startAps.attributes));
check('aps.alert present', !!startAps.alert);
check('aps["stale-date"] passed through', startAps['stale-date'] === 1800000000, String(startAps['stale-date']));
check('aps["dismissal-date"] passed through', startAps['dismissal-date'] === 1800003600, String(startAps['dismissal-date']));

// ─── 3. start, DYNAMIC ──────────────────────────────────────────────────────
//
// The two modes differ in exactly three fields, and the attributes-type is the
// one that cannot be wrong: the plugin generates ONE Swift struct per
// definition, so a mismatch leaves Apple with no type to attach the activity
// to and the start is rejected outright.

console.log('\n3. event: start — DYNAMIC (bundled definition + props)');

const dynStart = buildStartNotification({
    identity: {
        mode: 'dynamic',
        definitionId: DEFINITION_ID,
        activityName: ACTIVITY_NAME,
        deepLinkUrl: 'vyre://transaction/clz9k2m4x0001abcd',
    },
    contentState: DYNAMIC_STATE,
    alert: { title: 'Withdrawal started', body: '₦250,000.00 on its way', sound: 'default' },
});
const dynAps = apsOf(dynStart);

check(
    `attributes-type is the per-definition struct`,
    dynAps['attributes-type'] === 'VoltraVyreActivityLiveActivityAttributes',
    JSON.stringify(dynAps['attributes-type']),
);
check(
    'dynamicAttributesType matches @use-voltra/core',
    dynamicAttributesType('vyre_activity') === 'VoltraVyreActivityLiveActivityAttributes'
        && dynamicAttributesType('cross_border_transfer') === 'VoltraCrossBorderTransferLiveActivityAttributes',
    `${dynamicAttributesType('vyre_activity')} / ${dynamicAttributesType('cross_border_transfer')}`,
);
check('dynamic attributes carry name', dynAps.attributes?.name === ACTIVITY_NAME, JSON.stringify(dynAps.attributes));
check(
    'dynamic attributes carry deepLinkUrl',
    dynAps.attributes?.deepLinkUrl === 'vyre://transaction/clz9k2m4x0001abcd',
    JSON.stringify(dynAps.attributes),
);
check('dynamic content-state is props, not uiJsonData',
    !!dynAps['content-state']?.props && dynAps['content-state']?.uiJsonData === undefined,
    JSON.stringify(Object.keys(dynAps['content-state'] ?? {})));
check(
    'dynamic start is smaller than static',
    payloadBytes(dynStart) < payloadBytes(start),
    `dynamic ${payloadBytes(dynStart)}B vs static ${payloadBytes(start)}B — if this fails, STATIC_STATE is not a realistic render`,
);
console.log(
    `  note  dynamic start ${payloadBytes(dynStart)}B vs static ${payloadBytes(start)}B ` +
    `(${Math.round((1 - payloadBytes(dynStart) / payloadBytes(start)) * 100)}% smaller)`,
);

// ─── 4. update ──────────────────────────────────────────────────────────────

console.log('\n4. event: update');

const update = buildUpdateNotification({
    contentState: STATIC_STATE,
    options: { staleDate: 1800000000 },
});
const updateAps = apsOf(update);

check('aps.event === "update"', updateAps.event === 'update', JSON.stringify(updateAps.event));
check('aps["content-state"] survives compile', !!updateAps['content-state']);
check('aps.timestamp is an integer', Number.isInteger(updateAps.timestamp));
check('aps["stale-date"] passed through', updateAps['stale-date'] === 1800000000);

// attributes-type belongs to `start` alone. An update goes to the per-activity
// token, which already names the activity. Leaking it is how you end up with a
// SECOND activity instead of an updated one.
check('NO attributes-type on update', updateAps['attributes-type'] === undefined, JSON.stringify(updateAps['attributes-type']));
check('NO attributes on update', updateAps.attributes === undefined, JSON.stringify(updateAps.attributes));
check('no dismissal-date unless asked', updateAps['dismissal-date'] === undefined, String(updateAps['dismissal-date']));

// An update is mode-agnostic at the APNs layer — only the content-state shape
// differs, and the service reads the mode off the row so the two cannot be
// crossed. A dynamic activity handed { uiJsonData } decodes nothing.
const dynUpdate = buildUpdateNotification({ contentState: DYNAMIC_STATE });
check('dynamic update carries props', !!apsOf(dynUpdate)['content-state']?.props);
check('dynamic update is tiny', payloadBytes(dynUpdate) < 400, `${payloadBytes(dynUpdate)}B`);

// ─── 5. end ─────────────────────────────────────────────────────────────────

console.log('\n5. event: end');

const end = buildEndNotification({});
const endAps = apsOf(end);

check('aps.event === "end"', endAps.event === 'end', JSON.stringify(endAps.event));
check('aps["dismissal-date"] defaults to now', Number.isInteger(endAps['dismissal-date']), String(endAps['dismissal-date']));
check('end without final state omits content-state', endAps['content-state'] === undefined);
check('NO attributes-type on end', endAps['attributes-type'] === undefined);

const endWithState = buildEndNotification({
    finalContentState: STATIC_STATE,
    dismissalDate: 1800009999,
});
const endWithStateAps = apsOf(endWithState);
check('end WITH final state includes content-state', !!endWithStateAps['content-state']);
check('explicit dismissalDate wins', endWithStateAps['dismissal-date'] === 1800009999, String(endWithStateAps['dismissal-date']));

// ─── 6. Size budget ─────────────────────────────────────────────────────────
//
// The 4096-byte cap is on the SERIALISED payload, and the envelope is a flat
// 83 bytes. Voltra 2.4.0 compresses and base64-encodes the view tree, so the
// rendered uiJsonData contains ZERO quote characters and costs nothing to
// escape — the payload is simply layout + 83.
//
// This section pads with base64-shaped bytes to match that. An earlier draft
// used quote-dense raw JSON and derived a ×1.22 escaping factor, which is right
// for a hand-built tree and wrong for anything Voltra emits.
//
// Voltra also enforces its own ceiling inside renderLiveActivityToString and
// THROWS past it ("safe budget 3345B"), so in practice that is the gate and
// MAX_LAYOUT_BYTES is the backstop. Only STATIC mode can approach it at all.

console.log('\n6. payload size');

const envelope = payloadBytes(buildUpdateNotification({ contentState: { uiJsonData: '' } }));
console.log(`  note  envelope overhead: ${envelope}B`);

function layoutOf(bytes: number): string {
    // Base64 alphabet only, like Voltra's real output: no quotes, so no
    // escaping. Padding with JSON here would overstate the cost and make the
    // budget look tighter than it is.
    const unit = 'G0sFAICqqqrq9XQ1YL+kAwiYq6iZeZjJLSPAI+8LZEJCQBxUzdTcDULN3EBVwT0zDRQ';
    return unit.repeat(Math.max(1, Math.ceil(bytes / unit.length))).slice(0, bytes);
}

const atBudget = payloadBytes(buildUpdateNotification({ contentState: { uiJsonData: layoutOf(MAX_LAYOUT_BYTES) } }));
check(
    `a ${MAX_LAYOUT_BYTES}B layout still fits in ${MAX_PAYLOAD_BYTES}B`,
    atBudget <= MAX_PAYLOAD_BYTES,
    `${atBudget}B — MAX_LAYOUT_BYTES is too generous, lower it`,
);
check(
    'MAX_LAYOUT_BYTES is under Voltra\'s own 3345B ceiling',
    MAX_LAYOUT_BYTES <= 3345,
    `${MAX_LAYOUT_BYTES} — renderLiveActivityToString throws past 3345, so a higher value here is unreachable`,
);
console.log(`  note  layout at budget → payload ${atBudget}B (overhead ${atBudget - MAX_LAYOUT_BYTES}B, no escaping cost)`);

const overBudget = payloadBytes(buildUpdateNotification({ contentState: { uiJsonData: layoutOf(4200) } }));
check(
    'an oversized layout is detectably over the cap',
    overBudget > MAX_PAYLOAD_BYTES,
    `${overBudget}B — expected to exceed ${MAX_PAYLOAD_BYTES}B`,
);

check(
    'the real sample layout is nowhere near the cap',
    payloadBytes(update) < 1024,
    `${payloadBytes(update)}B`,
);

// ─── Result ─────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(72));
console.log(`  ${passed + failed} checks · ${failed} failed`);
if (failed > 0) {
    console.log('\n  failures:');
    for (const f of failures) console.log(`    · ${f}`);
    console.log(
        '\n  A missing aps key almost always means @parse/node-apn changed.\n' +
        '  Check `npm ls @parse/node-apn` — verified against 8.2.0.',
    );
}
console.log('─'.repeat(72) + '\n');

process.exit(failed > 0 ? 1 : 0);