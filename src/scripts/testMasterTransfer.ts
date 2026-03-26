import sweepService from '../services/sweep.service'
import chainService from '../services/chain.service'
import prisma from '../config/prisma.config'

async function testMasterTransfer() {

    console.log('─────────────────────────────────────────')
    console.log('Testing transferFromMaster — BASE USDC')
    console.log('─────────────────────────────────────────')

    // ── 1. Find admin wallet to confirm it exists ─────────────────────────
    const currency = await prisma.currency.findFirst({
        where: {
            ISO:   'USDC',
            chain: 'BASE'
        }
    })

    if (!currency) {
        console.error('No BASE USDC currency found')
        process.exit(1)
    }

    console.log('Currency found:')
    console.log('  currencyId: ', currency.id)
    console.log('  ISO:        ', currency.ISO)
    console.log('  chain:      ', currency.chain)
    console.log('─────────────────────────────────────────')

    // ── 2. Transfer details ───────────────────────────────────────────────
    const toAddress = '0xb0a7a90ec013d3897a8a861bb499fad985936e81'  // user deposit address
    const amount    = '0.0004'   // 1 USDC
    const ISO       = 'ETH'
    const chain     = 'BASE'

    console.log('Transfer details:')
    console.log('  from:       master wallet')
    console.log('  to:         ', toAddress)
    console.log('  amount:     ', amount, ISO)
    console.log('  chain:      ', chain)
    console.log('─────────────────────────────────────────')

    // ── 3. Run the transfer ───────────────────────────────────────────────
    console.log('Running transferFromMaster...')

    try {
        const txId = await sweepService.transferFromMaster({
            chain,
            currencyId: currency.id,
            toAddress,
            amount,
            ISO
        })

        console.log('─────────────────────────────────────────')
        console.log('Transfer successful!')
        console.log('  txId:', txId)
        console.log('─────────────────────────────────────────')

    } catch (err) {
        console.error('─────────────────────────────────────────')
        console.error('Transfer failed:', err)
        console.error('─────────────────────────────────────────')
    } finally {
        await prisma.$disconnect()
    }
}

testMasterTransfer()