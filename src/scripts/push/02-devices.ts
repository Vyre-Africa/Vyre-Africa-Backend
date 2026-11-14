/**
 * 02 — device registration, and the handover
 *
 *   npx tsx scripts/push/02-devices.ts
 *   npx tsx scripts/push/02-devices.ts <userIdA> <userIdB>
 *
 * Needs the database. Needs no Redis, no Expo credentials and no handset.
 *
 * ── The bug this exists to catch ───────────────────────────────────────
 *
 * Expo issues a push token per INSTALL, not per account. Sign in as Ada,
 * sign out, hand the phone to Bola, sign in as Bola — Expo returns the
 * same token both times.
 *
 * So if registration stores the token without reassigning its owner, the
 * row still says Ada. Every notification meant for Ada now rings on a
 * phone Bola is holding: "₦400,000.00 has landed in your wallet", on the
 * lock screen, to the wrong person. That is a confidentiality breach
 * reportable under NDPA, from a single missing line.
 *
 * The line is the `userId` inside the upsert's `update` block:
 *
 *     await prisma.deviceToken.upsert({
 *       where:  { token },
 *       create: { token, userId: user.id, ... },
 *       update: { userId: user.id, ... },   // ← this one
 *     });
 *
 * Leave it out and `create` still looks right, so the first install works,
 * every test with one account passes, and the fault only appears on a
 * shared or resold handset — which in this market is not an edge case.
 *
 * ── Two checks, because one is not enough ──────────────────────────────
 *
 * A: a STATIC read of devices.controller.ts, asserting the `update` block
 *    really does carry userId. The runtime test below issues its own
 *    statements, so on its own it would prove the database can do the
 *    right thing while production still does the wrong one.
 *
 * B: a RUNTIME exercise of the sequence, including that unregistering is
 *    scoped to the caller — Ada must not be able to delete the
 *    registration that now belongs to Bola.
 *
 * Nothing real is touched: the token is a clearly-marked synthetic value,
 * and the script removes it on the way out, including after a failure.
 */

/* Loads .env before anything imports the Prisma client.
 *
 * `tsx` does not do this on its own, and neither does @prisma/client in
 * v5+ — only the Prisma CLI reads .env. The server gets DATABASE_URL
 * because its entry point calls dotenv; a script that imports
 * config/prisma.client directly never goes through that, so without this
 * line Prisma falls back to its default and the run dies on ECONNREFUSED
 * with nothing to say about why.
 *
 * Must be the FIRST import: the Prisma client reads process.env when the
 * module is evaluated, so loading .env after it is too late. */
import 'dotenv/config';

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import prisma from '../../config/prisma.client';

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail?: string) {
  checks++;
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
  }
}

/* A synthetic token. Shaped like a real one so any validation on the way
   through accepts it, but with VYRETEST where the opaque part goes, so it
   is obvious in the table and cannot collide with a device. */
const TEST_TOKEN = 'ExponentPushToken[VYRETEST-02-devices]';

/* ──────────────────────────────────────────────────────────────────────
   A — static check on the controller
   ────────────────────────────────────────────────────────────────────── */

