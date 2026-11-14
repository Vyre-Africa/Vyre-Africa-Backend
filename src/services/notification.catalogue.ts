// src/services/notification.catalogue.ts
//
// One place where a notification's copy, its channels and its idempotency
// key are decided.
//
// ── Why this file exists ───────────────────────────────────────────────
//
// Right now callers pass `title` and `content` as strings into
// `notificationService.queue(...)`. That means the email body, the push
// body, the in-app row and the Ably payload for the same event are each
// written wherever the caller happened to be, and they drift. Spondle has
// the same shape and it is how their push ended up with
// `interruptionLevel` in a field Expo does not read, for months, while a
// log line insisted it was working.
//
// Render once. Every channel uses the same strings.

export type VyreEvent =
  | { kind: 'TRANSFER_SUBMITTED'; txId: string; amount: string; to: string }
  | { kind: 'TRANSFER_LANDED';    txId: string; amount: string; to: string }
  | { kind: 'TRANSFER_FAILED';    txId: string; amount: string; to: string; reason?: string }
  | { kind: 'DEPOSIT_PENDING';    walletId: string; amount: string; ref: string }
  /* `txId` OR `walletId` — see the render below. Some rails produce a
     VirtualTransaction for the credit (p2pTransfer returns one) and some
     only know which wallet grew. Both are optional so a call site can
     pass whichever it actually holds, rather than inventing one. */
  | { kind: 'DEPOSIT_CREDITED';   amount: string; ref: string; txId?: string; walletId?: string }
  /* A deposit that did not arrive. The counterpart to DEPOSIT_CREDITED,
     and the one people phone support about — money left their bank and
     nothing showed up. Silence here is the worst possible answer. */
  | { kind: 'DEPOSIT_FAILED';     amount: string; ref: string; walletId?: string }
  /* A buy/sell order settling. `got` and `paid` arrive pre-formatted with
     their currencies, because only the caller knows which side of the
     pair is which. */
  | { kind: 'ORDER_COMPLETED';    orderId: string; side: 'BUY' | 'SELL'; got: string; paid: string }
  | { kind: 'WALLET_CREATED';     walletId: string; currency: string }
  | { kind: 'KYC_APPROVED';       tier: number }
  | { kind: 'KYC_DECLINED';       sessionId: string }
  | { kind: 'KYC_REVIEW';         sessionId: string }
  | { kind: 'LIMIT_WARNING';      period: string; used: string; limit: string }
  | { kind: 'SECURITY_SIGNIN';    device: string; at: string }
  | { kind: 'SECURITY_PIN_CHANGED'; at: string }
  // Escape hatch for the existing call sites that pass free-form strings.
  // Everything routed through here is in-app + email only, never push, and
  // has no dedupe key — see `legacy()` at the bottom.
  | { kind: 'GENERIC'; title: string; content: string; url?: string };

export type EventKind = VyreEvent['kind'];

export type Rendered = {
  title: string;
  body: string;
  /** Deep link inside the app. Must start with "/" — see push.service.ts. */
  url: string;
  sound: boolean;
  /**
   * Breaks through Focus and Do Not Disturb on iOS. Needs the
   * `com.apple.developer.usernotifications.time-sensitive` entitlement,
   * which is already in app.json.
   *
   * Reserved for money that has landed or failed, and account security.
   * A transfer being *submitted* does not qualify — the person just
   * tapped send, they know.
   */
  timeSensitive: boolean;
};

export type ChannelPolicy = {
  inApp: boolean;
  push: boolean;
  email: boolean;
  sms: boolean;
  realtime: boolean;
  /**
   * Ignores NotificationSetting entirely.
   *
   * Only SECURITY_*. A new sign-in or a changed PIN is not a preference —
   * it is the control that lets someone notice their account is being
   * taken over. That is also why there is no `security` toggle in
   * NotificationSetting for a user to switch off.
   */
  mandatory: boolean;
};

/* ──────────────────────────────────────────────────────────────────────
   Copy

   Note what is NOT in any of these: a balance. The body renders on a lock
   screen to whoever is holding the phone, so a transaction amount is a
   deliberate choice (banks show it) and a running balance is not — that
   tells a thief whether the handset is worth keeping.
   ────────────────────────────────────────────────────────────────────── */

