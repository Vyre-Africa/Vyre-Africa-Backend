// ─────────────────────────────────────────────────────────────────────────────
// src/liveActivities/VyreActivity.tsx
//
// ONE layout for every Vyre Live Activity: a stablecoin → external fiat
// transfer, shown as two asset icons with a chevron track between them that
// fills as the transfer moves.
//
// ── Nothing personal on the card ─────────────────────────────────────────────
//
// No amount, no balance, no account number, no recipient name, no reference.
// A lock screen is readable by anyone holding the phone, and this is a money
// app in a market where that is not hypothetical. What the card carries is the
// PAIR and the PROGRESS — "your USDC is on its way to naira, three of four" —
// which is the part people actually want to glance at, and is useless to a
// stranger.
//
// That constraint is also what makes the layout reusable without edits:
// USDC→NGN, USDT→NGN, USDC→KES are the same card with different icons.
//
// ── Shared file ──────────────────────────────────────────────────────────────
// The backend renders this to uiJsonData with @use-voltra/ios-server (STATIC
// mode); the bundled definition renders the same tree on-device (DYNAMIC). They
// MUST agree, or a server update redraws the card differently from how the app
// drew it. Spondle duplicated the file with a "kept in sync" comment, which is
// a promise nobody keeps. Best first:
//   1. one file in a shared workspace package both import
//   2. backend owns it, mobile imports via a tsconfig path alias
//   3. duplicate it and add a CI step that diffs the two and fails
//
// ── Size ─────────────────────────────────────────────────────────────────────
// Voltra compresses and base64-encodes the tree, so the payload is the rendered
// length plus an 83-byte envelope with no escaping cost. Voltra itself throws
// past 3345 bytes; MAX_LAYOUT_BYTES in apns.service.ts sits just under. This
// tree is a fixed handful of nodes plus one chevron per step.
// ─────────────────────────────────────────────────────────────────────────────

import { Voltra } from '@use-voltra/ios';

// ─── Props ──────────────────────────────────────────────────────────────────

export type VyreActivityState = 'in_progress' | 'succeeded' | 'failed';

export type VyreAsset = {
  /** Ticker shown under the icon. 'USDC', 'USDT', 'NGN', 'KES'. */
  code: string;
  /**
   * Artwork, from `assets/voltra/<assetName>.png` — the filename without its
   * extension, which is how the Voltra plugin names the generated imageset.
   * png/jpg/jpeg only.
   *
   * Optional: when the asset is missing, `Voltra.Image`'s own `fallback`
   * renders an SF Symbol instead, so the card works before any artwork exists
   * and upgrades silently once the files land.
   */
  assetName?: string;
  /** Override the SF Symbol fallback. Defaults from `code`. */
  symbol?: string;
};

export type VyreActivityProps = {
  /** What is leaving. The stablecoin side. */
  from: VyreAsset;
  /** What is arriving. The fiat side. */
  to: VyreAsset;

  /** 0-based. stepIndex 1 of stepCount 4 lights two chevrons. */
  stepIndex: number;
  stepCount: number;

  /** What is happening now, in the caller's words. 'Converting', 'At your bank'. */
  stepLabel: string;

  state: VyreActivityState;

  /**
   * Where tapping the card goes. Supplied by the caller so this file knows
   * nothing about Vyre's routes.
   *
   * It must be a URL, not a router path: `/(tabs)/activity` is valid for
   * router.push and meaningless in a URL, where a group segment mounts the
   * screen outside its layout — no tab bar, no history, nothing to go back to.
   * `+native-intent.ts` strips them defensively, but send `vyre://activity`.
   */
  deepLink: string;

  /** Optional single action. Omit it rather than render a button that does nothing. */
  action?: { label: string; url: string; symbol?: string };
};

// ─── Palette ────────────────────────────────────────────────────────────────
// From vyreTokens.brand. Hardcoded because a widget extension cannot import
// the app's token module — but these MUST match vyreTokens or the card will
// not look like the app.
//
//   navy    #0A1B38   brand.navy
//   emerald #1DDE9B   brand.emerald
//   lemon   #E9F871   brand.lemon
//
// Taken from the shipped app icon (brand/vyre-icon-brand.svg), which is the
// authoritative brand artwork — its three fills ARE these three values. If
// constants/vyreTokens.ts disagrees, the tokens are what the app renders and
// these should be changed to match them, because a card that is two shades off
// the app it belongs to looks like a different product.
//
// The soft icon variant uses #193259 / #62CE9A / #E9F871 — a lighter navy and a
// desaturated green. Not used here: a lock screen card competes with whatever
// wallpaper is behind it, so it wants the saturated set.
//
// Solid navy, not a gradient.

