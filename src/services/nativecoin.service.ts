import { Request, Response } from 'express';
import prisma from '../config/prisma.config';
import config from '../config/env.config';
import axios from "axios";
// import {Currency,walletType} from '@prisma/client';
// import { currency as baseCurrency } from '../globals';
import { hasSufficientBalance } from '../utils';

    const tatumAxios = axios.create({
        baseURL: 'https://api.tatum.io/v3',
        headers: {
            'x-api-key': config.TATUM_LIVE_KEY,
            'Content-Type': 'application/json'
        }
    });

    const tatumAxiosV4 = axios.create({
        baseURL: 'https://api.tatum.io/v4',
        headers: {
            'x-api-key': config.TATUM_LIVE_KEY,
            'Content-Type': 'application/json'
        }
    });

class nativeCoinService
{    

    private generate_Address = async(Account_ID:string)=>{
    
        const response = await tatumAxios.post(`/offchain/account/${Account_ID}/address`)
        const result = response.data
        console.log(result)

        return result
    }

    async subscribe_address(payload:{
        address: string,
        chain: string
    }){

        const data = {
            type:"ADDRESS_EVENT",
            attr:{
               address: payload.address,
               chain: payload.chain,
               url:"https://api-dev.vyre.africa/api/v1/webhook/tatum" //The URL of the webhook listener you are using
               }
            }

        const result = await tatumAxiosV4.post('/subscription', data)

        return result.data

    }

    private complete_Withdrawal = async(
        withdrawal_Id: string,
        txId: string
    )=>{

        await tatumAxios.put(`/offchain/withdrawal/${withdrawal_Id}/${txId}`)

        const updatedTransaction = await prisma.transaction.update({
            where:{id: withdrawal_Id },
            data:{
              status:'SUCCESSFUL',
            }
        })

        return updatedTransaction

    }



    private Withdraw_Bitcoin = async(
        userId: string, 
        account_ID: string,
        address: string,
        amount: number,
    )=>{
        const data = {
            senderAccountId: account_ID,
            mnemonic: config.BTC_MNEMONIC,
            xpub: config.BTC_XPUB,
            address,
            amount
        };

        let transaction;

        const response = await tatumAxios.post('/offchain/bitcoin/transfer', data)
        console.log(response)
        const result = response.data

        transaction = await prisma.transaction.create({
            data:{
                id: result.id,
                userId: userId,
                currency: 'BTC',
                amount,
                status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                walletId: account_ID,
                type:'DEBIT_PAYMENT',
                description:'Bitcoin transfer'
            }
        })

        if(!result.completed){
            transaction = await this.complete_Withdrawal(result.id, result.txId)
        }

        return transaction

    }

    private Withdraw_Ethereum = async(
        userId: string, 
        account_ID: string,
        address: string,
        index: number,
        amount: number,
    )=>{
        const data = {
            senderAccountId: account_ID,
            mnemonic: config.ETH_MNEMONIC,
            index: index || 1,
            address,
            amount
        };

        let transaction;

        const response = await tatumAxios.post('/offchain/ethereum/transfer', data)
        console.log(response)
        const result = response.data

        transaction = await prisma.transaction.create({
            data:{
                id: result.id,
                userId: userId,
                currency: 'ETH',
                amount,
                status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                walletId: account_ID,
                type:'DEBIT_PAYMENT',
                description:'Ethereum transfer'
            }
        })

        if(!result.completed){
            transaction = await this.complete_Withdrawal(result.id, result.txId)
        }

        return transaction

        
    }

    private Withdraw_Litecoin = async(
        userId: string, 
        account_ID: string,
        address: string,
        amount: number,
    )=>{
        const data = {
            senderAccountId: account_ID,
            mnemonic: config.LTC_MNEMONIC,
            xpub: config.LTC_XPUB,
            address,
            amount
        };

        let transaction;

        const response = await tatumAxios.post('/offchain/litecoin/transfer', data)
        console.log(response)
        const result = response.data

        transaction = await prisma.transaction.create({
            data:{
                id: result.id,
                userId: userId,
                currency: 'LTC',
                amount,
                status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                walletId: account_ID,
                type:'DEBIT_PAYMENT',
                description:'Litecoin transfer'
            }
        })

        if(!result.completed){
           transaction = await this.complete_Withdrawal(result.id, result.txId)
        }
        return transaction
        
    }
    