export function render(e: VyreEvent): Rendered {
  switch (e.kind) {
    case 'TRANSFER_SUBMITTED':
      return {
        title: 'Transfer on its way',
        body: `${e.amount} to ${e.to} has been sent.`,
        url: `/transaction/${e.txId}`,
        sound: false,
        timeSensitive: false,
      };
    case 'TRANSFER_LANDED':
      return {
        title: 'Transfer delivered',
        body: `${e.amount} reached ${e.to}.`,
        url: `/transaction/${e.txId}`,
        sound: true,
        timeSensitive: true,
      };
    case 'TRANSFER_FAILED':
      return {
        title: "Transfer didn't go through",
        // "You have not been charged" is not padding. The first thing
        // anyone thinks when a transfer fails is that their money has
        // vanished, and the hold is released before this fires.
        body: e.reason
          ? `${e.amount} to ${e.to} failed — ${e.reason}. You have not been charged.`
          : `${e.amount} to ${e.to} failed. You have not been charged.`,
        url: `/transaction/${e.txId}`,
        sound: true,
        timeSensitive: true,
      };
    case 'DEPOSIT_PENDING':
      return {
        title: 'Money on the way',
        body: `${e.amount} is arriving — we'll confirm once it clears.`,
        url: `/wallet/${e.walletId}`,
        sound: false,
        timeSensitive: false,
      };
    case 'DEPOSIT_CREDITED':
      return {
        title: 'Money in',
        body: `${e.amount} has landed in your wallet.`,
        /* The receipt when we have one, the wallet otherwise.
        
           A deposit's receipt is the more useful destination — it is what
           a transfer notification opens, and it answers "where did this
           come from" rather than just showing a balance. But not every
           rail hands us a transaction: a webhook that only says "wallet X
           grew" can still deep-link to the wallet.
           
           The last fallback matters. `/wallet/undefined` is a route that
           exists and fails, which is worse than a list — so with neither
           id the tap goes to the activity feed, where the deposit is
           visible anyway. */
        url: e.txId
          ? `/transaction/${e.txId}`
          : e.walletId
            ? `/wallet/${e.walletId}`
            : '/(tabs)/activity',
        sound: true,
        timeSensitive: true,
      };
    case 'DEPOSIT_FAILED':
      return {
        title: "Deposit didn't arrive",
        body: `${e.amount} could not be credited. Tap for what to do next.`,
        url: e.walletId ? `/wallet/${e.walletId}` : '/(tabs)/activity',
        sound: true,
        /* Time-sensitive for the same reason TRANSFER_FAILED is: money the
           user expected is missing, and the sooner they know the sooner
           they can chase it. */
        timeSensitive: true,
      };
    case 'ORDER_COMPLETED':
      return {
        title: 'Order completed',
        body: e.side === 'BUY'
          ? `You bought ${e.got} for ${e.paid}.`
          : `You sold ${e.paid} for ${e.got}.`,
        /* The activity list, not an order screen — the app has no
           /order/[id] route. Point this at one if that changes. */
        url: '/(tabs)/activity',
        sound: false,
        timeSensitive: false,
      };
    case 'WALLET_CREATED':
      return {
        title: `${e.currency} wallet ready`,
        body: `You can now hold and send ${e.currency}.`,
        url: `/wallet/${e.walletId}`,
        sound: false,
        timeSensitive: false,
      };
    case 'KYC_APPROVED':
      return {
        title: 'Verification approved',
        body: 'Your limits have gone up. Tap to see what you can move now.',
        url: '/kyc',
        sound: true,
        timeSensitive: false,
      };
    case 'KYC_DECLINED':
      return {
        title: 'Verification unsuccessful',
        body: "We couldn't verify you with what was provided. Tap to try again.",
        url: '/kyc',
        sound: false,
        timeSensitive: false,
      };
    case 'KYC_REVIEW':
      return {
        title: 'Verification under review',
        body: 'Your submission needs a closer look. Nothing more for you to do.',
        url: '/kyc',
        sound: false,
        timeSensitive: false,
      };
    case 'LIMIT_WARNING':
      return {
        title: 'Approaching your monthly limit',
        body: `You've moved ${e.used} of ${e.limit} this month. Verify to raise it.`,
        url: '/kyc',
        sound: false,
        timeSensitive: false,
      };
    case 'SECURITY_SIGNIN':
      return {
        title: 'New sign-in',
        body: `Your account was opened on ${e.device}. Not you? Tap to secure it.`,
        url: '/(tabs)/settings',
        sound: true,
        timeSensitive: true,
      };
    case 'SECURITY_PIN_CHANGED':
      return {
        title: 'Your PIN was changed',
        body: "If this wasn't you, secure your account now.",
        url: '/(tabs)/settings',
        sound: true,
        timeSensitive: true,
      };
    case 'GENERIC':
      return {
        title: e.title,
        body: e.content,
        url: e.url ?? '/(tabs)',
        sound: false,
        timeSensitive: false,
      };
  }
}

/* ──────────────────────────────────────────────────────────────────────
   Channels
   ────────────────────────────────────────────────────────────────────── */

const T = true;
const F = false;

