/**
 * 03 — the dispatcher
 *
 *   npx tsx scripts/push/03-dispatch.ts
 *   npx tsx scripts/push/03-dispatch.ts <userId>
 *
 * Needs the database. Needs Redis reachable — not because any test uses a
 * queue, but because NotificationService opens one in its constructor, so
 * merely importing the module connects. Needs no Expo credentials and no
 * handset.
 *
 * ── No mail is sent and no realtime message is published ───────────────
 *
 * `mailService.general` and `ablyService.notifyUser` are replaced with
 * recorders before anything runs, and restored at the end. They are both
 * default-exported singletons, so this is a method assignment rather than
 * anything clever with the module cache. Every call is captured and
 * printed, which is also how the per-channel assertions are made.
 *
 * `push.service.sendToUser` is deliberately NOT stubbed. It is left real so
 * that the push leg genuinely runs — it just finds no DeviceToken rows for
 * the test user and returns `{ sent: 0 }`, which reports as `no-devices`.
 * That is the distinction the tests below turn on: `no-devices` means the
 * channel was attempted, `skipped` means a setting stopped it. Stubbing it
 * would erase exactly the difference being measured.
 *
 * ── What is checked ───────────────────────────────────────────────────
 *
 *   1. Replay safety — the same event twice produces one row and one send.
 *   2. Settings are read — push off means push skipped.
 *   3. Settings are overridden — a SECURITY_* event sends anyway.
 *   4. A missing settings row means ON, not off.
 *   5. Channels fail independently — a throwing mailer does not take the
 *      row, the realtime publish, or the push with it.
 *
 * (5) is the one that was actually broken before: the old UserNotify had
 * the user lookup, the row, the mail and the Ably publish inside a single
 * try/catch ending in `console.log(error)`, so a bounced email silently
 * discarded everything after it.
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
import mailService from '../../services/mail.service';
import ablyService from '../../services/ably.service';
import notificationService from '../../services/notification.service';
import { dedupeKeyFor, type VyreEvent } from '../../services/notification.catalogue';

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

/* ──────────────────────────────────────────────────────────────────────
   Recorders
   ────────────────────────────────────────────────────────────────────── */

type MailCall = { to: string; firstName: string; title: string; body: string };
type AblyCall = { userId: string; title: string; body: string };

const mailCalls: MailCall[] = [];
const ablyCalls: AblyCall[] = [];
let mailShouldThrow = false;

const realMail = mailService.general;
const realAbly = ablyService.notifyUser;

function installRecorders() {
  (mailService as any).general = async (to: string, firstName: string, title: string, body: string) => {
    mailCalls.push({ to, firstName, title, body });
    if (mailShouldThrow) throw new Error('simulated SMTP failure');
    return { ok: true };
  };
  (ablyService as any).notifyUser = async (userId: string, title: string, body: string) => {
    ablyCalls.push({ userId, title, body });
    return { ok: true };
  };
}

function restoreRecorders() {
  (mailService as any).general = realMail;
  (ablyService as any).notifyUser = realAbly;
}

function resetRecorders() {
  mailCalls.length = 0;
  ablyCalls.length = 0;
  mailShouldThrow = false;
}

/* ──────────────────────────────────────────────────────────────────────
   Fixtures

   Every event below uses a txId/ref/sessionId prefixed VYRETEST so the
   rows it creates are identifiable and removable, and can never collide
   with a real transaction.
   ────────────────────────────────────────────────────────────────────── */

const RUN = `VYRETEST-${Date.now()}`;
const createdKeys: string[] = [];

function event(kind: 'TRANSFER_LANDED' | 'DEPOSIT_CREDITED' | 'SECURITY_SIGNIN', tag: string): VyreEvent {
  switch (kind) {
    case 'TRANSFER_LANDED':
      return { kind, txId: `${RUN}-${tag}`, amount: '$250.00', to: 'Ada Nwosu' };
    case 'DEPOSIT_CREDITED':
      return { kind, walletId: 'wal_test', amount: '₦400,000.00', ref: `${RUN}-${tag}` };
    case 'SECURITY_SIGNIN':
      return { kind, device: 'iPhone 15 Pro', at: `${RUN}-${tag}` };
  }
}

/** Calls the worker body directly — this is what the queue would invoke. */
async function dispatch(userId: string, e: VyreEvent) {
  const key = dedupeKeyFor(userId, e);
  if (key) createdKeys.push(key);
  return (await notificationService.UserNotify({ userId, event: e })) as
    | Record<string, string>
    | undefined;
}

async function rowFor(userId: string, e: VyreEvent) {
  const key = dedupeKeyFor(userId, e);
  if (!key) return null;
  return prisma.notification.findUnique({ where: { dedupeKey: key } });
}

