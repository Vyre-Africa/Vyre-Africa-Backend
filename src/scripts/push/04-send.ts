/**
 * 04 — a real send to a real handset
 *
 *   # connectivity probe: are the credentials right at all?
 *   npx tsx scripts/push/04-send.ts --raw --token="ExponentPushToken[xxxx]"
 *
 *   # the real path, through sendToUser and the catalogue
 *   npx tsx scripts/push/04-send.ts --user=<userId> --event=TRANSFER_LANDED
 *
 *   # same, registering a token for that user first
 *   npx tsx scripts/push/04-send.ts --user=<id> --token="ExponentPushToken[xxxx]"
 *
 * Needs the database, Expo credentials, and a handset with a token. Get the
 * token from the app — the mobile checklist (MOBILE-E2E.md, step 2) says
 * where it is logged.
 *
 * ── Two modes, and why both ────────────────────────────────────────────
 *
 * When a notification does not arrive there are two quite different
 * causes, and guessing between them wastes an evening:
 *
 *   --raw   sends the smallest message Expo will accept: to, title, body,
 *           nothing else. If this arrives, the APNs/FCM credentials and
 *           the token are good, and any failure of the real path is in the
 *           payload or the data model. If this does NOT arrive, stop
 *           looking at this repo and go to `eas credentials`.
 *
 *   default goes through push.service.sendToUser, so it exercises the
 *           DeviceToken lookup, the catalogue copy, interruptionLevel,
 *           channelId, ttl, token validation, ticket handling and the
 *           PushReceipt rows. This is the one that proves the system works.
 *
 * The --raw message is deliberately minimal rather than a copy of the real
 * one. A second copy of the production payload is exactly the drift that
 * put `interruptionLevel` in the wrong place in Spondle for months.
 *
 * ── This bypasses notification.service on purpose ──────────────────────
 *
 * No Notification row, no settings check, no dedupe. So you can run it
 * repeatedly with the same event and keep getting notifications, which is
 * what you want while standing there looking at a phone. Script 03 covers
 * the dispatcher.
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

import { Expo } from 'expo-server-sdk';
import prisma from '../../config/prisma.client';
import { sendToUser } from '../../services/push.service';
import { render, type VyreEvent } from '../../services/notification.catalogue';

/* ──────────────────────────────────────────────────────────────────────
   Args
   ────────────────────────────────────────────────────────────────────── */

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const token = arg('token');
const userId = arg('user');
const kind = (arg('event') ?? 'TRANSFER_LANDED') as VyreEvent['kind'];
const raw = flag('raw');
const keep = flag('keep');

/** A handful of events worth firing at a real phone. */
function sample(k: VyreEvent['kind']): VyreEvent {
  const stamp = new Date().toISOString();
  switch (k) {
    case 'TRANSFER_LANDED':
      return { kind: 'TRANSFER_LANDED', txId: 'tx_manual_test', amount: '$250.00', to: 'Ada Nwosu' };
    case 'TRANSFER_FAILED':
      return { kind: 'TRANSFER_FAILED', txId: 'tx_manual_test', amount: '$250.00', to: 'Ada Nwosu', reason: 'bank declined' };
    case 'DEPOSIT_CREDITED':
      return { kind: 'DEPOSIT_CREDITED', walletId: 'wal_manual', amount: '₦400,000.00', ref: 'ref_manual' };
    case 'KYC_APPROVED':
      return { kind: 'KYC_APPROVED', tier: 2 };
    case 'SECURITY_SIGNIN':
      return { kind: 'SECURITY_SIGNIN', device: 'iPhone 15 Pro', at: stamp };
    default:
      console.log(`\n  --event=${k} has no sample in this script.`);
      console.log('  Try: TRANSFER_LANDED, TRANSFER_FAILED, DEPOSIT_CREDITED, KYC_APPROVED, SECURITY_SIGNIN\n');
      process.exit(1);
  }
}

/* ──────────────────────────────────────────────────────────────────────
   Raw probe
   ────────────────────────────────────────────────────────────────────── */

async function rawSend(to: string) {
  console.log('\n  mode   raw connectivity probe');

  if (!Expo.isExpoPushToken(to)) {
    console.log(`\n  "${to}" is not a valid Expo push token.`);
    console.log('  Expected ExponentPushToken[...] or ExpoPushToken[...].\n');
    return 1;
  }

  const expo = new Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN });
  const tickets = await expo.sendPushNotificationsAsync([
    { to, title: 'Vyre test', body: `Raw probe at ${new Date().toLocaleTimeString()}` },
  ]);

  const ticket = tickets[0];
  console.log(`\n  ticket ${JSON.stringify(ticket, null, 2).replace(/\n/g, '\n         ')}`);

  if (ticket.status === 'ok') {
    console.log('\n  Expo accepted it. That is NOT delivery — the receipt, about 15');
    console.log('  minutes from now, is what knows. Run 05-receipts.ts then, or just');
    console.log('  look at the phone.\n');
    return 0;
  }

  console.log(`\n  rejected: ${ticket.message}`);
  if (ticket.details?.error === 'DeviceNotRegistered') {
    console.log('  The token is stale — the app was uninstalled or the token rotated.');
    console.log('  Get a fresh one from the app.');
  }
  console.log('');
  return 1;
}

