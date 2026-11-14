/**
 * 05 — delivery receipts
 *
 *   npx tsx scripts/push/05-receipts.ts          # what's pending, then sweep
 *   npx tsx scripts/push/05-receipts.ts --age    # backdate first, so the sweep sees everything
 *   npx tsx scripts/push/05-receipts.ts --list   # look, change nothing
 *
 * Needs the database and Expo credentials. No handset.
 *
 * ── Why receipts matter at all ─────────────────────────────────────────
 *
 * `sendPushNotificationsAsync` returns a TICKET. A ticket with
 * `status: 'ok'` means Expo took the message, nothing more. The RECEIPT,
 * available about 15 minutes later, is the only thing that knows whether
 * APNs or FCM actually delivered it — and the only way the backend ever
 * learns that a handset uninstalled the app.
 *
 * Skip this and DeviceToken grows forever: every send burns message slots
 * on phones that no longer exist, and the `sent` figure the dispatcher
 * records becomes a count of messages Expo accepted rather than
 * notifications anyone received.
 *
 * ── --age ──────────────────────────────────────────────────────────────
 *
 * `collectPushReceipts` only looks at rows older than 15 minutes, which is
 * correct — Expo has nothing to say before then — and unhelpful when you
 * are testing. `--age` backdates the pending rows by 16 minutes and then
 * runs the real sweep, rather than this script reimplementing the sweep
 * with a different cutoff. Same code path, just older-looking rows.
 *
 * Expo clears receipts after 24 hours, so a row that has sat here longer
 * than that will come back unknown however often it is swept. That is why
 * the real function deletes what it processed whether or not it could read
 * it, and why the pending list below flags anything stale.
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

import prisma from '../../config/prisma.client';
import { collectPushReceipts } from '../../services/push.service';

const flag = (name: string) => process.argv.includes(`--${name}`);

const FIFTEEN_MIN = 15 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

function ago(d: Date) {
  const ms = Date.now() - d.getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m ago`;
}

async function show() {
  const pending = await prisma.pushReceipt.findMany({ orderBy: { createdAt: 'asc' } });
  const devices = await prisma.deviceToken.count();

  console.log(`\n  DeviceToken rows   ${devices}`);
  console.log(`  PushReceipt rows   ${pending.length}`);

  if (pending.length === 0) {
    console.log('\n  Nothing pending. Either nothing has been sent, or a sweep already');
    console.log('  collected it. Send something with 04-send.ts first.\n');
    return pending;
  }

  const ready = pending.filter((p) => Date.now() - p.createdAt.getTime() >= FIFTEEN_MIN);
  const stale = pending.filter((p) => Date.now() - p.createdAt.getTime() >= TWENTY_FOUR_HOURS);

  console.log(`    ready to collect   ${ready.length}  (older than 15m)`);
  console.log(`    too new            ${pending.length - ready.length}`);
  if (stale.length) {
    console.log(`    past 24h           ${stale.length}  — Expo has already discarded these`);
  }

  console.log('\n  pending:');
  for (const p of pending.slice(0, 20)) {
    const masked = p.token.slice(0, 22) + '…]';
    const state =
      Date.now() - p.createdAt.getTime() >= TWENTY_FOUR_HOURS
        ? 'expired'
        : Date.now() - p.createdAt.getTime() >= FIFTEEN_MIN
          ? 'ready'
          : 'too new';
    console.log(`    ${p.id}  ${masked}  ${ago(p.createdAt).padEnd(10)} ${state}`);
  }
  if (pending.length > 20) console.log(`    … and ${pending.length - 20} more`);

  return pending;
}

async function main() {
  console.log('\nDelivery receipts');
  console.log('─'.repeat(78));

  const pending = await show();

  if (flag('list')) {
    console.log('\n  --list: nothing changed.\n');
    return 0;
  }

  if (pending.length === 0) return 0;

  if (flag('age')) {
    const backdated = new Date(Date.now() - (FIFTEEN_MIN + 60_000));
    const { count } = await prisma.pushReceipt.updateMany({
      where: { createdAt: { gt: backdated } },
      data: { createdAt: backdated },
    });
    console.log(`\n  --age: backdated ${count} row(s) to ${backdated.toISOString()}`);
    console.log('         The sweep below is the real one, unmodified.');
  }

  const devicesBefore = await prisma.deviceToken.count();

  console.log('\n  sweeping…');
  const result = await collectPushReceipts();
  console.log(`  → ${JSON.stringify(result)}`);

  const devicesAfter = await prisma.deviceToken.count();
  const remaining = await prisma.pushReceipt.count();

  console.log(`\n  checked            ${result.checked}`);
  console.log(`  tokens dropped     ${result.dropped}`);
  console.log(`  DeviceToken rows   ${devicesBefore} → ${devicesAfter}`);
  console.log(`  PushReceipt rows   ${pending.length} → ${remaining}`);

  if (result.checked === 0) {
    console.log('\n  Nothing was old enough. Re-run with --age.');
  } else if (result.dropped > 0) {
    console.log('\n  Dropped tokens were DeviceNotRegistered: the app was uninstalled or');
    console.log('  the token rotated. Deleting them is correct — they will never work');
    console.log('  again, and the handset re-registers on next launch.');
  } else {
    console.log('\n  Every receipt came back clean. Nothing to prune.');
  }

  /* The sweep deletes what it processed whether or not the receipt was
     readable, because after 24 hours Expo has dropped it anyway and the
     row would otherwise sit here forever. So an empty table afterwards is
     the expected outcome, not a sign that something was lost. */
  if (remaining === 0 && result.checked > 0) {
    console.log('  The table is empty now, which is the intended end state.');
  }

  console.log('');
  return 0;
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