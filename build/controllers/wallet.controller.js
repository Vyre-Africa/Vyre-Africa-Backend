"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_config_1 = __importDefault(require("../config/prisma.config"));
const wallet_service_1 = __importDefault(require("../services/wallet.service"));
const decimal_js_1 = __importDefault(require("decimal.js"));
const transaction_service_1 = __importDefault(require("../services/transaction.service"));
class WalletController {
    async getRate(req, res) {
        const { currency, basePair, amount } = req.query;
        try {
            console.log('query', req.query);
            if (!currency || !basePair) {
                return res.status(400).json({
                    success: false,
                    msg: "Currency and basePair are required query parameters."
                });
            }
            const response = await wallet_service_1.default.getRate(currency, basePair);
            let convertedAmount;
            if (amount && !isNaN(Number(amount))) {
                convertedAmount = (Number(amount) * response.value).toFixed(2);
            }
            return res
                .status(200)
                .json({
                msg: `rate fetched successfully`,
                success: true,
                rate: response,
                value: convertedAmount
            });
        }
        catch (error) {
            console.log(error);
            res.status(500).send(error);
        }
    }
    async createWallet(req, res) {
        const { user } = req;
        const currencyId = req.params.currencyId;
        try {
            const currency = await prisma_config_1.default.currency.findUnique({
                where: { id: currencyId }
            });
            if (!currency) {
                return res.status(400)
                    .json({
                    msg: `currency not found`,
                    success: false,
                });
            }
            // const walletExists = await prisma.wallet.findFirst({
            //   where: { 
            //     userId: user.id,
            //     currencyId
            //   }
            // })
            // if(walletExists){
            //   return res.status(400)
            //     .json({
            //       msg: `${currency?.name} wallet already exists`,
            //       success: false,
            //     });
            // }
            const result = await wallet_service_1.default.createWallet({
                userId: user.id,
                currencyId: currency.id
            });
            return res
                .status(200)
                .json({
                msg: 'Wallet created Successfully',
                success: true,
                wallet: result
            });
        }
        catch (error) {
            console.log(error);
            res.status(500)
                .json({
                msg: 'Internal Server Error',
                success: false,
            });
        }
    }
    async init_BankDeposit(req, res) {
        const { user } = req;
        const { currencyId, amount } = req.body;
        if (!currencyId || !amount) {
            return res.status(400)
                .json({
                msg: 'required details missing',
                success: false,
            });
        }
        const currency = await prisma_config_1.default.currency.findUnique({
            where: { id: currencyId }
        });
        if (!currency) {
            return res.status(400)
                .json({
                msg: `currency not found`,
                success: false,
            });
        }
        try {
            const userData = await prisma_config_1.default.user.findUnique({
                where: { id: user.id }
            });
            const wallet = await prisma_config_1.default.wallet.findFirst({
                where: {
                    userId: userData?.id,
                    currencyId
                }
            });
            const payment = await wallet_service_1.default.depositFiat({
                currency: currency.ISO,
                amount,
                email: userData?.email,
                userId: userData?.id,
                walletId: wallet?.id
            });
            return res
                .status(200)
                .json({
                msg: 'Deposit initiated Successfully',
                success: true,
                payment
            });
        }
        catch (error) {
            console.log(error);
            res.status(500)
                .json({
                msg: 'Internal Server Error',
                success: false,
            });
        }
    }
    async authorize_fiat_Withdrawal(req, res) {
        const { user } = req;
        const { currencyId, amount } = req.body;
        console.log(req.body);
        if (!currencyId || !amount) {
            return res.status(400)
                .json({
                msg: 'required details missing',
                success: false,
            });
        }
        const currency = await prisma_config_1.default.currency.findUnique({
            where: { id: currencyId }
        });
        if (!currency) {
            return res.status(400)
                .json({
                msg: `currency not found`,
                success: false,
            });
        }
        try {
            const userData = await prisma_config_1.default.user.findUnique({
                where: { id: user.id }
            });
            const walletExists = await prisma_config_1.default.wallet.findFirst({
                where: {
                    userId: user.id,
                    currencyId
                }
            });
            if (!walletExists) {
                return res.status(400)
                    .json({
                    msg: 'User wallet does not exist',
                    success: false,
                });
            }
            if (amount > walletExists.availableBalance) {
                return res.status(400)
                    .json({
                    msg: 'Available balance not sufficient',
                    success: false,
                });
            }
            const payUrl = await wallet_service_1.default.authorize_Withdrawal(currency.ISO, amount, userData?.email, userData?.phoneNumber);
            if (payUrl) {
                return res
                    .status(200)
                    .json({
                    msg: 'Authorised Successfully',
                    success: true,
                    url: payUrl
                });
            }
            else {
                return res
                    .status(400)
                    .json({
                    msg: 'Operation Failed',
                    success: false,
                });
            }
        }
        catch (error) {
            console.log(error);
            res.status(500)
                .json({
                msg: 'Internal Server Error',
                success: false,
            });
        }
    }
    async init_VyreTransfer(req, res) {
        const { user } = req;
        const { amount, currencyId, receipient_id } = req.body;
        try {
            const currency = await prisma_config_1.default.currency.findUnique({
                where: { id: currencyId }
            });
            if (!currency) {
                return res.status(400)
                    .json({
                    msg: `currency not found`,
                    success: false,
                });
            }
            const walletExists = await prisma_config_1.default.wallet.findFirst({
                where: {
                    userId: user.id,
                    currencyId
                }
            });
            if (!walletExists) {
                return res.status(400)
                    .json({
                    msg: 'User wallet does not exist',
                    success: false,
                });
            }
            // ✅ Convert amount to Decimal immediately
            const amountDecimal = new decimal_js_1.default(amount);
            // ✅ Check balance with Decimal comparison
            const availableBalance = new decimal_js_1.default(walletExists.availableBalance);
            if (availableBalance.lessThan(amountDecimal)) {
                return res.status(400)
                    .json({
                    msg: 'Available balance not sufficient',
                    success: false,
                });
            }
            // const result = await walletService.offchain_Transfer
            // ({
            //   userId: user.id,
            //   receipientId: receipient_id,
            //   currencyId: currencyId,
            //   amount
            // })
            await wallet_service_1.default.queue({
                userId: user.id,
                receipientId: receipient_id,
                currencyId: currencyId,
                amount,
                type: 'OFFCHAIN'
            });
            return res
                .status(200)
                .json({
                msg: 'Transfer Successful',
                success: true
                // wallet:result
            });
        }
        catch (error) {
            console.log(error);
            res.status(500)
                .json({
                msg: 'Internal Server Error',
                success: false,
            });
        }
    }
    async init_BlockchainTransfer(req, res) {
        const { user } = req;
        const { amount, currencyId, address, destinationTag } = req.body;
        try {
            const currency = await prisma_config_1.default.currency.findUnique({
                where: { id: currencyId }
            });
            if (!currency) {
                return res.status(400)
                    .json({
                    msg: `currency not valid`,
                    success: false,
                });
            }
            const walletExists = await prisma_config_1.default.wallet.findFirst({
                where: {
                    userId: user.id,
                    currencyId
                }
            });
            if (!walletExists) {
                return res.status(400)
                    .json({
                    msg: 'User wallet does not exist',
                    success: false,
                });
            }
            // ✅ Convert amount to Decimal immediately
            const amountDecimal = new decimal_js_1.default(amount);
            // ✅ Check balance with Decimal comparison
            const availableBalance = new decimal_js_1.default(walletExists.availableBalance);
            if (availableBalance.lessThan(amountDecimal)) {
                return res.status(400)
                    .json({
                    msg: 'Available balance not sufficient',
                    success: false,
                });
            }
            if (currency.ISO === 'XRP' && !destinationTag) {
                return res.status(400)
                    .json({
                    msg: 'destination_Tag required for ripple widthdrawal',
                    success: false,
                });
            }
            // Handle crypto withdrawal logic here
            // const result = await walletService.blockchain_Transfer
            // ({
            //   userId: user.id, 
            //   currencyId: currency.id,
            //   amount: amount,
            //   address: address,
            //   destination_Tag: destinationTag
            // })
            await wallet_service_1.default.queue({
                userId: user.id,
                currencyId: currency.id,
                amount: amount,
                address: address,
                destination_Tag: destinationTag,
                type: 'BLOCKCHAIN'
            });
            return res
                .status(200)
                .json({
                msg: 'Transfer Initiated',
                success: true
                // wallet:result
            });
        }
        catch (error) {
            console.log(error);
            res.status(500)
                .json({
                msg: 'Internal Server Error',
                success: false,
            });
        }
    }
    async init_BankTransfer(req, res) {
        const { user } = req;
        const { account_number, bank_code, recipient_name, endpoint_url } = req.body;
        try {
            const result = await wallet_service_1.default.bank_Transfer({
                account_number,
                bank_code,
                recipient_name: recipient_name,
                endpoint: endpoint_url
            });
            // await walletService.queue({
            //   account_number,
            //   bank_code,
            //   recipient_name: recipient_name,
            //   endpoint: endpoint_url,
            //   type:'BANK'
            // })
            return res
                .status(200)
                .json({
                msg: 'Transfer Initiated',
                success: true,
                result
            });
        }
        catch (error) {
            console.log(error);
            res.status(500)
                .json({
                msg: 'Internal Server Error',
                success: false,
            });
        }
    }
    // async withdrawal(req: Request & Record<string, any>, res: Response) {
    //   const { user } = req;
    //   const {
    //     TRANSFER_TYPE,
    //     AMOUNT,
    //     CURRENCY,
    //     RECEIPIENT_ID,
    //     BLOCKCHAIN,
    //     BANK,
    //     bank_Account_Number, 
    //     bank
    //   } = req.body;
    //   try {
    //     const walletExists = await prisma.wallet.findFirst({
    //       where: { 
    //         userId: user.id,
    //         currency: CURRENCY
    //       }
    //     })
    //     if(!walletExists){
    //       return res.status(400)
    //         .json({
    //           msg: 'User wallet does not exist',
    //           success: false,
    //         });
    //     }
    //     if(AMOUNT > walletExists.availableBalance){
    //       return res.status(400)
    //         .json({
    //           msg: 'Available balance not sufficient',
    //           success: false,
    //         });
    //     }
    //     if ( TRANSFER_TYPE == 'VYRE') {
    //       // offchain transfer
    //       if (!blockchain_Address) {
    //         return res.status(400)
    //         .json({
    //           msg: 'Blockchain address is required for crypto withdrawals',
    //           success: false,
    //         });
    //       }
    //       if(CURRENCY === 'XRP' && !destination_Tag){
    //         return res.status(400)
    //         .json({
    //           msg: 'destination_Tag required for ripple widthdrawal',
    //           success: false,
    //         });
    //       }
    //       // Handle crypto withdrawal logic here
    //       const result = await walletService.blockchain_Transfer
    //       (
    //         user.id,
    //         CURRENCY,
    //         AMOUNT,
    //         blockchain_Address,
    //         destination_Tag
    //       )
    //       return res
    //       .status(200)
    //       .json({
    //         msg: 'Withdrawal Initiated',
    //         success: true,
    //         wallet:result
    //       });
    //     }
    //     if (walletExists.type === 'CRYPTO' && TRANSFER_TYPE == 'BLOCKCHAIN') {
    //       // Crypto withdrawal
    //       if (!BLOCKCHAIN.address) {
    //         return res.status(400)
    //         .json({
    //           msg: 'Blockchain address is required for crypto withdrawals',
    //           success: false,
    //         });
    //       }
    //       if(CURRENCY === 'XRP' && !BLOCKCHAIN.destinationTag){
    //         return res.status(400)
    //         .json({
    //           msg: 'destination_Tag required for ripple widthdrawal',
    //           success: false,
    //         });
    //       }
    //       // Handle crypto withdrawal logic here
    //       const result = await walletService.blockchain_Transfer
    //       (
    //         user.id,
    //         CURRENCY,
    //         AMOUNT,
    //         BLOCKCHAIN.address,
    //         BLOCKCHAIN.destinationTag
    //       )
    //       return res
    //       .status(200)
    //       .json({
    //         msg: 'Withdrawal Initiated',
    //         success: true,
    //         wallet:result
    //       });
    //     }
    //     if (walletExists.type === 'FIAT' && TRANSFER_TYPE == 'BANK') {
    //       // Fiat withdrawal
    //       if (!bank_Account_Number || !bank) {
    //         return res.status(400)
    //         .json({
    //           msg: 'Bank account number and bank name are required for fiat withdrawals',
    //           success: false,
    //         });
    //       }
    //     }
    //       // Handle fiat withdrawal logic here
    //     // } else {
    //     //   return res.status(400).json({ error: 'Invalid withdrawal type' });
    //     // }
    //     // return res
    //     //   .status(200)
    //     //   .json({
    //     //     msg: 'Wallet created Successfully',
    //     //     success: true,
    //     //     wallet:result
    //     //   });
    //   } catch (error) {
    //     console.log(error)
    //     res.status(500)
    //       .json({
    //         msg: 'Internal Server Error',
    //         success: false,
    //       });
    //   }
    // }
    async fetchPortfolio(req, res) {
        const { user } = req;
        try {
            const userPortfolio = await wallet_service_1.default.aggregateAllWallets(user.id, 'NGN');
            console.log('user portfolio', userPortfolio);
            return res
                .status(200)
                .json({
                msg: 'wallets fetched Successfully',
                success: true,
                data: userPortfolio
            });
        }
        catch (error) {
            console.log(error);
            return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
        }
    }
    async fetchWallets(req, res) {
        const { user } = req;
        const { type } = req.query;
        let wallets;
        try {
            if (type) {
                wallets = await prisma_config_1.default.wallet.findMany({
                    where: {
                        userId: user.id,
                        currency: {
                            type: type // This assumes 'type' is a variable containing the currency type you're filtering by
                        }
                    },
                    include: {
                        currency: true // Optionally include the full currency data in the response
                    }
                });
            }
            else {
                wallets = await prisma_config_1.default.wallet.findMany({
                    where: {
                        userId: user.id
                    },
                    include: {
                        currency: true // Optionally include the full currency data in the response
                    }
                });
            }
            console.log('Fetched wallets: ', wallets);
            return res
                .status(200)
                .json({
                msg: 'wallets fetched Successfully',
                success: true,
                wallets
            });
        }
        catch (error) {
            console.log(error);
            return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
        }
    }
    async fetchWallet(req, res) {
        const { user } = req;
        const walletId = req.params.id;
        try {
            const wallet = await wallet_service_1.default.getAccount(walletId);
            console.log('main wallet data', wallet);
            //  const wallet = await prisma.wallet.findUnique({
            //     where: {
            //       id: walletId
            //     }
            //   });
            // const wallet = await prisma.wallet.update({
            //   where: {
            //     id: walletId
            //   },
            //   data:{
            //     frozen: result.frozen,
            //     accountBalance:result.balance.accountBalance,
            //     availableBalance:result.balance.availableBalance
            //   }
            // });
            console.log('Fetched wallets: ', wallet);
            let Balance_rate;
            let Available_Balance_rate;
            if (wallet?.currency?.type === 'CRYPTO') {
                const response = await wallet_service_1.default.getRate(wallet?.currency?.ISO, 'NGN');
                Balance_rate = `${wallet.accountingCurrency} ${(Number(wallet?.accountBalance) * response.value).toFixed(2)}`;
                Available_Balance_rate = `${wallet.accountingCurrency} ${(Number(wallet?.availableBalance) * response.value).toFixed(2)}`;
            }
            return res
                .status(200)
                .json({
                msg: 'wallet fetched Successfully',
                success: true,
                wallet,
                rate: {
                    balance: Balance_rate,
                    available: Available_Balance_rate
                }
            });
        }
        catch (error) {
            console.log(error);
            return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
        }
    }
    async fetchWalletByName(req, res) {
        const { user } = req;
        const name = req.params.name;
        try {
            let wallet;
            const currency = await prisma_config_1.default.currency.findFirst({
                where: {
                    ISO: name
                }
            });
            if (!currency) {
                return res.status(400)
                    .json({
                    msg: 'currency not found',
                    success: false,
                });
            }
            wallet = await prisma_config_1.default.wallet.findFirst({
                where: {
                    userId: user.id,
                    currencyId: currency.id
                }
            });
            if (!wallet) {
                return res.status(400)
                    .json({
                    msg: 'wallet not found',
                    success: false,
                });
            }
            wallet = await wallet_service_1.default.getAccount(wallet.id);
            console.log('main wallet data', wallet);
            console.log('Fetched wallets: ', wallet);
            let Balance_rate;
            let Available_Balance_rate;
            if (wallet?.type === 'CRYPTO') {
                const response = await wallet_service_1.default.getRate(wallet?.currency, 'NGN');
                Balance_rate = `${wallet.accountingCurrency} ${(Number(wallet?.accountBalance) * response.value).toFixed(2)}`;
                Available_Balance_rate = `${wallet.accountingCurrency} ${(Number(wallet?.availableBalance) * response.value).toFixed(2)}`;
            }
            return res
                .status(200)
                .json({
                msg: 'wallet fetched Successfully',
                success: true,
                wallet,
                rate: {
                    balance: Balance_rate,
                    available: Available_Balance_rate
                }
            });
        }
        catch (error) {
            console.log(error);
            return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
        }
    }
    async fetchTransactions(req, res) {
        const { user } = req;
        const { walletId } = req.query;
        let transactions;
        try {
            if (walletId) {
                transactions = await transaction_service_1.default.getwalletRecords(walletId, 20);
            }
            else {
                transactions = await transaction_service_1.default.getUserRecords(user.id, 20);
            }
            console.log('Fetched transactions: ', transactions);
            return res
                .status(200)
                .json({
                msg: 'transactions fetched Successfully',
                success: true,
                transactions
            });
        }
        catch (error) {
            console.log(error);
            return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
        }
    }
}
exports.default = new WalletController();
