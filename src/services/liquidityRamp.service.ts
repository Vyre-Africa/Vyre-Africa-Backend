import axios, { AxiosInstance } from 'axios'
import logger from '../config/logger'

const rampApi: AxiosInstance = axios.create({
    baseURL: process.env.LIQUIDITY_RAMP_BASE_URL || 'https://ramp-be.quidax.io/api/v1/merchants/',
    headers: {
        'x-private-key': process.env.LIQUIDITY_RAMP_SECRET_KEY,
        'Content-Type':  'application/json'
    }
})

class LiquidityRampService {

    // ── Get live rate ─────────────────────────────────────────────────────────
    async getRate(toCurrency: string, fromFiat: string, chain: string): Promise<number> {
        const network    = this.getNetwork(chain)   // now correctly passes a CHAIN
        const fiatAmount = '5000'
    
        const { data } = await rampApi.get('/purchase_quotes/buy', {
            params: {
                currency:      fromFiat.toLowerCase(),
                token:         toCurrency.toLowerCase(),
                fiat_amount:   fiatAmount,
                token_network: network
            }
        })
    
        const cryptoAmount = parseFloat(data.data.to_amount)
    
        if (!cryptoAmount || isNaN(cryptoAmount) || cryptoAmount <= 0) {
            throw new Error(`Invalid rate response for ${toCurrency}/${fromFiat}: ${JSON.stringify(data.data)}`)
        }
    
        const rate = parseFloat(fiatAmount) / cryptoAmount
        logger.info('Rate fetched', { toCurrency, fromFiat, chain, fiatAmount, cryptoAmount, rate })
        return rate
    }

    // ── Initiate onramp — bank transfer ───────────────────────────────────────
    async initiateRampBankTransfer(payload: {
        merchantReference: string
        fromCurrency:      string   // fiat, e.g. 'ngn'
        toCurrency:        string   // crypto, e.g. 'usdt'
        fromAmount:        string   // fiat amount
        walletAddress:     string   // Vyre admin wallet — Quidax sends crypto here
        walletNetwork:     string   // e.g. 'bep20', 'base'
        customerEmail:     string
        customerFirstName: string
        customerLastName:  string
    }) {
        const { data } = await rampApi.post('/custodial/on_ramp_transactions/initiate', {
            from_currency:      payload.fromCurrency,
            to_currency:        payload.toCurrency,
            from_amount:        String(payload.fromAmount),
            merchant_reference: payload.merchantReference,
            customer: {
                email:      payload.customerEmail,
                first_name: payload.customerFirstName,
                last_name:  payload.customerLastName,
            },
            wallet_address: {
                address: payload.walletAddress,
                network: payload.walletNetwork,
            }
        })
    
        logger.info('Onramp initiated (bank)', {
            merchantReference: payload.merchantReference,
            data:              data.data
        })
        return data.data
    }

    // ── Confirm onramp ────────────────────────────────────────────────────────
    async confirmRamp(merchantReference: string) {
        const { data } = await rampApi.post(
            `/custodial/on_ramp_transactions/${merchantReference}/confirm`
        )

        logger.info('Onramp confirmed', { merchantReference, data: data.data })
        return data.data
    }

    // ── Initiate onramp — mobile money ────────────────────────────────────────
    async initiateRampMobileMoney(payload: {
        merchantReference:   string
        fromCurrency:        string   // fiat, e.g. 'ghs'
        toCurrency:          string   // crypto, e.g. 'usdt'
        fromAmount:          string   // fiat amount
        walletAddress:       string   // Vyre admin wallet — Quidax sends crypto here
        walletNetwork:       string   // e.g. 'bep20', 'base'
        customerEmail:       string
        customerFirstName:   string
        customerLastName:    string
        phoneNumber:         string
        networkProvider:     string   // MTN, AIRTEL, VODAFONE
    }) {
        // Step A — initiate (same base endpoint as bank transfer)
        const { data: initData } = await rampApi.post('/custodial/on_ramp_transactions/initiate', {
            from_currency:      payload.fromCurrency,
            to_currency:        payload.toCurrency,
            from_amount:        String(payload.fromAmount),
            merchant_reference: payload.merchantReference,
            customer: {
                email:      payload.customerEmail,
                first_name: payload.customerFirstName,
                last_name:  payload.customerLastName,
            },
            wallet_address: {
                address: payload.walletAddress,
                network: payload.walletNetwork,
            }
    })
 
    // Step B — attach mobile money details
    const { data: momoData } = await rampApi.post('/custodial/on_ramp_transactions/initiate_mobile_money', {
        merchant_reference: payload.merchantReference,
        phone_number:       payload.phoneNumber,
        network_provider:   payload.networkProvider,
    })
 
    logger.info('Onramp initiated (mobile money)', {
        merchantReference: payload.merchantReference,
        initData:          initData.data,
        momoData:          momoData.data
    })
 
    return { initData: initData.data, momoData: momoData.data }
}

