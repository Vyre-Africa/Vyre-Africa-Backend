"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_config_1 = __importDefault(require("../config/prisma.config"));
const wallet_service_1 = __importDefault(require("../services/wallet.service"));
const utils_1 = require("../utils");
const account_service_1 = __importDefault(require("../services/account.service"));
const fern_service_1 = __importDefault(require("../services/fern.service"));
class SwapController {
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
    async addFiatAccount(req, res) {
        const { user } = req;
        const { accountNumber, accountName, bankId, type, bicSwift, routingNumber, sortCode, institutionNumber, bsbNumber, ifscCode, clabeNumber, cnapsCode, pixCode, clearingCode,
        // currency,
        // Address,
         } = req.body;
        try {
            console.log('bicSwift', bicSwift);
            console.log('routingNumber', routingNumber);
            console.log('accountName', accountName);
            if (!bankId || !type) {
                return res.status(400)
                    .json({
                    msg: 'Incomplete Details',
                    success: false,
                });
            }
            const userData = await prisma_config_1.default.user.findUnique({
                where: { id: user.id }
            });
            if (!userData) {
                return res.status(400)
                    .json({
                    msg: 'User not found',
                    success: false,
                });
            }
            const bank = await prisma_config_1.default.bank.findUnique({
                where: { id: bankId }
            });
            console.log(bank);
            if (!bank) {
                return res.status(400).json({
                    msg: 'bank not found',
                    success: false,
                });
            }
            const account = await fern_service_1.default.fiatAccount({
                userId: user.id,
                bankName: bank.name,
                accountNumber,
                accountName,
                currency: bank?.currency,
                bankAddress: {
                    country: (0, utils_1.getISOByCountry)(bank?.country),
                    addressLine1: bank?.address,
                    city: bank?.city,
                    state: bank?.state,
                    postalCode: bank?.postalCode,
                    locale: "en-US"
                },
                ...(bank?.currency === 'USD' && { routingNumber }),
                ...(bank?.currency === 'NGN' && { nubanNumber: accountNumber }),
                ...(bank?.currency === 'EUR' && { iban: accountNumber }),
                ...(bank?.currency === 'GBP' && { sortCode }),
                ...(bank?.currency === 'AUD' && { bsbNumber }),
                ...(bank?.currency === 'CAD' && { institutionNumber }),
                ...(bank?.currency === 'INR' && { ifscCode }),
                ...(bank?.currency === 'MXN' && { clabeNumber }),
                ...(bank?.currency === 'CNY' && { cnapsCode }),
                ...(bank?.currency === 'BRL' && { pixCode }),
                ...(bank?.currency === 'HKD' && { clearingCode }),
                ...(bicSwift && { bicSwift }),
                accountType: type,
                bankMethod: (0, utils_1.getPaymentMethodByCurrency)(bank?.currency) || '',
                isThirdParty: bank.country === userData?.country ? false : true
            });
            if (account) {
                const fiatAccount = await prisma_config_1.default.fiatAccount.create({
                    data: {
                        id: account.paymentAccountId,
                        name: account.nickname,
                        bank: account.externalBankAccount.bankName,
                        accountNumber: accountNumber || sortCode || bsbNumber || institutionNumber || ifscCode || clabeNumber || cnapsCode || pixCode || clearingCode,
                        currency: bank?.currency,
                        method: account.externalBankAccount.bankAccountPaymentMethod,
                        country: userData?.country,
                        userId: user.id
                    }
                });
            }
            return res
                .status(200)
                .json({
                msg: 'Account Added Successfully',
                success: true,
                account
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
    async addCryptoAccount(req, res) {
        const { user } = req;
        const { currency, chain, address } = req.body;
        try {
            if (!chain || !address) {
                return res.status(400)
                    .json({
                    msg: 'Incomplete Details',
                    success: false,
                });
            }
            const userData = await prisma_config_1.default.user.findUnique({
                where: { id: user.id }
            });
            if (!userData) {
                return res.status(400)
                    .json({
                    msg: 'User not found',
                    success: false,
                });
            }
            const account = await fern_service_1.default.cryptoAccount({
                userId: user.id,
                chain,
                address
            });
            if (account) {
                await prisma_config_1.default.cryptoAccount.create({
                    data: {
                        id: account.paymentAccountId,
                        name: `${currency} ${account.nickname}`,
                        cryptoWalletType: account.externalCryptoWallet.cryptoWalletType,
                        chain: account.externalCryptoWallet.chain,
                        address: account.externalCryptoWallet.address,
                        userId: user.id
                    }
                });
            }
            return res
                .status(200)
                .json({
                msg: 'Account Linked Successfully',
                success: true,
                account
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
    async generateQuote(req, res) {
        const { user } = req;
        const { destination, source } = req.body;
        try {
            const userData = await prisma_config_1.default.user.findUnique({
                where: { id: user.id }
            });
            if (!userData) {
                return res.status(400)
                    .json({
                    msg: 'User not found',
                    success: false
                });
            }
            // const fromCurrency = source.sourceType === 'CRYPTO' 
            // ? source.sourceCurrency 
            // : 'USD';
            // const toCurrency = source.sourceType === 'CRYPTO' 
            // ? 'USD' 
            // : source.sourceCurrency;
            const rate = await wallet_service_1.default.getRate(source.sourceCurrency, 'USD');
            // Calculate 4.5% of the 
            // const fee = (rate.value * source.sourceAmount * 0.045).toFixed(2);
            const fee = (0, utils_1.calculateFee)(rate.value * source.sourceAmount);
            console.log('my rate', rate.value);
            console.log('my fee', fee);
            if (Number(fee) < 0.3) {
                return res
                    .status(400)
                    .json({
                    msg: 'Amount below minimum',
                    success: false
                });
            }
            const quote = await fern_service_1.default.generateQuote({
                customerId: userData?.fernUserId,
                source,
                destination,
                developerFee: {
                    developerFeeType: "USD",
                    developerFeeAmount: `${fee}`
                }
            });
            if (quote) {
                return res
                    .status(200)
                    .json({
                    msg: 'Quote generated Successfully',
                    success: true,
                    quote,
                    fee
                });
            }
            else {
                return res
                    .status(400)
                    .json({
                    msg: 'operation failed',
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
    async initiateSwap(req, res) {
        const { user } = req;
        const { quoteId } = req.body;
        try {
            // if(!chain || !address){
            //   return res.status(400)
            //   .json({
            //     msg: 'Incomplete Details',
            //     success: false,
            //   });
            // }
            const userData = await prisma_config_1.default.user.findUnique({
                where: { id: user.id }
            });
            if (!userData) {
                return res.status(400)
                    .json({
                    msg: 'User not found',
                    success: false
                });
            }
            const transaction = await fern_service_1.default.initTransaction({ quoteId });
            if (transaction) {
                await prisma_config_1.default.swap.create({
                    data: {
                        id: transaction.transactionId,
                        userId: userData?.id,
                        status: transaction.transactionStatus,
                        sourceCurrency: transaction.source?.sourceCurrency?.label,
                        destinationCurrency: transaction?.destination?.destinationCurrency?.label,
                        rate: parseFloat(transaction?.destination?.exchangeRate),
                        sourceAmount: parseFloat(transaction?.source?.sourceAmount),
                        destinationAmount: parseFloat(transaction?.destination?.destinationAmount),
                        fee: parseFloat(transaction?.fees?.developerFee?.feeAmount) + parseFloat(transaction?.fees?.fernFee?.feeAmount)
                    }
                });
                return res
                    .status(200)
                    .json({
                    msg: 'transaction Initiated Successfully',
                    success: true,
                    transaction
                });
            }
            else {
                return res
                    .status(400)
                    .json({
                    msg: 'operation failed',
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
    async fetchSwaps(req, res) {
        const { currency } = req.query;
        const { user } = req;
        console.log(req.query);
        try {
            // Build the where clause dynamically
            const whereClause = {
                userId: user.id,
                ...(currency && { sourceCurrency: currency })
            };
            const totalCount = await prisma_config_1.default.swap.count({
                where: whereClause
            });
            const swaps = await prisma_config_1.default.swap.findMany({
                where: whereClause,
                take: 20,
                orderBy: {
                    createdAt: 'desc' // newest orders first
                }
            });
            return res.status(200).json({
                msg: 'Successful',
                success: true,
                totalCount,
                swaps
            });
        }
        catch (error) {
            console.error(error);
            return res.status(500).send({
                msg: 'Internal Server Error',
                success: false
            });
        }
    }
    async fetchSwap(req, res) {
        const { id } = req.params;
        console.log(req.query);
        if (!id) {
            return res.status(400)
                .json({
                msg: 'swap id is required',
                success: false,
            });
        }
        try {
            // Build the where clause dynamically
            const swap = await prisma_config_1.default.swap.findUnique({
                where: { id }
            });
            if (!swap) {
                return res.status(404)
                    .json({
                    msg: 'transaction not found',
                    success: false,
                });
            }
            const result = await fern_service_1.default.getTransaction(swap?.id);
            await prisma_config_1.default.swap.update({
                where: { id: swap?.id },
                data: { status: result?.transactionStatus }
            });
            return res.status(200).json({
                msg: 'Successful',
                success: true,
                transaction: result
            });
        }
        catch (error) {
            console.error(error);
            return res.status(500).send({
                msg: 'Internal Server Error',
                success: false
            });
        }
    }
    async getLinkedAccounts(req, res) {
        const { type } = req.query;
        const { user } = req;
        try {
            console.log('query', req.query);
            let Accounts;
            if (!type) {
                return res.status(400)
                    .json({
                    msg: 'Account type required',
                    success: false,
                });
            }
            if (type && type == 'FIAT') {
                Accounts = await prisma_config_1.default.fiatAccount.findMany({
                    where: { userId: user.id }
                });
            }
            if (type && type == 'CRYPTO') {
                Accounts = await prisma_config_1.default.cryptoAccount.findMany({
                    where: { userId: user.id }
                });
            }
            return res
                .status(200)
                .json({
                msg: `Accounts fetched successfully`,
                success: true,
                accounts: Accounts,
            });
        }
        catch (error) {
            console.log(error);
            res.status(500).send(error);
        }
    }
    async deletePaymentAccount(req, res) {
        const user = req.user;
        const accountId = req.params.accountId;
        try {
            const success = await account_service_1.default.deleteAccountById(accountId);
            if (!success) {
                return res.status(400).json({
                    msg: 'Operation not successful',
                    success: false
                });
            }
            return res.status(201).json({
                msg: 'Payment Account deleted',
                success: true,
            });
        }
        catch (error) {
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }
    // async init_BankDeposit(req: Request & Record<string, any>, res: Response) {
    //   const { user } = req;
    //   const {currency,amount} = req.body
    //   if(!currency || !amount){
    //     return res.status(400)
    //       .json({
    //         msg: 'required details missing',
    //         success: false,
    //       });
    //   }
    //   try {
    //     const userData = await prisma.user.findUnique({
    //       where: { id: user.id }
    //     })
    //     const wallet = await prisma.wallet.findFirst({
    //       where:{
    //         userId:userData?.id,
    //         currency
    //       }
    //     })
    //     const payment = await walletService.depositFiat
    //     (
    //       currency,
    //       amount,
    //       userData?.email!,
    //       userData?.id!, 
    //       wallet?.id!
    //     )
    //     return res
    //       .status(200)
    //       .json({
    //         msg: 'Deposit initiated Successfully',
    //         success: true,
    //         payment
    //       });
    //   } catch (error) {
    //     console.log(error)
    //     res.status(500)
    //       .json({
    //         msg: 'Internal Server Error',
    //         success: false,
    //       });
    //   }
    // }
    async authorize_fiat_Withdrawal(req, res) {
        const { user } = req;
        const { currency, amount } = req.body;
        console.log(req.body);
        if (!currency || !amount) {
            return res.status(400)
                .json({
                msg: 'required details missing',
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
                    currency
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
            const payUrl = await wallet_service_1.default.authorize_Withdrawal(currency, amount, userData?.email, userData?.phoneNumber);
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
}
exports.default = new SwapController();