/** inApp, push, email, sms, realtime, mandatory */
const POLICY: Record<EventKind, ChannelPolicy> = {
  // Money moving gets an email receipt — confirmed as wanted. SMS stays off
  // until somebody decides it is worth the per-message cost in NGN.
  TRANSFER_SUBMITTED:   { inApp: T, push: T, email: T, sms: F, realtime: T, mandatory: F },
  TRANSFER_LANDED:      { inApp: T, push: T, email: T, sms: F, realtime: T, mandatory: F },
  TRANSFER_FAILED:      { inApp: T, push: T, email: T, sms: F, realtime: T, mandatory: F },
  DEPOSIT_PENDING:      { inApp: T, push: T, email: F, sms: F, realtime: T, mandatory: F },
  DEPOSIT_CREDITED:     { inApp: T, push: T, email: T, sms: F, realtime: T, mandatory: F },

  DEPOSIT_FAILED:       { inApp: T, push: T, email: T, sms: F, realtime: T, mandatory: F },

  ORDER_COMPLETED:      { inApp: T, push: T, email: T, sms: F, realtime: T, mandatory: F },

  WALLET_CREATED:       { inApp: T, push: T, email: F, sms: F, realtime: T, mandatory: F },

  KYC_APPROVED:         { inApp: T, push: T, email: T, sms: F, realtime: T, mandatory: F },
  KYC_DECLINED:         { inApp: T, push: T, email: T, sms: F, realtime: T, mandatory: F },
  KYC_REVIEW:           { inApp: T, push: T, email: F, sms: F, realtime: T, mandatory: F },
  LIMIT_WARNING:        { inApp: T, push: T, email: F, sms: F, realtime: T, mandatory: F },

  // mandatory — settings are not consulted.
  SECURITY_SIGNIN:      { inApp: T, push: T, email: T, sms: F, realtime: T, mandatory: T },
  SECURITY_PIN_CHANGED: { inApp: T, push: T, email: T, sms: F, realtime: T, mandatory: T },

  // Legacy callers. Deliberately no push: those call sites were written
  // for email and an in-app row, and quietly turning them into phone
  // notifications would be a surprise to users, not a feature.
  GENERIC:              { inApp: T, push: F, email: T, sms: F, realtime: T, mandatory: F },
};

export function channelsFor(kind: EventKind): ChannelPolicy {
  return POLICY[kind];
}

/* ──────────────────────────────────────────────────────────────────────
   Idempotency

   Returned as the Notification row's unique `dedupeKey` AND as BullMQ's
   `jobId`, so a replayed webhook is dropped at the queue before a worker
   runs, and caught again by the unique index if it somehow is not.

   This matters here specifically: handleNuvionEvent, handleDiditEvent and
   processRampWebhook all re-deliver, and the failure mode is telling
   someone twice that their money arrived.
   ────────────────────────────────────────────────────────────────────── */

export function dedupeKeyFor(userId: string, e: VyreEvent): string | null {
  switch (e.kind) {
    case 'TRANSFER_SUBMITTED':   return `transfer:${e.txId}:submitted`;
    case 'TRANSFER_LANDED':      return `transfer:${e.txId}:landed`;
    case 'TRANSFER_FAILED':      return `transfer:${e.txId}:failed`;
    case 'DEPOSIT_PENDING':      return `deposit:${e.ref}:pending`;
    case 'DEPOSIT_CREDITED':     return `deposit:${e.ref}:credited`;
    case 'DEPOSIT_FAILED':       return `deposit:${e.ref}:failed`;
    case 'ORDER_COMPLETED':      return `order:${e.orderId}:completed`;
    case 'WALLET_CREATED':       return `wallet:${e.walletId}:created`;
    case 'KYC_APPROVED':         return `kyc:${userId}:approved:${e.tier}`;
    case 'KYC_DECLINED':         return `kyc:${e.sessionId}:declined`;
    case 'KYC_REVIEW':           return `kyc:${e.sessionId}:review`;
    case 'LIMIT_WARNING':        return `limit:${userId}:${e.period}`;
    // Security events are deliberately NOT deduped by time — two sign-ins
    // a second apart are two things a person needs to know about. The
    // timestamp is part of the key so a genuine retry of the same event
    // still collapses.
    case 'SECURITY_SIGNIN':      return `security:${userId}:signin:${e.at}`;
    case 'SECURITY_PIN_CHANGED': return `security:${userId}:pin:${e.at}`;
    // No key: free-form callers have nothing stable to key on, and
    // inventing one from the title would collapse two genuinely different
    // messages that happen to share it.
    case 'GENERIC':              return null;
  }
}

/** Maps onto the existing NotificationType enum for the in-app row. */
export function legacyTypeFor(kind: EventKind): 'GENERAL' | 'ORDER' | 'TOPUP' {
  switch (kind) {
    case 'TRANSFER_SUBMITTED':
    case 'TRANSFER_LANDED':
    case 'TRANSFER_FAILED':
      return 'ORDER';
    case 'DEPOSIT_PENDING':
    case 'DEPOSIT_CREDITED':
    case 'DEPOSIT_FAILED':
      return 'TOPUP';
    case 'ORDER_COMPLETED':
      return 'ORDER';
    default:
      return 'GENERAL';
  }
}

/** Wraps an old-style call so existing call sites keep working unchanged. */
export function legacy(title: string, content: string, url?: string): VyreEvent {
  return { kind: 'GENERIC', title, content, url };
}