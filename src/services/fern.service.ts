import { Request, Response } from "express";
import { Paystack } from "paystack-sdk";
import config from "../config/env.config";
import prisma from '../config/prisma.client';
// import { Prisma } from "@prisma/client";
import axios from "axios";
import { UserBank,UserStatus,SwapStatus } from "@prisma/client";
import { generateRefCode,getISOByCountry } from "../utils";
import Ably from 'ably';
import { v4 as uuidv4 } from 'uuid';
import mailService from "./mail.service";

const fernAxios = axios.create({
  baseURL: 'https://api.fernhq.com',
  headers: {
    'Authorization': `Bearer ${config.fern.Key}`,
    'Content-Type': 'application/json',
    'x-idempotency-key': Date.now()
  }
});

const createFernRequest = (idempotencyKey: string) => {
  return axios.create({
    baseURL: 'https://api.fernhq.com',
    headers: {
      'Authorization': `Bearer ${config.fern.Key}`,
      'Content-Type': 'application/json',
      'x-idempotency-key': idempotencyKey
    }
  });
};

interface fiatAccount {
    userId:string,
    bankName:string,
    accountNumber:string,
    accountName:string,
    currency:string,

    bankAddress: {
      country: string,
      addressLine1: string,
      // addressLine2: string,
      city: string,
      state: string,
      postalCode: string,
      locale: string
    },

    // optionals
    routingNumber?:string,
    nubanNumber?:string,
    iban?:string,
    bicSwift?:string,
    sortCode?:string,
    bsbNumber?:string,
    institutionNumber?:string,
    ifscCode?:string,
    clabeNumber?:string,
    cnapsCode?:string,
    pixCode?:string,
    clearingCode?:string,

    accountType:string,
    bankMethod:string,
    isThirdParty:boolean
}

interface PaymentSource {
  sourcePaymentAccountId: string;
  sourceCurrency: string;
  sourcePaymentMethod: string;
  sourceAmount: string;
}

interface PaymentDestination {
  destinationPaymentAccountId: string;
  destinationPaymentMethod: string;
  destinationCurrency: string;
}

interface DeveloperFee {
  developerFeeType: string;
  developerFeeAmount: string;
}

interface QuotePayload {
  customerId: string;
  source: PaymentSource;
  destination: PaymentDestination;
  developerFee: DeveloperFee;
}


interface KycDetails {
  legalFirstName: string;
  legalLastName: string;
  phoneNumber: string;
  email:string;
  dateOfBirth: string;
  employmentStatus: string;
  mostRecentOccupation?: string;
  sourceOfFunds: string;
  accountPurpose: string;
  expectedMonthlyPaymentsUsd: string;
  // isIntermediary?: boolean;
  nationalIdType: string;
  nationalIdNumber: string;

  address: {
    streetLine1: string;
    city: string;
    stateRegionProvince: string;
    postalCode: string;
    countryCode: string;
  };
  documents: {
    governmentId: {
      type: string;
      // countryCode: string;
      documentIdNumber: string;
      issuanceDate: string;
      expirationDate: string;
      frontIdImage: string;
    };
    // proof_of_Address: {
    //   type: string;
    //   // description?: string;
    //   proofOfAddressImage: string;
    // };
  };
}


class FernService {

  // async customer(payload:KycDetails){

  //   console.log('in fern customer')

  //   const {
  //     legalFirstName,
  //     legalLastName,
  //     phoneNumber,
  //     email,
  //     dateOfBirth,
  //     employmentStatus,
  //     mostRecentOccupation,
  //     sourceOfFunds,
  //     accountPurpose,
  //     expectedMonthlyPaymentsUsd,
  //     address,
  //     documents
  //   } = payload as KycDetails;

  //   const customerData = {
  //     customerType: "INDIVIDUAL",
  //     firstName: legalFirstName,
  //     lastName: legalLastName,
  //     email,
  //     kycData:{
  //       legalFirstName,
  //       legalLastName,
  //       phoneNumber,
  //       dateOfBirth,

