// scripts/test-internal-offramp.ts
//
// Standalone test for the internal offramp flow, bypassing the
// controller and auth middleware entirely. Calls liquidityRampService
// directly so we see Quidax's REAL response body at each step, not
// just the generic "Request failed with status code 400" that's
// currently all the logs show.
//
// Run with: npx ts-node scripts/test-internal-offramp.ts
// (or node -r ts-node/register, matching however the existing test
// scripts in this codebase are run)
//
// ⚠️ This talks to whatever Quidax environment your config actually
// points at. Confirm you're hitting sandbox/test credentials before
// running, the same caution as the existing ACH/SEPA test scripts.

import config from '../config/env.config';
import liquidityRampService from '../services/liquidityRamp.service';
import { ulid } from 'ulid';

// ── Full error dump helper ──────────────────────────────────────────
// The bug we're chasing: the real code only logs error.message, which
// for an Axios error is just the HTTP status text. error.response.data
// is where Quidax actually explains WHY it rejected something, and
// that's been getting thrown away. This prints everything.
function dumpError(label: string, error: any) {
    console.log(`\n❌ ${label} FAILED`);
    console.log('  status:', error?.response?.status);
    console.log('  statusText:', error?.response?.statusText);
    console.log('  data:', JSON.stringify(error?.response?.data, null, 2));
    console.log('  message:', error?.message);
    console.log('  request URL:', error?.config?.url);
    console.log('  request method:', error?.config?.method);
    // The actual body WE sent — compare this against what Quidax's
    // docs say is expected, field by field.
    console.log('  request body sent:', error?.config?.data);
}