function staticCheck() {
  console.log('\nA · controller source\n');

  const candidates = [
    'src/controllers/devices.controller.ts',
    'src/controllers/device.controller.ts',
    'src/modules/devices/devices.controller.ts',
    'src/routes/devices.controller.ts',
  ];
  const found = candidates.map((p) => join(process.cwd(), p)).find((p) => existsSync(p));

  if (!found) {
    console.log('  SKIP  could not find devices.controller.ts');
    console.log('        looked in:');
    for (const c of candidates) console.log(`          ${c}`);
    console.log('        Add its path to `candidates` in this script, or check by eye that');
    console.log('        the deviceToken.upsert has `userId` in its `update` block — that is');
    console.log('        the whole point of this file.');
    return;
  }

  const src = readFileSync(found, 'utf8');
  console.log(`  read  ${found.replace(process.cwd() + '/', '')}`);

  const upsert = src.indexOf('deviceToken.upsert');
  check('controller upserts deviceToken', upsert !== -1,
    'no deviceToken.upsert found — registration may be using create(), which throws on a second install');

  if (upsert === -1) return;

  /* Read the `update:` block of that upsert specifically, rather than
     grepping the file for "userId" — which would match the `create` block
     and pass while the bug is present. */
  const tail = src.slice(upsert);
  const updateAt = tail.indexOf('update:');
  check('the upsert has an update block', updateAt !== -1);
  if (updateAt === -1) return;

  const afterUpdate = tail.slice(updateAt);
  const blockEnd = afterUpdate.indexOf('}');
  const updateBlock = afterUpdate.slice(0, blockEnd === -1 ? 200 : blockEnd + 1);

  check(
    'the update block reassigns userId',
    /userId\s*:/.test(updateBlock),
    `update block is:\n            ${updateBlock.replace(/\n\s*/g, ' ').trim()}\n` +
      '          On a handover this leaves the row owned by the previous user, and\n' +
      "          their notifications ring on the new user's phone.",
  );

  /* Unregister must be scoped. `delete({ where: { token } })` would let
     any authenticated user remove any device's registration by guessing or
     replaying a token — a denial of notifications for someone else,
     including the SECURITY_SIGNIN that would have warned them. */
  const hasScopedDelete = /deleteMany\s*\(\s*\{[^}]*where[^}]*userId/s.test(src);
  const hasUnscopedDelete = /deviceToken\.delete\s*\(\s*\{\s*where:\s*\{\s*token/.test(src);
  check(
    'unregister is scoped to the caller',
    hasScopedDelete && !hasUnscopedDelete,
    hasUnscopedDelete
      ? 'found an unscoped deviceToken.delete({ where: { token } }) — any user could\n' +
        "          deregister another user's handset, and it throws if the row is already gone"
      : 'no deleteMany with a userId in its where clause found',
  );
}

/* ──────────────────────────────────────────────────────────────────────
   B — runtime
   ────────────────────────────────────────────────────────────────────── */

/** Exactly the statement the controller runs. Kept in one place here so
 *  the sequence below reads as the sequence, not as six copies of it. */
async function registerAs(userId: string) {
  return prisma.deviceToken.upsert({
    where: { token: TEST_TOKEN },
    create: {
      token: TEST_TOKEN,
      userId,
      platform: 'ios',
      deviceName: 'Handover Test Device',
      osVersion: '18.1',
      appVersion: '1.0.0',
    },
    update: {
      userId,
      platform: 'ios',
      deviceName: 'Handover Test Device',
      osVersion: '18.1',
      appVersion: '1.0.0',
    },
  });
}

/** And the unregister, scoped the way the controller scopes it. */
async function unregisterAs(userId: string) {
  return prisma.deviceToken.deleteMany({ where: { token: TEST_TOKEN, userId } });
}

async function rows() {
  return prisma.deviceToken.findMany({ where: { token: TEST_TOKEN } });
}

async function resolveUsers(): Promise<[string, string] | null> {
  const [a, b] = process.argv.slice(2);
  if (a && b) {
    const found = await prisma.user.findMany({
      where: { id: { in: [a, b] } },
      select: { id: true },
    });
    const ids = found.map((u) => u.id);
    const missing = [a, b].filter((x) => !ids.includes(x));
    if (missing.length) {
      console.log(`\n  no such user: ${missing.join(', ')}\n`);
      return null;
    }
    return [a, b];
  }

  const recent = await prisma.user.findMany({
    select: { id: true, email: true },
    orderBy: { createdAt: 'desc' },
    take: 2,
  });
  if (recent.length < 2) {
    console.log('\n  needs two users in the database; found ' + recent.length + '.');
    console.log('  Pass ids explicitly: npx tsx scripts/push/02-devices.ts <a> <b>\n');
    return null;
  }
  console.log('\n  no ids given — using the two most recent users:');
  for (const u of recent) console.log(`    ${u.id}  ${u.email}`);
  return [recent[0].id, recent[1].id];
}

async function runtimeCheck(userA: string, userB: string) {
  console.log('\nB · the handover sequence\n');

  // Start clean, in case a previous run died mid-way.
  await prisma.deviceToken.deleteMany({ where: { token: TEST_TOKEN } });

  // 1 — Ada installs and signs in.
  await registerAs(userA);
  let r = await rows();
  check('after A registers: exactly one row', r.length === 1, `found ${r.length}`);
  check('after A registers: the row belongs to A', r[0]?.userId === userA, `userId is ${r[0]?.userId}`);
  const firstSeen = r[0]?.createdAt;

  // 2 — Ada reopens the app. Same token, same user. This must not duplicate.
  await registerAs(userA);
  r = await rows();
  check('re-registering the same user does not duplicate', r.length === 1, `found ${r.length}`);
  check(
    'createdAt is preserved across re-registration',
    r[0]?.createdAt?.getTime() === firstSeen?.getTime(),
    'the row was recreated rather than updated',
  );

  // 3 — the handover. Bola signs in on Ada's phone.
  await registerAs(userB);
  r = await rows();
  check('after the handover: still exactly one row', r.length === 1, `found ${r.length}`);
  check(
    'after the handover: the row belongs to B',
    r[0]?.userId === userB,
    `userId is still ${r[0]?.userId} — B's handset would receive A's notifications`,
  );

  // 4 — and A must no longer reach this handset at all.
  const aDevices = await prisma.deviceToken.findMany({ where: { userId: userA } });
  check(
    'A no longer has this device',
    !aDevices.some((d) => d.token === TEST_TOKEN),
    "A still owns the token — a push to A lands on the phone B is holding",
  );

  // 5 — A tries to unregister the device that is now B's. Nothing happens.
  const deletedByA = await unregisterAs(userA);
  r = await rows();
  check(
    "A cannot unregister B's device",
    deletedByA.count === 0 && r.length === 1,
    `deleteMany removed ${deletedByA.count} row(s) — unregister is not scoped to the caller`,
  );

  // 6 — B can, and it is idempotent: a second call must not throw.
  const deletedByB = await unregisterAs(userB);
  r = await rows();
  check('B can unregister their own device', deletedByB.count === 1 && r.length === 0);

  const again = await unregisterAs(userB);
  check(
    'unregistering twice is harmless',
    again.count === 0,
    'deleteMany should return count 0, not throw — a retried sign-out must not 500',
  );
}

/* ────────────────────────────────────────────────────────────────────── */

async function main() {
  console.log('\nDevice registration and handover');
  console.log('─'.repeat(78));

  staticCheck();

  const users = await resolveUsers();
  if (!users) {
    console.log('─'.repeat(78));
    console.log('\n  static checks only — no users to run the sequence against\n');
    return failures > 0 ? 1 : 0;
  }

  const [a, b] = users;
  if (a === b) {
    console.log('\n  A and B are the same user — the handover cannot be tested.\n');
    return 1;
  }

  try {
    await runtimeCheck(a, b);
  } finally {
    // Always, including after an assertion failure or a throw.
    await prisma.deviceToken.deleteMany({ where: { token: TEST_TOKEN } });
  }

  console.log(`\n${'─'.repeat(78)}`);
  console.log(`\n${checks} checks · ${failures} failed\n`);
  return failures > 0 ? 1 : 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('\n  threw:', err);
    await prisma.deviceToken.deleteMany({ where: { token: TEST_TOKEN } }).catch(() => {});
    await prisma.$disconnect();
    process.exit(1);
  });