  //       address,
  //       nationalIdNumber: documents.governmentId.documentIdNumber,
  //       documents: [
  //         {
  //           type: "GOVERNMENT_ID",
  //           subtype: documents.governmentId.type,
  //           countryCode: documents.governmentId.countryCode,
  //           documentIdNumber: documents.governmentId.documentIdNumber,
  //           issuanceDate: documents.governmentId.issuanceDate,
  //           expirationDate: documents.governmentId.expirationDate,
  //           frontIdImage: documents.governmentId.frontIdImage,
  //           // backIdImage: "text",
  //           // proofOfAddressImage: documents.proofOfAddress.proofOfAddressImage,
  //           // description: `${documents.proofOfAddress.type} means of verification`
  //         },
  //         {
  //           type: "PROOF_OF_ADDRESS",
  //           subtype: documents.proofOfAddress.type,
  //           description: `${documents.proofOfAddress.type} means of verification`,
  //           proofOfAddressImage: documents.proofOfAddress.proofOfAddressImage,
  //         }
  //       ],
  //       employmentStatus,
  //       mostRecentOccupation,
  //       sourceOfFunds,
  //       accountPurpose,
  //       // accountPurposeOther: "Real estate transactions",
  //       expectedMonthlyPaymentsUsd,
  //       // isIntermediary: false,

  //     }
  //   }

  //   try {

  //     console.log('in fern axios')
  //     const response = await fernAxios.post('/customers', customerData)
  //     const result = response.data
  //     console.log(result)

  //     return result
      
  //   } catch (error) {
  //     console.log(error,'error')
  //   }
    
    
  // }

  async customer(payload: KycDetails) {
    console.log('Starting Fern customer creation');
  
    const {
      legalFirstName,
      legalLastName,
      phoneNumber,
      email,
      nationalIdType,
      nationalIdNumber,
      dateOfBirth,
      employmentStatus,
      mostRecentOccupation,
      sourceOfFunds,
      accountPurpose,
      expectedMonthlyPaymentsUsd,
      address,
      documents
    } = payload;

    console.log('nationalIdNumber', nationalIdNumber)
    console.log('countryCode', address.countryCode)
    console.log('nationalIdType', nationalIdType)
  
    const customerData = {
      customerType: "INDIVIDUAL",
      firstName: legalFirstName,
      lastName: legalLastName,
      email,
      kycData: {
        legalFirstName,
        legalLastName,
        phoneNumber,
        dateOfBirth,
        address,
        nationalIdNumber,
        nationalIdIssuingCountry: address?.countryCode,
        nationalIdType,
        nationality: address?.countryCode,
        documents: [
          {
            type: "GOVERNMENT_ID",
            subtype: documents?.governmentId?.type,
            countryCode: address?.countryCode,
            documentIdNumber: documents?.governmentId?.documentIdNumber,
            issuanceDate: documents?.governmentId?.issuanceDate,
            expirationDate: documents?.governmentId?.expirationDate,
            frontIdImage: documents?.governmentId?.frontIdImage,
            description: `${documents?.governmentId?.type} means of verification`,
            // proofOfAddressImage: documents?.proof_of_Address?.proofOfAddressImage
          }
          // {
          //   type: "PROOF_OF_ADDRESS",
          //   subtype: documents?.proof_of_Address?.type,
          //   description: `${documents?.proof_of_Address?.type} means of verification`,
          //   proofOfAddressImage: documents?.proof_of_Address?.proofOfAddressImage
          // }
        ],
        employmentStatus,
        mostRecentOccupation,
        sourceOfFunds,
        accountPurpose,
        expectedMonthlyPaymentsUsd,
      }
    };
  
    // Debug: log the payload being sent
    // console.log('Request payload:', JSON.stringify(payload, null, 2));
  
    try {
      console.log('Making request to Fern API...');
      const response = await fernAxios.post('/customers', customerData);
      console.log('Fern API response:', response.data);
      return response.data;

      // Fern API response: {
      //   customerId: '067bf433-12c2-45ad-98fc-d48e79cf9aaa',
      //   customerStatus: 'CREATED',
      //   email: 'vyreafrica@gmail.com',
      //   customerType: 'INDIVIDUAL',
      //   name: 'Harvey Anafuwe',
      //   verificationLink: 'https://app.fernhq.com/verify-customer/067bf433-12c2-45ad-98fc-d48e79cf9aaa',
      //   updatedAt: '2025-09-04T04:44:13.478Z',
      //   organizationId: 'afa84494-b334-4bf1-987d-67494e2b2f3f',
      //   kycLink: 'https://app.fernhq.com/verify-customer/067bf433-12c2-45ad-98fc-d48e79cf9aaa'
      // }


    } catch (error:any) {
      // Comprehensive error handling
      if (axios.isAxiosError(error)) {
        console.error('Fern API Error:');
        console.error('URL:', error.config?.url);
        console.error('Method:', error.config?.method);
        console.error('Status:', error.response?.status);
        console.error('Response Data:', error.response?.data);
        console.error('Response Data:', error.response?.data.details.issues);
        console.error('Request Headers:', error.config?.headers);
      } else {
        console.error('Unexpected Error:', error);
      }
      const mainError = error?.response?.data.details.issues
      throw mainError; // Re-throw to see the full stack trace
    }
  }