const NAVY = '#0A1B38';
const EMERALD = '#1DDE9B';
const LEMON = '#E9F871';
const WHITE = '#FFFFFF';

/**
 * How the card is backed. Change this ONE word and rebuild — all three paths
 * are wired below.
 *
 *   'solid'   An opaque navy rectangle we draw. The card is Vyre navy on every
 *             wallpaper, in both appearances, forever. Least native-looking,
 *             most predictable, and the only option where the lemon and
 *             emerald accents are guaranteed the contrast they were picked for.
 *             This is what delivery and ride-hailing apps ship.
 *
 *   'tint'    SwiftUI's .activityBackgroundTint(NAVY) — navy over the system's
 *             blurred material, so the wallpaper reads through. Blends like a
 *             native widget. But the result is navy MIXED WITH the wallpaper,
 *             not navy: over a warm wallpaper it lands closer to aubergine,
 *             and over a pale one it washes out and takes the accents with it.
 *
 *   'system'  No tint at all — the plain material, which is simply a blur of
 *             whatever is behind it. The most native and the least Vyre;
 *             on a bright wallpaper the card turns bright and nothing on it
 *             says whose card this is.
 *
 * iOS owns the opacity and it differs between light and dark appearance, so
 * under 'tint' and 'system' treat the background as a hue rather than a fill
 * and never rely on it for text contrast.
 *
 * Worth deciding on the device rather than from a mockup: `--start`, lock the
 * phone, and look at it over the wallpaper you actually use.
 */
const BACKGROUND: 'solid' | 'tint' | 'system' = 'system';

/** Failure red. Muted rather than alarm-red — a stalled payout is bad news, not a siren. */
const RED = '#E05260';

// ── The white-alpha set ─────────────────────────────────────────────────────
//
// Every one of these assumes a DARK backdrop, and under BACKGROUND = 'system'
// the backdrop is no longer ours — it is a blur of the customer's wallpaper.
// The lock screen renders its content in dark appearance, so the material
// stays dark-leaning whatever the photo behind it, and these should hold. But
// "should" is doing work in that sentence, and the two below marked RISK are
// the ones to look at on a real phone over a bright wallpaper.
//
// If either reads thin, raise it here — nothing else needs touching:
//   DIM    0.22 → 0.30     unlit chevrons
//   MUTED  0.62 → 0.75     the step label
// Raise DIM further than that and the unlit chevrons start competing with the
// lit ones, which is the whole signal the card exists to carry.
const DIM = 'rgba(255, 255, 255, 0.22)';      // RISK — unlit chevrons
const HAIRLINE = 'rgba(255, 255, 255, 0.12)'; // unused under 'system'; see BACKGROUND
const MUTED = 'rgba(255, 255, 255, 0.62)';    // RISK — step label
// COIN_BG was the tinted circle behind each coin. Removed with the badge
// wrapper — see AssetBadge. Left documented rather than silently deleted
// because the ring it used to draw is the reason artwork is sized full-bleed.

// ─── State tokens ───────────────────────────────────────────────────────────