    private Withdraw_Tron = async(
        userId: string, 
        account_ID: string,
        address: string,
        index: number,
        amount: number,
    )=>{
        const data = {
            senderAccountId: account_ID,
            mnemonic: config.TRON_MNEMONIC,
            index: index || 1,
            address,
            amount
        };

        let transaction;

        const response = await tatumAxios.post('/offchain/tron/transfer', data)
        console.log(response)
        const result = response.data

        transaction = await prisma.transaction.create({
            data:{
                id: result.id,
                userId: userId,
                currency: 'TRON',
                amount,
                status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                walletId: account_ID,
                type:'DEBIT_PAYMENT',
                description:'Tron transfer'
            }
        })

        if(!result.completed){
           transaction = await this.complete_Withdrawal(result.id, result.txId)
        }

        return transaction

        
    }

    private Withdraw_BNB = async(
        userId: string, 
        account_ID: string,
        address: string,
        amount: number,
    )=>{
        const data = {
            senderAccountId: account_ID,
            fromPrivateKey: config.BNB_KEY,
            address,
            amount
        };

        let transaction;

        const response = await tatumAxios.post('/offchain/bnb/transfer', data)
        console.log(response)
        const result = response.data

        transaction = await prisma.transaction.create({
            data:{
                id: result.id,
                userId: userId,
                currency: 'BNB',
                amount,
                status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                walletId: account_ID,
                type:'DEBIT_PAYMENT',
                description:'BNB transfer'
            }
        })

        if(!result.completed){
           transaction = await this.complete_Withdrawal(result.id, result.txId)
        }

        return transaction

    }

    private Withdraw_XRP = async(
        userId: string, 
        account_ID: string,
        address: string,
        amount: number,
        destination_Tag: number,
    )=>{
        const data = {
            senderAccountId: account_ID,
            account: config.XRP_ADDRESS,
            secret: config.XRP_SECRET,
            attr: destination_Tag,
            address,
            amount
        };

        let transaction;

        const response = await tatumAxios.post('/offchain/xrp/transfer', data)
        console.log(response)
        const result = response.data

        transaction = await prisma.transaction.create({
            data:{
                id: result.id,
                userId: userId,
                currency: 'XRP',
                amount,
                status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                walletId: account_ID,
                type:'DEBIT_PAYMENT',
                description:'Ripple transfer'
            }
        })

        if(!result.completed){
           transaction = await this.complete_Withdrawal(result.id, result.txId)
        }

        return transaction

    }


    private create_Naira_wallet = async(userId:string,currencyId:string)=>{

        console.log('Creating Naira wallet')
        const data = {
            currency: "VC_NGN",
            customer:{
               accountingCurrency: "NGN",
               externalId: userId
            }
        };
        const response = await tatumAxios.post('/ledger/account', data)
        console.log(response)
        const result = response.data

        const newWallet = await prisma.wallet.create({
            data:{
                id: result.id,
                currencyId,
                userId,
                Tatum_customerId: result.customerId,
                accountingCurrency: result.accountingCurrency,
                frozen: result.frozen
            }
        })

        console.log('new Naira wallet', newWallet)

        return newWallet
    }

    private create_Dollar_wallet = async(userId:string, currencyId:string)=>{
        const data = {
            currency: "VC_USD",
            customer:{
               accountingCurrency: "USD",
               externalId: userId
            }
        };
        const response = await tatumAxios.post('/ledger/account', data)
        console.log(response)
        const result = response.data

        const newWallet = await prisma.wallet.create({
            data:{
                id: result.id,
                currencyId,
                userId,
                Tatum_customerId: result.customerId,
                accountingCurrency: result.accountingCurrency,
                frozen: result.frozen
            }
        })

        return newWallet
    }