    // ── Verify mobile money OTP ───────────────────────────────────────────────
    async verifyMobileMoneyOtp(payload: {
        merchantReference: string
        otp:               string
    }) {
        const { data } = await rampApi.post('/custodial/on_ramp_transactions/verify_mobile_money_otp/', {
            merchant_reference: payload.merchantReference,
            otp:                payload.otp,
        })

        logger.info('Mobile money OTP verified', { merchantReference: payload.merchantReference })
        return data.data
    }

    // ── Initiate offramp ──────────────────────────────────────────────────────
    async initiateOfframp(payload: {
        merchantReference: string
        fromCurrency:      string   // crypto, e.g. 'usdt'
        toCurrency:        string   // fiat, e.g. 'ngn'
        fromAmount:        string   // crypto amount user sends
        network:           string   // e.g. 'bep20'
        customerEmail:     string
        customerFirstName: string
        customerLastName:  string
    }) {
        const { data } = await rampApi.post('/custodial/off_ramp_transactions/initiate', {
            from_currency:      payload.fromCurrency,
            to_currency:        payload.toCurrency,
            from_amount:        payload.fromAmount,
            network:            payload.network,
            merchant_reference: payload.merchantReference,
            customer: {
                email:      payload.customerEmail,
                first_name: payload.customerFirstName,
                last_name:  payload.customerLastName,
            }
        })
    
        logger.info('Offramp initiated', { merchantReference: payload.merchantReference, data: data.data })
        return data.data
    }

    // ── Add payout bank account ───────────────────────────────────────────────
    async addOfframpPayoutAccount(payload: {
        merchantReference: string
        bankCode:          string
        accountNumber:     string
    }) {
        const { data } = await rampApi.post(
            `/custodial/off_ramp_transactions/${payload.merchantReference}/bank_account`,
            {
                bank_code:      payload.bankCode,
                account_number: payload.accountNumber,
            }
        )

        logger.info('Offramp payout account added', { merchantReference: payload.merchantReference })
        return data.data
    }

    // ── Confirm offramp ───────────────────────────────────────────────────────
    async confirmOfframp(merchantReference: string) {
        const { data } = await rampApi.post(
            `/custodial/off_ramp_transactions/${merchantReference}/confirm`
        )

        logger.info('Offramp confirmed', { merchantReference, data: data.data })
        return data.data
    }

    // ── Verify webhook signature ──────────────────────────────────────────────
    verifyWebhookSignature(body: string, signature: string): boolean {
        try {
            if (!signature) {
                logger.warn('Ramp webhook — missing x-ramp-signature header')
                return false
            }

            const secret = process.env.LIQUIDITY_RAMP_SECRET_KEY
            if (!secret) {
                logger.error('LIQUIDITY_RAMP_SECRET_KEY not set — cannot verify webhook')
                return false
            }

            const crypto   = require('crypto')
            const expected = crypto
                .createHmac('sha256', secret)
                .update(body)
                .digest('hex')

            return expected === signature

        } catch (err: any) {
            logger.error('Webhook signature verification failed', { error: err.message })
            return false
        }
    }

    private readonly CHAIN_TO_QUIDAX_NETWORK: Record<string, string> = {
        ETHEREUM: 'erc20',
        BASE:     'base',
        BSC:      'bep20',
        POLYGON:  'polygon',
        ARBITRUM: 'arbitrum',
        OPTIMISM: 'optimism',
        TRON:     'trc20',
    }
    
    // REPLACE the existing getNetwork method with this
    
    getNetwork(chain: string): string {
        const key     = chain?.toUpperCase()
        const network = this.CHAIN_TO_QUIDAX_NETWORK[key]
    
        if (!network) {
            logger.warn(`No Quidax network mapping found for chain: ${chain}`)
            throw new Error(`Unsupported chain for Quidax ramp: ${chain}`)
        }
    
        return network
    }

    // // ── Helper: token network ─────────────────────────────────────────────────
    // getNetwork(token: string): string {
    //     const networks: Record<string, string> = {
    //         USDC: 'base',
    //         USDT: 'tron',
    //     }
    //     return networks[token.toUpperCase()] ?? 'base'
    // }
}

export default new LiquidityRampService()