/* ──────────────────────────────────────────────────────────────────────
   Settings helpers — the original row is captured and put back.
   ────────────────────────────────────────────────────────────────────── */

async function setSettings(userId: string, push: boolean, email: boolean) {
  await prisma.notificationSetting.upsert({
    where: { userId },
    create: { userId, pushNotification: push, emailNotification: email, smsNotification: false },
    update: { pushNotification: push, emailNotification: email },
  });
}

/* ──────────────────────────────────────────────────────────────────────
   Tests
   ────────────────────────────────────────────────────────────────────── */

async function test1_replay(userId: string) {
  console.log('\n1 · replay safety\n');
  resetRecorders();
  await setSettings(userId, true, true);

  const e = event('TRANSFER_LANDED', 'replay');

  const first = await dispatch(userId, e);
  console.log(`  first  → ${JSON.stringify(first)}`);
  const second = await dispatch(userId, e);
  console.log(`  second → ${JSON.stringify(second)}`);

  const key = dedupeKeyFor(userId, e)!;
  const count = await prisma.notification.count({ where: { dedupeKey: key } });

  check('one row for two identical events', count === 1, `found ${count}`);
  check(
    'the second dispatch returned nothing',
    second === undefined,
    `returned ${JSON.stringify(second)} — it continued past the duplicate check and re-sent`,
  );
  check(
    'only one email for two identical events',
    mailCalls.length === 1,
    `${mailCalls.length} emails — a replayed webhook would tell the user twice`,
  );
  check('only one realtime publish', ablyCalls.length === 1, `${ablyCalls.length} publishes`);
}

async function test2_settingsHonoured(userId: string) {
  console.log('\n2 · settings are read\n');
  resetRecorders();
  await setSettings(userId, false, false);

  const e = event('DEPOSIT_CREDITED', 'settings-off');
  const out = await dispatch(userId, e);
  console.log(`  → ${JSON.stringify(out)}`);

  check('push was skipped, not attempted', out?.push === 'skipped', `push was "${out?.push}"`);
  check('email was skipped', out?.email === 'skipped', `email was "${out?.email}"`);
  check('no email actually sent', mailCalls.length === 0, `${mailCalls.length} sent`);

  /* Realtime is not gated on settings, on purpose: it only updates a
     screen the user is already looking at. It is not an interruption, and
     muting it would make the app look broken to someone who turned push
     off. */
  check('realtime still published', out?.realtime === 'sent', `realtime was "${out?.realtime}"`);

  const row = await rowFor(userId, e);
  check('the in-app row is still created', row !== null,
    'the feed is not a channel the user switched off — the row must exist either way');
}

async function test3_mandatoryOverride(userId: string) {
  console.log('\n3 · security overrides settings\n');
  resetRecorders();
  await setSettings(userId, false, false); // still off from the user's side

  const e = event('SECURITY_SIGNIN', 'mandatory');
  const out = await dispatch(userId, e);
  console.log(`  → ${JSON.stringify(out)}`);

  /* `no-devices` is the pass here, not `sent`. The test user has no
     DeviceToken row, so the real sendToUser found nothing to send to — but
     it RAN, which is the point. `skipped` would mean the setting stopped
     it, and a user who has muted notifications would never learn their
     account had been opened on someone else's phone. */
  check(
    'push was attempted despite being switched off',
    out?.push === 'no-devices' || out?.push === 'sent',
    `push was "${out?.push}" — "skipped" means the mandatory flag is not working`,
  );
  check(
    'email was sent despite being switched off',
    out?.email === 'sent' && mailCalls.length === 1,
    `email was "${out?.email}", ${mailCalls.length} call(s)`,
  );
}

async function test4_noSettingsRow(userId: string) {
  console.log('\n4 · a missing settings row means ON\n');
  resetRecorders();
  await prisma.notificationSetting.deleteMany({ where: { userId } });

  const e = event('TRANSFER_LANDED', 'no-settings');
  const out = await dispatch(userId, e);
  console.log(`  → ${JSON.stringify(out)}`);

  /* Nothing creates a NotificationSetting row at signup, so almost every
     existing user has none. Reading a missing row as "all off" would mute
     the entire user base the moment this ships. */
  check('email sent with no settings row', out?.email === 'sent', `email was "${out?.email}"`);
  check(
    'push attempted with no settings row',
    out?.push === 'no-devices' || out?.push === 'sent',
    `push was "${out?.push}"`,
  );
}