    private create_Bitcoin_wallet = async(userId:string, currencyId:string)=>{
        const data = {
            currency: "BTC",
            xpub: config.BTC_XPUB,
            customer:{
               accountingCurrency: "USD",
               externalId: userId
            }
        };
        const response = await tatumAxios.post('/ledger/account', data)
        console.log(response)
        const result = response.data

        const deposit = await this.generate_Address(result.id)

        const subscribed = await this.subscribe_address({
            address: deposit.address,
            chain:'bitcoin-mainnet'
        })

        const newWallet = await prisma.wallet.create({
            data:{
                id: result.id,
                currencyId,
                userId,
                depositAddress: deposit.address,
                subscriptionId: subscribed.id,
                derivationKey: deposit.derivationKey,
                Tatum_customerId: result.customerId,
                accountingCurrency: result.accountingCurrency,
                frozen: result.frozen
            }
        })

        return newWallet
    }

    private create_Ethereum_wallet = async(userId:string, currencyId:string)=>{
        const data = {
            currency: "ETH",
            xpub: config.ETH_XPUB,
            customer:{
               accountingCurrency: "USD",
               externalId: userId
            }
        };
        const response = await tatumAxios.post('/ledger/account', data)
        console.log(response)
        const result = response.data

        const deposit = await this.generate_Address(result.id)

        const subscribed = await this.subscribe_address({
            address: deposit.address,
            chain:'ethereum-mainnet'
        })

        const newWallet = await prisma.wallet.create({
            data:{
                id: result.id,
                currencyId,
                userId,
                depositAddress: deposit.address,
                subscriptionId: subscribed.id,
                derivationKey: deposit.derivationKey,
                Tatum_customerId: result.customerId,
                accountingCurrency: result.accountingCurrency,
                frozen: result.frozen
            }
        })

        return newWallet
    }

    private create_Litecoin_wallet = async(userId:string, currencyId:string)=>{
        const data = {
            currency: "LTC",
            xpub: config.LTC_XPUB,
            customer:{
               accountingCurrency: "USD",
               externalId: userId
            }
        };
        const response = await tatumAxios.post('/ledger/account', data)
        console.log(response)
        const result = response.data
        const deposit = await this.generate_Address(result.id)

        const subscribed = await this.subscribe_address({
            address: deposit.address,
            chain:'litecoin-mainnet'
        })

        const newWallet = await prisma.wallet.create({
            data:{
                id: result.id,
                currencyId,
                userId,
                depositAddress: deposit.address,
                subscriptionId: subscribed.id,
                derivationKey: deposit.derivationKey,
                Tatum_customerId: result.customerId,
                accountingCurrency: result.accountingCurrency,
                frozen: result.frozen
            }
        })

        return newWallet
    }

    private create_Tron_wallet = async(userId:string, currencyId:string)=>{
        const data = {
            currency: "TRON",
            xpub: config.TRON_XPUB,
            customer:{
               accountingCurrency: "USD",
               externalId: userId
            }
        };
        const response = await tatumAxios.post('/ledger/account', data)
        console.log(response)
        const result = response.data
        const deposit = await this.generate_Address(result.id)

        const subscribed = await this.subscribe_address({
            address: deposit.address,
            chain:'tron-mainnet'
        })

        const newWallet = await prisma.wallet.create({
            data:{
                id: result.id,
                currencyId,
                userId,
                depositAddress: deposit.address,
                subscriptionId: subscribed.id,
                derivationKey: deposit.derivationKey,
                Tatum_customerId: result.customerId,
                accountingCurrency: result.accountingCurrency,
                frozen: result.frozen
            }
        })

        return newWallet
    }

