// src/services/notification.service.ts
//
// The dispatcher. One notification, fanned out to the channels that should
// carry it.
//
// ── How to read this file ──────────────────────────────────────────────
//
// `UserNotify` is the worker body, and it is written as seven named steps
// with the detail of each pushed down into its own method. Read it top to
// bottom and you have the whole flow in about twenty lines:
//
//   1. normalise   accept both the old and new job shapes
//   2. decide      what this event wants: copy, channels, dedupe key
//   3. recipient   who is being told, and at which address
//   4. open        create the row PENDING — and stop here if it is a replay
//   5. preferences what the user has switched on
//   6. deliver     all channels at once, each failing on its own
//   7. close       write down what actually happened
//
// The steps are in that order for a reason: nothing is sent until the row
// exists, because the row is the replay guard. Sending first and recording
// after is how a retried webhook tells someone twice that their money
// arrived.
//
// ── What this replaced ─────────────────────────────────────────────────
//
// The previous version wrapped the user lookup, the row, mailService and
// ablyService in a single try/catch ending in `console.log(error)`. A mail
// failure silently took the realtime publish and the row with it. Each
// channel is now settled on its own and the outcome is stored on the row,
// so a quietly bouncing mailer is visible in the database instead of
// invisible everywhere.
//
// It also never read NotificationSetting — the preference screen was
// decorative — and never called push at all; mobilePushService was
// imported and unused. Both are wired here.

import prisma from '../config/prisma.client';
import mailService from './mail.service';
import ablyService from './ably.service';
import logger from '../config/logger';
import { Queue } from 'bullmq';
import connection from '../config/redis.config';
import { sendToUser } from './push.service';
import {
  render,
  channelsFor,
  dedupeKeyFor,
  legacyTypeFor,
  legacy,
  type ChannelPolicy,
  type Rendered,
  type VyreEvent,
} from './notification.catalogue';
import type { NotificationType } from '@prisma/client';

/* ──────────────────────────────────────────────────────────────────────
   Types
   ────────────────────────────────────────────────────────────────────── */

export type NotifyJob = {
  userId: string;
  event: VyreEvent;
  /**
   * Richer body for the EMAIL channel only. Push, the in-app row and Ably
   * all keep the catalogue's copy.
   *
   * The two want different things, and pretending otherwise costs one of
   * them. A lock screen gets "$250.00 reached Ada Nwosu." — short, no
   * balance, readable by whoever happens to be holding the phone. An email
   * is a record someone keeps, and wants the amount, the recipient, the
   * bank, the reference and the masked account.
   *
   * Migrating the webhook handlers off `queue()` without this would have
   * replaced their existing email bodies with the push line, which is a
   * downgrade dressed up as a refactor.
   *
   * HTML, because that is what mailService.general sends and what those
   * call sites already build.
   */
  emailHtml?: string;
};

/** The old shape, still arriving from `queue()` and from Redis on rollout. */
type LegacyJob = { userId: string; title: string; content: string };

/** Who is being told, and where. */
type Recipient = {
  /** Null for a TempUser: they have an address but no account to push to. */
  user: { firstName: string | null } | null;
  email: string | null;
  firstName: string;
};

/** Per-channel result, stored on the row as JSON. */
type Outcomes = Record<string, string>;

/**
 * What the settings look like when a user has no NotificationSetting row.
 *
 * Most users do not have one — nothing creates it on signup. Treating a
 * missing row as "everything off" would silently disable notifications for
 * the entire existing user base the moment this ships.
 */
const DEFAULT_SETTINGS = {
  emailNotification: true,
  pushNotification: true,
  smsNotification: false,
};

type Prefs = typeof DEFAULT_SETTINGS;

/* ──────────────────────────────────────────────────────────────────────
   Pure helpers — no I/O, so they are easy to read and easy to test
   ────────────────────────────────────────────────────────────────────── */

/**
 * Accepts both job shapes.
 *
 * `'event' in job` narrows the union for TypeScript and checks the key at
 * runtime, in one expression.
 *
 * This exists for the DEPLOY, not for the code. When a new version ships,
 * Redis still holds jobs enqueued by the old one, and the worker picks them
 * up immediately. Without this, `event.kind` reads `.kind` of undefined,
 * every one of those jobs throws, and they retry until BullMQ gives up —
 * so the people who did something right before the deploy are the ones
 * never told about it.
 */
function normaliseJob(job: NotifyJob | LegacyJob): NotifyJob {
  return 'event' in job
    ? job
    : { userId: job.userId, event: legacy(job.title, job.content) };
}

