// ─────────────────────────────────────────────────────────────────────────────
// scripts/live-activity/01-send.ts
//
// The end-to-end driver. Hits a real device with a real APNs push, against a
// SYNTHETIC subject — no withdrawal, no bank, no provider. Deliberately: a real
// withdrawal has too many moving parts and you cannot make one fail on demand,
// which is exactly the path most likely to be broken.
//
//   npx ts-node scripts/live-activity/01-send.ts --user <userId> --start
//   npx ts-node scripts/live-activity/01-send.ts --user <userId> --advance
//   npx ts-node scripts/live-activity/01-send.ts --user <userId> --advance
//   npx ts-node scripts/live-activity/01-send.ts --user <userId> --end
//
//   --status        what the DB thinks, without sending anything
//   --break-end     send the end to a deliberately corrupt token, so you can
//                   watch the row stay ACTIVE instead of lying about ENDED
//   --sweep         run the sweep; after --break-end this is what recovers it
//   --fail          finish in the failed state instead of succeeded
//   --dynamic       start in DYNAMIC mode (bundled definition + { props })
//                   instead of STATIC (server-rendered { uiJsonData })
//   --cleanup       delete the synthetic row so you can start over
//
// Run the whole sequence twice, once with --dynamic on the --start, to prove
// both modes. Only the start takes the flag: the mode is stored on the row, so
// advance and finish follow it automatically — which is the behaviour worth
// checking, since a dynamic activity handed { uiJsonData } decodes nothing.
// --dynamic additionally requires the app.json `liveActivities` entry and a
// build containing the bundled definition.
//
// The intended session, in order:
//
//   --status                 → no activity. Confirms the user has a token.
//   --start                  → card appears on the lock screen
//   (open the app once)      → client reports the per-activity token
//   --status                 → activityPushToken is now set
//   --advance  --advance     → the card mutates in place, segments fill
//   --break-end              → end fails; row stays ACTIVE, endAttempts 1
//   --status                 → confirms it did NOT claim ENDED
//   --sweep                  → retries with the real token; card dismisses
//
// That last trio is the whole point. Spondle writes ENDED regardless of the
// result, so a failed end leaves a stale card with a DB that says otherwise.
// Keep this script after the first green run — it is the smoke test for every
// future dev build, the way 00-payload.ts is the offline one.
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import prisma from '../../config/prisma.client';
import liveActivityService from '../../services/liveActivity.service';
import apnsService from '../../services/apns.service';
import type { VyreActivityProps } from '../../services/liveActivities/VyreActivity';

// ─── A synthetic subject ────────────────────────────────────────────────────
// Fixed id so repeated runs hit the same row. SubjectType is obviously not a
// real flow, so a stray row can never be mistaken for one.

const SUBJECT_TYPE = 'SMOKE_TEST';
const SUBJECT_ID = 'smoke-0001';

/**
 * Four step labels with the shape of a real stablecoin → fiat payout.
 *
 * Labels only. No amount, no account, no reference: the card carries the PAIR
 * and the PROGRESS, because a lock screen is readable by anyone holding the
 * phone.
 */
const STEPS = ['Received', 'Converting', 'Sending', 'Paid out'];

/**
 * `assetName` points at assets/voltra/<name>.png. Until those exist the layout
 * falls back to an SF Symbol per ticker, so this is testable with no artwork.
 */
const FROM = { code: 'USDC', assetName: 'usdc' };
const TO = { code: 'NGN', assetName: 'ngn' };

/**
 * A URL, not a router path. `vyre://(tabs)/activity` mounts the screen outside
 * its layout — no tab bar, no history — which is how a tapped card stranded the
 * app until a force-quit. +native-intent.ts strips groups defensively now, but
 * producers should not emit them.
 */
const DEEP_LINK = 'vyre://activity';

