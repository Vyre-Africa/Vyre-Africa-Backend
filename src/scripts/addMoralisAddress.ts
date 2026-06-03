// src/scripts/addMoralisAddress.ts
import dotenv from 'dotenv';
dotenv.config();

import Moralis from 'moralis';

// ── Config ────────────────────────────────────────────────────
const STREAM_MAP: Record<string, string | undefined> = {
    ETH:      process.env.MORALIS_STREAM_ETH,
    BASE:     process.env.MORALIS_STREAM_BASE,
    POLYGON:  process.env.MORALIS_STREAM_POLYGON,
    BSC:      process.env.MORALIS_STREAM_BSC,
    ARBITRUM: process.env.MORALIS_STREAM_ARBITRUM,
    OPTIMISM: process.env.MORALIS_STREAM_OPTIMISM,
};

async function addAddress() {
    const args      = process.argv.slice(2);
    const chain     = args[0]?.toUpperCase();
    const address   = args[1]?.toLowerCase();

    // ── Validate args ─────────────────────────────────────────
    if (!chain || !address) {
        console.log('─────────────────────────────────────────');
        console.log('Usage: npm run moralis:add-address <chain> <address>');
        console.log('─────────────────────────────────────────');
        console.log('Examples:');
        console.log('  npm run moralis:add-address BASE 0xdc45ba3fd2ba10f01c4618c7a948eab0d98d5dc9');
        console.log('  npm run moralis:add-address ETH  0xdc45ba3fd2ba10f01c4618c7a948eab0d98d5dc9');
        console.log('─────────────────────────────────────────');
        console.log('Supported chains:', Object.keys(STREAM_MAP).join(', '));
        console.log('─────────────────────────────────────────');
        process.exit(1);
    }

    const streamId = STREAM_MAP[chain];

    if (!streamId) {
        console.error(`❌ No stream ID found for chain: ${chain}`);
        console.error(`   Make sure MORALIS_STREAM_${chain} is set in your .env`);
        process.exit(1);
    }

    if (!/^0x[0-9a-f]{40}$/.test(address)) {
        console.error(`❌ Invalid address: ${address}`);
        process.exit(1);
    }

    console.log('─────────────────────────────────────────');
    console.log(`Adding address to Moralis stream`);
    console.log('─────────────────────────────────────────');
    console.log(`  Chain:    ${chain}`);
    console.log(`  Address:  ${address}`);
    console.log(`  StreamId: ${streamId}`);
    console.log('─────────────────────────────────────────');

    try {
        await Moralis.start({ apiKey: process.env.MORALIS_API_KEY! });

        const result = await Moralis.Streams.addAddress({
            id:      streamId,
            address: address
        });

        console.log('✅ Address added successfully');
        console.log(result.toJSON());
        console.log('─────────────────────────────────────────');

    } catch (error: any) {
        console.error('❌ Failed to add address:', error.message);
        process.exit(1);
    } finally {
        process.exit(0);
    }
}

addAddress();