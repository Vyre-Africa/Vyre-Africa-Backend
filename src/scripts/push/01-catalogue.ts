/**
 * 01 — the catalogue, offline
 *
 *   npx tsx scripts/push/01-catalogue.ts
 *
 * No database, no Redis, no network, no device, no credentials. This is the
 * one you can run on a plane. Run it first, and again after every change to
 * notification.catalogue.ts.
 *
 * ── What it actually proves ────────────────────────────────────────────
 *
 * 1. EXHAUSTIVENESS, at compile time rather than at runtime. `SAMPLES` is
 *    typed so that every member of the VyreEvent union must appear, under
 *    its own key, with its own fields. Add a kind to the union and forget
 *    it here and this file stops compiling. A runtime loop could not do
 *    that — it can only check the kinds somebody remembered to list.
 *
 * 2. The three tables stay in step. `render`, `channelsFor` and
 *    `dedupeKeyFor` are three separate switches over the same union. The
 *    compiler catches a missing `case`; it cannot catch a `case` that
 *    returns something useless, so the assertions below do.
 *
 * 3. Dedupe keys discriminate by KIND, not just by id. The samples
 *    deliberately share ids — every transfer uses the same `txId`, both
 *    deposits the same `ref`, all three KYC events the same `sessionId` —
 *    so any two kinds that key the same way collide here instead of in
 *    production. The failure that buys: a transfer landing swallowed as a
 *    duplicate of its own submission, so the user is told their money is
 *    on the way and never told it arrived.
 *
 *    Note what this does NOT catch, so nobody trusts it further than it
 *    goes: one kind losing its suffix while the others keep theirs is
 *    still a distinct key, so it passes — correctly, since a lone
 *    rename is not a collision. Only an actual duplicate fails.
 *
 * ── Verified by mutation ──────────────────────────────────────────────
 *
 * These assertions were checked by breaking the catalogue on purpose and
 * confirming each break was caught, rather than by assuming a green run
 * means anything:
 *
 *   TRANSFER_SUBMITTED and TRANSFER_LANDED keyed alike  → caught
 *   DEPOSIT_CREDITED keyed as DEPOSIT_PENDING           → caught
 *   TRANSFER_LANDED returning no key at all             → caught
 *   GENERIC given push                                  → caught
 *   KYC_APPROVED marked mandatory                       → caught
 *   a url turned absolute                               → caught
 *   timeSensitive on a kind that does not push          → caught
 *
 * 4. The copy is sane: no empty strings, no `undefined` leaking from an
 *    optional field, no unexpanded `${...}`, every url a relative deep
 *    link, and the whole payload inside Expo's 4096-byte ceiling.
 *
 * ── What it cannot prove ──────────────────────────────────────────────
 *
 * That any of it is DELIVERED. Nothing here talks to Expo. Scripts 04 and
 * 05 do that, and only a real handset closes the loop.
 */

import {
  render,
  channelsFor,
  dedupeKeyFor,
  legacyTypeFor,
  type VyreEvent,
  type EventKind,
} from '../../services/notification.catalogue';

/* ──────────────────────────────────────────────────────────────────────
   Samples

   `Extract<VyreEvent, { kind: K }>` is what makes this a real check. A
   plain `Record<EventKind, VyreEvent>` would happily accept a
   TRANSFER_LANDED object filed under the KYC_APPROVED key.

   Ids are shared ON PURPOSE — see point 3 in the header.
   ────────────────────────────────────────────────────────────────────── */

type SampleMap = { [K in EventKind]: Extract<VyreEvent, { kind: K }> };

const TX = 'tx_shared_for_test';
const REF = 'ref_shared_for_test';
const SESSION = 'session_shared_for_test';

