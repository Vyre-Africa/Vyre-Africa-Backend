// src/services/liquidityRamp.service.ts
import axios, { AxiosInstance } from 'axios'
import prisma from '../config/prisma.client'
import logger from '../config/logger'

const rampApi: AxiosInstance = axios.create({
    baseURL: process.env.LIQUIDITY_RAMP_BASE_URL!,
    headers: {
        Authorization: `Bearer ${process.env.LIQUIDITY_RAMP_SECRET_KEY}`,
        'Content-Type': 'application/json'
    }
})

class LiquidityRampService {

    // ══════════════════════════════════════════════════════
    // FIAT CONFIG
    // Add new currencies here only — nothing else changes
    // ══════════════════════════════════════════════════════

    private readonly FIAT_CONFIG: Record<string, {
        currency:     string   // Quidax currency code
        channel:      string   // bank_transfer or mobile_money
        currencyCode: string   // for bank_account endpoint
        supported:    boolean
    }> = {
        NGN: { currency: 'ngn', channel: 'bank_transfer', currencyCode: 'ngn', supported: true  },
        GHS: { currency: 'ghs', channel: 'mobile_money',  currencyCode: 'ghs', supported: true  },
        KES: { currency: 'kes', channel: 'mobile_money',  currencyCode: 'kes', supported: false },
        ZAR: { currency: 'zar', channel: 'bank_transfer', currencyCode: 'zar', supported: false },
        XAF: { currency: 'xaf', channel: 'mobile_money',  currencyCode: 'xaf', supported: false },
        XOF: { currency: 'xof', channel: 'mobile_money',  currencyCode: 'xof', supported: false },
    }

    getFiatConfig(fiatISO: string) {
        const config = this.FIAT_CONFIG[fiatISO.toUpperCase()]
        if (!config)           throw new Error(`Unknown fiat currency: ${fiatISO}`)
        if (!config.supported) throw new Error(`${fiatISO} is not yet supported`)
        return config
    }

    // ══════════════════════════════════════════════════════
    // RATES
    // ══════════════════════════════════════════════════════

    async getRate(toCurrency: string, fromFiat: string): Promise<number> {
        const pair = this.getPair(toCurrency, fromFiat)

        const { data } = await rampApi.get(`/markets/${pair}/ticker`)
        const rate     = parseFloat(data.data.ticker.sell)

        if (!rate || isNaN(rate) || rate <= 0) {
            throw new Error(`Invalid rate for ${pair}: ${data.data.ticker.sell}`)
        }

        logger.info('Rate fetched', { pair, rate })
        return rate
    }

    // ══════════════════════════════════════════════════════
    // ONRAMP — user pays fiat → receives crypto
    // ══════════════════════════════════════════════════════

    // ── Step 1: Initiate ──────────────────────────────────
    // Routes to bank transfer or mobile money based on fiat
    async initiateRamp(payload: {
        userId:         string
        fromAmount:     string   // fiat amount
        fromFiat:       string   // NGN or GHS
        toCurrency:     string   // USDT or USDC
        reference:      string   // RAMP_{awaitingId}
        depositAddress: string   // unique wallet per tx from pool
        mobileDetails?: {        // only for GHS
            phoneNumber:     string
            networkProvider: string  // MTN, AIRTEL, VODAFONE
        }
    }) {
        const { userId, fromAmount, fromFiat, toCurrency,
                reference, depositAddress, mobileDetails } = payload

        const fiatConfig = this.getFiatConfig(fromFiat)
        const user       = await this.getUser(userId)

        if (fiatConfig.channel === 'mobile_money') {

            if (!mobileDetails?.phoneNumber || !mobileDetails?.networkProvider) {
                throw new Error('Phone number and network provider required for mobile money')
            }

            const validProviders = ['MTN', 'AIRTEL', 'VODAFONE']
            if (!validProviders.includes(mobileDetails.networkProvider.toUpperCase())) {
                throw new Error(`Invalid network provider. Allowed: ${validProviders.join(', ')}`)
            }

            return await this.initiateRampMobileMoney({
                user, fromAmount, fromFiat, toCurrency,
                reference, depositAddress, mobileDetails
            })
        }

        // Default — bank transfer (NGN)
        return await this.initiateRampBankTransfer({
            user, fromAmount, fromFiat, toCurrency,
            reference, depositAddress
        })
    }

    // ── Bank transfer onramp (NGN) ─────────────────────────
    private async initiateRampBankTransfer(payload: {
        user:           any
        fromAmount:     string
        fromFiat:       string
        toCurrency:     string
        reference:      string
        depositAddress: string
    }) {
        const { user, fromAmount, fromFiat,
                toCurrency, reference, depositAddress } = payload

        logger.info('Initiating bank transfer onramp', { reference, fromAmount, fromFiat })

        const { data } = await rampApi.post('/on_ramp_transactions/initiate', {
            from_currency:      fromFiat.toLowerCase(),
            to_currency:        toCurrency.toLowerCase(),
            from_amount:        fromAmount,
            merchant_reference: reference,
            customer: {
                email:      user.realEmail ?? user.email,
                first_name: user.firstName,
                last_name:  user.lastName
            },
            wallet_address: {
                address: depositAddress,
                network: this.getNetwork(toCurrency)
            }
        })

        logger.info('Bank transfer onramp initiated', {
            reference,
            toAmount: data.data.to_amount,
            status:   data.data.status
        })

        return { ...data.data, channel: 'bank_transfer' }
    }