/* ──────────────────────────────────────────────────────────────────────
   The real path
   ────────────────────────────────────────────────────────────────────── */

async function realSend(uid: string) {
  const event = sample(kind);
  const r = render(event);

  console.log('\n  mode   real — through sendToUser');
  console.log(`  user   ${uid}`);
  console.log(`  event  ${event.kind}`);
  console.log(`\n  This is what should appear on the phone:`);
  console.log(`    ${r.title}`);
  console.log(`    ${r.body}`);
  console.log(`\n  interruptionLevel  ${r.timeSensitive ? 'time-sensitive' : 'active'}`);
  console.log(`  deep link          ${r.url}`);

  let createdRegistration = false;

  if (token) {
    if (!Expo.isExpoPushToken(token)) {
      console.log(`\n  "${token}" is not a valid Expo push token.\n`);
      return 1;
    }
    const existing = await prisma.deviceToken.findUnique({ where: { token } });
    createdRegistration = !existing;
    await prisma.deviceToken.upsert({
      where: { token },
      create: {
        token,
        userId: uid,
        platform: 'ios',
        deviceName: 'Manual test (04-send.ts)',
        appVersion: '1.0.0',
      },
      update: { userId: uid },
    });
    console.log(`\n  ${createdRegistration ? 'registered' : 'reassigned'} the token to this user`);
  }

  const devices = await prisma.deviceToken.findMany({
    where: { userId: uid },
    select: { token: true, platform: true, deviceName: true, lastSeenAt: true },
  });

  if (devices.length === 0) {
    console.log('\n  This user has no registered devices, so there is nothing to send to.');
    console.log('  Either pass --token=... to register one, or register from the app');
    console.log('  (MOBILE-E2E.md step 2).\n');
    return 1;
  }

  console.log(`\n  devices (${devices.length}):`);
  for (const d of devices) {
    const masked = d.token.slice(0, 22) + '…]';
    console.log(`    ${masked}  ${d.platform}  ${d.deviceName ?? ''}`);
  }

  const result = await sendToUser(uid, event);

  /* Scoped by this user's tokens rather than by a row count taken before
     the send: `createdAt` is a database default, so comparing it against a
     timestamp from this process would drift with any clock skew between
     Node and Postgres, and the one-minute window below is only a guard
     against picking up receipts from an earlier run. */
  const after = await prisma.pushReceipt.findMany({
    where: {
      token: { in: devices.map((d) => d.token) },
      createdAt: { gte: new Date(Date.now() - 60_000) },
    },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`\n  result ${JSON.stringify(result)}`);

  if (after.length) {
    console.log(`\n  receipts queued for collection (${after.length}):`);
    for (const rec of after) console.log(`    ${rec.id}`);
    console.log('\n  Those ids are TICKET ids. Expo accepted the message; whether a');
    console.log('  handset got it is only known from the receipt. In ~15 minutes:');
    console.log('    npx tsx scripts/push/05-receipts.ts');
    console.log('  or, to not wait:');
    console.log('    npx tsx scripts/push/05-receipts.ts --age');
  }

  if (result.dropped > 0) {
    console.log(`\n  ${result.dropped} token(s) were dropped — invalid format, or Expo said`);
    console.log('  DeviceNotRegistered. Those rows have been deleted, which is correct:');
    console.log('  a token Expo rejects will never work again.');
  }

  if (createdRegistration && !keep) {
    await prisma.deviceToken.delete({ where: { token: token! } }).catch(() => {});
    console.log('\n  removed the registration this script created (pass --keep to leave it)');
  }

  console.log('');
  return result.sent > 0 ? 0 : 1;
}

/* ────────────────────────────────────────────────────────────────────── */

async function main() {
  console.log('\nReal send');
  console.log('─'.repeat(78));

  if (!process.env.EXPO_ACCESS_TOKEN) {
    console.log('\n  EXPO_ACCESS_TOKEN is not set.');
    console.log('  Sends may still work, because without push security enabled in the');
    console.log('  Expo dashboard the endpoint accepts unauthenticated requests — which');
    console.log('  is the problem, not the convenience: anyone holding a user token could');
    console.log('  deliver a notification that renders as if Vyre sent it. Enable push');
    console.log('  security and set this before launch.');
  }

  if (raw) {
    if (!token) {
      console.log('\n  --raw needs --token=ExponentPushToken[...]\n');
      return 1;
    }
    return rawSend(token);
  }

  if (!userId) {
    console.log('\n  Needs either --raw --token=... or --user=<userId>.\n');
    console.log('  Examples:');
    console.log('    npx tsx scripts/push/04-send.ts --raw --token="ExponentPushToken[xxxx]"');
    console.log('    npx tsx scripts/push/04-send.ts --user=clx123 --event=TRANSFER_LANDED');
    console.log('    npx tsx scripts/push/04-send.ts --user=clx123 --token="ExponentPushToken[xxxx]"\n');
    return 1;
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) {
    console.log(`\n  no such user: ${userId}\n`);
    return 1;
  }

  return realSend(userId);
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('\n  threw:', err);
    await prisma.$disconnect();
    process.exit(1);
  });