  async customer_Created(payload:{customerId:string, status:string, kycLink:string, email:string}){

    const {customerId,status,kycLink,email} = payload

    console.log('customer created',{
      customerId,
      status,
      kycLink,
      email
    })
    
    const updatedUser = await prisma.user.update({
      where:{email},
      data:{
        userStatus: status as UserStatus,
        fernUserId: customerId,
        fernKycLink: kycLink
      }
    })
    console.log(updatedUser)

    return true
  }

  async customer_updated(status:string, email:string){
    
    const updatedUser = await prisma.user.update({
      where:{email},
      data:{
        userStatus: status as UserStatus,
        accountVerified: status ==='ACTIVE'? true : false
      }
    })
    console.log(updatedUser)
    
    if(status === 'ACTIVE'){
      await mailService.sendWelcomeEmail(updatedUser.email,updatedUser.firstName)
    }

    return true
  }

  async fiatAccount(payload:fiatAccount){

    const {
      routingNumber,
      nubanNumber,
      iban,
      bicSwift,
      sortCode,
      bsbNumber,
      institutionNumber,
      ifscCode,
      clabeNumber,
      cnapsCode,
      pixCode,
      clearingCode
    } = payload

    const user = await prisma.user.findUnique({
      where:{id:payload.userId}
    })

    const directNameParts = payload.accountName.trim().split(' ');

    const accountData = {
        paymentAccountType: "EXTERNAL_BANK_ACCOUNT",
        customerId: user?.fernUserId,
        nickname: `${payload.bankName} ${payload.currency} Account`,
        externalBankAccount: {
          accountNumber: payload.accountNumber,
          bankName: payload.bankName,
          bankAccountCurrency: payload.currency,

          ...(routingNumber && { routingNumber }),
          ...(nubanNumber && { nubanNumber }),
          ...(iban && { iban }),
          ...(sortCode && { sortCode }),
          ...(bsbNumber && { bsbNumber }),
          ...(institutionNumber && { institutionNumber }),
          ...(ifscCode && { ifscCode }),
          ...(clabeNumber && { clabeNumber }),
          ...(cnapsCode && { cnapsCode }),
          ...(pixCode && { pixCode }),
          ...(clearingCode && { clearingCode }),
          ...(bicSwift && { bicSwift }),

          bankAddress: payload.bankAddress,

          bankAccountType: payload.accountType,
          bankAccountPaymentMethod: payload.bankMethod,

          bankAccountOwner: {
            email: user?.email,
            firstName: directNameParts[0],
            lastName: directNameParts.slice(1).join(' '),
            address: {
              country: getISOByCountry(user?.country as string),
              addressLine1: user?.address,
              // addressLine2: user?.addressLine2,
              city: user?.city,
              state: user?.state,
              postalCode: user?.postalCode,
              "locale": "en-US"
            },
            type: "INDIVIDUAL"
          }
          
        },
        isThirdParty: true
    }
    
    const response = await fernAxios.post('/payment-accounts', accountData)
    const result = response.data
    console.log(result)

    return result

  }

  async cryptoAccount(payload:{
    userId:string,
    chain:string,
    address:string
  }){

    const user = await prisma.user.findUnique({
      where:{id:payload.userId}
    })
      
    const accountData = {
      paymentAccountType: "EXTERNAL_CRYPTO_WALLET",
      customerId: user?.fernUserId,
      nickname: `${payload.chain} Account`,
      externalCryptoWallet: {
       cryptoWalletType: "EVM",
       chain: payload.chain,
       address: payload.address
      },
    }
          
    const response = await fernAxios.post('/payment-accounts', accountData)
    const result = response.data
    console.log(result)
      
    return result
      
  }

