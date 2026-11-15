// ─────────────────────────────────────────────────────────────────────────────
// src/liveActivities/VyreActivity.tsx
//
// ONE layout for every Vyre Live Activity. Nothing in here names a payment
// rail, a provider or a flow — the caller supplies the copy, the step labels
// and the deep link, so a new subject is a mapping function rather than a new
// layout.
//
// ── Shared file ──────────────────────────────────────────────────────────────
// The backend renders this to uiJsonData with @use-voltra/ios-server; the
// mobile app renders the same tree when it starts an activity locally. They
// MUST agree, or a server update redraws the card differently from how the app
// drew it. Spondle duplicated the file with a "kept in sync" comment, which is
// a promise no one keeps. Options, best first:
//   1. one file in a shared workspace package both import
//   2. backend owns it, mobile imports via a tsconfig path alias
//   3. duplicate it and add a CI step that diffs the two and fails
// Pick one before the second copy exists.
//
// ── Size ─────────────────────────────────────────────────────────────────────
// uiJsonData is a JSON string nested inside the APNs JSON, so its quotes are
// escaped on the way out: measured ×1.22 over an 83-byte envelope, giving a
// real budget of ~3200 bytes of layout JSON (MAX_LAYOUT_BYTES in
// apns.service.ts). This tree is a fixed handful of nodes plus one per step, so
// it sits far under — but 00-payload.ts asserts the budget and the service
// refuses an oversized payload with the byte count, rather than letting Apple
// answer PayloadTooLarge with no clue which layout did it.
// ─────────────────────────────────────────────────────────────────────────────

import { Voltra } from '@use-voltra/ios';

// ─── Props ──────────────────────────────────────────────────────────────────

export type VyreActivityState = 'in_progress' | 'succeeded' | 'failed';

export type VyreActivityProps = {
  /** Headline. "Withdrawal", "Transfer to UK" — the caller's words. */
  title: string;

  /**
   * Pre-formatted, WITH its currency. Never a number: Vyre money is Decimal,
   * and Spondle's bill layout took `amount: number` straight into
   * Intl.NumberFormat, which is exactly what DecimalUtil exists to prevent.
   */
  amount: string;

  /** Second line. A masked account, a bank, a recipient. Optional. */
  detail?: string;

  /** 0-based. stepIndex 2 of stepCount 4 fills two segments. */
  stepIndex: number;
  stepCount: number;

  /** What is happening now, in the caller's words. "Converting", "At your bank". */
  stepLabel: string;

  state: VyreActivityState;

  /**
   * Where tapping the card goes. Supplied by the caller so this file knows
   * nothing about Vyre's routes — Spondle hardcoded
   * `spondle://activity/${choreId}` into every layout.
   *
   * Vyre's routes are SINGULAR: vyre://transaction/<id>, vyre://wallet/<id>.
   * The plural forms 404, which cost us an evening on the push deep links.
   */
  deepLink: string;

  /** Optional single action. Omit it rather than render a button that does nothing. */
  action?: { label: string; url: string; symbol?: string };
};

// ─── Palette ────────────────────────────────────────────────────────────────
// From vyreTokens.brand. Hardcoded here because the widget extension cannot
// import the app's token module — but these three MUST match vyreTokens or the
// card will not look like the app.
//
//   navy    #0A1E3C   brand.navy
//   emerald #1ED296   brand.emerald
//   lemon   #E4FB55   brand.lemon
//
// Solid navy, not a gradient.

const NAVY = '#0A1E3C';
const EMERALD = '#1ED296';
const LEMON = '#E4FB55';
const WHITE = '#FFFFFF';

/** Failure red. Muted rather than alarm-red — a failed payout is bad news, not a siren. */
const RED = '#E05260';

const TRACK = 'rgba(255, 255, 255, 0.18)';
const HAIRLINE = 'rgba(255, 255, 255, 0.12)';
const MUTED = 'rgba(255, 255, 255, 0.62)';

// ─── State tokens ───────────────────────────────────────────────────────────

type StateTokens = {
  /** Fills completed step segments, and tints the status pill. */
  accent: string;
  /** Pill text sits on the accent, so it has to read against it. */
  onAccent: string;
  symbol: string;
};

function tokensFor(state: VyreActivityState): StateTokens {
  if (state === 'succeeded') {
    return { accent: EMERALD, onAccent: NAVY, symbol: 'checkmark' };
  }
  if (state === 'failed') {
    return { accent: RED, onAccent: WHITE, symbol: 'exclamationmark' };
  }
  // In flight. Lemon is the brand's yellow and reads as "working" without
  // borrowing the green that means done.
  return { accent: LEMON, onAccent: NAVY, symbol: 'arrow.triangle.2.circlepath' };
}

// ─── Step rule ──────────────────────────────────────────────────────────────

/**
 * Segmented, not a continuous bar. Two reasons.
 *
 * Spondle used a time-driven LinearProgressView, which for an operation of
 * unpredictable length fills and then sits at 100% while nothing happens —
 * that reads as stuck. And these stages ARE discrete: a payout is either
 * dispatched or it is not, so a bar at 62% implies a precision that does not
 * exist.
 *
 * One node per step, so a 4-step activity adds 4 nodes to the payload.
 */