function propsFor(stepIndex: number, state: VyreActivityProps['state']): VyreActivityProps {
    const i = Math.max(0, Math.min(STEPS.length - 1, stepIndex));
    return {
        from: FROM,
        to: TO,
        stepIndex: i,
        stepCount: STEPS.length,
        stepLabel: state === 'failed' ? 'Stopped' : STEPS[i],
        state,
        deepLink: DEEP_LINK,
        ...(state === 'failed'
            ? { action: { label: 'Get help', url: 'vyre://support', symbol: 'questionmark.circle' } }
            : {}),
    };
}

/**
 * What a later step actually knows — deliberately NOT the asset pair.
 *
 * `start` is the only call here that passes full props. Everything after it
 * sends a patch, which is what a provider webhook would realistically carry: a
 * status and a position, no currencies. If the pair reappears on the card after
 * an `--advance`, the merge against the stored baseProps worked. If the card
 * shows placeholder tickers, it did not — and that is the single thing these
 * two commands are now testing.
 */
function stepPatch(
    stepIndex: number,
    state: VyreActivityProps['state'],
): Partial<VyreActivityProps> {
    const i = Math.max(0, Math.min(STEPS.length - 1, stepIndex));
    return {
        stepIndex: i,
        stepLabel: state === 'failed' ? 'Stopped' : STEPS[i],
        state,
        ...(state === 'failed'
            ? { action: { label: 'Get help', url: 'vyre://support', symbol: 'questionmark.circle' } }
            : {}),
    };
}

// ─── Args ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
};

const userId = val('--user');

async function showStatus(uid: string) {
    const devices = await prisma.deviceToken.findMany({
        where: { userId: uid, platform: 'ios' },
        orderBy: { lastSeenAt: 'desc' },
    });

    console.log(`\ndevices (ios): ${devices.length}`);
    for (const d of devices) {
        console.log(
            `  ${d.token.slice(0, 16)}…  ${d.deviceName ?? 'unnamed'}  os=${d.osVersion ?? '?'}  ` +
            `push-to-start=${d.liveActivityPushToStartToken ? 'YES' : 'no'}` +
            (d.liveActivityTokenUpdatedAt ? `  (reported ${d.liveActivityTokenUpdatedAt.toISOString()})` : ''),
        );
    }
    if (!devices.some((d) => d.liveActivityPushToStartToken)) {
        console.log(
            '\n  No push-to-start token on any device. Either the Voltra extension is\n' +
            '  not in this build, the app has not run since it was added, or the\n' +
            '  device is below iOS 17.2 — on which only the app can start an activity.',
        );
    }

    const row = await prisma.liveActivity.findUnique({
        where: {
            subjectType_subjectId_userId: {
                subjectType: SUBJECT_TYPE, subjectId: SUBJECT_ID, userId: uid,
            },
        },
    });

    console.log('\nactivity row:');
    if (!row) {
        console.log('  (none — run --start)');
        return;
    }
    console.log(`  id                ${row.id}`);
    console.log(`  status            ${row.status}`);
    console.log(`  renderMode        ${row.renderMode}${row.definitionId ? `  (definition "${row.definitionId}")` : ''}`);
    console.log(`  step              ${row.stepIndex + 1}/${row.stepCount}  "${row.stepLabel ?? ''}"`);
    console.log(`  activityId        ${row.activityId ?? '(null — push-to-start returns none)'}`);
    console.log(`  activityPushToken ${row.activityPushToken ? row.activityPushToken.slice(0, 16) + '…' : '(null — open the app once)'}`);
    console.log(`  endRequestedAt    ${row.endRequestedAt?.toISOString() ?? '-'}`);
    console.log(`  endAttempts       ${row.endAttempts}`);
    console.log(`  endedAt           ${row.endedAt?.toISOString() ?? '-'}`);
    console.log(`  errorMessage      ${row.errorMessage ?? '-'}`);
    console.log(`  lastContentState  ${row.lastContentState ? 'stored' : '(none)'}`);

    if (row.status === 'ACTIVE' && !row.activityPushToken) {
        console.log(
            '\n  Write-once: without a per-activity token this activity cannot be\n' +
            '  updated or ended remotely. Open the app once so the client reports it.',
        );
    }
}

