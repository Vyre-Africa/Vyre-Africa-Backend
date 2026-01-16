"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// import Flutterwave from "flutterwave-node-v3";
const env_config_1 = __importDefault(require("../config/env.config"));
const prisma_config_1 = __importDefault(require("../config/prisma.config"));
const axios_1 = __importDefault(require("axios"));
const logger_1 = __importDefault(require("../config/logger"));
const Flutterwave = require('flutterwave-node-v3');
const qorepayAxios = axios_1.default.create({
    baseURL: 'https://gate.qorepay.com/',
    headers: {
        'accept': 'application/json',
        'authorization': `Bearer ${env_config_1.default.QOREPAY_BEARER_TOKEN}`,
        'Content-Type': 'application/json'
    }
});
const qorepayServer = axios_1.default.create({
    baseURL: 'https://gate.qorepay.com',
    headers: {
        'accept': 'application/json',
        'authorization': `Bearer ${env_config_1.default.QOREPAY_S2S_TOKEN}`,
        'Content-Type': 'multipart/form-data'
    }
});
class QorepayService {
    async deposit_via_Url(payload) {
        const { currency, amount, email, userId, walletId } = payload;
        const data = {
            client: {
                email
            },
            purchase: {
                currency,
                products: [
                    {
                        name: "Deposit",
                        quantity: 1,
                        price: amount * 100
                    }
                ]
            },
            brand_id: env_config_1.default.QOREPAY_BRAND_ID,
            failure_redirect: `${env_config_1.default.urls.userDashboard}/failed`,
            success_redirect: `${env_config_1.default.urls.userDashboard}/successful`
        };
        const response = await qorepayAxios.post(`/api/v1/purchases/`, data);
        console.log(response.data);
        const result = response.data;
        // create transaction record
        const transaction = await prisma_config_1.default.transaction.create({
            data: {
                id: result.id,
                userId,
                currency,
                amount,
                reference: result.id,
                status: 'PENDING',
                walletId,
                type: 'FIAT_DEPOSIT',
                description: `${currency} deposit`
            }
        });
        const paymentDetails = {
            id: result.id,
            url: result.checkout_url,
            success_redirect: result.success_redirect,
            failure_redirect: result.failure_redirect,
        };
        return paymentDetails;
    }
    async deposit_via_Bank(payload) {
        const { currency, amount, email, userId, walletId } = payload;
        try {
            // Step 1: Create purchase
            const data = {
                client: { email },
                purchase: {
                    currency,
                    products: [{
                            name: "Deposit",
                            quantity: 1,
                            price: amount * 100
                        }]
                },
                brand_id: env_config_1.default.QOREPAY_BRAND_ID
            };
            const response = await qorepayAxios.post('/api/v1/purchases/', data);
            const result = response.data;
            if (!result)
                throw new Error('Could not initialize payment');
            // Step 2 & 3: Create transaction record AND fetch bank details in parallel
            const formData = new FormData();
            formData.append('s2s', 'true');
            formData.append('pm', 'sarepay_bank_transfer');
            const [transaction, bankAccount] = await Promise.all([
                // Create transaction record
                prisma_config_1.default.transaction.create({
                    data: {
                        id: result.id,
                        userId,
                        currency,
                        amount,
                        reference: result.id,
                        status: 'PENDING',
                        walletId,
                        type: 'FIAT_DEPOSIT',
                        description: `${currency} deposit`
                    }
                }),
                // Get bank details
                qorepayServer.post(`/p/${result.id}/`, formData)
            ]);
            const details = bankAccount.data.data;
            return {
                id: result.id,
                account_number: details?.account_number,
                account_name: details?.account_name,
                bank: details?.bank,
                status: details?.status,
                type: details?.type,
                expires_at: details?.expires_at,
                validity_type: details?.validity_type
            };
        }
        catch (error) {
            logger_1.default.error('Bank deposit initialization failed:', error);
            throw error;
        }
    }
    async bank_Transfer(payload) {
        const { currency, amount, email, phone, account_number, bank_code, recipient_name } = payload;
        const data = {
            client: {
                email,
                phone
            },
            payment: {
                amount: (Number(amount)) * 100,
                currency,
                description: `${currency} withdrawal `,
            },
            sender_name: 'Vyre Africa',
            brand_id: env_config_1.default.QOREPAY_BRAND_ID,
        };
        const response = await qorepayAxios.post(`/api/v1/payouts/`, data);
        console.log('first response', response.data);
        const result = response.data;
        const registered = await axios_1.default.get(result?.execution_url);
        const payment = registered.data;
        // const paymentDetails ={
        //     banks: payment?.detail.data,
        //     url: payment?.payout_url,
        // }
        if (payment?.status === 'error') {
            throw new Error('Could not initialize transfer');
        }
        // return payment?.payout_url
        const transferData = {
            account_number,
            bank_code,
            recipient_name
        };
        const transferResponse = await axios_1.default.post(payment?.payout_url, transferData);
        console.log('qorepay transfer response', transferResponse.data);
        const transferResult = transferResponse.data;
        return { success: true, ...result };
    }
}
exports.default = new QorepayService();