    private create_Bnb_wallet = async(userId:string, currencyId:string)=>{
        const data = {
            currency: "BNB",
            xpub: config.BNB_ADDRESS,
            customer:{
               accountingCurrency: "USD",
               externalId: userId
            }
        };
        const response = await tatumAxios.post('/ledger/account', data)
        console.log(response)
        const result = response.data
        const deposit = await this.generate_Address(result.id)

        const subscribed = await this.subscribe_address({
            address: deposit.address,
            chain:'bsc-mainnet'
        })

        const newWallet = await prisma.wallet.create({
            data:{
                id: result.id,
                currencyId,
                userId,
                depositAddress: deposit.address,
                subscriptionId: subscribed.id,
                derivationKey: deposit.derivationKey,
                Tatum_customerId: result.customerId,
                accountingCurrency: result.accountingCurrency,
                frozen: result.frozen
            }
        })

        return newWallet
    }

    private create_Ripple_wallet = async(userId:string, currencyId:string)=>{
        const data = {
            currency: "XRP",
            xpub: config.XRP_ADDRESS,
            customer:{
               accountingCurrency: "USD",
               externalId: userId
            }
        };
        const response = await tatumAxios.post('/ledger/account', data)
        console.log(response)
        const result = response.data
        const deposit = await this.generate_Address(result.id)

        const subscribed = await this.subscribe_address({
            address: deposit.address,
            chain:'ripple-mainnet'
        })

        const newWallet = await prisma.wallet.create({
            data:{
                id: result.id,
                currencyId,
                userId,
                depositAddress: deposit.address,
                subscriptionId: subscribed.id,
                derivationKey: deposit.derivationKey,
                destinationTag: deposit.destinationTag,

                Tatum_customerId: result.customerId,
                accountingCurrency: result.accountingCurrency,
                frozen: result.frozen
            }
        })

        return newWallet
    }


    

    async createWallet(ISO:string, userId:string, currencyId:string){
        let result;
        switch (ISO) {

            case 'NGN':
                result = await this.create_Naira_wallet(userId, currencyId)
                return result
                break;

                case 'USD':
                result = await this.create_Dollar_wallet(userId, currencyId)
                return result
                break;
                
                case 'BTC':
                result = await this.create_Bitcoin_wallet(userId, currencyId)
                return result
                break;
                
                case 'ETH':
                result = await this.create_Ethereum_wallet(userId, currencyId)
                return result
                break;

                case 'LTC':
                result = await this.create_Litecoin_wallet(userId, currencyId)
                return result
                break;
                
                case 'TRON':
                result = await this.create_Tron_wallet(userId, currencyId)
                return result
                break;

                case 'BNB':
                result = await this.create_Bnb_wallet(userId, currencyId)
                return result
                break;

                case 'XRP':
                result = await this.create_Ripple_wallet(userId, currencyId)
                return result
                break;

                default:
                 return
        }

    }

    async blockchain_Transfer(payload:{
        ISO:string, 
        userId:string, 
        walletId:string,
        amount: number,
        address: string,
        index: number,
        destination_Tag?: number
    }){
        const {ISO, userId, walletId, amount, address, index, destination_Tag } = payload

        let result;

        switch (ISO) {
            
            case 'BTC':
              result = await this.Withdraw_Bitcoin(
                userId, 
                walletId,
                address,
                amount
              )
              return result
              break;
            
            case 'ETH':
                result = await this.Withdraw_Ethereum(
                    userId, 
                    walletId,
                    address,
                    index,
                    amount
                )
                return result
              break;

            case 'LTC':
                result = await this.Withdraw_Litecoin(
                    userId, 
                    walletId,
                    address,
                    amount
                )
                return result
              break;
            
            case 'TRON':
                result = await this.Withdraw_Tron(
                    userId, 
                    walletId,
                    address,
                    index,
                    amount
                )
                return result
              break;

            case 'BNB':
                result = await this.Withdraw_BNB(
                    userId, 
                    walletId,
                    address,
                    amount
                )
                return result
              break;

            case 'XRP':
                result = await this.Withdraw_XRP(
                    userId, 
                    walletId,
                    address,
                    amount,
                    destination_Tag!
                )
                return result
              break;

            // case 'USDC':
            //     result = await this.Withdraw_USDC_ETH(
            //         userId, 
            //         walletId,
            //         address,
            //         amount
            //     )
            //     return result
            //   break;

            default:
             return
        } 

    }
    
}

export default new nativeCoinService()