  async generateQuote(payload:QuotePayload){
          
    const response = await fernAxios.post('/quotes', payload)
    const result = response.data
    console.log(result)
      
    return result
  }

  async initTransaction(payload:{quoteId:string}){

    // const idempotencyKey = uuidv4();

    const fern = createFernRequest(payload.quoteId);
    const response = await fern.post('/transactions', payload);
    // const response = await fernAxios.post('/transactions', payload)
    const result = response.data
    console.log(result)
      
    return result
  }

  async getTransaction(id:string){

    const response = await fernAxios.get(`/transactions/${id}`)
    const result = response.data
    console.log(result)
      
    return result
  }

  async transaction_updated(status:string, transactionId:string){
    console.log("====================== transaction update hit",status, transactionId )
    const updatedTransaction = await prisma.swap.update({
      where:{id:transactionId},
      data:{
        status: status as SwapStatus
      }
    })
    console.log(updatedTransaction)

    // const ably = new Ably.Realtime("nECyrQ.Y6Twcg:Ao47kxy-2RK2df35GalolYCLEUwlYuhbASnKwUeFUiE")
    // ably.connection.once("connected", () => {
    //   console.log("Connected to Ably!")
    // })

    // const SwapChannel = ably.channels.get("SWAP")

    // await SwapChannel.publish(transactionId,{status})
    // // return 'done'
    // ably.connection.close();
    return updatedTransaction

  }

  

  // async payment_Account_Created(payload:{
  //   customerId: string, 
  //   paymentAccountId: string, 
  //   bankName?: string, 
  //   nickname: string
  //   accountMask?: string,
  //   currency: string,
  //   method?: string,

  //   cryptoWalletType ?:string,
  //   chain?: string,
  //   address?: string
  // }){

  //   const user = await prisma.user.findFirst({
  //     where:{fernUserId:payload.customerId }
  //   })

  //   if(payload.bankName){
  //     const fiatAccount = await prisma.fiatAccount.create({
  //       data:{
  //         id: payload.paymentAccountId,
  //         name: payload.nickname,
  //         currency: payload.currency,
  //         country: user?.country!,
  //         userId: user?.id,
  //         bank: payload.bankName,
  //         accountNumber: payload.accountMask!,
  //         method: payload.method!
          
  //       }
  //     })

  //   }

  //   if(payload.chain){
  //     const cryptoAccount = await prisma.cryptoAccount.create({
  //       data:{
  //         id: payload.paymentAccountId,
  //         name: payload.nickname,
  //         userId:user?.id,
          
  //         cryptoWalletType: payload.cryptoWalletType,
  //         chain: payload.chain,
  //         address: payload.address
          
  //       }
  //     })
  //   }
    

  //   return true
  // }

  

    // async getBanks(){
    //    try {
    //     const secretKey = config.paystack.secretKey

    //     const availableBanks = await paystackAxios.get('https://api.paystack.co/bank', {
    //         headers: {
    //             Authorization: `Bearer ${secretKey}`
    //         },
    //         params:{
    //             country: 'nigeria',
    //             use_cusor: false
    //         }
    //     })

    //     const banks:any[] = availableBanks?.data.data;

    //     // availableBanks?.data.data.map(async(item:any) => {
    //     //     await prisma.bank.create({
    //     //         data:{
    //     //           name: item.name,
    //     //           slug: item.slug,
    //     //           code: item.code,
    //     //           country: item.country
    //     //         }
    //     //     })

    //     // });

    //     for (const bank of banks) {
    //         await prisma.bank.create({
    //           data: {
    //             name: bank.name,
    //             slug: bank.slug,
    //             code: bank.code,
    //             country: bank.country,
    //           },
    //         });
    //     }

    //     console.log('Banks successfully fetched and saved to the database.');


    //    } catch (error) {
    //     console.log(error)
    //     return null
    //    }
    // }

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
    //         const paystackResponse: PaystackBankResponse = response.data;
    //         const { data: banks, meta } = paystackResponse;
      
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

    // async resolveAccount(bank_code: string, account_number:string){
    //     return await this.paystack.verification.resolveAccount({
    //         account_number,
    //         bank_code
    //     });
    // }

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

export default new  FernService()