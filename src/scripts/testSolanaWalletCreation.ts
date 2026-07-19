// scripts/testSolanaWalletCreation.ts
//
// Standalone, step-by-step trace of USDC-on-Solana wallet creation,
// bypassing the queue/HTTP layer so failures surface immediately with a
// full stack trace instead of getting swallowed by a worker retry.
//
// Usage:
//   npx ts-node scripts/testSolanaWalletCreation.ts --userId=<id> [--cleanup]
//
// --cleanup wipes any existing USDC/SOLANA wallet+account+address for that
// user BEFORE running, so the script is safely re-runnable. Without it,
// a second run against a user who already has the wallet will hit a
// unique-constraint error on `prisma.wallet.create` — that's expected,
// not a new bug, so don't confuse it with the real failure.

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../config/prisma.client';
import stableCoinService from '../services/stablecoin.service';
import { getChainConfigByCurrency, getChainKey, CHAIN_CONFIG } from '../config/blockchain.config';

function arg(name: string): string | undefined {
    const match = process.argv.find(a => a.startsWith(`--${name}=`));
    return match?.split('=')[1];
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

function step(label: string) {
    console.log(`\n─── ${label} ${'─'.repeat(Math.max(0, 50 - label.length))}`);
}

async function main() {
    const userId = arg('userId');
    const cleanup = hasFlag('cleanup');

    if (!userId) {
        console.error('Usage: --userId=<id> [--cleanup]');
        process.exit(1);
    }

    step('0. Env sanity check');
    console.log('TATUM_LIVE_KEY present:', !!process.env.TATUM_LIVE_KEY);
    console.log('DATABASE_URL present:  ', !!process.env.DATABASE_URL);

    step('1. Resolve the USDC currency row for chain=SOLANA');
    const currency = await prisma.currency.findFirst({
        where: { ISO: 'USDC', chain: 'SOLANA' },
        select: { id: true, ISO: true, chain: true, isStablecoin: true, type: true },
    });
    if (!currency) {
        console.error('❌ No Currency row found with ISO=USDC, chain=SOLANA.');
        console.error('   Check the actual value stored in your Currency table —');
        console.error('   if it\'s not exactly "SOLANA", getChainConfigByCurrency() below will never match.');
        process.exit(1);
    }
    console.log('Found currency:', currency);

    step('2. Verify user exists');
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
    if (!user) {
        console.error(`❌ No user found with id ${userId}`);
        process.exit(1);
    }
    console.log('Found user:', user);

    step('3. Pre-flight: resolve chain config directly (isolates config bugs from runtime bugs)');
    const chainConfig = getChainConfigByCurrency('SOLANA', 'USDC');
    console.log('getChainConfigByCurrency("SOLANA", "USDC") →', chainConfig);
    if (!chainConfig) {
        console.error('❌ No matching entry in CHAIN_CONFIG for blockchain=SOLANA, currency=USDC.');
        process.exit(1);
    }

    const chainKey = getChainKey(chainConfig.blockchain, chainConfig.currency);
    console.log(`getChainKey("${chainConfig.blockchain}", "${chainConfig.currency}") →`, chainKey);
    if (!chainKey) {
        console.error('❌ getChainKey returned undefined — this alone would abort createWallet().');
        process.exit(1);
    }

    console.log(`\nchainConfig.blockchain = "${chainConfig.blockchain}"`);
    console.log(`CHAIN_CONFIG["${chainConfig.blockchain}"] exists?`, !!CHAIN_CONFIG[chainConfig.blockchain.toUpperCase()]);
    console.log(`CHAIN_CONFIG["SOL"] exists?`, !!CHAIN_CONFIG['SOL']);
    if (!CHAIN_CONFIG[chainConfig.blockchain.toUpperCase()]) {
        console.warn('⚠️  This is the suspected bug: generateKeypairWallet() will look up');
        console.warn(`    CHAIN_CONFIG["${chainConfig.blockchain}"], which does not exist —`);
        console.warn('    only CHAIN_CONFIG["SOL"] does. Expect step 5 below to fail with');
        console.warn(`    "Unsupported blockchain: ${chainConfig.blockchain}" UNLESS Solana is`);
        console.warn('    configured as a gas-pump chain (which bypasses this code path).');
    }

    step('4. Cleanup (if requested) — remove any prior test wallet for this user/currency');
    if (cleanup) {
        const existingWallet = await prisma.wallet.findFirst({
            where: { userId, currencyId: currency.id },
        });
        if (existingWallet) {
            await prisma.virtualAccountAddress.deleteMany({ where: { virtualAccountId: existingWallet.id } });
            await prisma.wallet.delete({ where: { id: existingWallet.id } }).catch(() => {});
            await prisma.virtualAccount.delete({ where: { id: existingWallet.id } }).catch(() => {});
            console.log('Removed existing wallet/account/addresses for a clean run.');
        } else {
            console.log('Nothing to clean up.');
        }
    } else {
        console.log('Skipped (pass --cleanup to enable). If this user already has a USDC/SOLANA wallet, step 5 will fail on a duplicate id, not the real bug.');
    }

    step('5. Full createWallet() call — this is where the actual bug (if present) throws');
    const start = Date.now();
    try {
        const wallet = await stableCoinService.createUSDCWallet('SOLANA', userId, currency.id);
        console.log(`\n✅ SUCCESS in ${Date.now() - start}ms`);
        console.log('Wallet:', wallet);
    } catch (error: any) {
        console.log(`\n❌ FAILED after ${Date.now() - start}ms`);
        console.error('Message:', error.message);
        console.error('Stack:', error.stack);

        if (error.message?.includes('Unsupported blockchain: SOLANA')) {
            console.error('\n👉 This confirms the CHAIN_CONFIG key mismatch described above.');
            console.error('   Fix: in generateKeypairWallet() (and generateHDAddress()/derivePrivateKey()');
            console.error('   if this pattern repeats there), look up CHAIN_CONFIG by the chain KEY');
            console.error('   (e.g. "SOL") rather than by config.blockchain\'s value ("SOLANA").');
        }
    }

    await prisma.$disconnect();
}

main().catch((e) => {
    console.error('Script crashed:', e);
    process.exit(1);
});