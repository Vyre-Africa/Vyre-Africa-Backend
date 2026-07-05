// src/scripts/debug-rate.ts
// ts-node --transpile-only -r dotenv/config src/scripts/debug-rate.ts

import axios from 'axios'

const rampApi = axios.create({
    baseURL: process.env.LIQUIDITY_RAMP_BASE_URL || 'https://ramp-be.quidax.io/api/v1/merchants/',
    headers: {
        'x-private-key': process.env.LIQUIDITY_RAMP_SECRET_KEY,
        'Content-Type':  'application/json'
    }
})

async function run() {
    try {
        // Test 1 — SELL quote (user sells crypto, gets fiat)
        console.log('Testing /purchase_quotes/sell ...')
        const sell = await rampApi.get('/purchase_quotes/sell', {
            params: {
                token:         'usdc',
                currency:      'ngn',
                token_amount:  '1',
                token_network: 'base'
            }
        })
        console.log('SELL response:', JSON.stringify(sell.data, null, 2))

    } catch (err: any) {
        console.error('SELL failed:', err.response?.status, JSON.stringify(err.response?.data, null, 2))
    }

    try {
        // Test 2 — BUY quote (user buys crypto, pays fiat)
        console.log('\nTesting /purchase_quotes/buy ...')
        const buy = await rampApi.get('/purchase_quotes/buy', {
            params: {
                currency:      'ngn',
                token:         'usdc',
                fiat_amount:   '5000',
                token_network: 'base'
            }
        })
        console.log('BUY response:', JSON.stringify(buy.data, null, 2))

    } catch (err: any) {
        console.error('BUY failed:', err.response?.status, JSON.stringify(err.response?.data, null, 2))
    }
}

run()