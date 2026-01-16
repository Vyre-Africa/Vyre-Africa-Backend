"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_config_1 = __importDefault(require("../config/prisma.config"));
const order_service_1 = __importDefault(require("../services/order.service"));
const wallet_service_1 = __importDefault(require("../services/wallet.service"));
const anon_service_1 = __importDefault(require("../services/anon.service"));
// import {Currency,walletType} from '@prisma/client';
const utils_1 = require("../utils");
const decimal_js_1 = __importDefault(require("decimal.js"));
const logger_1 = __importDefault(require("../config/logger"));
class OrderController {
    async createOrder(req, res) {
        const { user } = req;
        const { price, amount, type, pairId, minimumAmount } = req.body;
        console.log(price, amount, type, pairId);
        try {
            //  const userData = await prisma.user.findUnique({
            //     where: { id: user.id }
            //   })
            // fetch pair
            // check if user has both wallets
            // check the base currency balance of the user if its sufficient for the order
            // block the amount for the order
            // create the order using a prisma transaction
            const pair = await prisma_config_1.default.pair.findUnique({
                where: { id: pairId },
                include: {
                    quoteCurrency: {
                        select: {
                            id: true,
                            ISO: true
                        },
                    },
                    baseCurrency: {
                        select: {
                            id: true,
                            ISO: true
                        },
                    },
                    quoteWallet: true,
                    baseWallet: true,
                }
            });
            if (!pair) {
                return res.status(400)
                    .json({
                    msg: 'order pair does not exist',
                    success: false,
                });
            }
            console.log('pair', pair);
            const [baseWallet, quoteWallet] = await Promise.all([
                prisma_config_1.default.wallet.findFirst({
                    where: {
                        userId: user.id,
                        currencyId: pair?.baseCurrency?.id
                    }
                }),
                prisma_config_1.default.wallet.findFirst({
                    where: {
                        userId: user.id,
                        currencyId: pair?.quoteCurrency?.id
                    }
                })
            ]);
            if (!baseWallet || !quoteWallet) {
                return res.status(400)
                    .json({
                    msg: 'User wallets required does not exist',
                    success: false,
                });
            }
            // ✅ Quick balance check before queuing
            const amountDecimal = new decimal_js_1.default(amount);
            const walletToCheck = type === 'SELL' ? baseWallet : quoteWallet;
            const availableBalance = new decimal_js_1.default(walletToCheck.availableBalance);
            if (availableBalance.lessThan(amountDecimal)) {
                return res.status(400).json({
                    msg: `Insufficient ${type === 'SELL' ? 'base' : 'quote'} balance`,
                    success: false,
                });
            }
            // ✅ PHASE 2: Generate order ID immediately
            const orderId = (0, utils_1.generateOrderId)();
            // ✅ Queue the heavy work (transaction, blocking, etc.)
            await order_service_1.default.create_Order_Queue({
                orderId, // Pass the pre-generated ID
                userId: user.id,
                rate: parseFloat(price),
                amount: parseFloat(amount),
                orderType: type,
                pairId,
                minimumAmount: minimumAmount ? parseFloat(minimumAmount) : undefined,
                baseWallet,
                quoteWallet
            });
            return res
                .status(200)
                .json({
                msg: 'Order Created Successfully',
                success: true,
                order: {
                    id: orderId,
                    type: type,
                    amount: amount,
                    pair,
                    price: price,
                    status: 'PROCESSING', // Add status field
                    createdAt: new Date().toISOString()
                }
            });
        }
        catch (error) {
            console.log(error);
            return res.status(500).json({
                msg: 'Order creation unsuccessful',
                success: false
            });
        }
    }
    async processOrder(req, res) {
        const { user } = req;
        const { amount, orderId } = req.body;
        try {
            // ============================================
            // STEP 1: VALIDATE INPUT
            // ============================================
            if (!amount || !orderId) {
                return res.status(400).json({
                    msg: 'Amount and order ID are required',
                    success: false
                });
            }
            // ============================================
            // STEP 2: FETCH ORDER WITH PAIR DETAILS
            // ============================================
            const order = await prisma_config_1.default.order.findUnique({
                where: { id: orderId },
                include: {
                    pair: {
                        include: {
                            baseCurrency: { select: { id: true, ISO: true } },
                            quoteCurrency: { select: { id: true, ISO: true } }
                        }
                    }
                }
            });
            if (!order) {
                return res.status(404).json({
                    msg: 'Order not found',
                    success: false
                });
            }
            if (!order.pair) {
                return res.status(400).json({
                    msg: 'Order pair not found',
                    success: false
                });
            }
            // ============================================
            // STEP 3: VALIDATE MINIMUM AMOUNT WITH DECIMAL
            // ============================================
            const amountDecimal = new decimal_js_1.default(amount);
            const minimumAmountDecimal = new decimal_js_1.default(order.amountMinimum);
            // ✅ Use Decimal's lessThan method for precise comparison
            if (amountDecimal.lessThan(minimumAmountDecimal)) {
                return res.status(400).json({
                    msg: `Minimum order amount is ${minimumAmountDecimal.toString()} ${order.pair?.baseCurrency?.ISO}`,
                    success: false
                });
            }
            // ============================================
            // STEP 4: FETCH USER WALLETS (PARALLEL)
            // ============================================
            const [userBaseWallet, userQuoteWallet] = await Promise.all([
                prisma_config_1.default.wallet.findFirst({
                    where: {
                        currencyId: order.pair?.baseCurrency?.id,
                        userId: user.id
                    }
                }),
                prisma_config_1.default.wallet.findFirst({
                    where: {
                        currencyId: order.pair?.quoteCurrency?.id,
                        userId: user.id
                    }
                })
            ]);
            if (!userBaseWallet || !userQuoteWallet) {
                return res.status(400).json({
                    msg: 'Required wallets not found. Please create wallets for this trading pair.',
                    success: false
                });
            }
            // Execute instant order
            const result = await order_service_1.default.instantOrder({
                orderId,
                amount,
                userId: user.id,
                baseWallet: userBaseWallet,
                quoteWallet: userQuoteWallet
            });
            // ✅ Return based on result.success
            if (result.success) {
                return res.status(200).json({
                    msg: result.message,
                    success: true,
                    data: result.data
                });
            }
            else {
                return res.status(400).json({
                    msg: result.message,
                    success: false
                });
            }
        }
        catch (error) {
            logger_1.default.error('Instant order action failed', {
                userId: user.id,
                error: error.message
            });
            return res.status(500).json({
                msg: 'An unexpected error occurred',
                success: false
            });
        }
    }
    async initiateAnonymous(req, res) {
        // const { user } = req;
        const { orderId, currencyId, amount, user, bank, crypto, paymentMethod } = req.body;
        try {
            const order = await prisma_config_1.default.order.findUnique({
                where: { id: orderId },
                select: {
                    id: true,
                    type: true
                }
            });
            if (!order) {
                return res.status(400)
                    .json({
                    msg: 'order not found',
                    success: false
                });
            }
            const currency = await prisma_config_1.default.currency.findUnique({
                where: { id: currencyId },
                select: {
                    id: true
                }
            });
            if (!currency) {
                return res.status(400)
                    .json({
                    msg: 'currency not found',
                    success: false
                });
            }
            if (order?.type === 'BUY' && (!bank.accountNumber || !bank.bankCode || !bank.recipient)) {
                return res.status(400)
                    .json({
                    msg: 'bank details required',
                    success: false
                });
            }
            if (order?.type === 'SELL' && !crypto.address) {
                return res.status(400)
                    .json({
                    msg: 'crypto details required',
                    success: false
                });
            }
            const transferDetails = await anon_service_1.default.preActions({
                orderId,
                currencyId,
                amount,
                userDetails: user,
                paymentMethod,
                bank: {
                    accountNumber: bank.accountNumber,
                    bank_code: bank.bankCode,
                    recipient: bank.recipient
                },
                crypto: {
                    address: crypto.address
                    // chain: crypto.chain
                },
            });
            return res
                .status(200)
                .json({
                msg: 'Order initialization Successful',
                success: true,
                details: transferDetails
            });
        }
        catch (error) {
            console.log(error);
            return res.status(500).send({ msg: 'Initialisation failed', success: false, error });
        }
    }
    async getRatebyPair(req, res) {
        const { pairId } = req.query;
        try {
            console.log('query', req.query);
            if (!pairId) {
                return res.status(400).json({
                    success: false,
                    msg: "Pair Id required."
                });
            }
            const pair = await prisma_config_1.default.pair.findUnique({
                where: { id: pairId },
                include: {
                    baseCurrency: true,
                    quoteCurrency: true
                }
            });
            if (!pair) {
                return res.status(400).json({
                    success: false,
                    msg: "Pair not found."
                });
            }
            const response = await wallet_service_1.default.getRate(pair?.baseCurrency?.ISO, pair?.quoteCurrency?.ISO);
            // let convertedAmount: any | undefined;
            return res
                .status(200)
                .json({
                msg: `rate fetched successfully`,
                success: true,
                rate: response
            });
        }
        catch (error) {
            console.log(error);
            res.status(500).send(error);
        }
    }
    async fetchOrder(req, res) {
        const orderId = req.params.id;
        if (!orderId) {
            return res.status(400)
                .json({
                msg: 'order Id required',
                success: false,
            });
        }
        try {
            const order = await prisma_config_1.default.order.findUnique({
                where: {
                    id: orderId
                },
                select: {
                    id: true,
                    type: true,
                    user: {
                        select: {
                            firstName: true,
                            lastName: true,
                            photoUrl: true,
                        }
                    },
                    pair: {
                        select: {
                            name: true,
                            baseCurrency: {
                                select: {
                                    id: true,
                                    type: true,
                                    name: true,
                                    ISO: true,
                                    chain: true,
                                    imgUrl: true,
                                    chainImgUrl: true,
                                    flagEmoji: true
                                }
                            },
                            quoteCurrency: {
                                select: {
                                    id: true,
                                    type: true,
                                    name: true,
                                    ISO: true,
                                    chain: true,
                                    imgUrl: true,
                                    chainImgUrl: true,
                                    flagEmoji: true
                                }
                            }
                        }
                    },
                    amount: true,
                    amountProcessed: true, // Amount of the order that has been filled
                    amountMinimum: true,
                    percentageProcessed: true, // Percentage of the order that has been filled
                    price: true,
                    status: true,
                    createdAt: true
                },
            });
            return res
                .status(200)
                .json({
                msg: 'Successful',
                success: true,
                order: { ...order, paymentMethods: (0, utils_1.getPaymentSystems)(order?.pair?.quoteCurrency?.ISO) },
            });
        }
        catch (error) {
            console.error(error);
            return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
        }
    }
    async cancelOrder(req, res) {
        const { user } = req;
        const orderId = req.params.id;
        if (!orderId) {
            return res.status(400)
                .json({
                msg: 'order Id required',
                success: false,
            });
        }
        try {
            const order = await prisma_config_1.default.order.findUnique({
                where: {
                    id: orderId
                },
                select: {
                    id: true,
                    type: true,
                    amount: true
                },
            });
            if (!order) {
                return res.status(400)
                    .json({
                    msg: 'order not found',
                    success: false,
                });
            }
            const pendingOrders = await prisma_config_1.default.awaiting.findMany({
                where: {
                    orderId: order.id,
                    status: {
                        in: ['PENDING', 'PROCESSING']
                    }
                }
            });
            if (pendingOrders.length) {
                return res.status(400).json({
                    msg: 'Pending order exists',
                    success: false,
                    data: pendingOrders // optional: include the pending orders in response
                });
            }
            const canceledOrder = await order_service_1.default.cancelOrder({ orderId, userId: user.id });
            return res
                .status(200)
                .json({
                msg: 'Successful',
                success: true,
                order: canceledOrder,
            });
        }
        catch (error) {
            console.error(error);
            return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
        }
    }
    async fetchOrders(req, res) {
        const { cursor, type, pairId, priceMin, priceMax } = req.query;
        console.log(req.query);
        try {
            // Build the where clause dynamically
            const whereClause = {
                ...(type && { type }),
                ...(pairId && { pairId }),
                ...((priceMin || priceMax) && {
                    price: {
                        ...(priceMin && { gte: parseFloat(priceMin) }),
                        ...(priceMax && { lte: parseFloat(priceMax) })
                    }
                }),
                status: 'OPEN'
            };
            const totalCount = await prisma_config_1.default.order.count({
                where: whereClause
            });
            const orders = await prisma_config_1.default.order.findMany({
                where: whereClause,
                select: {
                    id: true,
                    type: true,
                    user: {
                        select: {
                            firstName: true,
                            lastName: true,
                            photoUrl: true,
                        }
                    },
                    pair: {
                        select: {
                            name: true,
                            baseCurrency: {
                                select: {
                                    id: true,
                                    type: true,
                                    name: true,
                                    ISO: true,
                                    chain: true,
                                    imgUrl: true,
                                    chainImgUrl: true,
                                    isStablecoin: true,
                                    flagEmoji: true
                                }
                            },
                            quoteCurrency: {
                                select: {
                                    id: true,
                                    type: true,
                                    name: true,
                                    ISO: true,
                                    chain: true,
                                    imgUrl: true,
                                    chainImgUrl: true,
                                    isStablecoin: true,
                                    flagEmoji: true
                                }
                            }
                        }
                    },
                    amount: true,
                    amountProcessed: true,
                    percentageProcessed: true,
                    price: true,
                    status: true,
                    createdAt: true
                },
                skip: cursor ? 1 : 0, // Only skip if cursor is provided
                take: 20,
                ...(cursor && {
                    cursor: {
                        id: cursor
                    }
                }),
                orderBy: {
                    createdAt: 'desc' // Assuming you want newest orders first
                }
            });
            const newCursor = orders.length > 0 ? orders[orders.length - 1].id : null;
            return res.status(200).json({
                msg: 'Successful',
                success: true,
                totalCount: totalCount,
                cursor: newCursor,
                orders
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
    async fetch_user_orders(req, res) {
        const user = req.user;
        console.log(req.query);
        try {
            const orders = await prisma_config_1.default.order.findMany({
                where: { userId: user.id },
                select: {
                    id: true,
                    type: true,
                    user: {
                        select: {
                            firstName: true,
                            lastName: true,
                            photoUrl: true,
                        }
                    },
                    pair: {
                        select: {
                            name: true,
                            baseCurrency: {
                                select: {
                                    id: true,
                                    type: true,
                                    name: true,
                                    ISO: true,
                                    chain: true,
                                    imgUrl: true,
                                    chainImgUrl: true,
                                    isStablecoin: true,
                                    flagEmoji: true
                                }
                            },
                            quoteCurrency: {
                                select: {
                                    id: true,
                                    type: true,
                                    name: true,
                                    ISO: true,
                                    chain: true,
                                    imgUrl: true,
                                    chainImgUrl: true,
                                    isStablecoin: true,
                                    flagEmoji: true
                                }
                            }
                        }
                    },
                    amount: true,
                    amountProcessed: true,
                    percentageProcessed: true,
                    price: true,
                    status: true,
                    createdAt: true
                },
                orderBy: {
                    createdAt: 'desc' // Assuming you want newest orders first
                }
            });
            return res.status(200).json({
                msg: 'Successful',
                success: true,
                orders
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
    async fetchPairs(req, res) {
        // const { limit, page, type, pairId } = req.query;
        try {
            const totalCount = await prisma_config_1.default.order.count();
            // const itemLimit = (limit ? parseInt(limit as string) : 20) || 20;
            // console.log(limit)
            // const totalPages = Math.ceil(totalCount / itemLimit);
            // const currentPage = page ? Math.max(parseInt(page as string), 1) : 1;
            // const skip = (currentPage - 1) * itemLimit;
            const pairs = await prisma_config_1.default.pair.findMany({
                select: {
                    id: true,
                    name: true,
                    baseCurrency: {
                        select: {
                            id: true,
                            type: true,
                            name: true,
                            ISO: true,
                            chain: true,
                            imgUrl: true,
                            chainImgUrl: true,
                            isStablecoin: true,
                            flagEmoji: true
                        }
                    },
                    quoteCurrency: {
                        select: {
                            id: true,
                            type: true,
                            name: true,
                            ISO: true,
                            chain: true,
                            imgUrl: true,
                            chainImgUrl: true,
                            isStablecoin: true,
                            flagEmoji: true
                        }
                    }
                }
            });
            return res
                .status(200)
                .json({
                msg: 'Successful',
                success: true,
                totalCount: totalCount,
                pairs
            });
        }
        catch (error) {
            console.error(error);
            return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
        }
    }
    async fetchPairWallets(req, res) {
        const { user } = req;
        const { pairId } = req.query;
        try {
            let baseWallet;
            let quoteWallet;
            const pair = await prisma_config_1.default.pair.findFirst({
                where: { id: pairId },
                include: {
                    baseCurrency: true,
                    quoteCurrency: true,
                }
            });
            if (!pair) {
                return res.status(400)
                    .json({
                    msg: 'pair not found',
                    success: false,
                });
            }
            baseWallet = await prisma_config_1.default.wallet.findFirst({
                where: {
                    userId: user.id,
                    currencyId: pair?.baseCurrency?.id
                },
                include: {
                    currency: true
                }
            });
            quoteWallet = await prisma_config_1.default.wallet.findFirst({
                where: {
                    userId: user.id,
                    currencyId: pair?.quoteCurrency?.id
                },
                include: {
                    currency: true
                }
            });
            if (!baseWallet) {
                return res.status(400)
                    .json({
                    msg: `please create your ${pair?.baseCurrency?.ISO} wallet`,
                    success: false,
                });
            }
            if (!quoteWallet) {
                return res.status(400)
                    .json({
                    msg: `please create your ${pair?.quoteCurrency?.ISO} wallet`,
                    success: false,
                });
            }
            baseWallet = await wallet_service_1.default.getAccount(baseWallet?.id);
            quoteWallet = await wallet_service_1.default.getAccount(quoteWallet?.id);
            // console.log('main wallet data', wallet)
            // console.log('Fetched wallets: ', wallet);
            return res
                .status(200)
                .json({
                msg: 'wallets fetched Successfully',
                success: true,
                baseWallet,
                quoteWallet
            });
        }
        catch (error) {
            console.log(error);
            return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
        }
    }
}
exports.default = new OrderController();