type StateTokens = {
  /** Lights the travelled chevrons and tints the status pill. */
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

/**
 * SF Symbol fallback per ticker, used only when no artwork is bundled.
 *
 * Deliberately small: the real icons come from assets/voltra. Naira has its own
 * glyph from SF Symbols 4 (iOS 16+), which is the one worth getting right since
 * it is the destination on nearly every Vyre transfer.
 */
const SYMBOL_FOR: Record<string, string> = {
  NGN: 'nairasign.circle.fill',
  USD: 'dollarsign.circle.fill',
  USDC: 'dollarsign.circle.fill',
  USDT: 'dollarsign.circle.fill',
  EUR: 'eurosign.circle.fill',
  GBP: 'sterlingsign.circle.fill',
  KES: 'banknote.fill',
  GHS: 'banknote.fill',
  ZAR: 'banknote.fill',
};

function symbolFor(asset: VyreAsset): string {
  return asset.symbol ?? SYMBOL_FOR[asset.code.toUpperCase()] ?? 'banknote.fill';
}

/**
 * Which bundled artwork belongs to a currency code.
 *
 * Only codes with a file in `assets/voltra/` appear here — an entry for artwork
 * that does not exist would point `Voltra.Image` at a missing imageset, and
 * while `fallback` catches that, the badge would then render the SF Symbol at
 * full-bleed sizing meant for a circular mark. Adding a currency means adding
 * the PNG and the line together.
 *
 * Crypto uses the token's own mark; fiat uses the country's flag, because a
 * payout destination is a place, and a flag is read faster than a currency
 * glyph by someone glancing at a lock screen.
 */
const CRYPTO_ARTWORK: Record<string, string> = {
  USDC: 'usdc', USDT: 'usdt', DAI: 'dai', ETH: 'eth', BTC: 'btc',
};

/**
 * Every ISO 4217 code with a bundled flag in `assets/voltra/`.
 *
 * A set rather than a map because the naming is uniform: the file is always
 * the lowercased code, so NGN is ngn.png and there is nothing to look up. The
 * set still has to exist — deriving the name without checking membership would
 * point `Voltra.Image` at a missing imageset for any currency we have not
 * bundled, and the fallback only covers a FAILED load, not a nonexistent one.
 *
 * Flags are the issuing country's. Where a currency spans several countries
 * the issuer is chosen deliberately, not taken first off a list — USD's
 * country list begins with Antarctica.
 *
 * XOF, XAF, XPF and XCD are currency unions with no issuing country, so no
 * flag could be honest about them. Those four carry a symbol disc instead.
 */
const FIAT_ARTWORK = new Set([
    'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
    'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BRL',
    'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNY',
    'COP', 'CRC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP',
    'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD',
    'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HTG', 'HUF', 'IDR', 'ILS', 'INR',
    'IQD', 'IRR', 'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF',
    'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL',
    'LYD', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR',
    'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR',
    'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR',
    'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD',
    'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SYP', 'SZL', 'THB', 'TJS',
    'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX', 'USD',
    'UYU', 'UZS', 'VED', 'VND', 'VUV', 'WST', 'XAF', 'XCD', 'XOF', 'XPF',
    'YER', 'ZAR', 'ZMW', 'ZWG',
]);

export function assetFor(code: string): VyreAsset {
  const upper = code.toUpperCase();
  const crypto = CRYPTO_ARTWORK[upper];
  if (crypto) return { code: upper, assetName: crypto };
  if (FIAT_ARTWORK.has(upper)) return { code: upper, assetName: upper.toLowerCase() };
  return { code: upper };
}

// ─── One asset: icon above its ticker ───────────────────────────────────────

function AssetBadge({ asset, tint }: { asset: VyreAsset; tint: string }) {
  return (
    <Voltra.VStack alignment="center" style={{ width: 52 }}>
      {/* ── The badge ───────────────────────────────────────────────────────
          The image IS the badge. There is no sized box around it.

          It used to be a 34x34 VStack (COIN_BG, borderRadius 17) wrapping a
          34x34 Image, and on device BOTH collapsed to a flat bar a few points
          tall — the artwork never appeared and Voltra's own `fallback` never
          fired either. A missing asset cannot flatten its parent, so the box
          was the problem, not the file. Voltra renders a failed image as
          `Color.clear.overlay(fallback).applyStyle(style)`, and Color.clear has
          no intrinsic size, so anything that loses its frame vanishes.

          Nesting two fixed frames and depending on both to survive was the
          mistake. One element, one frame, nothing to collapse into.

          resizeMode is "cover", not "contain": cover maps to
          `.resizable().scaledToFill().clipped()`, which takes its size from the
          frame, while contain maps to `.scaledToFit()`, which negotiates with
          the parent and can end up with nothing. The artwork is square, so
          cover crops nothing.

          No borderRadius. Every mark is already circular — USDC is a blue
          disc, USDT a green one, a fiat flag is a circle — so the clip was
          never doing work, and it was one more thing that could fail. */}
      {asset.assetName ? (
        <Voltra.Image
          source={{ assetName: asset.assetName }}
          resizeMode="cover"
          style={{ width: 34, height: 34, marginBottom: 5 }}
          // Still worth passing: if the asset name is wrong, this is the only
          // thing standing between a customer and an empty badge.
          fallback={<Voltra.Symbol name={symbolFor(asset)} tintColor={tint} scale="large" />}
        />
      ) : (
        // No artwork bundled for this currency. A glyph needs no frame of its
        // own — it has an intrinsic size — so it goes in bare.
        <Voltra.VStack alignment="center" style={{ marginBottom: 5 }}>
          <Voltra.Symbol name={symbolFor(asset)} tintColor={tint} scale="large" />
        </Voltra.VStack>
      )}

      <Voltra.Text
        style={{
          color: WHITE,
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 0.4,
        }}
      >
        {asset.code.toUpperCase()}
      </Voltra.Text>
    </Voltra.VStack>
  );
}

// ─── The chevron track ──────────────────────────────────────────────────────

/**
 * Chevrons, not a progress bar.
 *
 * Two reasons. They are inherently DIRECTIONAL, which is the whole point of
 * the card — something is moving from the stablecoin to the fiat — where a bar
 * only says "how far". And these stages are discrete: a payout is either
 * dispatched or it is not, so a bar at 62% implies a precision that does not
 * exist. Spondle used a time-driven LinearProgressView, which for an operation
 * of unpredictable length fills and then sits at 100% while nothing happens.
 *
 * One node per step, so a 4-step transfer adds 4 nodes to the payload.
 */
function ChevronTrack(props: VyreActivityProps, t: StateTokens) {
  const count = Math.max(1, Math.min(6, Math.floor(props.stepCount)));
  // At least one, always. A negative stepIndex is a caller bug, and zero lit
  // chevrons reads as "nothing has happened" rather than "at the beginning" —
  // which on a transfer card looks broken rather than early.
  const lit =
    props.state === 'succeeded'
      ? count
      : Math.max(1, Math.min(count, Math.floor(props.stepIndex) + 1));

  const chevrons = [];
  for (let i = 0; i < count; i++) {
    chevrons.push(
      <Voltra.Symbol
        key={`chev-${i}`}
        name="chevron.right"
        tintColor={i < lit ? t.accent : DIM}
        // medium, not small. At `small` the chevrons render around 8pt wide and
        // the whole gesture of the card — the thing moving left to right — is
        // lost past arm's length, which is the only distance a lock screen is
        // ever read from.
        scale="medium"
        style={{ marginRight: i === count - 1 ? 0 : 4 }}
      />,
    );
  }

  return (
    <Voltra.HStack
      alignment="center"
      style={{
        flex: 1,
        marginLeft: 6,
        marginRight: 6,
        // Pulls the track up onto the COIN centreline.
        //
        // Without it the chevrons sit ~9pt low. The row centres its children
        // against the tallest one, and a badge is 52pt tall (34 disc + 5 gap +
        // 13 ticker) while its disc is centred at 17pt. Centring the chevrons
        // in 52 puts them at 26 — below the coins, pointing at the tickers.
        // An 18pt bottom margin (ticker + gap) makes the track's box the same
        // shape as the badge, so both centre on the same line.
        marginBottom: 18,
      }}
    >
      {chevrons}
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
          // Under 'solid' we paint the navy ourselves; under the other two
          // ActivityKit owns the background and anything we paint would cover
          // the material it is blurring.
          ...(BACKGROUND === 'solid' ? { backgroundColor: NAVY } : {}),
          // No border and no borderRadius in any mode. The system rounds and
          // clips the presentation at its own radius, so our 22pt corners sat
          // inside theirs — two nested roundings with a sliver showing between
          // them, which is what made the card look pasted onto the lock screen
          // rather than part of it.
          //
          // 16pt padding, not 18. ActivityKit gives the lock screen
          // presentation 160pt of height and clips past it. Measured: 16 + 22
          // header + 12 + (34 + 5 + 13 badge) + 10 + 27 action footer = 155pt,
          // leaving headroom for a larger accessibility font. At 18/14/38/6 the
          // failed state — the only one carrying the action button — came to
          // ~170pt, and the button is the one control on the card.
          padding: 16,
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

        {/* The whole story: from → to, with the track between them. */}
        <Voltra.HStack alignment="center" style={{ marginBottom: 10 }}>
          <AssetBadge asset={props.from} tint={WHITE} />
          {ChevronTrack(props, t)}
          <AssetBadge asset={props.to} tint={props.state === 'succeeded' ? t.accent : WHITE} />
        </Voltra.HStack>

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
                  paddingTop: 6,
                  paddingBottom: 6,
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

  // `lockScreen` takes either a ReactNode or { content, activityBackgroundTint }
  // — @use-voltra/ios live-activity/types.ts. The object form is the only way
  // to reach SwiftUI's .activityBackgroundTint(), so the card uses it.
  //
  // LiveActivityVariants also has `island` (expanded / compact / minimal) and
  // `supplementalActivityFamilies.small` for watchOS and CarPlay — and this
  // card is a natural fit for the compact Island, which is two icons and a
  // chevron wide. Worth adding once the lock screen is settled.
  return {
    lockScreen: {
      content: lockScreen,
      // Only 'tint' sets one. Voltra drops the key when it is undefined
      // (renderer.ts guards on truthiness), so 'solid' and 'system' both ship
      // a payload with no ls_background_tint at all — and ActivityKit's
      // default for no tint is the plain material, which is exactly 'system'.
      ...(BACKGROUND === 'tint' ? { activityBackgroundTint: NAVY } : {}),
    },
  };
}