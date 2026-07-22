// scripts/manualCustodialSweep.ts
//
// Sends tokens directly FROM a wallet you control (using its own stored
// private key) to any destination — for the case where the "stuck" funds
// are sitting on your own admin/master wallet itself, not on a user's
// custodial deposit address. This is a plain signed transfer, not the
// custodial-contract sweep mechanism (that's for moving funds off
// addresses that don't hold their own gas — this wallet does).
//
// Uses the explicit-contract endpoint (/blockchain/token/transaction)
// rather than the per-chain ticker-alias endpoint (/polygon/transaction
// with currency: 'USDC_MATIC') — the ticker alias was confirmed to
// resolve to the wrong USDC contract on Polygon during testing (Polygon
// has two separate USDC contracts in circulation — native USDC and the
// older bridged USDC.e — and Tatum's ticker resolved to the one with a
// zero balance instead of the one actually holding the funds). Specifying
// contractAddress explicitly removes that ambiguity entirely.
//
// ⚠️  THIS MOVES REAL FUNDS. Dry run by default — add --confirm to execute.
//
// Usage:
//   npx ts-node --transpile-only -r dotenv/config scripts/manualCustodialSweep.ts \
//     --from=<wallet address holding the funds> \
//     --to=<destination address> \
//     --amount=8 \
//     --chain=POLYGON \
//     --currency=USDC
//
//     add --confirm to actually broadcast

import prisma from '../config/prisma.client';
import { tatumGet, tatumPost } from '../utils';
import { getChainConfigByCurrency } from '../config/blockchain.config';

function arg(name: string): string | undefined {
    const match = process.argv.find(a => a.startsWith(`--${name}=`));
    return match?.split('=')[1];
}
const CONFIRMED = process.argv.includes('--confirm');

const ENDPOINT_MAP: Record<string, string> = {
    ETHEREUM: 'ethereum', POLYGON: 'polygon', BSC: 'bsc',
    ARBITRUM: 'arb', OPTIMISM: 'optimism', BASE: 'base', TRON: 'tron',
};

function step(label: string) {
    console.log(`\n─── ${label} ${'─'.repeat(Math.max(0, 55 - label.length))}`);
}

