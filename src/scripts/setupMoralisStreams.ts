import dotenv from 'dotenv';
dotenv.config();

import Moralis from 'moralis';
import moralisService from '../services/moralis.service';

async function setupStreams() {
    console.log('─────────────────────────────────────────');
    console.log('Setting up Moralis Streams');
    console.log('─────────────────────────────────────────');

    await Moralis.start({ apiKey: process.env.MORALIS_API_KEY! });

    const CHAIN_CONFIGS = moralisService.getChainConfigs();
    const ERC20_ABI     = moralisService.getERC20Abi();

    const streamIds: Record<string, string> = {};

    for (const [name, config] of Object.entries(CHAIN_CONFIGS)) {
        try {
            console.log(`\nCreating stream for ${name}...`);

            const stream = await Moralis.Streams.add({
                chains:                      [config.chainId],
                description:                 `Vyre Africa — incoming stablecoin deposits on ${name}`,
                tag:                         `vyre-${name.toLowerCase()}-deposits`,
                webhookUrl:                  process.env.MORALIS_WEBHOOK_URL!,
                abi:                         ERC20_ABI,
                includeContractLogs:         true,
                // filterPossibleSpamAddresses: true,
                topic0:                      ['Transfer(address,address,uint256)'],
                advancedOptions: [
                    {
                        topic0: 'Transfer(address,address,uint256)',
                        filter: moralisService.buildFilterForChain(name)
                    }
                ]
            } as any);

            const { id } = stream.toJSON();
            streamIds[name] = id;

            console.log(`✅ ${name} stream created`);
            console.log(`   ID:         ${id}`);
            console.log(`   Chain ID:   ${config.chainId}`);
            console.log(`   Contracts:  ${config.contracts.join(', ')}`);
            console.log(`   Min amount: 1 USDC/USDT`);
            console.log(`   Spam filter: enabled`);

        } catch (error: any) {
            console.error(`❌ Failed to create ${name} stream:`, error.message);
        }
    }

    // ── Print env vars to add to .env ─────────────────────────
    console.log('\n─────────────────────────────────────────');
    console.log('Add these to your .env:');
    console.log('─────────────────────────────────────────');
    console.log(`MORALIS_API_KEY=${process.env.MORALIS_API_KEY}`);
    console.log(`MORALIS_WEBHOOK_URL=${process.env.MORALIS_WEBHOOK_URL}`);
    for (const [chain, id] of Object.entries(streamIds)) {
        console.log(`MORALIS_STREAM_${chain}=${id}`);
    }
    console.log('─────────────────────────────────────────');

    process.exit(0);
}

setupStreams().catch(console.error);