const SAMPLES: SampleMap = {
  TRANSFER_SUBMITTED: { kind: 'TRANSFER_SUBMITTED', txId: TX, amount: '$250.00', to: 'Ada Nwosu' },
  TRANSFER_LANDED: { kind: 'TRANSFER_LANDED', txId: TX, amount: '$250.00', to: 'Ada Nwosu' },
  TRANSFER_FAILED: { kind: 'TRANSFER_FAILED', txId: TX, amount: '$250.00', to: 'Ada Nwosu' },
  DEPOSIT_PENDING: { kind: 'DEPOSIT_PENDING', walletId: 'wal_1', amount: '₦400,000.00', ref: REF },
  DEPOSIT_CREDITED: { kind: 'DEPOSIT_CREDITED', walletId: 'wal_1', amount: '₦400,000.00', ref: REF },
  DEPOSIT_FAILED: { kind: 'DEPOSIT_FAILED', amount: '₦400,000.00', ref: REF, walletId: 'wal_1' },
  ORDER_COMPLETED: { kind: 'ORDER_COMPLETED', orderId: 'ord_1', side: 'BUY', got: '100.00 USDC', paid: '₦150,000.00' },
  WALLET_CREATED: { kind: 'WALLET_CREATED', walletId: 'wal_2', currency: 'USDC' },
  KYC_APPROVED: { kind: 'KYC_APPROVED', tier: 2 },
  KYC_DECLINED: { kind: 'KYC_DECLINED', sessionId: SESSION },
  KYC_REVIEW: { kind: 'KYC_REVIEW', sessionId: SESSION },
  LIMIT_WARNING: { kind: 'LIMIT_WARNING', period: '2026-11', used: '$8,400.00', limit: '$10,000.00' },
  SECURITY_SIGNIN: { kind: 'SECURITY_SIGNIN', device: 'iPhone 15 Pro', at: '2026-11-12T03:40:00Z' },
  SECURITY_PIN_CHANGED: { kind: 'SECURITY_PIN_CHANGED', at: '2026-11-12T03:41:00Z' },
  GENERIC: { kind: 'GENERIC', title: 'Scheduled maintenance', content: 'Transfers pause 02:00–02:30 WAT.' },
};

/**
 * TRANSFER_FAILED carries an optional `reason`, and the sample above omits
 * it. That is the interesting case — an optional field is where
 * `undefined` leaks into a body — so the variant WITH a reason is checked
 * too, rather than instead.
 */
const EXTRA_VARIANTS: VyreEvent[] = [
  { kind: 'TRANSFER_FAILED', txId: 'tx_other', amount: '$10.00', to: 'Ada', reason: 'insufficient balance' },
  { kind: 'GENERIC', title: 'With a link', content: 'Tap through.', url: '/wallet/wal_9' },
  // DEPOSIT_FAILED with no walletId — exercises the /(tabs)/activity fallback.
  { kind: 'DEPOSIT_FAILED', amount: '$50.00', ref: 'ref_other' },
  { kind: 'ORDER_COMPLETED', orderId: 'ord_2', side: 'SELL', got: '₦75,000.00', paid: '50.00 USDC' },
];

/* ──────────────────────────────────────────────────────────────────────
   Known routes

   Kept in step with the Stack.Screen names in the app's app/_layout.tsx,
   by hand, because this script runs in the backend repo and cannot read
   them.

   This list exists because its absence cost a bug. The catalogue shipped
   `/transactions/:id` and `/wallets/:id` — PLURAL — while the app
   registers `transaction/[id]` and `wallet/[id]`. Every transfer and
   deposit notification opened Expo's Unmatched Route screen. The checks
   below all passed, because "is it relative" and "does it have a scheme"
   are true of a url that points nowhere.

   A mismatch here is a notification whose tap goes nowhere, which is
   worse than no deep link at all: the user went looking for their money
   and the app told them the page does not exist.
   ────────────────────────────────────────────────────────────────────── */

const KNOWN_ROUTES = [
  '/(tabs)',
  '/(tabs)/settings',
  '/(tabs)/activity',
  '/transaction/:id',
  '/wallet/:id',
  '/kyc',
  '/fund',
  '/send',
  '/new-wallet',
  '/verify',
  '/notifications',
];

/**
 * Does this url match any registered route?
 *
 * Matches against the patterns rather than trying to guess which segments
 * of the url are ids. The first version of this did guess — "anything
 * after the first segment that is not a (group) is an id" — and promptly
 * reported `/(tabs)/settings` as broken, because `settings` is a literal.
 * A test that cries wolf about correct code gets switched off.
 */
function matchesKnownRoute(url: string): boolean {
  return KNOWN_ROUTES.some((route) => {
    const pattern =
      '^' +
      route
        .split('/')
        .map((seg) =>
          seg === ':id'
            ? '[^/]+'
            : // (tabs) and friends are literals containing regex characters
              seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        )
        .join('/') +
      '$';
    return new RegExp(pattern).test(url);
  });
}

/* ──────────────────────────────────────────────────────────────────────
   Tiny harness

   Deliberately not jest/vitest. This has to be runnable by anyone who has
   just cloned the repo, with no test runner configured and no config file
   to get wrong, and it has to be readable as documentation of what the
   rules are.
   ────────────────────────────────────────────────────────────────────── */

let failures = 0;
let warnings = 0;
let checks = 0;

function check(label: string, condition: boolean, detail?: string) {
  checks++;
  if (!condition) {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
  }
}

function warn(label: string, condition: boolean, detail?: string) {
  checks++;
  if (!condition) {
    warnings++;
    console.log(`  WARN  ${label}${detail ? `\n          ${detail}` : ''}`);
  }
}

/** Expo's documented per-message ceiling, `data` included. */
const MAX_PAYLOAD_BYTES = 4096;