/**
 * Should this channel carry this notification?
 *
 * Two questions at once: does this KIND of event use the channel at all,
 * and has the user allowed it — or is this one of the events that ignores
 * their settings?
 *
 * Only SECURITY_* is mandatory. Someone who muted notifications is still
 * told their account was opened on a new device, because that is how they
 * find out it was not them.
 */
function allows(policy: ChannelPolicy, channel: boolean, pref: boolean): boolean {
  return channel && (policy.mandatory || pref);
}

/* ──────────────────────────────────────────────────────────────────────
   The service
   ────────────────────────────────────────────────────────────────────── */

class NotificationService {
  private generalQueue: Queue;

  constructor() {
    this.generalQueue = new Queue('general-process', { connection });
  }

  /* ════════════════════════════════════════════════════════════════════
     Enqueue
     ════════════════════════════════════════════════════════════════════ */

  /**
   * The typed path. Prefer this.
   *
   * `jobId` is the dedupe key, so BullMQ refuses a duplicate before a
   * worker ever runs. The unique index on Notification.dedupeKey catches
   * anything that slips past — a job that completed and was evicted from
   * the queue's history (removeOnComplete: 100) and was then redelivered.
   *
   * @param opts.emailHtml a richer body for the email only — see NotifyJob
   */
  async notify(userId: string, event: VyreEvent, opts?: { emailHtml?: string }) {
    const jobId = dedupeKeyFor(userId, event) ?? undefined;
    return this.generalQueue.add(
      'user-notification',
      { userId, event, emailHtml: opts?.emailHtml } satisfies NotifyJob,
      jobId ? { jobId } : undefined,
    );
  }

  /**
   * The legacy path, kept so existing call sites compile untouched.
   *
   * Routes through GENERIC, which is in-app and email only — deliberately
   * no push, because those call sites were written for email and quietly
   * turning them into phone notifications would surprise users rather than
   * delight them.
   *
   * Migrate callers to `notify()` as you touch them. Nothing breaks in the
   * meantime.
   */
  async queue(payload: {
    userId?: string;
    title: string;
    content: string;
    type?: NotificationType;
  }) {
    if (!payload.userId) {
      logger.warn('[notify] queue() called with no userId — dropped');
      return;
    }
    return this.generalQueue.add('user-notification', {
      userId: payload.userId,
      event: legacy(payload.title, payload.content),
    } satisfies NotifyJob);
  }

  /* ════════════════════════════════════════════════════════════════════
     The worker body — seven steps, in order
     ════════════════════════════════════════════════════════════════════ */

  async UserNotify(job: NotifyJob | LegacyJob): Promise<Outcomes | undefined> {
    // 1 ── Normalise. Both job shapes become one.
    const { userId, event, emailHtml } = normaliseJob(job);

    // 2 ── Decide. Three pure lookups, no I/O: what this event says, which
    //      channels carry it, and how a replay of it is recognised.
    const copy = render(event);
    const policy = channelsFor(event.kind);
    const dedupeKey = dedupeKeyFor(userId, event);

    // 3 ── Recipient.
    const recipient = await this.findRecipient(userId);
    if (!recipient) {
      logger.warn(`[notify] no recipient for ${userId} — dropped`);
      return;
    }

    // 4 ── Open the row. This is also the replay guard, which is why it
    //      happens BEFORE anything is sent.
    const row = await this.openRow({ userId, event, copy, policy, dedupeKey, recipient });
    if (row === 'duplicate') return;

    // 5 ── Preferences.
    const prefs = await this.readPreferences(recipient.user ? userId : null);

    // 6 ── Deliver, all channels at once.
    const outcomes = await this.deliver({ userId, event, copy, policy, prefs, recipient, emailHtml });

    // 7 ── Close the row with what actually happened.
    await this.closeRow(row, outcomes);

    return outcomes;
  }

  /* ──────────────────────────────────────────────────────────────────
     Step 3 — who
     ────────────────────────────────────────────────────────────────── */