    // ── Mobile money onramp (GHS) ──────────────────────────
    private async initiateRampMobileMoney(payload: {
        user:           any
        fromAmount:     string
        fromFiat:       string
        toCurrency:     string
        reference:      string
        depositAddress: string
        mobileDetails:  { phoneNumber: string; networkProvider: string }
    }) {
        const { user, fromAmount, fromFiat, toCurrency,
                reference, depositAddress, mobileDetails } = payload

        logger.info('Initiating mobile money onramp', {
            reference, fromAmount,
            networkProvider: mobileDetails.networkProvider
        })

        // Step A — initiate the transaction
        const { data: initData } = await rampApi.post('/on_ramp_transactions/initiate', {
            from_currency:      fromFiat.toLowerCase(),
            to_currency:        toCurrency.toLowerCase(),
            from_amount:        fromAmount,
            merchant_reference: reference,
            customer: {
                email:      user.realEmail ?? user.email,
                first_name: user.firstName,
                last_name:  user.lastName
            },
            wallet_address: {
                address: depositAddress,
                network: this.getNetwork(toCurrency)
            }
        })

        // Step B — trigger mobile money prompt on customer phone
        const { data: momoData } = await rampApi.post(
            '/on_ramp_transactions/initiate_mobile_money',
            {
                merchant_reference: reference,
                phone_number:       mobileDetails.phoneNumber,
                network_provider:   mobileDetails.networkProvider.toUpperCase()
            }
        )

        logger.info('Mobile money prompt sent', {
            reference,
            nextStep:    momoData.data.next_step,   // PIN or OTP
            instruction: momoData.data.instruction
        })

        return {
            ...initData.data,
            channel: 'mobile_money',
            mobileMoneyDetails: {
                nextStep:    momoData.data.next_step,   // PIN or OTP
                instruction: momoData.data.instruction,
                fee:         momoData.data.fee,
                amount:      momoData.data.amount,
                currency:    momoData.data.currency
            }
        }
    }

    // ── Step 2: Confirm onramp ─────────────────────────────
    // Bank transfer only — mobile money skips this
    async confirmRamp(merchantReference: string, channel: string) {
        if (channel === 'mobile_money') {
            // No confirm needed — momo prompt already triggered
            logger.info('Mobile money — skipping confirm step', { merchantReference })
            return null
        }

        logger.info('Confirming onramp', { merchantReference })

        const { data } = await rampApi.post(
            `/on_ramp_transactions/${merchantReference}/confirm`
        )

        logger.info('Onramp confirmed — bank account generated', {
            merchantReference,
            bank:           data.data.bank_name,
            accountNumber:  data.data.account_number,
            amountExpected: data.data.amount_expected
        })

        return {
            bankName:       data.data.bank_name,
            accountName:    data.data.account_name,
            accountNumber:  data.data.account_number,
            amountExpected: data.data.amount_expected,
            processorFee:   data.data.processor_fee,
            vat:            data.data.vat,
            reference:      data.data.reference
        }
    }

    // ── Step 3: Verify OTP — GHS only, when next_step = OTP ─
    async verifyMobileMoneyOtp(payload: {
        merchantReference: string
        otp:               string
    }) {
        const { merchantReference, otp } = payload

        logger.info('Verifying mobile money OTP', { merchantReference })

        const { data } = await rampApi.post(
            '/on_ramp_transactions/verify_mobile_money_otp/',
            { merchant_reference: merchantReference, otp }
        )

        logger.info('Mobile money OTP verified', { merchantReference })
        return data.data
    }

    // ── Shape onramp response → existing payments object ───
    shapeAsPayments(
        initiated:         any,
        bankDetails:       any,   // null for mobile money
        merchantReference: string
    ) {
        const base = {
            id:              merchantReference,
            expires_at:      new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            rampReference:   initiated.reference,
            rampPublicId:    initiated.public_id,
            fromAmount:      initiated.from_amount,
            toAmount:        initiated.to_amount,
            blockchainFee:   initiated.blockchain_fee,
            isSyntheticRamp: true,
            isOfframp:       false,
            channel:         initiated.channel
        }

        if (initiated.channel === 'mobile_money') {
            return {
                ...base,
                amountExpected:     initiated.mobileMoneyDetails?.amount,
                fee:                initiated.mobileMoneyDetails?.fee,
                instruction:        initiated.mobileMoneyDetails?.instruction,
                nextStep:           initiated.mobileMoneyDetails?.nextStep,
                currency:           initiated.mobileMoneyDetails?.currency
            }
        }

        // Bank transfer
        return {
            ...base,
            bank:           bankDetails.bankName,
            account_number: bankDetails.accountNumber,
            account_name:   bankDetails.accountName,
            amountExpected: bankDetails.amountExpected,
            processorFee:   bankDetails.processorFee,
            vat:            bankDetails.vat
        }
    }

