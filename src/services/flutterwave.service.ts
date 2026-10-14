import { Request, Response } from "express";
import { Paystack } from "paystack-sdk";
// import Flutterwave from "flutterwave-node-v3";
import config from "../config/env.config";
import prisma from '../config/prisma.client';
import axios from "axios";
import { UserBank } from "@prisma/client";
import { generateRefCode } from "../utils";
import logger from "../config/logger";
const Flutterwave = require('flutterwave-node-v3');
// import Flutterwave from 'flutterwave-node-v3'

class FlutterwaveService {
    flw: any;

    // NEW — why the SDK is unusable, kept rather than discarded.
    //
    // THE BUG THIS FIXES, measured 13 Oct:
    //   TypeError: Cannot read properties of undefined (reading 'Misc')
    //     at resolveAccount (flutterwave.service.ts:138)
    //
    // The old constructor logged a warning and `return`ed when the keys were
    // absent, which left `this.flw` undefined. Every method then crashed on
    // its first property access — three layers away from the actual cause,
    // with a message naming 'Misc' rather than the missing keys. A guard that
    // turns a clear startup problem into an obscure runtime one is worse than
    // no guard.
    private configured = false;
    private initError: string | null = null;

    constructor() {
      const publicKey = config.flutterwave?.FLW_PUBLIC_KEY;
      const secretKey = config.flutterwave?.FLW_SECRET_KEY;

      if (!publicKey || !secretKey) {
        this.initError =
          'FLW_PUBLIC_KEY and/or FLW_SECRET_KEY are not set, so Flutterwave is not initialised. ' +
          'Account-name verification will be unavailable until they are.';
        // Warned at ERROR level, not console.warn: this silently disables the
        // only account-name check in the product, which is not a warning.
        logger.error(`[Flutterwave] ${this.initError}`, {
          hasPublicKey: Boolean(publicKey),
          hasSecretKey: Boolean(secretKey),
        });
        return;
      }

      try {
        this.flw = new Flutterwave(publicKey, secretKey);
        this.configured = true;
      } catch (error: any) {
        this.initError = `Flutterwave SDK failed to initialise: ${error?.message}`;
        logger.error(`[Flutterwave] ${this.initError}`);
      }
    }

    // One place that answers "can I call this at all", so no method has to
    // find out by dereferencing undefined.
    private unavailable(): { status: 'unavailable'; message: string } | null {
      if (this.configured && this.flw) return null;
      return {
        status: 'unavailable',
        message: this.initError ?? 'Flutterwave is not configured',
      };
    }

    // ⚠️ THIS IS WHY THE Bank TABLE HAS NO NIGERIAN ROWS.
    // It is hardcoded to ZA and writes country: 'South Africa'. It is the only
    // thing that ever seeds Bank, so the `bankId` path in verifyAccountDetail
    // — used by the domestic transfer flow — cannot resolve a Nigerian bank at
    // all. Measured 13 Oct: 0 NG rows.
    //
    // Left as-is rather than quietly changed: it also calls prisma.bank.create
    // in a loop with no upsert, so running it twice duplicates every row.
    // Fixing it properly means a country argument and an upsert on (code,
    // country), which is a change worth making deliberately.
    async getBanks(){
       try {
        const down = this.unavailable();
        if (down) { logger.error('[Flutterwave] getBanks called while unavailable', { reason: down.message }); return null; }

        const payload = {
          "country":"ZA" //Pass either NG, GH, KE, UG, ZA or TZ to get list of banks in Nigeria, Ghana, Kenya, Uganda, South Africa or Tanzania respectively
        }
        const response = await this.flw.Bank.country(payload)
        console.log(response);

        const banks:any[] = response?.data;

        for (const bank of banks) {
          console.log(bank)
            await prisma.bank.create({
              data: {
                name: bank.name,
                slug: `bank-${bank.name}`,
                code: bank.code,
                country: 'South Africa',
                currency:'ZAR'
              },
            });
        }

        console.log('Banks successfully fetched and saved to the database.');


       } catch (error) {
        console.log(error)
        return null
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

    // Three distinct outcomes, and callers need to tell them apart:
    //
    //   status 'success'      the bank answered, data.account_name is the name
    //   status 'error'        the bank answered NO — wrong account details
    //   status 'unavailable'  we never asked. Not the user's fault, and telling
    //                         them "wrong account details" makes them retype a
    //                         correct number
    //
    // The old version collapsed the last two into 'error', which the
    // controller turns into 400 "wrong account details". On a missing-key or
    // network failure that message is actively misleading.
    async resolveAccount(bank_code: string, account_number: string) {
      const down = this.unavailable();
      if (down) {
        logger.error('[Flutterwave] resolveAccount called while unavailable', { reason: down.message });
        return down;
      }

      try {
        const payload = {
          account_number,
          account_bank: bank_code,
        };
        const response = await this.flw.Misc.verify_Account(payload);
        return response;
      } catch (error) {
        logger.error('Flutterwave account resolution failed:', error);
        // A thrown request is an infra failure, not a verdict on the account,
        // so it reports as unavailable rather than as wrong details.
        return { status: 'unavailable', message: 'Verification request failed — please try again' };
      }
    }

    // async verifyTransaction(transactionId: string)
    // {
    //     return await this.paystack.transaction.verify(transactionId)
    // }

    // async resolveCard(bin: number){
    //     return await this.paystack.verification.resolveCard(bin);
    // }

    // async makeTransfer(amount: number, reference:string, userBank:any)
    // {
    //     try {
    //         const recipient = await this.paystack.recipient.create({
    //             type: 'nuban',
    //             name: userBank.accountName,
    //             account_number: userBank.accountNumber,
    //             bank_code: userBank.bank.code
    //         })
    
    //         if(recipient.status && recipient.data?.recipient_code){
    //             return await this.paystack.transfer.initiate({
    //                 source: 'balance',
    //                 amount: amount * 100,
    //                 recipient: recipient.data?.recipient_code,
    //                 reason: 'Qaya withdrawal',
    //                 reference
    //             })
    //         }
    
    //         return false
    //     } catch (error) {
    //         console.log(error)
    //         return false
    //     }
    // }
}

export default new FlutterwaveService()