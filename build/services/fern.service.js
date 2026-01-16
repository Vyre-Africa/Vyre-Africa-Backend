"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const env_config_1 = __importDefault(require("../config/env.config"));
const prisma_config_1 = __importDefault(require("../config/prisma.config"));
// import { Prisma } from "@prisma/client";
const axios_1 = __importDefault(require("axios"));
const utils_1 = require("../utils");
const mail_service_1 = __importDefault(require("./mail.service"));
const fernAxios = axios_1.default.create({
    baseURL: 'https://api.fernhq.com',
    headers: {
        'Authorization': `Bearer ${env_config_1.default.fern.Key}`,
        'Content-Type': 'application/json',
        'x-idempotency-key': Date.now()
    }
});
const createFernRequest = (idempotencyKey) => {
    return axios_1.default.create({
        baseURL: 'https://api.fernhq.com',
        headers: {
            'Authorization': `Bearer ${env_config_1.default.fern.Key}`,
            'Content-Type': 'application/json',
            'x-idempotency-key': idempotencyKey
        }
    });
};
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
    async customer(payload) {
        console.log('Starting Fern customer creation');
        const { legalFirstName, legalLastName, phoneNumber, email, nationalIdType, nationalIdNumber, dateOfBirth, employmentStatus, mostRecentOccupation, sourceOfFunds, accountPurpose, expectedMonthlyPaymentsUsd, address, documents } = payload;
        console.log('nationalIdNumber', nationalIdNumber);
        console.log('countryCode', address.countryCode);
        console.log('nationalIdType', nationalIdType);
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
        }
        catch (error) {
            // Comprehensive error handling
            if (axios_1.default.isAxiosError(error)) {
                console.error('Fern API Error:');
                console.error('URL:', error.config?.url);
                console.error('Method:', error.config?.method);
                console.error('Status:', error.response?.status);
                console.error('Response Data:', error.response?.data);
                console.error('Response Data:', error.response?.data.details.issues);
                console.error('Request Headers:', error.config?.headers);
            }
            else {
                console.error('Unexpected Error:', error);
            }
            const mainError = error?.response?.data.details.issues;
            throw mainError; // Re-throw to see the full stack trace
        }
    }
    async customer_Created(payload) {
        const { customerId, status, kycLink, email } = payload;
        console.log('customer created', {
            customerId,
            status,
            kycLink,
            email
        });
        const updatedUser = await prisma_config_1.default.user.update({
            where: { email },
            data: {
                userStatus: status,
                fernUserId: customerId,
                fernKycLink: kycLink
            }
        });
        console.log(updatedUser);
        return true;
    }
    async customer_updated(status, email) {
        const updatedUser = await prisma_config_1.default.user.update({
            where: { email },
            data: {
                userStatus: status,
                accountVerified: status === 'ACTIVE' ? true : false
            }
        });
        console.log(updatedUser);
        if (status === 'ACTIVE') {
            await mail_service_1.default.sendWelcomeEmail(updatedUser.email, updatedUser.firstName);
        }
        return true;
    }
    async fiatAccount(payload) {
        const { routingNumber, nubanNumber, iban, bicSwift, sortCode, bsbNumber, institutionNumber, ifscCode, clabeNumber, cnapsCode, pixCode, clearingCode } = payload;
        const user = await prisma_config_1.default.user.findUnique({
            where: { id: payload.userId }
        });
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
                        country: (0, utils_1.getISOByCountry)(user?.country),
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
        };
        const response = await fernAxios.post('/payment-accounts', accountData);
        const result = response.data;
        console.log(result);
        return result;
    }
    async cryptoAccount(payload) {
        const user = await prisma_config_1.default.user.findUnique({
            where: { id: payload.userId }
        });
        const accountData = {
            paymentAccountType: "EXTERNAL_CRYPTO_WALLET",
            customerId: user?.fernUserId,
            nickname: `${payload.chain} Account`,
            externalCryptoWallet: {
                cryptoWalletType: "EVM",
                chain: payload.chain,
                address: payload.address
            },
        };
        const response = await fernAxios.post('/payment-accounts', accountData);
        const result = response.data;
        console.log(result);
        return result;
    }
    async generateQuote(payload) {
        const response = await fernAxios.post('/quotes', payload);
        const result = response.data;
        console.log(result);
        return result;
    }
    async initTransaction(payload) {
        // const idempotencyKey = uuidv4();
        const fern = createFernRequest(payload.quoteId);
        const response = await fern.post('/transactions', payload);
        // const response = await fernAxios.post('/transactions', payload)
        const result = response.data;
        console.log(result);
        return result;
    }
    async getTransaction(id) {
        const response = await fernAxios.get(`/transactions/${id}`);
        const result = response.data;
        console.log(result);
        return result;
    }
    async transaction_updated(status, transactionId) {
        console.log("====================== transaction update hit", status, transactionId);
        const updatedTransaction = await prisma_config_1.default.swap.update({
            where: { id: transactionId },
            data: {
                status: status
            }
        });
        console.log(updatedTransaction);
        // const ably = new Ably.Realtime("nECyrQ.Y6Twcg:Ao47kxy-2RK2df35GalolYCLEUwlYuhbASnKwUeFUiE")
        // ably.connection.once("connected", () => {
        //   console.log("Connected to Ably!")
        // })
        // const SwapChannel = ably.channels.get("SWAP")
        // await SwapChannel.publish(transactionId,{status})
        // // return 'done'
        // ably.connection.close();
        return updatedTransaction;
    }
}
exports.default = new FernService();