    // ══════════════════════════════════════════════════════
    // OFFRAMP — user sends crypto → receives fiat
    // ══════════════════════════════════════════════════════

    // ── Step 1: Initiate ──────────────────────────────────
    async initiateOfframp(payload: {
        fromAmount:    string    // crypto amount
        fromCurrency:  string    // USDT or USDC
        toFiat:        string    // NGN or GHS
        network:       string    // bep20 or base
        reference:     string    // OFFRAMP_{awaitingId}
        customerName:  { firstName: string; lastName: string; email: string }
    }) {
        const { fromAmount, fromCurrency, toFiat,
                network, reference, customerName } = payload

        const fiatConfig = this.getFiatConfig(toFiat)

        logger.info('Initiating offramp', {
            reference, fromAmount, fromCurrency, toFiat
        })

        const { data } = await rampApi.post('/off_ramp_transactions/initiate', {
            from_currency:      fromCurrency.toLowerCase(),
            to_currency:        fiatConfig.currency,
            from_amount:        fromAmount,
            network,
            merchant_reference: reference,
            customer: {
                // Always bank-resolved name — guarantees match in step 3
                email:      customerName.email,
                first_name: customerName.firstName,
                last_name:  customerName.lastName
            }
        })

        logger.info('Offramp initiated', {
            reference,
            toAmount: data.data.to_amount,
            status:   data.data.status
        })

        return data.data
    }

    // ── Step 2: Confirm — get Quidax deposit address ───────
    async confirmOfframp(merchantReference: string) {
        logger.info('Confirming offramp', { merchantReference })

        const { data } = await rampApi.post(
            `/off_ramp_transactions/${merchantReference}/confirm`
        )

        logger.info('Offramp confirmed — deposit address generated', {
            merchantReference,
            address: data.data.address,
            network: data.data.network
        })

        return {
            address:  data.data.address,   // user sends crypto here
            network:  data.data.network,
            currency: data.data.currency,
            tag:      data.data.tag        // null for USDT
        }
    }

    // ── Step 3: Add payout account ─────────────────────────
    // NGN → bank account number
    // GHS → mobile money number
    // Same endpoint — just different values
    async addOfframpPayoutAccount(payload: {
        merchantReference: string
        bankCode:          string
        accountNumber:     string  // bank acc for NGN, momo number for GHS
        fiatISO:           string
    }) {
        const { merchantReference, bankCode, accountNumber, fiatISO } = payload
        const fiatConfig = this.getFiatConfig(fiatISO)

        logger.info('Adding payout account to offramp', {
            merchantReference,
            bankCode,
            accountNumber,
            fiatISO
        })

        const { data } = await rampApi.post(
            `/off_ramp_transactions/${merchantReference}/bank_account`,
            {
                bank_code:      bankCode,
                account_number: accountNumber,
                currency_code:  fiatConfig.currencyCode  // ngn or ghs
            }
        )

        logger.info('Payout account added', {
            merchantReference,
            accountName:   data.data.metadata.account_name,
            accountNumber: data.data.metadata.account_number,
            status:        data.data.status
        })

        return data.data
    }

    // ── Shape offramp response → existing crypto object ────
    shapeOfframpAsPayments(
        initiated:         any,
        depositInfo:       any,
        merchantReference: string
    ) {
        return {
            id:       merchantReference,
            address:  depositInfo.address,    // user sends crypto here
            network:  depositInfo.network,
            currency: initiated.from_currency,
            toAmount:   initiated.to_amount,  // fiat user receives
            fromAmount: initiated.from_amount,
            rampReference:   initiated.reference,
            rampPublicId:    initiated.public_id,
            isSyntheticRamp: true,
            isOfframp:       true,
            triggerAddress:  null             // Quidax webhook handles this
        }
    }

    // ══════════════════════════════════════════════════════
    // HELPERS
    // ══════════════════════════════════════════════════════

    private async getUser(userId: string) {
        const user = await prisma.user.findUnique({
            where:  { id: userId },
            select: { firstName: true, lastName: true, email: true, realEmail: true }
        })
        if (!user) throw new Error('User not found')
        return user
    }

    getNetwork(currency: string): string {
        const networks: Record<string, string> = {
            USDT: 'bep20',
            USDC: 'base'
        }
        return networks[currency.toUpperCase()] ?? 'bep20'
    }

    getPair(toCurrency: string, fromFiat: string): string {
        return `${toCurrency.toLowerCase()}${fromFiat.toLowerCase()}`
        // usdtngn, usdcngn, usdtghs, usdcghs
    }

    verifyWebhookSignature(payload: string, signature: string): boolean {
        const crypto   = require('crypto')
        const secret   = process.env.LIQUIDITY_RAMP_WEBHOOK_SECRET!
        const expected = crypto
            .createHmac('sha256', secret)
            .update(payload)
            .digest('hex')
        return expected === signature
    }
}

export default new LiquidityRampService()