/**
 * Advisory only — these are rules of thumb from how iOS and Android lay out
 * a banner, NOT published limits. Over them the text still arrives, it just
 * gets an ellipsis on the lock screen, which for "Transfer didn't go
 * through — you have not been charged" is the half that matters.
 */
const TITLE_SOFT_LIMIT = 40;
const BODY_SOFT_LIMIT = 120;

const PLACEHOLDER_LEAKS = ['undefined', 'null', 'NaN', '${', '[object Object]'];

/* ──────────────────────────────────────────────────────────────────────
   Per-event checks
   ────────────────────────────────────────────────────────────────────── */

const USER = 'user_test_catalogue';
const allKinds = Object.keys(SAMPLES) as EventKind[];
const everyEvent: VyreEvent[] = [...allKinds.map((k) => SAMPLES[k]), ...EXTRA_VARIANTS];

console.log(`\nCatalogue — ${allKinds.length} kinds, ${everyEvent.length} events under test\n`);
console.log('─'.repeat(78));

for (const event of everyEvent) {
  const r = render(event);
  const policy = channelsFor(event.kind);
  const key = dedupeKeyFor(USER, event);

  const flags = [
    policy.inApp ? 'in-app' : null,
    policy.push ? 'push' : null,
    policy.email ? 'email' : null,
    policy.sms ? 'sms' : null,
    policy.realtime ? 'realtime' : null,
    policy.mandatory ? 'MANDATORY' : null,
    r.timeSensitive ? 'time-sensitive' : null,
    r.sound ? 'sound' : null,
  ].filter(Boolean);

  console.log(`\n${event.kind}`);
  console.log(`  title  ${r.title}`);
  console.log(`  body   ${r.body}`);
  console.log(`  url    ${r.url}`);
  console.log(`  →      ${flags.join(' · ')}`);
  console.log(`  key    ${key ?? '(none — not deduped)'}`);
  console.log(`  type   ${legacyTypeFor(event.kind)}`);

  // Copy exists at all.
  check(`${event.kind}: title is not empty`, r.title.trim().length > 0);
  check(`${event.kind}: body is not empty`, r.body.trim().length > 0);

  // Nothing leaked from an interpolation or an absent optional field.
  for (const leak of PLACEHOLDER_LEAKS) {
    check(
      `${event.kind}: title has no "${leak}"`,
      !r.title.includes(leak),
      `title was: ${r.title}`,
    );
    check(
      `${event.kind}: body has no "${leak}"`,
      !r.body.includes(leak),
      `body was: ${r.body}`,
    );
  }

  // Length, advisory.
  warn(
    `${event.kind}: title fits a banner (${r.title.length} chars)`,
    r.title.length <= TITLE_SOFT_LIMIT,
    `${r.title.length} > ${TITLE_SOFT_LIMIT} — will truncate on a lock screen`,
  );
  warn(
    `${event.kind}: body fits a banner (${r.body.length} chars)`,
    r.body.length <= BODY_SOFT_LIMIT,
    `${r.body.length} > ${BODY_SOFT_LIMIT} — will truncate on a lock screen`,
  );

  /* The url reaches the client inside a server payload and the app routes
     on it. An absolute url there is an open redirect — someone who can
     influence an event's fields could land a Vyre notification that opens
     a page they control. push.service.ts is the enforcement point; this is
     the check that the catalogue never hands it one. */
  check(
    `${event.kind}: url is a relative deep link`,
    r.url.startsWith('/'),
    `url was: ${r.url}`,
  );
  check(
    `${event.kind}: url has no scheme or host`,
    !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(r.url),
    `url was: ${r.url}`,
  );

  /* The check that was missing. A relative url with no scheme is still a
     dead end if the app registers no such route — see KNOWN_ROUTES. */
  check(
    `${event.kind}: url points at a route the app registers`,
    matchesKnownRoute(r.url),
    `"${r.url}" matches none of KNOWN_ROUTES.\n` +
      '          Either the catalogue is wrong, or app/_layout.tsx gained a screen\n' +
      '          and KNOWN_ROUTES in this file was not updated with it.',
  );

  /* Marking something time-sensitive while not pushing it is a
     contradiction: interruptionLevel only exists on a push. If this fires,
     either the policy or the render is wrong. */
  check(
    `${event.kind}: time-sensitive implies push`,
    !r.timeSensitive || policy.push,
    'timeSensitive: true but policy.push: false',
  );

  /* Mandatory means "ignore the user's NotificationSetting". That is a
     real override of an expressed preference, so it is allowed for exactly
     one category: noticing an account takeover. If a product event ever
     acquires it, this fails loudly. */
  check(
    `${event.kind}: mandatory only on SECURITY_*`,
    !policy.mandatory || event.kind.startsWith('SECURITY_'),
    'non-security event is set mandatory — it would bypass user settings',
  );

  // Every channel flag must be a real boolean, not undefined from a
  // half-filled POLICY row.
  for (const [name, value] of Object.entries(policy)) {
    check(`${event.kind}: policy.${name} is a boolean`, typeof value === 'boolean');
  }

  /* Size. This is the actual push body plus the actual data object, which
     is the pair that counts against Expo's limit. Ids only in `data` is
     why these come out around 300 bytes rather than near the ceiling. */
  const payload = JSON.stringify({
    to: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
    title: r.title,
    body: r.body,
    sound: r.sound ? 'default' : undefined,
    interruptionLevel: r.timeSensitive ? 'time-sensitive' : 'active',
    channelId: 'default',
    priority: r.timeSensitive ? 'high' : 'default',
    data: { kind: event.kind, url: r.url },
    ttl: 60 * 60 * 6,
  });
  const bytes = Buffer.byteLength(payload, 'utf8');
  check(
    `${event.kind}: payload within ${MAX_PAYLOAD_BYTES} bytes`,
    bytes <= MAX_PAYLOAD_BYTES,
    `${bytes} bytes`,
  );

  /* Determinism. The key is used as BullMQ's jobId AND as a unique column.
     If it varied between calls — a timestamp taken inside the function,
     say — dedupe would silently never fire and the unique index would
     never collide. */
  check(
    `${event.kind}: dedupe key is deterministic`,
    dedupeKeyFor(USER, event) === key,
    'two calls with identical input returned different keys',
  );
}

