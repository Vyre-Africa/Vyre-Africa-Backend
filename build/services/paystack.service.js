"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const paystack_sdk_1 = require("paystack-sdk");
const env_config_1 = __importDefault(require("../config/env.config"));
const prisma_config_1 = __importDefault(require("../config/prisma.config"));
const axios_1 = __importDefault(require("axios"));
const paystackAxios = axios_1.default.create({
    baseURL: "api.paystack.co",
    withCredentials: true
});
class PaystackService {
    constructor() {
        this.paystack = new paystack_sdk_1.Paystack(env_config_1.default.paystack.secretKey);
    }
    async getBanks() {
        try {
            const secretKey = env_config_1.default.paystack.secretKey;
            const availableBanks = await paystackAxios.get('https://api.paystack.co/bank', {
                headers: {
                    Authorization: `Bearer ${secretKey}`
                },
                params: {
                    country: 'nigeria',
                    use_cusor: false
                }
            });
            const banks = availableBanks?.data.data;
            // availableBanks?.data.data.map(async(item:any) => {
            //     await prisma.bank.create({
            //         data:{
            //           name: item.name,
            //           slug: item.slug,
            //           code: item.code,
            //           country: item.country
            //         }
            //     })
            // });
            for (const bank of banks) {
                await prisma_config_1.default.bank.create({
                    data: {
                        name: bank.name,
                        slug: bank.slug,
                        code: bank.code,
                        country: bank.country,
                    },
                });
            }
            console.log('Banks successfully fetched and saved to the database.');
        }
        catch (error) {
            console.log(error);
            return null;
        }
    }
    async getAllBanks() {
        try {
            const secretKey = env_config_1.default.paystack.secretKey;
            let nextCursor = null;
            do {
                // Fetch banks from Paystack API with cursor pagination
                const response = await axios_1.default.get('https://api.paystack.co/bank', {
                    headers: {
                        Authorization: `Bearer ${secretKey}`,
                    },
                    params: {
                        country: 'nigeria',
                        use_cursor: true,
                        next: nextCursor, // Use the cursor for pagination
                    },
                });
                // Access the `data` property of the AxiosResponse
                const paystackResponse = response.data;
                const { data: banks, meta } = paystackResponse;
                // Save banks to the database
                for (const bank of banks) {
                    await prisma_config_1.default.bank.create({
                        data: {
                            name: bank.name,
                            slug: bank.slug,
                            code: bank.code,
                            country: bank.country
                        },
                    });
                }
                console.log(`Fetched and saved ${banks.length} banks.`);
                nextCursor = meta.next; // Update the cursor for the next request
            } while (nextCursor); // Continue until there are no more pages
            console.log('All banks fetched and saved to the database.');
        }
        catch (error) {
            console.error('Error fetching or saving banks:', error);
            throw error; // Re-throw the error to handle it elsewhere if needed
        }
    }
    async resolveAccount(bank_code, account_number) {
        return await this.paystack.verification.resolveAccount({
            account_number,
            bank_code
        });
    }
    async verifyTransaction(transactionId) {
        return await this.paystack.transaction.verify(transactionId);
    }
    async resolveCard(bin) {
        return await this.paystack.verification.resolveCard(bin);
    }
    async makeTransfer(amount, reference, userBank) {
        try {
            const recipient = await this.paystack.recipient.create({
                type: 'nuban',
                name: userBank.accountName,
                account_number: userBank.accountNumber,
                bank_code: userBank.bank.code
            });
            if (recipient.status && recipient.data?.recipient_code) {
                return await this.paystack.transfer.initiate({
                    source: 'balance',
                    amount: amount * 100,
                    recipient: recipient.data?.recipient_code,
                    reason: 'Qaya withdrawal',
                    reference
                });
            }
            return false;
        }
        catch (error) {
            console.log(error);
            return false;
        }
    }
}
exports.default = new PaystackService();
