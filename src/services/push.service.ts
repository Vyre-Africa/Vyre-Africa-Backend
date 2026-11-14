// src/services/push.service.ts
//
// Delivery. Takes a VyreEvent, puts it on every device the user has.
//
// ── Scope ──────────────────────────────────────────────────────────────
//
// This sends and nothing else. It does not persist a Notification row,
// read NotificationSetting, or send email — notification.service.ts does
// all three and calls in here for the push leg.
//
// Copy is NOT defined here any more. `render()` lives in
// notification.catalogue.ts so that the email body, the push body, the
// in-app row and the Ably payload for one event are the same strings.
// Two copies of the copy is how Spondle ended up with `interruptionLevel`
// in a field Expo does not read, for months, with a log line insisting it
// worked.
//
// ── Why Expo's service and not APNs/FCM directly ───────────────────────
//
// One token format, one endpoint, both platforms, and it handles the
// retry/receipt machinery. The exception, later: Live Activities do NOT go
// through Expo. They need `apns-push-type: liveactivity` straight to APNs
// with the key EAS already holds. That is a second send path alongside
// this one, not a replacement.
//
// ── Limits this file is written around (Expo's documented numbers) ─────
//
//   * 4096 bytes per message, `data` included
//   * 100 messages per request
//   * 1000 receipt ids per request
//   * 600 notifications/second per project
//
// The SDK chunks for the first three.

import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';
import prisma from '../config/prisma.client';
import { render, type VyreEvent } from './notification.catalogue';

/**
 * `accessToken` is not optional for us.
 *
 * Without push security enabled in the Expo dashboard, the send endpoint for
 * this project accepts unauthenticated requests — so anyone who obtains a
 * user's Expo token can deliver a notification that renders as if it came
 * from Vyre. On a money app the abuse writes itself: "₦500,000 received —
 * tap to confirm". Turn it on, set EXPO_ACCESS_TOKEN, and unauthenticated
 * sends start returning UNAUTHORIZED.
 */
const expo = new Expo({
  accessToken: process.env.EXPO_ACCESS_TOKEN,
});

/*
 * `useFcmV1: true` was here and is deliberately gone.
 *
 * It was never doing anything. On the 3.x line the SDK only puts `useFcmV1`
 * on the query string when it is set to FALSE — v1 is already the server's
 * default, so passing `true` is a no-op. And the option was deleted outright
 * in expo-server-sdk 5.0.0, once legacy FCM was switched off at Google's end
 * and there was no longer a second path to choose between. Leaving it in
 * would have been a compile error the moment this package was upgraded past
 * 4.x, which is the upgrade the `interruptionLevel` fix below requires.
 */

/* ──────────────────────────────────────────────────────────────────────
   Send
   ────────────────────────────────────────────────────────────────────── */

export async function sendToUser(userId: string, event: VyreEvent) {
  return sendToUsers([userId], event);
}

