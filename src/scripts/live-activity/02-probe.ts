// ─────────────────────────────────────────────────────────────────────────────
// scripts/live-activity/02-probe.ts
//
//   npx ts-node src/scripts/live-activity/02-probe.ts <pushToStartToken>
//
// A one-shot diagnostic for "the pending stream has been canceled", which is
// what node-apn reports when the HTTP/2 stream dies before Apple answers. That
// message carries no `reason`, so it tells you nothing about WHY — and this
// project's logger drops the metadata object, so even the verdict is invisible.
//
// This talks to APNs with Node's own http2, no node-apn and no logger. Three
// stages, each printing what it found:
//
//   1. can we open an HTTP/2 session to APNs at all (and is TLS unmolested)
//   2. does the ES256 provider JWT build correctly
//   3. what does Apple actually say to a Live Activity start
//
// If stage 3 prints a :status and a reason, the connection is fine and the
// problem is node-apn or the payload. If stage 1 fails, nothing above it
// matters and the fix is network-side.
//
// NOTE on the JWT: ES256 in JOSE is the raw r||s pair, 64 bytes — NOT DER.
// Node needs `dsaEncoding: 'ieee-p1363'` for that. check-key.ts signs with
// 'der' because it only proves the key works; a DER signature in a real JWT
// gets a 403 from Apple, which would look like a credentials problem.
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import crypto from 'crypto';
import http2 from 'http2';
import tls from 'tls';
import config from '../../config/env.config';

const HOST = config.apns?.production
    ? 'api.push.apple.com'
    : 'api.sandbox.push.apple.com';

const token = process.argv[2];

/**
 * Which event to probe. Defaults to `start`, which needs the PUSH-TO-START
 * token. `update` and `end` need the PER-ACTIVITY token from
 * LiveActivity.activityPushToken — a different value, and sending one where
 * the other belongs is itself a rejection.
 */
const event = (process.argv[3] ?? 'start') as 'start' | 'update' | 'end';

function head(n: number, s: string) {
    console.log(`\n${n}. ${s}`);
}

// ─── 1. Reachability and TLS ────────────────────────────────────────────────

function checkTls(): Promise<boolean> {
    return new Promise((resolve) => {
        head(1, `TLS + ALPN to ${HOST}`);

        const socket = tls.connect(
            { host: HOST, port: 443, ALPNProtocols: ['h2'], servername: HOST },
            () => {
                const cert = socket.getPeerCertificate();
                const alpn = (socket as any).alpnProtocol;

                console.log(`  connected      : yes`);
                console.log(`  ALPN           : ${alpn ?? '(none)'}`);
                console.log(`  authorized     : ${socket.authorized}${socket.authorizationError ? ` (${socket.authorizationError})` : ''}`);
                console.log(`  cert subject   : ${cert?.subject?.CN ?? '?'}`);
                console.log(`  cert issuer    : ${cert?.issuer?.O ?? '?'} / ${cert?.issuer?.CN ?? '?'}`);

                if (alpn !== 'h2') {
                    console.log(
                        '\n  ✗ APNs is HTTP/2 ONLY. Without h2 every stream dies exactly the way\n' +
                        '    node-apn reported. Something is downgrading the connection.',
                    );
                }
                const issuer = `${cert?.issuer?.O ?? ''} ${cert?.issuer?.CN ?? ''}`;
                if (issuer && !/apple|digicert|entrust/i.test(issuer)) {
                    console.log(
                        '\n  ✗ That issuer is not Apple\'s chain — something is intercepting TLS\n' +
                        '    (ISP middlebox, corporate proxy, local VPN). Ordinary HTTPS survives\n' +
                        '    interception; HTTP/2 to APNs usually does not.',
                    );
                }

                socket.end();
                resolve(alpn === 'h2');
            },
        );

        socket.setTimeout(8000, () => {
            console.log('  connected      : TIMED OUT after 8s');
            console.log('\n  ✗ Port 443 to APNs is not reachable from here. Nothing else can work.');
            socket.destroy();
            resolve(false);
        });

        socket.on('error', (err: any) => {
            console.log(`  connected      : no — ${err?.code ?? ''} ${err?.message ?? err}`);
            resolve(false);
        });
    });
}

// ─── 2. The provider JWT ────────────────────────────────────────────────────

function buildJwt(): string | null {
    head(2, 'ES256 provider JWT');

    const { keyId, teamId, keyContent } = config.apns ?? ({} as any);
    if (!keyId || !teamId || !keyContent) {
        console.log('  ✗ missing APNS_KEY_ID / APNS_TEAM_ID / APNS_KEY_CONTENT');
        return null;
    }

    try {
        const key = crypto.createPrivateKey(keyContent);
        const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const signingInput =
            `${b64({ alg: 'ES256', kid: keyId })}.${b64({ iss: teamId, iat: Math.floor(Date.now() / 1000) })}`;

        // JOSE wants r||s (64 bytes), not DER. See the header note.
        const sig = crypto.sign('sha256', Buffer.from(signingInput), {
            key,
            dsaEncoding: 'ieee-p1363',
        });

        console.log(`  kid            : ${keyId}`);
        console.log(`  iss            : ${teamId}`);
        console.log(`  signature      : ${sig.length} bytes (64 = correct for ES256/JOSE)`);
        return `${signingInput}.${sig.toString('base64url')}`;
    } catch (err: any) {
        console.log(`  ✗ ${err?.message}`);
        return null;
    }
}

// ─── 3. What Apple actually says ────────────────────────────────────────────

