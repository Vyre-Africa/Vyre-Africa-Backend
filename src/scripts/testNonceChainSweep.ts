import sweepService from '../services/sweep.service'
import chainService from '../services/chain.service'
import prisma from '../config/prisma.config'

async function testNonceChainSweep() {

    console.log('─────────────────────────────────────────')
    console.log('Testing nonceChainSweep — BASE USDC')
    console.log('─────────────────────────────────────────')

    // ── 1. Find a BASE USDC wallet to test with ──────────────────────────
    const wallet = await prisma.wallet.findUnique({
        where: {
            id: '69b42190abe7a4e76c81096d'
        },
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
    console.log('─────────────────────────────────────────')

    // ── 2. Get chain config ───────────────────────────────────────────────
    const chainConfig = chainService.getChainConfig('USDC', 'BASE')

    console.log('Chain config found:')
    console.log('  tatumCurrency:  ', chainConfig.tatumCurrency)
    console.log('  webhookChain:   ', chainConfig.webhookChain)
    console.log('  mnemonic set:   ', !!chainConfig.mnemonic)
    console.log('─────────────────────────────────────────')

    // ── 3. Run the sweep ──────────────────────────────────────────────────
    // Use a small test amount — adjust as needed
    const testAmount = '7.4'  // 0.01 USDC

    console.log(`Running nonceChainSweep for ${testAmount} USDC on BASE...`)

    try {
        const txId = await sweepService.nonceChainSweep({
            chain:          'BASE',
            ISO:            'USDC',
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