  /**
   * Anonymous users are ordinary User rows (isAnonymous + realEmail), so
   * they get the full treatment including push. Only TempUser sits outside:
   * a TempUser is pre-account and has no app session to push to, which is
   * why `user` comes back null for them and the push leg is skipped.
   *
   * Both reads run in parallel — an id is one or the other, never both, and
   * waiting for the first to miss before trying the second doubles the
   * latency of every notification to save one query on a minority of them.
   */
  private async findRecipient(userId: string): Promise<Recipient | null> {
    const [user, tempUser] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { firstName: true, email: true, realEmail: true, isAnonymous: true },
      }),
      prisma.tempUser.findUnique({
        where: { id: userId },
        select: { email: true },
      }),
    ]);

    if (!user && !tempUser) return null;

    return {
      user: user ? { firstName: user.firstName } : null,
      // realEmail first: anonymous users carry a placeholder in `email` and
      // their deliverable address in `realEmail`.
      email: user?.realEmail || user?.email || tempUser?.email || null,
      firstName: user?.firstName || 'there',
    };
  }

  /* ──────────────────────────────────────────────────────────────────
     Step 4 — the row, and the replay guard
     ────────────────────────────────────────────────────────────────── */

  /**
   * Creates the Notification row as PENDING, before anything is sent.
   *
   * Returns the row id, or `null` when this event has no in-app row (the
   * policy says so, or the recipient is a TempUser with no account), or
   * `'duplicate'` when this exact event has already been delivered.
   *
   * ── Why the order matters ──────────────────────────────────────────
   *
   * handleNuvionEvent, handleDiditEvent and processRampWebhook all
   * re-deliver, and BullMQ evicts completed jobs after 100 — so a late
   * redelivery is not caught by jobId alone. The unique index on
   * `dedupeKey` is the backstop, and it only works if the row is written
   * before the sending happens. Send first and the second delivery goes
   * out while the index is still being consulted.
   *
   * The failure that prevents: telling someone twice that their money
   * arrived.
   */
  private async openRow(args: {
    userId: string;
    event: VyreEvent;
    copy: Rendered;
    policy: ChannelPolicy;
    dedupeKey: string | null;
    recipient: Recipient;
  }): Promise<string | null | 'duplicate'> {
    const { userId, event, copy, policy, dedupeKey, recipient } = args;

    if (!policy.inApp || !recipient.user) return null;

    try {
      if (dedupeKey) {
        const existing = await prisma.notification.findUnique({
          where: { dedupeKey },
          select: { id: true },
        });
        if (existing) {
          logger.info(`[notify] duplicate ${dedupeKey} — already delivered`);
          return 'duplicate';
        }
      }

      const created = await prisma.notification.create({
        data: {
          userId,
          title: copy.title,
          content: copy.body,
          url: copy.url,
          type: legacyTypeFor(event.kind) as NotificationType,
          dedupeKey,
          status: 'PENDING',
        },
      });
      return created.id;
    } catch (err: any) {
      // P2002 is a unique violation on dedupeKey: two workers raced the
      // findUnique above. The loser stops, which is the correct outcome —
      // the winner is already sending.
      if (err?.code === 'P2002') {
        logger.info(`[notify] duplicate ${dedupeKey} — lost the race, stopping`);
        return 'duplicate';
      }
      // Any other failure: the row could not be written, but the user
      // should still be told. Carry on with no row to update later.
      logger.error('[notify] could not create notification row', err);
      return null;
    }
  }

  /* ──────────────────────────────────────────────────────────────────
     Step 5 — preferences
     ────────────────────────────────────────────────────────────────── */

  /** `null` userId means a TempUser, who has no settings row by definition. */
  private async readPreferences(userId: string | null): Promise<Prefs> {
    if (!userId) return DEFAULT_SETTINGS;

    const setting = await prisma.notificationSetting.findUnique({
      where: { userId },
      select: { emailNotification: true, pushNotification: true, smsNotification: true },
    });

    return setting ?? DEFAULT_SETTINGS;
  }

  /* ──────────────────────────────────────────────────────────────────
     Step 6 — delivery
     ────────────────────────────────────────────────────────────────── */

  /**
   * Starts every permitted channel at once and waits for all of them.
   *
   * ── Two things make this safe ──────────────────────────────────────
   *
   * Each channel catches its own failure, so one cannot reject the batch.
   * And `allSettled` rather than `all`, which would abandon the rest the
   * moment one rejected. Belt and braces on purpose: this is the exact
   * behaviour the previous single try/catch got wrong.
   *
   * ── The vocabulary in `outcomes` ───────────────────────────────────
   *
   *   sent         it went
   *   failed       it was attempted and threw
   *   skipped      a user setting stopped it
   *   no-address   nobody to email
   *   no-devices   the push ran and found no registered handset
   *
   * `skipped` versus `no-devices` is the distinction that matters: the
   * first means a preference was honoured, the second means the channel
   * ran and had nowhere to go. Collapsing them would make a muted user and
   * a user with no phone look identical in the data.
   */
  private async deliver(args: {
    userId: string;
    event: VyreEvent;
    copy: Rendered;
    policy: ChannelPolicy;
    prefs: Prefs;
    recipient: Recipient;
    emailHtml?: string;
  }): Promise<Outcomes> {
    const { userId, event, copy, policy, prefs, recipient, emailHtml } = args;

    const outcomes: Outcomes = {};
    const tasks: Promise<void>[] = [];

    /* ── Email ─────────────────────────────────────────────────────── */
    if (allows(policy, policy.email, prefs.emailNotification) && recipient.email) {
      tasks.push(
        mailService
          // The call site's richer body when it supplied one, the
          // catalogue's otherwise. See `emailHtml` on NotifyJob.
          .general(recipient.email, recipient.firstName, copy.title, emailHtml ?? copy.body)
          .then(() => void (outcomes.email = 'sent'))
          .catch((err: any) => {
            outcomes.email = 'failed';
            logger.error('[notify] email failed', err);
          }),
      );
    } else if (policy.email) {
      outcomes.email = recipient.email ? 'skipped' : 'no-address';
    }

    /* ── Push ──────────────────────────────────────────────────────── */
    if (allows(policy, policy.push, prefs.pushNotification) && recipient.user) {
      tasks.push(
        sendToUser(userId, event)
          .then((r) => void (outcomes.push = r.sent > 0 ? 'sent' : 'no-devices'))
          .catch((err: any) => {
            outcomes.push = 'failed';
            logger.error('[notify] push failed', err);
          }),
      );
    } else if (policy.push) {
      outcomes.push = 'skipped';
    }

    /* ── Realtime ──────────────────────────────────────────────────────
       Deliberately NOT gated on settings. This only refreshes a screen the
       user is already looking at — it is not an interruption, and muting it
       would make the app look broken to someone who turned push off. */
    if (policy.realtime) {
      tasks.push(
        ablyService
          .notifyUser(userId, copy.title, copy.body)
          .then(() => void (outcomes.realtime = 'sent'))
          .catch((err: any) => {
            outcomes.realtime = 'failed';
            logger.error('[notify] ably failed', err);
          }),
      );
    }

    await Promise.allSettled(tasks);
    return outcomes;
  }

  /* ──────────────────────────────────────────────────────────────────
     Step 7 — record
     ────────────────────────────────────────────────────────────────── */

  /**
   * Stores the per-channel result on the row.
   *
   * `status` is SENT if ANY channel got through, because a notification
   * that reached the user by email is not a failed notification just
   * because their phone is off.
   *
   * ── Why this swallows its own error ────────────────────────────────
   *
   * By the time this runs the notifications have already gone out. If the
   * update threw, the error would escape UserNotify, BullMQ would mark the
   * job failed, and the retry would send everything a SECOND time — a
   * second email and a second push, because of a database hiccup that
   * happened after the work was done. Losing the bookkeeping is the
   * cheaper failure.
   */
  private async closeRow(rowId: string | null, outcomes: Outcomes): Promise<void> {
    if (!rowId) return;

    const anySent = Object.values(outcomes).includes('sent');

    await prisma.notification
      .update({
        where: { id: rowId },
        data: {
          status: anySent ? 'SENT' : 'FAILED',
          channels: outcomes,
          sentAt: anySent ? new Date() : null,
        },
      })
      .catch((err) => logger.error('[notify] could not update row', err));
  }

  /* ════════════════════════════════════════════════════════════════════
     Reads
     ════════════════════════════════════════════════════════════════════ */

  async getUserNotification(userId: string, limit?: string) {
    return prisma.notification.findMany({
      where: { userId },
      take: limit ? parseInt(limit) : 20,
      orderBy: { createdAt: 'desc' },
    });
  }

  async unreadCount(userId: string) {
    return prisma.notification.count({ where: { userId, read: false } });
  }

  async markRead(userId: string, ids?: string[]) {
    return prisma.notification.updateMany({
      // Scoped to the caller: an id you do not own is not yours to mark.
      where: { userId, read: false, ...(ids?.length ? { id: { in: ids } } : {}) },
      data: { read: true, readAt: new Date() },
    });
  }

  async filterUserNotification(
    userId: string,
    limit: string,
    dateFrom: Date | null,
    dateTo: Date | null,
    type: string | null,
  ) {
    return prisma.notification.findMany({
      where: {
        userId,
        ...(dateFrom && dateTo && { createdAt: { gte: dateFrom, lte: dateTo } }),
        ...(type && { type: type as NotificationType }),
      },
      take: limit ? parseInt(limit) : 20,
      orderBy: { createdAt: 'desc' },
    });
  }
}

export default new NotificationService();