function sendStart(jwt: string): Promise<void> {
    return new Promise((resolve) => {
        head(3, `Live Activity ${event} — Apple's real answer`);

        const now = Math.floor(Date.now() / 1000);
        const topic = `${config.apns?.bundleId}.push-type.liveactivity`;

        // attributes + attributes-type belong to `start` ONLY. An update or end
        // goes to the per-activity token, which already identifies the activity.
        const aps: Record<string, any> =
            event === 'start'
                ? {
                      timestamp: now,
                      event: 'start',
                      'content-state': { uiJsonData: 'G0sFAIC' },   // deliberately trivial
                      attributes: { name: 'VyreActivity' },
                      'attributes-type': 'VoltraAttributes',
                      alert: { title: 'Probe', body: 'Probe' },
                      'stale-date': now + 600,
                  }
                : event === 'end'
                  ? {
                        timestamp: now,
                        event: 'end',
                        // No content-state and no dismissal-date: the minimum
                        // Apple accepts. If THIS is rejected, the problem is the
                        // event itself or the token, not anything we add to it.
                    }
                  : {
                        timestamp: now,
                        event: 'update',
                        'content-state': { uiJsonData: 'G0sFAIC' },
                    };

        const payload = JSON.stringify({ aps });

        console.log(`  host           : ${HOST}`);
        console.log(`  topic          : ${topic}`);
        console.log(`  event          : ${event}`);
        console.log(`  token          : ${token.slice(0, 16)}… (${token.length} chars)`);
        console.log(`  expects        : ${event === 'start' ? 'push-to-start token (DeviceToken.liveActivityPushToStartToken)' : 'per-activity token (LiveActivity.activityPushToken)'}`);
        console.log(`  payload        : ${Buffer.byteLength(payload)} bytes`);
        console.log(`  aps keys       : ${Object.keys(aps).sort().join(', ')}`);

        const client = http2.connect(`https://${HOST}`);

        client.on('error', (err: any) =>
            console.log(`  session error  : ${err?.code ?? ''} ${err?.message ?? err}`));
        client.on('goaway', (code: number, lastStream: number, data?: Buffer) =>
            console.log(`  GOAWAY         : code=${code} lastStream=${lastStream} data=${data?.toString() ?? ''}`));

        const req = client.request({
            ':method': 'POST',
            ':path': `/3/device/${token}`,
            'apns-topic': topic,
            'apns-push-type': 'liveactivity',
            'apns-priority': '10',
            'apns-expiration': '0',
            authorization: `bearer ${jwt}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
        });

        let status = 0;
        let body = '';

        req.on('response', (headers) => {
            status = Number(headers[':status']);
            console.log(`\n  :status        : ${status}`);
            const id = headers['apns-id'];
            if (id) console.log(`  apns-id        : ${id}`);
        });
        req.on('data', (c) => { body += c; });

        req.on('end', () => {
            if (body) console.log(`  body           : ${body}`);
            console.log();

            if (status === 200) {
                console.log('  ✓ Apple ACCEPTED it. The connection and credentials are fine, so the\n' +
                            '    failure is inside node-apn or its payload — not the network.');
                console.log('    Check the card: if nothing appears, Voltra could not decode the\n' +
                            '    content-state, which is a layout problem rather than a push one.');
            } else {
                const reason = (() => { try { return JSON.parse(body).reason; } catch { return null; } })();
                console.log(`  ✗ Apple REJECTED it${reason ? `: ${reason}` : ''}`);
                const hints: Record<string, string> = {
                    BadDeviceToken: 'token is for the OTHER gateway — flip APNS_PRODUCTION, or the build signing does not match',
                    DeviceTokenNotForTopic: 'APNS_BUNDLE_ID does not match the app that issued this token',
                    TopicDisallowed: 'this key or App ID has no push capability for that topic',
                    InvalidProviderToken: 'the JWT was rejected — wrong kid/iss, or the key is not enabled for this app',
                    ExpiredProviderToken: 'JWT iat is too old or the clock is skewed',
                    BadPushType: 'apns-push-type: liveactivity is not accepted for this topic',
                    Unregistered: 'this token is dead — the app was removed or reinstalled',
                };
                if (reason && hints[reason]) console.log(`    → ${hints[reason]}`);
            }
            client.close();
            resolve();
        });

        req.on('error', (err: any) => {
            console.log(`\n  ✗ stream error : ${err?.code ?? ''} ${err?.message ?? err}`);
            console.log('    Same class of failure node-apn reported, reproduced without it —\n' +
                        '    so it is the connection, not the library.');
            client.close();
            resolve();
        });

        req.setTimeout(10000, () => {
            console.log('\n  ✗ stream timed out after 10s with no response from Apple.');
            req.close();
            client.close();
            resolve();
        });

        req.end(payload);
    });
}

// ─── Run ────────────────────────────────────────────────────────────────────

(async () => {
    if (!token || !['start', 'update', 'end'].includes(event)) {
        console.log('\n  usage: npx ts-node src/scripts/live-activity/02-probe.ts <token> [start|update|end]');
        console.log('\n    start   DeviceToken.liveActivityPushToStartToken');
        console.log('    update  LiveActivity.activityPushToken');
        console.log('    end     LiveActivity.activityPushToken\n');
        process.exit(1);
    }
    if (!/^[0-9a-fA-F]+$/.test(token)) {
        console.log(`\n  ✗ that token is not hex (${token.length} chars). APNs tokens are hex only.\n`);
        process.exit(1);
    }

    const h2ok = await checkTls();
    const jwt = buildJwt();

    if (!h2ok) {
        console.log('\n  Stopping: no HTTP/2 session to APNs, so stage 3 would only repeat it.\n');
        process.exit(1);
    }
    if (!jwt) {
        console.log('\n  Stopping: no usable provider JWT.\n');
        process.exit(1);
    }

    await sendStart(jwt);
    console.log();
})();