/* ──────────────────────────────────────────────────────────────────────
   Cross-event checks
   ────────────────────────────────────────────────────────────────────── */

console.log(`\n${'─'.repeat(78)}\n`);

/* The point of the shared ids. Three transfer events share one txId, two
   deposits share one ref, three KYC events share one sessionId. If any
   pair collides, one of those notifications is unsendable: the second
   arrival is dropped as a replay of the first. */
const keyed = allKinds
  .map((k) => ({ kind: k, key: dedupeKeyFor(USER, SAMPLES[k]) }))
  .filter((x): x is { kind: EventKind; key: string } => x.key !== null);

const seen = new Map<string, EventKind>();
for (const { kind, key } of keyed) {
  const prior = seen.get(key);
  check(
    `dedupe key is unique to its kind: ${kind}`,
    prior === undefined,
    prior ? `collides with ${prior} on "${key}" — one of the two can never be delivered` : undefined,
  );
  seen.set(key, kind);
}
console.log(`  ${keyed.length} of ${allKinds.length} kinds are deduped, ${seen.size} distinct keys`);

/* GENERIC is the legacy escape hatch. It must stay off push: those call
   sites were written to send an email, and turning them into phone
   notifications retroactively would surprise users rather than delight
   them. It is also the only kind allowed to have no dedupe key, because a
   free-form caller has nothing stable to key on. */
check(
  'GENERIC does not push',
  channelsFor('GENERIC').push === false,
  'GENERIC gained push — every legacy queue() call site would start buzzing phones',
);
check(
  'GENERIC has no dedupe key',
  dedupeKeyFor(USER, SAMPLES.GENERIC) === null,
  'a key invented from free-form text would collapse two different messages',
);
for (const kind of allKinds) {
  if (kind === 'GENERIC') continue;
  check(
    `${kind} has a dedupe key`,
    dedupeKeyFor(USER, SAMPLES[kind]) !== null,
    'only GENERIC may be undeduped — everything else is replayable by a webhook',
  );
}

/* Money landing or failing is the one thing worth breaking Focus for. If
   this list grows, time-sensitive stops meaning anything and iOS
   eventually demotes the app. Edit the expectation deliberately. */
const EXPECTED_TIME_SENSITIVE: EventKind[] = [
  'TRANSFER_LANDED',
  'TRANSFER_FAILED',
  'DEPOSIT_CREDITED',
  'DEPOSIT_FAILED',
  'SECURITY_SIGNIN',
  'SECURITY_PIN_CHANGED',
];
const actualTimeSensitive = allKinds.filter((k) => render(SAMPLES[k]).timeSensitive).sort();
check(
  'the time-sensitive set is exactly what was agreed',
  JSON.stringify(actualTimeSensitive) === JSON.stringify([...EXPECTED_TIME_SENSITIVE].sort()),
  `expected [${[...EXPECTED_TIME_SENSITIVE].sort().join(', ')}]\n          got      [${actualTimeSensitive.join(', ')}]`,
);

/* ────────────────────────────────────────────────────────────────────── */

console.log(`\n${'─'.repeat(78)}`);
console.log(`\n${checks} checks · ${failures} failed · ${warnings} warnings\n`);
process.exit(failures > 0 ? 1 : 0);