function stepRule(props: VyreActivityProps, t: StateTokens) {
  const count = Math.max(1, Math.min(6, Math.floor(props.stepCount)));
  const filled =
    props.state === 'succeeded'
      ? count
      : Math.max(0, Math.min(count, Math.floor(props.stepIndex) + 1));

  const segments = [];
  for (let i = 0; i < count; i++) {
    segments.push(
      <Voltra.VStack
        key={`seg-${i}`}
        style={{
          flex: 1,
          height: 4,
          borderRadius: 2,
          backgroundColor: i < filled ? t.accent : TRACK,
          marginRight: i === count - 1 ? 0 : 4,
        }}
      />,
    );
  }

  return (
    <Voltra.HStack alignment="center" style={{ marginBottom: 8 }}>
      {segments}
    </Voltra.HStack>
  );
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function buildVyreActivityLayout(props: VyreActivityProps) {
  const t = tokensFor(props.state);

  const stepCount = Math.max(1, Math.min(6, Math.floor(props.stepCount)));
  const stepHuman = Math.max(1, Math.min(stepCount, Math.floor(props.stepIndex) + 1));

  const lockScreen = (
    <Voltra.Link destination={props.deepLink}>
      <Voltra.VStack
        alignment="leading"
        style={{
          backgroundColor: NAVY,
          borderRadius: 22,
          padding: 18,
          borderWidth: 1,
          borderColor: HAIRLINE,
        }}
      >
        {/* Header: wordmark + state pill */}
        <Voltra.HStack alignment="center" style={{ marginBottom: 12 }}>
          <Voltra.Text
            style={{
              color: WHITE,
              fontSize: 13,
              fontWeight: '800',
              letterSpacing: 1.2,
              flex: 1,
            }}
          >
            VYRE
          </Voltra.Text>

          <Voltra.HStack
            alignment="center"
            style={{
              backgroundColor: t.accent,
              paddingLeft: 9,
              paddingRight: 11,
              paddingTop: 4,
              paddingBottom: 4,
              borderRadius: 999,
            }}
          >
            <Voltra.Symbol name={t.symbol} tintColor={t.onAccent} scale="small" />
            <Voltra.Text
              style={{
                color: t.onAccent,
                fontSize: 11,
                fontWeight: '700',
                marginLeft: 4,
              }}
            >
              {props.stepLabel}
            </Voltra.Text>
          </Voltra.HStack>
        </Voltra.HStack>

        {/* Title */}
        <Voltra.Text
          style={{
            color: MUTED,
            fontSize: 13,
            fontWeight: '600',
            marginBottom: 2,
          }}
        >
          {props.title}
        </Voltra.Text>

        {/* Amount — the thing people unlock their phone to see */}
        <Voltra.Text
          style={{
            color: WHITE,
            fontSize: 30,
            fontWeight: '800',
            marginBottom: props.detail ? 2 : 14,
          }}
        >
          {props.amount}
        </Voltra.Text>

        {props.detail ? (
          <Voltra.Text
            style={{
              color: MUTED,
              fontSize: 13,
              fontWeight: '500',
              marginBottom: 14,
            }}
          >
            {props.detail}
          </Voltra.Text>
        ) : null}

        {stepRule(props, t)}

        {/* Footer: step counter, and the action if there is one */}
        <Voltra.HStack alignment="center">
          <Voltra.Text
            style={{
              color: MUTED,
              fontSize: 11,
              fontWeight: '600',
              flex: 1,
            }}
          >
            {props.state === 'succeeded'
              ? 'Complete'
              : props.state === 'failed'
                ? 'Stopped'
                : `Step ${stepHuman} of ${stepCount}`}
          </Voltra.Text>

          {props.action ? (
            <Voltra.Link destination={props.action.url}>
              <Voltra.HStack
                alignment="center"
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.10)',
                  paddingLeft: props.action.symbol ? 10 : 13,
                  paddingRight: 13,
                  paddingTop: 7,
                  paddingBottom: 7,
                  borderRadius: 999,
                }}
              >
                {props.action.symbol ? (
                  <Voltra.Symbol name={props.action.symbol} tintColor={WHITE} scale="small" />
                ) : null}
                <Voltra.Text
                  style={{
                    color: WHITE,
                    fontSize: 12,
                    fontWeight: '700',
                    marginLeft: props.action.symbol ? 5 : 0,
                  }}
                >
                  {props.action.label}
                </Voltra.Text>
              </Voltra.HStack>
            </Voltra.Link>
          ) : null}
        </Voltra.HStack>
      </Voltra.VStack>
    </Voltra.Link>
  );

  // Spondle's factories return { lockScreen } only, so that is the shape known
  // to work with this Voltra version. If it also supports Dynamic Island
  // variants (compact / minimal / expanded), they belong here — a withdrawal in
  // flight is exactly what the Island is for. Needs the @use-voltra versions to
  // confirm before I write against an API I have only inferred.
  return { lockScreen };
}