async function main() {
    if (!userId) {
        console.log('\n  --user <userId> is required.\n');
        console.log('  npx ts-node scripts/live-activity/01-send.ts --user <id> --status\n');
        process.exit(1);
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) {
        console.log(`\n  No user ${userId}\n`);
        process.exit(1);
    }

    const key = { userId, subjectType: SUBJECT_TYPE, subjectId: SUBJECT_ID };

    if (has('--cleanup')) {
        const deleted = await prisma.liveActivity.deleteMany({
            where: { subjectType: SUBJECT_TYPE, subjectId: SUBJECT_ID, userId },
        });
        console.log(`\n  deleted ${deleted.count} synthetic row(s)\n`);
        return;
    }

    if (has('--status') || argv.length <= 2) {
        await showStatus(userId);
        console.log();
        return;
    }

    if (has('--start')) {
        const renderMode = has('--dynamic') ? 'DYNAMIC' as const : 'STATIC' as const;
        console.log(`\n  starting in ${renderMode} mode…`);
        if (renderMode === 'DYNAMIC') {
            console.log('  (needs the app.json liveActivities entry and a build with the definition)');
        }
        const out = await liveActivityService.start({
            ...key,
            renderMode,
            props: propsFor(0, 'in_progress'),
            alert: {
                title: 'Withdrawal started',
                body: '₦250,000.00 is on its way to GTBank ••••8832',
                sound: 'default',
            },
            // Short on purpose so you can watch both fire during one test
            // rather than waiting out production values.
            staleAfterMs: 10 * 60 * 1000,
            dismissAfterMs: 30 * 60 * 1000,
        });
        console.log(out.started ? `  started: ${out.id}` : `  NOT started: ${out.reason}`);
        if (out.started) {
            console.log('\n  Look at the lock screen. Then open the app once so the client');
            console.log('  reports a per-activity token, and --advance will work.');
        }
        await showStatus(userId);
        console.log();
        return;
    }

    if (has('--advance')) {
        const row = await prisma.liveActivity.findUnique({
            where: { subjectType_subjectId_userId: key },
        });
        if (!row) {
            console.log('\n  no row — run --start first\n');
            return;
        }
        const next = Math.min(STEPS.length - 2, row.stepIndex + 1); // last step is for --end
        console.log(`\n  advancing ${row.stepIndex + 1} → ${next + 1} ("${STEPS[next]}")…`);
        const out = await liveActivityService.advance({ ...key, patch: stepPatch(next, 'in_progress') });
        console.log(out.updated ? '  updated — the card should have changed in place' : `  NOT updated: ${out.reason}`);
        await showStatus(userId);
        console.log();
        return;
    }

    if (has('--break-end')) {
        // Deliberately corrupt the token, attempt the end, then restore it. The
        // point is the BOOKKEEPING: the row must stay ACTIVE with endAttempts
        // incremented and endRequestedAt set, so --sweep can recover it. If it
        // reads ENDED after this, the conditional status write is broken.
        const row = await prisma.liveActivity.findUnique({
            where: { subjectType_subjectId_userId: key },
        });
        if (!row?.activityPushToken) {
            console.log('\n  needs a per-activity token — run --start, open the app, then retry\n');
            return;
        }

        const real = row.activityPushToken;
        const broken = 'f'.repeat(real.length);

        console.log('\n  pointing the row at a corrupt token…');
        await prisma.liveActivity.update({
            where: { id: row.id }, data: { activityPushToken: broken },
        });

        console.log('  attempting the end (expected to fail)…');
        const out = await liveActivityService.finish({ ...key, patch: stepPatch(3, 'succeeded') });
        console.log(`  finish returned: ${JSON.stringify(out)}`);

        const after = await prisma.liveActivity.findUnique({ where: { id: row.id } });
        console.log('\n  restoring the real token…');
        await prisma.liveActivity.update({
            where: { id: row.id },
            data: {
                activityPushToken: real,
                // A dead-token verdict nulls the token and closes the row; undo
                // that too, or --sweep has nothing to find.
                ...(after?.status !== 'ACTIVE' ? { status: 'ACTIVE', endedAt: null } : {}),
            },
        });

        console.log('\n  what matters:');
        console.log(`    endRequestedAt set          : ${after?.endRequestedAt ? 'yes ← correct' : 'no ← WRONG, the sweep cannot find it'}`);
        console.log(`    endAttempts                 : ${after?.endAttempts}`);

        // Three readings, and only one of them is a failure.
        //
        // This test deliberately creates the exact state the background sweep
        // exists to repair, so it RACES a registered 5-minute job. If the sweep
        // wins, the row is already ENDED by the time we look — which is the
        // behaviour under test, not a fault. An earlier version called that
        // "WRONG", which is a worse outcome than having no check at all.
        if (after?.status === 'ACTIVE') {
            console.log('    status after the failed end : ACTIVE  ← correct');
            console.log('\n  The failed end did NOT write ENDED. That is the whole point:');
            console.log('  Spondle writes it regardless, so its DB claims the card is gone');
            console.log('  while it sits on the lock screen until its dismissal date.');
            console.log('\n  Now run --sweep. The card should dismiss and the row go ENDED.\n');
        } else if (after?.status === 'ENDED' && (after?.endAttempts ?? 0) > 1) {
            console.log('    status after the failed end : ENDED  ← the sweep got there first');
            console.log('\n  Not a failure. The registered sweep woke up between the corrupt-token');
            console.log('  end and this read, found the row by endRequestedAt, retried with the');
            console.log('  REAL token and succeeded. Check the lock screen: the card should be');
            console.log('  gone, which is the end path working rather than the test failing.');
            console.log('\n  To watch the sequence by hand instead, pause the worker first.\n');
        } else {
            console.log(`    status after the failed end : ${after?.status}  ← UNEXPECTED`);
            console.log('\n  A failed end should leave the row ACTIVE for the sweep, or the sweep');
            console.log('  should have ended it with endAttempts > 1. Neither happened, so the');
            console.log('  conditional status write needs looking at.\n');
        }
        return;
    }

    if (has('--sweep')) {
        console.log('\n  sweeping…');
        const out = await liveActivityService.sweep();
        console.log(`  ${JSON.stringify(out)}`);
        await showStatus(userId);
        console.log();
        return;
    }

    if (has('--end')) {
        console.log('\n  finishing…');
        const out = await liveActivityService.finish({
            ...key,
            // A success completes the journey, so it names the last step. A
            // failure does NOT: omitting stepIndex lets mergeProps take it
            // from the row, freezing the chevrons where the transfer actually
            // stopped. Passing 3 here said "failed at step 4 of 4", which is a
            // lie about where the money got to — and it is the same mistake
            // transferActivity.finishTransferCard avoids. The driver has to
            // match the adapter or it validates behaviour nobody ships.
            patch: has('--fail')
                ? { stepLabel: 'Stopped', state: 'failed' as const,
                    action: { label: 'Get help', url: 'vyre://support', symbol: 'questionmark.circle' } }
                : stepPatch(3, 'succeeded'),
            // Long enough to read the final frame. Dismissing instantly means
            // the resolution is never seen, which defeats the point.
            lingerMs: 20_000,
        });
        console.log(`  ${JSON.stringify(out)}`);
        console.log('\n  The card should show its final state, then disappear in ~20s.');
        await showStatus(userId);
        console.log();
        return;
    }

    console.log('\n  unknown flag. one of: --status --start --advance --end --fail --break-end --sweep --cleanup\n');
}

main()
    .catch((err) => {
        console.error('\n  threw:', err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await apnsService.shutdown();
        await prisma.$disconnect();
    });