async function main() {
    const fromAddress = arg('from');
    const toAddress   = arg('to');
    const amount      = arg('amount');
    const chain       = (arg('chain') ?? 'POLYGON').toUpperCase();
    const currencyISO = (arg('currency') ?? 'USDC').toUpperCase();

    if (!fromAddress || !toAddress || !amount) {
        console.error('Usage: --from=<address> --to=<destination> --amount=<amount> [--chain=POLYGON] [--currency=USDC] [--confirm]');
        process.exit(1);
    }

    step('0. Parameters');
    console.log({ fromAddress, toAddress, amount, chain, currencyISO, mode: CONFIRMED ? 'LIVE — will broadcast' : 'DRY RUN' });

    step('1. Resolve chain config');
    const chainConfig = getChainConfigByCurrency(chain, currencyISO);
    if (!chainConfig) {
        console.error(`❌ No CHAIN_CONFIG entry for ${chain}/${currencyISO}`);
        process.exit(1);
    }
    if (!chainConfig.isToken || !chainConfig.tokenMint) {
        console.error(`❌ ${chain}/${currencyISO} is not configured as a token with a tokenMint — this script's transfer path requires an explicit contract address.`);
        process.exit(1);
    }
    console.log('Resolved config:', {
        tokenSymbol: chainConfig.tokenSymbol,
        tokenMint: chainConfig.tokenMint,
        tatumChainParam: chainConfig.tatumChainParam,
        decimals: chainConfig.decimals,
    });

    const endpoint = ENDPOINT_MAP[chainConfig.blockchain];
    if (!endpoint) {
        console.error(`❌ No endpoint mapping for blockchain ${chainConfig.blockchain}`);
        process.exit(1);
    }

    step('2. Find the private key for this address');
    const addressRecord = await prisma.virtualAccountAddress.findFirst({
        where: { address: fromAddress, blockchain: chainConfig.blockchain, isActive: true },
        select: { index: true, xpub: true, virtualAccountId: true },
    });
    if (!addressRecord) {
        console.error(`❌ No VirtualAccountAddress record found for ${fromAddress} on ${chainConfig.blockchain} — can't derive its key without this.`);
        process.exit(1);
    }
    if (addressRecord.index === null || addressRecord.index === undefined) {
        console.error(`❌ No derivation index stored for ${fromAddress} — this address may not be HD-derived, or the record is incomplete.`);
        process.exit(1);
    }
    console.log('Found address record — index:', addressRecord.index);

    step('3. Check this address holds enough native gas token to pay its own fee');
    try {
        const balanceData = await tatumGet(`/${endpoint}/account/balance/${fromAddress}`);
        const nativeBalance = parseFloat(balanceData?.balance ?? balanceData?.[chainConfig.blockchain.toLowerCase()]?.balance ?? '0');
        console.log(`Native gas token balance on ${fromAddress}:`, nativeBalance);
        if (nativeBalance <= 0) {
            console.warn(`⚠️  This address appears to hold NO native gas balance. The transfer will likely fail to broadcast.`);
            console.warn(`   If this is unexpectedly zero for what you believed was your treasury/gas-paying wallet, stop and investigate before proceeding.`);
        }
    } catch (e: any) {
        console.warn('⚠️  Could not check native balance (non-fatal, proceeding):', e.message);
    }

    step('4. Get current nonce');
    const nonceRaw = await tatumGet(`/${endpoint}/transaction/count/${fromAddress}`);
    const nonce = typeof nonceRaw === 'number' ? nonceRaw : nonceRaw?.nonce ?? 0;
    console.log('Current nonce:', nonce);

    step('5. What will happen if this proceeds');
    console.log(`- Derive private key at index ${addressRecord.index} on ${chainConfig.blockchain}`);
    console.log(`- Broadcast via /blockchain/token/transaction: send ${amount} ${currencyISO}`);
    console.log(`  on contract ${chainConfig.tokenMint} from ${fromAddress} to ${toAddress}`);
    console.log(`- ${fromAddress} pays its own gas fee (nonce ${nonce})`);

    if (!CONFIRMED) {
        console.log('\n🛑 Dry run only — nothing broadcast. Re-run with --confirm to execute.');
        await prisma.$disconnect();
        return;
    }

    step('6. Deriving private key');
    const privRes = await tatumPost(`/${endpoint}/wallet/priv`, {
        mnemonic: chainConfig.mnemonic,
        index: addressRecord.index,
    });
    const privateKey = privRes.key;
    if (!privateKey) {
        console.error('❌ Failed to derive private key');
        process.exit(1);
    }
    console.log('✅ Private key derived');

    step('7. Broadcasting transfer');
    try {
        // Explicit-contract endpoint — bypasses Tatum's per-chain ticker
        // alias resolution (e.g. 'USDC_MATIC') entirely, which was
        // confirmed to point at the wrong contract's balance during
        // testing. contractAddress here is the exact address confirmed
        // on Polygonscan against the actual funds.
        const res = await tatumPost('/blockchain/token/transaction', {
            chain: chainConfig.tatumChainParam ?? 'MATIC',
            to: toAddress,
            contractAddress: chainConfig.tokenMint,
            amount,
            digits: chainConfig.decimals ?? 6,
            fromPrivateKey: privateKey,
            nonce,
        });
        console.log('\n✅ Broadcast successful!');
        console.log('txId:', res.txId);
        console.log(`\nTrack it: https://polygonscan.com/tx/${res.txId}`);
    } catch (error: any) {
        console.error('\n❌ Broadcast failed');
        console.error('Status:', error?.response?.status);
        console.error('Data:', error?.response?.data);
        console.error('Message:', error.message);
    }

    await prisma.$disconnect();
}

main().catch((e) => {
    console.error('Script crashed:', e);
    process.exit(1);
});