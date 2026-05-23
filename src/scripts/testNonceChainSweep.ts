import sweepService from '../services/sweep.service'
import { getChainConfigByCurrency } from '../config/blockchain.config'
import prisma from '../config/prisma.client'
import dotenv from 'dotenv'

dotenv.config()

async function testNonceChainSweep() {

    console.log('─────────────────────────────────────────')
    console.log('Testing nonceChainSweep — BASE USDC')
    console.log('─────────────────────────────────────────')

    // ── 1. Find a BASE USDC wallet to test with ──────────────────────────
    const wallet = await prisma.wallet.findUnique({
        where: { id: 'cmpb531q2000f0ds673zi33a0' },
        include: {
            currency: true,
            user:     true
        }
    })

    if (!wallet) {
        console.error('No BASE USDC wallet found — create one first')
        process.exit(1)
    }

    console.log('Wallet found:')
    console.log('  walletId:       ', wallet.id)
    console.log('  depositAddress: ', wallet.depositAddress)
    console.log('  derivationKey:  ', wallet.derivationKey)
    console.log('  userId:         ', wallet.userId)
    console.log('  currency:       ', wallet.currency?.ISO)
    console.log('  chain:          ', wallet.currency?.chain)
    console.log('─────────────────────────────────────────')

    // ── 2. Get chain config using new blockchain.config ───────────────────
    const chainConfig = getChainConfigByCurrency(
        wallet.currency?.chain!,   // 'BASE'
        wallet.currency?.ISO!      // 'USDC'
    )

    if (!chainConfig) {
        console.error('No chain config found for', wallet.currency?.chain, wallet.currency?.ISO)
        process.exit(1)
    }

    console.log('Chain config found:')
    console.log('  blockchain:     ', chainConfig.blockchain)
    console.log('  currency:       ', chainConfig.currency)
    console.log('  tokenMint:      ', chainConfig.tokenMint)
    console.log('  webhookChain:   ', chainConfig.webhookChain)
    console.log('  mnemonic set:   ', !!chainConfig.mnemonic)
    console.log('─────────────────────────────────────────')

    // ── 3. Run the sweep ──────────────────────────────────────────────────
    const testAmount = '16.5'

    console.log(`Running nonceChainSweep for ${testAmount} USDC on BASE...`)

    try {
        const txId = await sweepService.nonceChainSweep({
            chain:          wallet.currency?.chain!,  // 'BASE'
            ISO:            wallet.currency?.ISO!,    // 'USDC'
            currencyId:     wallet.currencyId!,
            chainConfig,
            depositAddress: wallet.depositAddress!,
            derivationKey:  wallet.derivationKey!,
            amount:         testAmount
        })

        console.log('─────────────────────────────────────────')
        console.log('Sweep successful!')
        console.log('  txId:', txId)
        console.log('─────────────────────────────────────────')

    } catch (err) {
        console.error('─────────────────────────────────────────')
        console.error('Sweep failed:', err)
        console.error('─────────────────────────────────────────')
    } finally {
        await prisma.$disconnect()
    }
}

testNonceChainSweep()