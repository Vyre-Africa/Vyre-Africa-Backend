"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// import Flutterwave from "flutterwave-node-v3";
const env_config_1 = __importDefault(require("../config/env.config"));
const prisma_config_1 = __importDefault(require("../config/prisma.config"));
const Flutterwave = require('flutterwave-node-v3');
// import Flutterwave from 'flutterwave-node-v3'
class FlutterwaveService {
    constructor() {
        this.flw = new Flutterwave(env_config_1.default.flutterwave.FLW_PUBLIC_KEY, env_config_1.default.flutterwave.FLW_SECRET_KEY);
    }
    async getBanks() {
        try {
            const payload = {
                "country": "ZA" //Pass either NG, GH, KE, UG, ZA or TZ to get list of banks in Nigeria, Ghana, Kenya, Uganda, South Africa or Tanzania respectively
            };
            const response = await this.flw.Bank.country(payload);
            console.log(response);
            const banks = response?.data;
            for (const bank of banks) {
                console.log(bank);
                await prisma_config_1.default.bank.create({
                    data: {
                        name: bank.name,
                        slug: `bank-${bank.name}`,
                        code: bank.code,
                        country: 'South Africa',
                        currency: 'ZAR'
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
    // async getAllBanks(): Promise<void> {
    //     interface Bank {
    //         name: string;
    //         slug: string;
    //         code: string;
    //         country: string;
    //         currency: string;
    //         type: string;
    //     }
    //     interface PaystackBankResponse {
    //         status: boolean;
    //         message: string;
    //         data: Bank[];
    //         meta: {
    //             next: string | null;
    //             previous: string | null;
    //             perPage: number;
    //         };
    //     }
    //     try {
    //       const secretKey = config.paystack.secretKey;
    //       let nextCursor: string | null = null;
    //       do {
    //         // Fetch banks from Paystack API with cursor pagination
    //         const response = await axios.get<PaystackBankResponse>('https://api.paystack.co/bank', {
    //           headers: {
    //             Authorization: `Bearer ${secretKey}`,
    //           },
    //           params: {
    //             country: 'nigeria',
    //             use_cursor: true,
    //             next: nextCursor, // Use the cursor for pagination
    //           },
    //         });
    //         // Access the `data` property of the AxiosResponse
    //         // const paystackResponse: PaystackBankResponse = response.data;
    //         // const { data: banks, meta } = paystackResponse;
    //         // Save banks to the database
    //         for (const bank of banks) {
    //           await prisma.bank.create({
    //             data: {
    //               name: bank.name,
    //               slug: bank.slug,
    //               code: bank.code,
    //               country: bank.country
    //             },
    //           });
    //         }
    //         console.log(`Fetched and saved ${banks.length} banks.`);
    //         nextCursor = meta.next; // Update the cursor for the next request
    //       } while (nextCursor); // Continue until there are no more pages
    //       console.log('All banks fetched and saved to the database.');
    //     } catch (error) {
    //       console.error('Error fetching or saving banks:', error);
    //       throw error; // Re-throw the error to handle it elsewhere if needed
    //     }
    // }
    async resolveAccount(bank_code, account_number) {
        try {
            const payload = {
                account_number: account_number,
                account_bank: bank_code
            };
            const response = await this.flw.Misc.verify_Account(payload);
            console.log(response);
            return response;
        }
        catch (error) {
            console.log(error);
        }
        // return await this.paystack.verification.resolveAccount({
        //     account_number,
        //     bank_code
        // });
    }
}
exports.default = new FlutterwaveService();