async function main() {
    // ── Config sanity check FIRST ─────────────────────────────────
    // If the settlement account env vars are unset, addOfframpPayoutAccount
    // would be sending undefined values, which is a strong candidate
    // for exactly this 400. Confirm before anything else runs.
    console.log('── Config check ──────────────────────────────────');
    console.log('OFFRAMP_SETTLEMENT_BANK_CODE:', config.OFFRAMP_SETTLEMENT_BANK_CODE ?? '⚠️  UNSET');
    console.log('OFFRAMP_SETTLEMENT_ACCOUNT_NUMBER:', config.OFFRAMP_SETTLEMENT_ACCOUNT_NUMBER ?? '⚠️  UNSET');
    console.log('OFFRAMP_MIN_USD:', config.OFFRAMP_MIN_USD ?? '(using default)');

    if (!config.OFFRAMP_SETTLEMENT_BANK_CODE || !config.OFFRAMP_SETTLEMENT_ACCOUNT_NUMBER) {
        console.log('\n🛑 Settlement account is not configured. This alone would explain');
        console.log('   a 400 on addOfframpPayoutAccount — it would be sending undefined');
        console.log('   bank_code / account_number to Quidax. Fix this before continuing.\n');
        return;
    }

    const merchantReference = `WALLETOFFRAMP_TEST_${ulid()}`;

    // Deliberately matching the REAL failing request's parameters as
    // closely as possible — same amount (5), same currency, same
    // chain — so whatever's wrong reproduces here too.
    const testAmount = '5';
    const cryptoCurrency = 'usdc';
    const fiatCurrency = 'ngn';
    const network = 'base'; // from CHAIN_TO_QUIDAX_NETWORK['BASE']

    console.log('\n── Step 1: initiateOfframp ───────────────────────');
    console.log({ merchantReference, testAmount, cryptoCurrency, fiatCurrency, network });

    let offrampInit: any;
    try {
        offrampInit = await liquidityRampService.initiateOfframp({
            merchantReference,
            fromCurrency: cryptoCurrency,
            toCurrency: fiatCurrency,
            fromAmount: testAmount,
            network,
            customerEmail: 'team@vyre.africa',
            // CHANGED AGAIN — this settlement account is a Qorepay
            // virtual account, and the account is registered as
            // "ANAFUWE HARVEY" (surname first), not "Harvey Anafuwe".
            // This is a DIFFERENT hypothesis than the earlier
            // middle-name test: virtual accounts issued through a BaaS
            // provider commonly display in SURNAME GIVENNAME order on
            // the bank's side, independent of whether a middle name is
            // involved at all.
            //
            // Testing order specifically here — if THIS passes where
            // "Harvey" / "Anafuwe" would have failed, the real fix is
            // about name ORDER for virtual accounts, not about
            // stripping middle names.
            customerFirstName: 'QOREPAY/ANAFUWE',
            customerLastName: 'HARVEY',
        });
        console.log('✅ initiateOfframp succeeded');
        console.log(JSON.stringify(offrampInit, null, 2));
    } catch (error: any) {
        dumpError('initiateOfframp', error);
        return; // can't continue without this succeeding
    }

    console.log('\n── Step 2: addOfframpPayoutAccount ───────────────');
    console.log({
        merchantReference,
        bankCode: config.OFFRAMP_SETTLEMENT_BANK_CODE,
        accountNumber: config.OFFRAMP_SETTLEMENT_ACCOUNT_NUMBER,
    });

    try {
        const bankAccount = await liquidityRampService.addOfframpPayoutAccount({
            merchantReference,
            bankCode: config.OFFRAMP_SETTLEMENT_BANK_CODE,
            accountNumber: config.OFFRAMP_SETTLEMENT_ACCOUNT_NUMBER,
        });
        console.log('✅ addOfframpPayoutAccount succeeded');
        console.log(JSON.stringify(bankAccount, null, 2));
    } catch (error: any) {
        // ⚠️ THIS is the error we actually need to see. Everything
        // above this point was working in the real failing run too —
        // this block's output is the whole point of running the script.
        dumpError('addOfframpPayoutAccount', error);
        console.log('\n── What to check next ─────────────────────────');
        console.log('1. Does error.response.data name a specific invalid field?');
        console.log('2. Does Quidax expect a DIFFERENT bank_code format for NGN');
        console.log('   than what\'s being sent (e.g. 3-digit CBN code vs a');
        console.log('   Quidax-specific bank identifier)?');
        console.log('3. Does this merchantReference / account need to be an');
        console.log('   account Quidax can actually verify exists (i.e. is this');
        console.log('   hitting a real bank-account-resolution check that fails');
        console.log('   in sandbox for this specific account number)?');
        return;
    }

    console.log('\n── Step 3: confirmOfframp ────────────────────────');
    console.log('⚠️  This step returns a real deposit address. Stopping here');
    console.log('    deliberately — uncomment below only once steps 1-2 are');
    console.log('    confirmed working, since confirming creates a live');
    console.log('    Quidax transaction expecting real crypto.');

    /*
    try {
        const offrampConfirm = await liquidityRampService.confirmOfframp(merchantReference);
        console.log('✅ confirmOfframp succeeded');
        console.log(JSON.stringify(offrampConfirm, null, 2));
    } catch (error: any) {
        dumpError('confirmOfframp', error);
    }
    */

    console.log('\n✅ Test complete.');
    console.log('\nIf step 2 passed with "Anafuwe" / "Harvey" (surname-first order),');
    console.log('that confirms this is a VIRTUAL ACCOUNT NAME ORDER issue, separate');
    console.log('from the middle-name question. Qorepay virtual accounts appear to');
    console.log('register as SURNAME GIVENNAME, not GIVENNAME SURNAME.');
    console.log('\nThis matters for production: if Vyre\'s own settlement account is');
    console.log('a Qorepay virtual account with this naming convention, any OTHER');
    console.log('Qorepay-issued virtual accounts used as user payout destinations');
    console.log('may need the SAME order handling, not just this one settlement');
    console.log('account. Worth checking whether this is a Qorepay-wide convention');
    console.log('or specific to how this one account happened to be provisioned.');
}

main().catch((err) => {
    console.error('Unexpected script error:', err);
    process.exit(1);
});