export async function sendToUsers(userIds: string[], event: VyreEvent) {
  if (userIds.length === 0) return { sent: 0, dropped: 0 };

  const devices = await prisma.deviceToken.findMany({
    where: { userId: { in: userIds } },
    select: { token: true },
  });
  if (devices.length === 0) return { sent: 0, dropped: 0 };

  const { title, body, url, sound, timeSensitive } = render(event);

  const messages: ExpoPushMessage[] = [];
  const invalid: string[] = [];

  for (const { token } of devices) {
    // Cheap local check before spending a message slot on something that was
    // mangled in transit or truncated by a column that is too narrow.
    if (!Expo.isExpoPushToken(token)) {
      invalid.push(token);
      continue;
    }
    messages.push({
      to: token,
      title,
      body,
      sound: sound ? 'default' : undefined,

      // TOP LEVEL, not under `_ios`.
      //
      // Spondle sets `message._ios = { interruptionLevel: 'time-sensitive' }`,
      // which is not a field Expo documents — so it is dropped, and their
      // "breaking through Focus/DND" log line fires while the notification
      // goes out at normal priority. Expo takes `interruptionLevel` alongside
      // `sound`, `badge`, `subtitle` and `threadId`.
      //
      // Needs expo-server-sdk >= 3.13.0, which is where the field entered
      // ExpoPushMessage as:
      //
      //   interruptionLevel?: 'active' | 'critical' | 'passive' | 'time-sensitive'
      //
      // On 3.12.0 and earlier the property does not exist in the type and
      // tsc raises TS2353 here. Upgrade; do NOT cast it away. A cast would
      // compile and the field would still be sent, but it would also hide
      // the next type change in this object — and a wrong field in this
      // exact spot is the Spondle bug above, which went unnoticed for
      // months precisely because nothing ever complained.
      interruptionLevel: timeSensitive ? 'time-sensitive' : 'active',

      channelId: 'default',
      priority: timeSensitive ? 'high' : 'default',

      // Ids only. The client refetches the record rather than reading it out
      // of the payload — keeps us well inside 4096 bytes, and means a
      // notification can never display a stale figure.
      data: { kind: event.kind, url },

      // Money notifications are worthless late. Expiring beats delivering
      // "transfer on its way" a day after it landed.
      ttl: 60 * 60 * 6,
    });
  }

  if (invalid.length) {
    await prisma.deviceToken.deleteMany({ where: { token: { in: invalid } } });
  }

  // The SDK chunks to 100, gzips, caps itself at six concurrent connections
  // and backs off on 429/5xx.
  const chunks = expo.chunkPushNotifications(messages);
  const tickets: { ticket: ExpoPushTicket; token: string }[] = [];

  for (const chunk of chunks) {
    try {
      const batch = await expo.sendPushNotificationsAsync(chunk);
      // Tickets come back in request order, so this pairing is positional and
      // only holds because a chunk is never reordered.
      batch.forEach((ticket, i) => tickets.push({ ticket, token: String(chunk[i].to) }));
    } catch (err) {
      console.error('[push] chunk failed', err);
    }
  }

  const dead: string[] = [];
  const receipts: { id: string; token: string }[] = [];

  for (const { ticket, token } of tickets) {
    if (ticket.status === 'ok') {
      // "ok" means Expo accepted it, NOT that a device got it.
      receipts.push({ id: ticket.id, token });
    } else if (ticket.details?.error === 'DeviceNotRegistered') {
      dead.push(token);
    } else {
      console.error('[push] ticket error', ticket.message, ticket.details);
    }
  }

  if (dead.length) {
    await prisma.deviceToken.deleteMany({ where: { token: { in: dead } } });
  }

  if (receipts.length) {
    await prisma.pushReceipt.createMany({ data: receipts, skipDuplicates: true });
  }

  return { sent: receipts.length, dropped: dead.length + invalid.length };
}

/* ──────────────────────────────────────────────────────────────────────
   Receipts

   Scheduled as 'Push_Receipt_Sweep' every 15 minutes in
   scheduleRecurringJobs(). Expo's guidance: check about 15 minutes after
   sending, and receipts are cleared after 24 hours — so rows older than
   that are gone whether or not we read them, which is why the sweep at
   the bottom is unconditional.
   ────────────────────────────────────────────────────────────────────── */

export async function collectPushReceipts() {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000);

  const pending = await prisma.pushReceipt.findMany({
    where: { createdAt: { lt: cutoff } },
    take: 1000, // Expo's per-request ceiling
  });
  if (pending.length === 0) return { checked: 0, dropped: 0 };

  const dead = new Set<string>();
  const byId = new Map(pending.map((p) => [p.id, p.token]));

  for (const chunk of expo.chunkPushNotificationReceiptIds(pending.map((p) => p.id))) {
    try {
      const got = await expo.getPushNotificationReceiptsAsync(chunk);
      for (const [id, receipt] of Object.entries(got)) {
        if (receipt.status !== 'error') continue;

        const code = receipt.details?.error;
        const token = byId.get(id);

        if (code === 'DeviceNotRegistered' && token) {
          dead.add(token);
        } else if (code === 'MessageRateExceeded') {
          // Nothing to do per-message — it means we are pushing too hard and
          // should batch more, not retry this one.
          console.warn('[push] rate exceeded — back off');
        } else if (code === 'InvalidCredentials') {
          // The APNs key or FCM credential is wrong or revoked. Not transient:
          // every send fails until someone runs `eas credentials`.
          console.error('[push] INVALID CREDENTIALS — run `eas credentials`');
        } else {
          console.error('[push] receipt error', code, receipt.message);
        }
      }
    } catch (err) {
      console.error('[push] receipt fetch failed', err);
    }
  }

  if (dead.size) {
    await prisma.deviceToken.deleteMany({ where: { token: { in: [...dead] } } });
  }

  // Swept whether or not they were readable: after 24h Expo has dropped them
  // anyway, and leaving rows here grows a table forever.
  await prisma.pushReceipt.deleteMany({ where: { id: { in: pending.map((p) => p.id) } } });

  return { checked: pending.length, dropped: dead.size };
}