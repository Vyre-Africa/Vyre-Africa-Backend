
import prisma from '../config/prisma.client';
import config from '../config/env.config';
import liquidityRampService from './liquidityRamp.service'; // adjust path to match wherever this actually lives
import logger from '../config/logger';
import { ulid } from 'ulid';

class WalletFundingService {

    async initiateStablecoinWalletFunding(payload: {
        userId: string;
        currencyId: string;      // determines both the stablecoin AND its chain
        fiatAmount: string;
        fiatCurrency: string;    // e.g. 'NGN'
        userDetails: {
            email: string;
            firstName: string;
            lastName: string;
        };
    }) {
        const { userId, currencyId, fiatAmount, fiatCurrency, userDetails } = payload;

        const currency = await prisma.currency.findUnique({ where: { id: currencyId } });
        if (!currency) throw new Error('Currency not found');
        if (!currency.chain) throw new Error(`Currency ${currency.ISO} has no chain configured`);

        // Confirm the user actually HAS a wallet for this currency before
        // taking their money — no point starting a ramp that can never
        // be credited anywhere.
        const userWallet = await prisma.wallet.findFirst({ where: { userId, currencyId } });
        if (!userWallet) throw new Error(`User has no wallet for ${currency.ISO} on ${currency.chain}`);

        // Same admin-wallet resolution as the existing P2P onramp flow —
        // Quidax always delivers to Vyre's pooled admin wallet, never to
        // the user's own address.
        const adminWallet = await prisma.wallet.findFirst({
            where: { userId: config.Admin_Id, currencyId },
        });
        if (!adminWallet?.depositAddress) {
            throw new Error(`Admin wallet not found or missing deposit address for ${currency.ISO} on ${currency.chain}`);
        }

        const network = liquidityRampService.getNetwork(currency.chain);

        // NEW prefix — distinct from RAMP_/OFFRAMP_ so the webhook can
        // tell this flow apart from the existing P2P synthetic-order flow
        // before doing anything else.
        const reference = `WALLETFUND_${ulid()}`;

        const rampInit = await liquidityRampService.initiateRampBankTransfer({
            merchantReference: reference,
            fromCurrency: fiatCurrency.toLowerCase(),
            toCurrency: currency.ISO.toLowerCase(),
            fromAmount: fiatAmount,
            walletAddress: adminWallet.depositAddress,
            walletNetwork: network,
            customerEmail: userDetails.email,
            customerFirstName: userDetails.firstName,
            customerLastName: userDetails.lastName,
        });

        const rampConfirm = await liquidityRampService.confirmRamp(reference);

        const record = await prisma.walletFundingRequest.create({
            data: {
                userId,
                currencyId,
                chain: currency.chain,
                fiatAmount,
                fiatCurrency: fiatCurrency.toUpperCase(),
                expectedCryptoAmount: rampInit.to_amount,
                merchantReference: reference,
                quidaxReference: rampInit.reference,
                bankName: rampConfirm.bank_name,
                bankAccountNumber: rampConfirm.account_number,
                bankAccountName: rampConfirm.account_name,
                status: 'PENDING',
            },
        });

        logger.info('Wallet funding initiated', {
            userId, reference, currency: currency.ISO, chain: currency.chain,
            fiatAmount, expectedCryptoAmount: rampInit.to_amount,
        });

        return {
            reference,
            bankName: rampConfirm.bank_name,
            bankAccountNumber: rampConfirm.account_number,
            bankAccountName: rampConfirm.account_name,
            fiatAmount: rampConfirm.amount,
            expectedCryptoAmount: rampInit.to_amount,
            currency: currency.ISO,
        };
    }
}

export default new WalletFundingService();