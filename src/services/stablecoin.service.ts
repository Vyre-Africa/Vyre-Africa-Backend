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

class stableCoinService
{    

    private generate_Address = async(Account_ID:string)=>{
    
        const response = await tatumAxios.post(`/offchain/account/${Account_ID}/address`)
        const result = response.data
        console.log(result)

        return result
    }

    private subscribe_events = async(
        accountId: string
    )=>{

        const data = {
            type:"ACCOUNT_INCOMING_BLOCKCHAIN_TRANSACTION",
            attr:{
               id: accountId, // The Virtual_Account_ID
               url:"https://vyre-a33d9c003be3.herokuapp.com/api/v1/tatum/events" //The URL of the webhook listener you are using
               }
            }

        const subscribed = await tatumAxios.post('/subscription', data)

        // const subcribed = await prisma.transaction.update({
        //     where:{id: withdrawal_Id },
        //     data:{
        //       status:'SUCCESSFUL',
        //     }
        // })

        return subscribed.data.id

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

    // USDC TRANSFERS
    private Transfer_USDC_ETH = async(payload:{
        userId: string, 
        account_ID: string,
        address: string,
        index: number,
        amount: number,
    })=>{

        const {userId, account_ID, address, index, amount } = payload

        const data = {
            senderAccountId: account_ID,
            mnemonic: config.USDC.ETH_MNEMONIC,
            index: index || 1,
            address,
            amount: String(amount)
        };

        let transaction;

        const response = await tatumAxios.post('/offchain/ethereum/erc20/transfer', data)
        console.log(response)
        const result = response.data

        transaction = await prisma.transaction.create({
            data:{
                id: result.id,
                userId: userId,
                currency: 'USDC_ETH',
                amount,
                status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                walletId: account_ID,
                type:'DEBIT_PAYMENT',
                description:'USDC ETHEREUM transfer'
            }
        })

        if(!result.completed){
            transaction = await this.complete_Withdrawal(result.id, result.txId)
        }

        return transaction

        
    }
    private Transfer_USDC_MATIC = async(payload:{
        userId: string, 
        account_ID: string,
        address: string,
        index: number,
        amount: number,
    })=>{

        const { userId, account_ID, address, index, amount } = payload

        const data = {
            senderAccountId: account_ID,
            mnemonic: config.USDC.POLYGON_MNEMONIC,
            index: index || 1,
            address,
            amount: String(amount)
        };

        let transaction;

        const response = await tatumAxios.post('/offchain/polygon/transfer', data)
        console.log(response)
        const result = response.data

        transaction = await prisma.transaction.create({
            data:{
                id: result.id,
                userId: userId,
                currency: 'USDC_MATIC',
                amount,
                status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                walletId: account_ID,
                type:'DEBIT_PAYMENT',
                description:'USDC MATIC transfer'
            }
        })

        if(!result.completed){
            transaction = await this.complete_Withdrawal(result.id, result.txId)
        }

        return transaction

        
    }
    private Transfer_USDC_BASE = async(payload:{
        userId: string, 
        account_ID: string,
        address: string,
        index: number,
        amount: number,
    })=>{

        const { userId, account_ID, address, index, amount } = payload

        const data = {
            senderAccountId: account_ID,
            mnemonic: config.USDC.BASE_MNEMONIC,
            index: index || 1,
            address,
            amount: String(amount)
        };

        let transaction;

        const response = await tatumAxios.post('/offchain/base/transfer', data)
        console.log(response)
        const result = response.data

        transaction = await prisma.transaction.create({
            data:{
                id: result.id,
                userId: userId,
                currency: 'USDC_BASE',
                amount,
                status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                walletId: account_ID,
                type:'DEBIT_PAYMENT',
                description:'USDC BASE transfer'
            }
        })

        if(!result.completed){
            transaction = await this.complete_Withdrawal(result.id, result.txId)
        }

        return transaction

        
    }
    private Transfer_USDC_BSC = async(payload:{
        userId: string, 
        account_ID: string,
        address: string,
        index: number,
        amount: number,
    })=>{

        const { userId, account_ID, address, index, amount } = payload

        const data = {
            senderAccountId: account_ID,
            mnemonic: config.USDC.BSC_MNEMONIC,
            index: index || 1,
            address,
            amount: String(amount)
        };

        let transaction;

        const response = await tatumAxios.post('/offchain/bsc/transfer', data)
        console.log(response)
        const result = response.data

        transaction = await prisma.transaction.create({
            data:{
                id: result.id,
                userId: userId,
                currency: 'USDC_BSC',
                amount,
                status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                walletId: account_ID,
                type:'DEBIT_PAYMENT',
                description:'USDC BSC transfer'
            }
        })

        if(!result.completed){
            transaction = await this.complete_Withdrawal(result.id, result.txId)
        }

        return transaction

        
    }
    private Transfer_USDC_OP = async(payload:{
        userId: string, 
        account_ID: string,
        address: string,
        index: number,
        amount: number
    })=>{

        const { userId, account_ID, address, index, amount } = payload

        const data = {
            senderAccountId: account_ID,
            mnemonic: config.USDC.OPTIMISM_MNEMONIC,
            index: index || 1,
            address,
            amount: String(amount)
        };

        let transaction;

        const response = await tatumAxios.post('/offchain/optimism/transfer', data)
        console.log(response)
        const result = response.data

        transaction = await prisma.transaction.create({
            data:{
                id: result.id,
                userId: userId,
                currency: 'USDC_OP',
                amount,
                status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                walletId: account_ID,
                type:'DEBIT_PAYMENT',
                description:'USDC OPTIMISM transfer'
            }
        })

        if(!result.completed){
            transaction = await this.complete_Withdrawal(result.id, result.txId)
        }

        return transaction

        
    }
    private Transfer_USDC_ARB = async(payload:{
        userId: string, 
        account_ID: string,
        address: string,
        index: number,
        amount: number
    })=>{

        const { userId, account_ID, address, index, amount } = payload

        const data = {
            senderAccountId: account_ID,
            mnemonic: config.USDC.ARBITRUM_MNEMONIC,
            index: index || 1,
            address,
            amount: String(amount)
        };

        let transaction;

        const response = await tatumAxios.post('/offchain/arb/transfer', data)
        console.log(response)
        const result = response.data

        transaction = await prisma.transaction.create({
            data:{
                id: result.id,
                userId: userId,
                currency: 'USDC_ARB',
                amount,
                status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                walletId: account_ID,
                type:'DEBIT_PAYMENT',
                description:'USDC ARBITRUM transfer'
            }
        })

        if(!result.completed){
            transaction = await this.complete_Withdrawal(result.id, result.txId)
        }

        return transaction

        
    }

    // USDT TRANSFERS
    private Transfer_USDT_ETH = async(payload:{
        userId: string, 
        account_ID: string,
        address: string,
        index: number,
        amount: number,
    })=>{

        const { userId, account_ID,address, index, amount } = payload

        const data = {
            senderAccountId: account_ID,
            mnemonic: config.USDT.ETH_MNEMONIC,
            index: index || 1,
            address,
            amount: String(amount)
        };

        let transaction;

        const response = await tatumAxios.post('/offchain/ethereum/erc20/transfer', data)
        console.log(response)
        const result = response.data

        transaction = await prisma.transaction.create({
            data:{
                id: result.id,
                userId: userId,
                currency: 'USDT_ETH',
                amount,
                status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                walletId: account_ID,
                type:'DEBIT_PAYMENT',
                description:'USDT ETHEREUM transfer'
            }
        })

        if(!result.completed){
            transaction = await this.complete_Withdrawal(result.id, result.txId)
        }

        return transaction

        
    }
    private Transfer_USDT_BASE = async(payload:{
        userId: string, 
        account_ID: string,
        address: string,
        index: number,
        amount: number,
    })=>{

        const { userId, account_ID, address, index, amount } = payload

        const data = {
            senderAccountId: account_ID,
            mnemonic: config.USDT.BASE_MNEMONIC,
            index: index || 1,
            address,
            amount: String(amount)
        };

        let transaction;

        const response = await tatumAxios.post('/offchain/base/transfer', data)
        console.log(response)
        const result = response.data

        transaction = await prisma.transaction.create({
            data:{
                id: result.id,
                userId: userId,
                currency: 'USDT_BASE',
                amount,
                status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                walletId: account_ID,
                type:'DEBIT_PAYMENT',
                description:'USDT BASE transfer'
            }
        })

        if(!result.completed){
            transaction = await this.complete_Withdrawal(result.id, result.txId)
        }

        return transaction

        
    }
    private Transfer_USDT_BSC = async(payload:{
        userId: string, 
        account_ID: string,
        address: string,
        index: number,
        amount: number,
    })=>{

        const { userId, account_ID, address, index, amount } = payload

        const data = {
            senderAccountId: account_ID,
            mnemonic: config.USDT.BSC_MNEMONIC,
            index: index || 1,
            address,
            amount: String(amount)
        };

        let transaction;

        const response = await tatumAxios.post('/offchain/bsc/transfer', data)
        console.log(response)
        const result = response.data

        transaction = await prisma.transaction.create({
            data:{
                id: result.id,
                userId: userId,
                currency: 'USDT_BSC',
                amount,
                status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                walletId: account_ID,
                type:'DEBIT_PAYMENT',
                description:'USDT BSC transfer'
            }
        })

        if(!result.completed){
            transaction = await this.complete_Withdrawal(result.id, result.txId)
        }

        return transaction

        
    }
    private Transfer_USDT_TRON = async(payload:{
        userId: string, 
        account_ID: string,
        address: string,
        index: number,
        amount: number
    })=>{

        const { userId, account_ID, address, index, amount } = payload

        const data = {
            senderAccountId: account_ID,
            mnemonic: config.USDT.TRON_MNEMONIC,
            index: index || 1,
            address,
            amount: String(amount)
        };

        let transaction;

        const response = await tatumAxios.post('/offchain/tron/transfer', data)
        console.log(response)
        const result = response.data

        transaction = await prisma.transaction.create({
            data:{
                id: result.id,
                userId: userId,
                currency: 'USDT_TRON',
                amount,
                status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                walletId: account_ID,
                type:'DEBIT_PAYMENT',
                description:'USDT TRON transfer'
            }
        })

        if(!result.completed){
            transaction = await this.complete_Withdrawal(result.id, result.txId)
        }

        return transaction

        
    }
    private Transfer_USDT_OP = async(payload:{
        userId: string, 
        account_ID: string,
        address: string,
        index: number,
        amount: number
    })=>{

        const { userId, account_ID, address, index, amount } = payload

        const data = {
            senderAccountId: account_ID,
            mnemonic: config.USDT.OPTIMISM_MNEMONIC,
            index: index || 1,
            address,
            amount: String(amount)
        };

        let transaction;

        const response = await tatumAxios.post('/offchain/optimism/transfer', data)
        console.log(response)
        const result = response.data

        transaction = await prisma.transaction.create({
            data:{
                id: result.id,
                userId: userId,
                currency: 'USDT_OP',
                amount,
                status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                walletId: account_ID,
                type:'DEBIT_PAYMENT',
                description:'USDT OPTIMISM transfer'
            }
        })

        if(!result.completed){
            transaction = await this.complete_Withdrawal(result.id, result.txId)
        }

        return transaction

        
    }
    private Transfer_USDT_ARB = async(payload:{
        userId: string, 
        account_ID: string,
        address: string,
        index: number,
        amount: number
    })=>{

        const { userId, account_ID, address, index, amount } = payload

        const data = {
            senderAccountId: account_ID,
            mnemonic: config.USDT.ARBITRUM_MNEMONIC,
            index: index || 1,
            address,
            amount: String(amount)
        };

        let transaction;

        const response = await tatumAxios.post('/offchain/arb/transfer', data)
        console.log(response)
        const result = response.data

        transaction = await prisma.transaction.create({
            data:{
                id: result.id,
                userId: userId,
                currency: 'USDT_ARB',
                amount,
                status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                walletId: account_ID,
                type:'DEBIT_PAYMENT',
                description:'USDT ARBITRUM transfer'
            }
        })

        if(!result.completed){
            transaction = await this.complete_Withdrawal(result.id, result.txId)
        }

        return transaction

        
    }



    

// USDC
    private create_USDC_Eth_wallet = async(userId:string, currencyId:string)=>{
        const data = {
            currency: "USDC",
            xpub: config.USDC.ETH_XPUB,
            customer:{
               accountingCurrency: "USD",
               externalId: userId
            }
        };
        const response = await tatumAxios.post('/ledger/account', data)
        console.log(response)
        const result = response.data
        const deposit = await this.generate_Address(result.id)

        const newWallet = await prisma.wallet.create({
            data:{
                id: result.id,
                currencyId,
                userId,
                depositAddress: deposit.address,
                derivationKey: deposit.derivationKey,
                Tatum_customerId: result.customerId,
                accountingCurrency: result.accountingCurrency,
                frozen: result.frozen
            }
        })

        return newWallet
    }
    private create_USDC_Base_wallet = async(userId:string, currencyId:string)=>{
        const data = {
            currency: "USDC_BASE",
            xpub: config.USDC.BASE_XPUB,
            customer:{
               accountingCurrency: "USD",
               externalId: userId
            }
        };
        const response = await tatumAxios.post('/ledger/account', data)
        console.log(response)
        const result = response.data
        const deposit = await this.generate_Address(result.id)

        const newWallet = await prisma.wallet.create({
            data:{
                id: result.id,
                currencyId,
                userId,
                depositAddress: deposit.address,
                derivationKey: deposit.derivationKey,
                Tatum_customerId: result.customerId,
                accountingCurrency: result.accountingCurrency,
                frozen: result.frozen
            }
        })

        return newWallet
    }
    private create_USDC_BSC_wallet = async(userId:string, currencyId:string)=>{
        const data = {
            currency: "USDC_BSC",
            xpub: config.USDC.BSC_XPUB,
            customer:{
               accountingCurrency: "USD",
               externalId: userId
            }
        };
        const response = await tatumAxios.post('/ledger/account', data)
        console.log(response)
        const result = response.data
        const deposit = await this.generate_Address(result.id)

        const newWallet = await prisma.wallet.create({
            data:{
                id: result.id,
                currencyId,
                userId,
                depositAddress: deposit.address,
                derivationKey: deposit.derivationKey,
                Tatum_customerId: result.customerId,
                accountingCurrency: result.accountingCurrency,
                frozen: result.frozen
            }
        })

        return newWallet
    }
    private create_USDC_Matic_wallet = async(userId:string, currencyId:string)=>{
        const data = {
            currency: "USDC_MATIC",
            xpub: config.USDC.POLYGON_XPUB,
            customer:{
               accountingCurrency: "USD",
               externalId: userId
            }
        };
        const response = await tatumAxios.post('/ledger/account', data)
        console.log(response)
        const result = response.data
        const deposit = await this.generate_Address(result.id)

        const newWallet = await prisma.wallet.create({
            data:{
                id: result.id,
                currencyId,
                userId,
                depositAddress: deposit.address,
                derivationKey: deposit.derivationKey,
                Tatum_customerId: result.customerId,
                accountingCurrency: result.accountingCurrency,
                frozen: result.frozen
            }
        })

        return newWallet
    }
    private create_USDC_Arb_wallet = async(userId:string, currencyId:string)=>{
        const data = {
            currency: "USDC_ARB",
            xpub: config.USDC.ARBITRUM_XPUB,
            customer:{
               accountingCurrency: "USD",
               externalId: userId
            }
        };
        const response = await tatumAxios.post('/ledger/account', data)
        console.log(response)
        const result = response.data
        const deposit = await this.generate_Address(result.id)

        const newWallet = await prisma.wallet.create({
            data:{
                id: result.id,
                currencyId,
                userId,
                depositAddress: deposit.address,
                derivationKey: deposit.derivationKey,
                Tatum_customerId: result.customerId,
                accountingCurrency: result.accountingCurrency,
                frozen: result.frozen
            }
        })

        return newWallet
    }
    private create_USDC_OP_wallet = async(userId:string, currencyId:string)=>{
        const data = {
            currency: "USDC_OP",
            xpub: config.USDC.OPTIMISM_XPUB,
            customer:{
               accountingCurrency: "USD",
               externalId: userId
            }
        };
        const response = await tatumAxios.post('/ledger/account', data)
        console.log(response)
        const result = response.data
        const deposit = await this.generate_Address(result.id)

        const newWallet = await prisma.wallet.create({
            data:{
                id: result.id,
                currencyId,
                userId,
                depositAddress: deposit.address,
                derivationKey: deposit.derivationKey,
                Tatum_customerId: result.customerId,
                accountingCurrency: result.accountingCurrency,
                frozen: result.frozen
            }
        })

        return newWallet
    }

// USDT
    private create_TetherErc_wallet = async(userId:string, currencyId:string)=>{
        const data = {
            currency: "USDT",
            xpub: config.USDT.ETH_XPUB,
            customer:{
               accountingCurrency: "USD",
               externalId: userId
            }
        };
        const response = await tatumAxios.post('/ledger/account', data)
        console.log(response)
        const result = response.data
        const deposit = await this.generate_Address(result.id)

        const newWallet = await prisma.wallet.create({
            data:{
                id: result.id,
                currencyId,
                userId,
                depositAddress: deposit.address,
                derivationKey: deposit.derivationKey,
                Tatum_customerId: result.customerId,
                accountingCurrency: result.accountingCurrency,
                frozen: result.frozen
            }
        })

        return newWallet
    }
    private create_TetherTrc_wallet = async(userId:string, currencyId:string)=>{
        const data = {
            currency: "USDT_TRON",
            xpub: config.USDT.TRON_XPUB,
            customer:{
               accountingCurrency: "USD",
               externalId: userId
            }
        };
        const response = await tatumAxios.post('/ledger/account', data)
        console.log(response)
        const result = response.data
        const deposit = await this.generate_Address(result.id)

        const newWallet = await prisma.wallet.create({
            data:{
                id: result.id,
                currencyId,
                userId,
                depositAddress: deposit.address,
                derivationKey: deposit.derivationKey,
                Tatum_customerId: result.customerId,
                accountingCurrency: result.accountingCurrency,
                frozen: result.frozen
            }
        })

        return newWallet
    }
    private create_TetherBase_wallet = async(userId:string, currencyId:string)=>{
        const data = {
            currency: "USDT_BASE",
            xpub: config.USDT.BASE_XPUB,
            customer:{
               accountingCurrency: "USD",
               externalId: userId
            }
        };
        const response = await tatumAxios.post('/ledger/account', data)
        console.log(response)
        const result = response.data
        const deposit = await this.generate_Address(result.id)

        const newWallet = await prisma.wallet.create({
            data:{
                id: result.id,
                currencyId,
                userId,
                depositAddress: deposit.address,
                derivationKey: deposit.derivationKey,
                Tatum_customerId: result.customerId,
                accountingCurrency: result.accountingCurrency,
                frozen: result.frozen
            }
        })

        return newWallet
    }
    private create_TetherBSC_wallet = async(userId:string, currencyId:string)=>{
        const data = {
            currency: "USDT_BSC",
            xpub: config.USDT.BSC_XPUB,
            customer:{
               accountingCurrency: "USD",
               externalId: userId
            }
        };
        const response = await tatumAxios.post('/ledger/account', data)
        console.log(response)
        const result = response.data
        const deposit = await this.generate_Address(result.id)

        const newWallet = await prisma.wallet.create({
            data:{
                id: result.id,
                currencyId,
                userId,
                depositAddress: deposit.address,
                derivationKey: deposit.derivationKey,
                Tatum_customerId: result.customerId,
                accountingCurrency: result.accountingCurrency,
                frozen: result.frozen
            }
        })

        return newWallet
    }
    private create_TetherARB_wallet = async(userId:string, currencyId:string)=>{
        const data = {
            currency: "USDT_ARB",
            xpub: config.USDT.ARBITRUM_XPUB,
            customer:{
               accountingCurrency: "USD",
               externalId: userId
            }
        };
        const response = await tatumAxios.post('/ledger/account', data)
        console.log(response)
        const result = response.data
        const deposit = await this.generate_Address(result.id)

        const newWallet = await prisma.wallet.create({
            data:{
                id: result.id,
                currencyId,
                userId,
                depositAddress: deposit.address,
                derivationKey: deposit.derivationKey,
                Tatum_customerId: result.customerId,
                accountingCurrency: result.accountingCurrency,
                frozen: result.frozen
            }
        })

        return newWallet
    }
    private create_TetherOP_wallet = async(userId:string, currencyId:string)=>{
        const data = {
            currency: "USDT_OP",
            xpub: config.USDT.OPTIMISM_XPUB,
            customer:{
               accountingCurrency: "USD",
               externalId: userId
            }
        };
        const response = await tatumAxios.post('/ledger/account', data)
        console.log(response)
        const result = response.data
        const deposit = await this.generate_Address(result.id)

        const newWallet = await prisma.wallet.create({
            data:{
                id: result.id,
                currencyId,
                userId,
                depositAddress: deposit.address,
                derivationKey: deposit.derivationKey,
                Tatum_customerId: result.customerId,
                accountingCurrency: result.accountingCurrency,
                frozen: result.frozen
            }
        })

        return newWallet
    }



    async create_Tether_wallet(chain:string, userId:string, currencyId:string){
        let result;
        switch (chain) {

            case 'ETHEREUM':
             result = await this.create_TetherErc_wallet(userId, currencyId)
            return result
            break;

            case 'TRON':
             result = await this.create_TetherTrc_wallet(userId, currencyId)
            return result
            break;

            case 'BASE':
            result = await this.create_TetherBase_wallet(userId, currencyId)
            return result
            break;

            case 'BSC':
            result = await this.create_TetherBSC_wallet(userId, currencyId)
            return result
            break;

            case 'ARBITRUM':
            result = await this.create_TetherARB_wallet(userId, currencyId)
            return result
            break;

            case 'OPTIMISM':
            result = await this.create_TetherOP_wallet(userId, currencyId)
            return result
            break;

            default:
            return
        }

    }
    async create_USDC_wallet(chain:string, userId:string, currencyId:string){
        let result;
        switch (chain) {

            case 'ETHEREUM':
             result = await this.create_USDC_Eth_wallet(userId, currencyId)
            return result
            break;

            case 'POLYGON':
             result = await this.create_USDC_Matic_wallet(userId, currencyId)
            return result
            break;

            case 'BASE':
            result = await this.create_USDC_Base_wallet(userId, currencyId)
            return result
            break;

            case 'BSC':
            result = await this.create_USDC_BSC_wallet(userId, currencyId)
            return result
            break;

            case 'ARBITRUM':
            result = await this.create_USDC_Arb_wallet(userId, currencyId)
            return result
            break;

            case 'OPTIMISM':
            result = await this.create_USDC_OP_wallet(userId, currencyId)
            return result
            break;

            default:
            return
        }
    }

    async Transfer_Tether(payload:{
        chain:string, 
        userId:string, 
        walletId:string,
        amount: number,
        index: number,
        address: string
    }){
        const {chain, userId, walletId, amount, address, index } = payload

        let result;

        const transferPayload = {
            userId, 
            account_ID: walletId,
            address,
            index,
            amount,
        }

        switch (chain) {
            
            
            case 'ETHEREUM':
                result = await this.Transfer_USDT_ETH(transferPayload)
               return result
               break;
               case 'TRON':
                result = await this.Transfer_USDT_TRON(transferPayload)
               return result
               break;
   
               case 'BASE':
               result = await this.Transfer_USDT_BASE(transferPayload)
               return result
               break;
   
               case 'BSC':
               result = await this.Transfer_USDT_BSC(transferPayload)
               return result
               break;
   
               case 'ARBITRUM':
               result = await this.Transfer_USDT_ARB(transferPayload)
               return result
               break;
   
               case 'OPTIMISM':
               result = await this.Transfer_USDT_OP(transferPayload)
               return result
               break;

            default:
             return
        } 

    }

    async Transfer_USDC(payload:{
        chain:string, 
        userId:string, 
        walletId:string,
        amount: number,
        index: number,
        address: string
    }){
        const {chain, userId, walletId, amount, address, index } = payload

        let result;

        const transferPayload = {
            userId, 
            account_ID: walletId,
            address,
            index,
            amount,
        }

        switch (chain) {
            
            
            case 'ETHEREUM':
                result = await this.Transfer_USDC_ETH(transferPayload)
               return result
               break;
               case 'POLYGON':
                result = await this.Transfer_USDC_MATIC(transferPayload)
               return result
               break;
   
               case 'BASE':
               result = await this.Transfer_USDC_BASE(transferPayload)
               return result
               break;
   
               case 'BSC':
               result = await this.Transfer_USDC_BSC(transferPayload)
               return result
               break;
   
               case 'ARBITRUM':
               result = await this.Transfer_USDC_ARB(transferPayload)
               return result
               break;
   
               case 'OPTIMISM':
               result = await this.Transfer_USDC_OP(transferPayload)
               return result
               break;

            default:
             return
        } 

    }
    
}

export default new stableCoinService()