async function test5_partialFailure(userId: string) {
  console.log('\n5 · channels fail independently\n');
  resetRecorders();
  await setSettings(userId, true, true);
  mailShouldThrow = true;

  const e = event('TRANSFER_LANDED', 'partial');
  const out = await dispatch(userId, e);
  console.log(`  → ${JSON.stringify(out)}`);

  check('email recorded as failed', out?.email === 'failed', `email was "${out?.email}"`);
  check(
    'realtime survived the email failure',
    out?.realtime === 'sent',
    'under the old single try/catch this was silently dropped',
  );
  check(
    'push survived the email failure',
    out?.push === 'no-devices' || out?.push === 'sent',
    `push was "${out?.push}"`,
  );

  const row = await rowFor(userId, e);
  check('the row still exists', row !== null);
  check(
    'the row records which channel failed',
    !!row?.channels && JSON.stringify(row.channels).includes('failed'),
    `channels is ${JSON.stringify(row?.channels)} — without this a bouncing mailer is invisible`,
  );
  check(
    'the row is SENT because something got through',
    row?.status === 'SENT',
    `status is ${row?.status}`,
  );
  check('sentAt is set', !!row?.sentAt, 'sentAt is null on a row that did send');
}

/* ────────────────────────────────────────────────────────────────────── */

async function resolveUser(): Promise<{ id: string; email: string | null } | null> {
  const given = process.argv[2];
  if (given) {
    const u = await prisma.user.findUnique({
      where: { id: given },
      select: { id: true, email: true, realEmail: true },
    });
    if (!u) {
      console.log(`\n  no such user: ${given}\n`);
      return null;
    }
    return { id: u.id, email: u.realEmail ?? u.email };
  }
  const u = await prisma.user.findFirst({
    select: { id: true, email: true, realEmail: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!u) {
    console.log('\n  no users in the database\n');
    return null;
  }
  return { id: u.id, email: u.realEmail ?? u.email };
}

async function cleanup(userId: string) {
  if (createdKeys.length) {
    await prisma.notification.deleteMany({ where: { dedupeKey: { in: createdKeys } } });
  }
  // Anything the run created without a key (there should be none, but a
  // half-failed run can leave one behind).
  await prisma.notification.deleteMany({
    where: { userId, content: { contains: RUN } },
  });
}

async function main() {
  console.log('\nDispatcher');
  console.log('─'.repeat(78));

  const user = await resolveUser();
  if (!user) return 1;

  console.log(`\n  user   ${user.id}`);
  console.log(`  email  ${user.email ?? '(none)'}  — stubbed, nothing will be sent`);

  const priorSettings = await prisma.notificationSetting.findUnique({ where: { userId: user.id } });
  const priorDevices = await prisma.deviceToken.count({ where: { userId: user.id } });

  /* Tests 3, 4 and 5 read `no-devices` as "the push leg ran". If this user
     has a real handset registered, the push would genuinely be sent — the
     assertions accept either, but say so rather than letting a live push
     arrive unexplained at four in the morning. */
  if (priorDevices > 0) {
    console.log(`\n  note:  this user has ${priorDevices} registered device(s), so the push legs`);
    console.log('         below will send for real. Pass a user with no devices to avoid that.');
  }

  installRecorders();
  try {
    await test1_replay(user.id);
    await test2_settingsHonoured(user.id);
    await test3_mandatoryOverride(user.id);
    await test4_noSettingsRow(user.id);
    await test5_partialFailure(user.id);
  } finally {
    restoreRecorders();
    await cleanup(user.id);

    // Put the user's own preferences back exactly as they were.
    if (priorSettings) {
      await prisma.notificationSetting.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          pushNotification: priorSettings.pushNotification,
          emailNotification: priorSettings.emailNotification,
          smsNotification: priorSettings.smsNotification,
        },
        update: {
          pushNotification: priorSettings.pushNotification,
          emailNotification: priorSettings.emailNotification,
          smsNotification: priorSettings.smsNotification,
        },
      });
    } else {
      await prisma.notificationSetting.deleteMany({ where: { userId: user.id } });
    }
  }

  console.log(`\n${'─'.repeat(78)}`);
  console.log(`\n${checks} checks · ${failures} failed\n`);
  return failures > 0 ? 1 : 0;
}

main()
  .then(async (code) => {
    /* The Queue opened in NotificationService's constructor holds the Redis
       socket, and the process hangs on exit without this. It is private, so
       this reaches past the type — the alternative is a close() method on
       the service that exists only for tests. */
    await (notificationService as any).generalQueue?.close?.().catch?.(() => {});
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('\n  threw:', err);
    restoreRecorders();
    await (notificationService as any).generalQueue?.close?.().catch?.(() => {});
    await prisma.$disconnect();
    process.exit(1);
  });