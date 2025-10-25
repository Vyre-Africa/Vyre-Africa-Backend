import { Request, Response } from "express";
import { Paystack } from "paystack-sdk";
// import Flutterwave from "flutterwave-node-v3";
import config from "../config/env.config";
import prisma from '../config/prisma.config';
import axios from "axios";
import { UserBank } from "@prisma/client";
import { generateRefCode } from "../utils";
const Flutterwave = require('flutterwave-node-v3');

class FlutterwaveService {
    flw: any;

    constructor() {
      this.flw = new Flutterwave(
        process.env.FLW_PUBLIC_KEY,
        process.env.FLW_SECRET_KEY
      );
    }

    async getBanks(){
       try {
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

    async resolveAccount(bank_code: string, account_number:string){

      try {
        const payload = {
            account_number: account_number,
            account_bank: bank_code
        }
        const response = await this.flw.Misc.verify_Account(payload)
        console.log(response);
        return response

      } catch (error) {
        console.log(error)
      }

        // return await this.paystack.verification.resolveAccount({
        //     account_number,
        //     bank_code
        // });
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