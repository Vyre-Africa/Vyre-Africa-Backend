import { PrismaClient } from '@prisma/client';
import { Paystack } from 'paystack-sdk';
import { Request, Response } from 'express';
import prisma from '../config/prisma.client';
import orderService from '../services/order.service';
import walletService from '../services/wallet.service';
import paystackService from '../services/paystack.service';
import notificationService from '../services/notification.service';
import config from '../config/env.config';
import smsService from '../services/sms.service';
import mobilePushService from '../services/mobilePush.service';
import { subMinutes } from 'date-fns';
import anonService from '../services/anon.service';
// import {Currency,walletType} from '@prisma/client';
import { generateOrderId, amountSufficient, getPaymentSystems } from '../utils';
import { getMinimumOrderAmount, getMinimumOrderDescription } from '../config/minimum.config';
import Decimal from 'decimal.js';
import logger from '../config/logger';
import { checkKycLimit, toUsd } from '../services/kycLimits.service';


async function assertAnonKycLimit({
  email,
  order,
  amount,
}: {
  email:  string;
  order:  { type: string; price: any; pair?: { baseCurrency?: { ISO: string } | null; quoteCurrency?: { ISO: string } | null } | null };
  amount: string;
}): Promise<void> {
 
  const registeredUser = await prisma.user.findFirst({
    where: {
      realEmail:     email,
      isAnonymous:   false,
      isDeactivated: false,
    },
    select: { id: true, kycTier: true },
  });
 
  const kycTier = (() => {
    const t = Number(registeredUser?.kycTier ?? 0);
    return (t === 1 || t === 2 || t === 3 ? t : 0) as 0 | 1 | 2 | 3;
  })();
 
  const kycUserId = registeredUser?.id ?? null;
 
  const currencyIso = order.type === 'SELL'
    ? (order.pair?.quoteCurrency?.ISO ?? 'NGN')
    : (order.pair?.baseCurrency?.ISO  ?? 'USDC');
 
  const tradeAmountUsd = toUsd({
    amount:     parseFloat(amount),
    currencyIso,
    ratePerUsd: Number(order.price ?? 1),
  });
 
  const limitCheck = await checkKycLimit({
    userId:         kycUserId,
    kycTier,
    tradeAmountUsd,
  });
 
  if (!limitCheck.allowed) {
    throw Object.assign(new Error(limitCheck.reason ?? 'Trading limit exceeded'), {
      code: 'KYC_LIMIT_EXCEEDED',
      data: {
        code:            'KYC_LIMIT_EXCEEDED',
        kycTier,
        remainingUsd:    limitCheck.remainingUsd ?? null,
        limitUsd:        limitCheck.limitUsd     ?? null,
        usedUsd:         limitCheck.usedUsd      ?? null,
        upgradeRequired: kycTier < 3,
      }
    });
  }
}
 
async function assertRegisteredKycLimit({
  user,
  order,
  amount,
}: {
  user:   any;
  order:  any;
  amount: string;
}): Promise<void> {
 
  const currencyIso = order.type === 'SELL'
    ? (order.pair?.quoteCurrency?.ISO ?? 'NGN')
    : (order.pair?.baseCurrency?.ISO  ?? 'USDC');
 
  const tradeAmountUsd = toUsd({
    amount:     parseFloat(amount),
    currencyIso,
    ratePerUsd: Number(order.price ?? 1),
  });
 
  const limitCheck = await checkKycLimit({
    userId:         user.id,
    kycTier:        user.kycTier ?? 0,
    tradeAmountUsd,
  });
 
  if (!limitCheck.allowed) {
    throw Object.assign(new Error(limitCheck.reason ?? 'Trading limit exceeded'), {
      code: 'KYC_LIMIT_EXCEEDED',
      data: {
        code:            'KYC_LIMIT_EXCEEDED',
        kycTier:         user.kycTier ?? 0,
        remainingUsd:    limitCheck.remainingUsd ?? null,
        limitUsd:        limitCheck.limitUsd     ?? null,
        usedUsd:         limitCheck.usedUsd      ?? null,
        upgradeRequired: (user.kycTier ?? 0) < 3,
      }
    });
  }
}


class OrderController {


  async createOrder(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const { price, amount, type, pairId, minimumAmount } = req.body;
 
    console.log(price, amount, type, pairId)
 
    try {
 
      // Anonymous users can trade (counterparty) but not create orders
      if (user?.isAnonymous) {
          throw new Error('Anonymous users cannot create orders. Please create a Vyre account.');
      }
 
      // Must be an approved vendor to create orders
      if (!user?.isVendor) {
          const application = await prisma.vendorApplication.findUnique({
              where:  { userId: user.id },
              select: { status: true }
          });
 
          if (!application) {
              throw new Error('VENDOR_REQUIRED: You need to apply to become a vendor to create orders.');
          }
          if (application.status === 'PENDING') {
              throw new Error('VENDOR_PENDING: Your vendor application is under review. You will be notified once approved.');
          }
          if (application.status === 'REJECTED') {
              throw new Error('VENDOR_REJECTED: Your vendor application was not approved. Please reapply.');
          }
          if (application.status === 'SUSPENDED') {
              throw new Error('VENDOR_SUSPENDED: Your vendor account has been suspended. Please contact support.');
          }
 
          throw new Error('VENDOR_REQUIRED: You are not approved to create orders.');
      }
 
      // ── Guard against zero/missing price BEFORE any Decimal division ────────
      // Needed now that BUY orders convert amount → base-currency equivalent
      // using price. A zero/invalid price would otherwise throw inside Decimal
      // and surface as a confusing 500 instead of a clean 400.
      const priceDecimal = new Decimal(price ?? 0);
      if (priceDecimal.lessThanOrEqualTo(0)) {
        return res.status(400).json({
          msg: 'A valid price greater than zero is required',
          success: false,
        });
      }
 
      const pair = await prisma.pair.findUnique({
        where:{id: pairId},
        include:{
          quoteCurrency:{
            select:{
              id:true,
              ISO:true  
            },
          },
          baseCurrency:{
            select:{
              id:true,
              ISO:true  
            },
          },
          quoteWallet:true,
          baseWallet:true,
        }
      })
 
      if(!pair){
        return res.status(400)
          .json({
            msg: 'order pair does not exist',
            success: false,
          });
      }
 
      console.log('pair', pair)
 
      const [baseWallet, quoteWallet] = await Promise.all([
        prisma.wallet.findFirst({
          where: {
            userId: user.id,
            currencyId: pair?.baseCurrency?.id!
          }
        }),
        prisma.wallet.findFirst({
          where: {
            userId: user.id,
            currencyId: pair?.quoteCurrency?.id!
          }
        })
      ]);
 
      if(!baseWallet || !quoteWallet){
        return res.status(400)
          .json({
            msg: 'User wallets required does not exist',
            success: false,
          });
      }
 
      // ✅ Quick balance check before queuing — already correctly directional
      const amountDecimal = new Decimal(amount);
      const walletToCheck = type === 'SELL' ? baseWallet : quoteWallet;
      const availableBalance = new Decimal(walletToCheck.availableBalance);
 
      if (availableBalance.lessThan(amountDecimal)) {
        return res.status(400).json({
          msg: `Insufficient ${type === 'SELL' ? 'base' : 'quote'} balance`,
          success: false,
        });
      }
 
      // ✅ Get configured minimum for the base currency
      const configuredMinimum = getMinimumOrderAmount(pair.baseCurrency?.ISO as string);
 
      const userMinimum = minimumAmount ? new Decimal(minimumAmount) : new Decimal(0);
      const enforcedMinimum = Decimal.max(userMinimum, configuredMinimum);
 
      // ── Convert amountDecimal to its BASE-currency equivalent before
      // comparing against enforcedMinimum, which is always base-denominated.
      // SELL: amountDecimal is already base currency — no conversion.
      // BUY:  amountDecimal is quote currency (fiat) — divide by price to get
      //       the equivalent base-currency (crypto) exposure.
      const baseEquivalentAmount = type === 'SELL'
        ? amountDecimal
        : amountDecimal.dividedBy(priceDecimal);
 
      // ✅ Validate order amount meets minimum — now unit-consistent
      if (baseEquivalentAmount.lessThan(enforcedMinimum)) {
        const description = getMinimumOrderDescription(pair.baseCurrency?.ISO as string);
 
        return res.status(400).json({
          msg: `Order amount (${baseEquivalentAmount.toString()} ${pair.baseCurrency?.ISO as string} equivalent) is below minimum requirement of ${description}`,
          success: false
        });
      }
 
      // ✅ PHASE 2: Generate order ID immediately
      const orderId = generateOrderId();
 
      // ✅ Queue the heavy work (transaction, blocking, etc.)
      await orderService.create_Order_Queue({
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
 
    } catch (error) {
      console.log(error);
      return res.status(500).json({
        msg:`Order creation failed : ${error instanceof Error ? error.message : 'Unknown error'}`,
        success: false
      });
    }
  }

  async processOrder(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const { amount, orderId } = req.body;
  
    try {
  
      // ── STEP 1: Validate input ───────────────────────────────────────────────
      if (!amount || !orderId) {
        return res.status(400).json({ msg: 'Amount and order ID are required', success: false });
      }
  
      // ── STEP 2: Fetch order with pair details ────────────────────────────────
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
          pair: {
            include: {
              baseCurrency:  { select: { id: true, ISO: true } },
              quoteCurrency: { select: { id: true, ISO: true } }
            }
          }
        }
      });
  
      if (!order) {
        return res.status(404).json({ msg: 'Order not found', success: false });
      }
  
      if (order.userId === user.id) {
        return res.status(400).json({ msg: 'Self trade not allowed', success: false });
      }
  
      if (!order.pair) {
        return res.status(400).json({ msg: 'Order pair not found', success: false });
      }
  
      // ── STEP 3: Validate minimum amount ─────────────────────────────────────
      const amountDecimal = new Decimal(amount);
      const minimumAmountDecimal = new Decimal(order.amountMinimum);
  
      if (amountDecimal.lessThan(minimumAmountDecimal)) {
        return res.status(400).json({
          msg: `Minimum order amount is ${minimumAmountDecimal.toString()} ${order.pair?.baseCurrency?.ISO}`,
          success: false
        });
      }
  
      // ── STEP 4: KYC limit check ──────────────────────────────────────────────
      await assertRegisteredKycLimit({ user, order, amount });
  
      // ── STEP 5: Fetch user wallets ───────────────────────────────────────────
      const [userBaseWallet, userQuoteWallet] = await Promise.all([
        prisma.wallet.findFirst({
          where: { currencyId: order.pair?.baseCurrency?.id, userId: user.id }
        }),
        prisma.wallet.findFirst({
          where: { currencyId: order.pair?.quoteCurrency?.id, userId: user.id }
        })
      ]);
  
      if (!userBaseWallet || !userQuoteWallet) {
        return res.status(400).json({
          msg: 'Required wallets not found. Please create wallets for this trading pair.',
          success: false
        });
      }
  
      // ── STEP 6: Execute instant order ────────────────────────────────────────
      const result = await orderService.instantOrder({
        orderId,
        amount,
        userId:      user.id,
        baseWallet:  userBaseWallet,
        quoteWallet: userQuoteWallet
      });
  
      if (result.success) {
        return res.status(200).json({ msg: result.message, success: true, data: result.data });
      } else {
        return res.status(400).json({ msg: result.message, success: false });
      }
  
    } catch (error: any) {
  
      // Surface KYC limit errors as structured 403
      if (error.code === 'KYC_LIMIT_EXCEEDED') {
        return res.status(403).json({
          success: false,
          msg:     error.message,
          data:    error.data,
        });
      }
  
      logger.error('Instant order action failed', { userId: user.id, error: error.message });
      return res.status(500).json({ msg: 'An unexpected error occurred', success: false });
    }
  }

  async initiateAnonymous(req: Request & Record<string, any>, res: Response) {

    const { orderId, currencyId, amount, user, bank, crypto, paymentMethod, mobileDetails } = req.body;
  
    try {
  
      // ── Fetch order with pair for validation + KYC limit check ──────────────
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
          id:    true,
          type:  true,
          price: true,
          pair: {
            select: {
              baseCurrency:  { select: { ISO: true } },
              quoteCurrency: { select: { ISO: true } },
            }
          }
        }
      });
  
      if (!order) {
        return res.status(400).json({ msg: 'order not found', success: false });
      }
  
      const currency = await prisma.currency.findUnique({
        where:  { id: currencyId },
        select: { id: true }
      });
  
      if (!currency) {
        return res.status(400).json({ msg: 'currency not found', success: false });
      }
  
      if (order?.type === 'BUY' && (!bank.accountNumber || !bank.bankCode || !bank.recipient)) {
        return res.status(400).json({ msg: 'bank details required', success: false });
      }
  
      if (order?.type === 'SELL' && !crypto.address) {
        return res.status(400).json({ msg: 'crypto details required', success: false });
      }
  
      // ── KYC limit check ───────────────────────────────────────────────────────
      // Reuses the order already fetched above — no extra DB query.
      // Looks up the email's registered KYC tier silently; defaults to Tier 0.

      // await assertAnonKycLimit({ email: user.email, order, amount });
  
      // ── Proceed to preActions ─────────────────────────────────────────────────
      const transferDetails = await anonService.preActions({
        orderId,
        currencyId,
        amount,
        userDetails: user,
        paymentMethod,
        mobileDetails,
        bank: {
          accountNumber: bank.accountNumber,
          bank_code:     bank.bankCode,
          recipient:     bank.recipient
        },
        crypto: {
          address: crypto.address
        }
      });
  
      return res.status(200).json({
        msg:     'Order initialization Successful',
        success: true,
        details: transferDetails
      });
  
    } catch (error: any) {
      console.log(error);
  
      if (error.code === 'KYC_LIMIT_EXCEEDED') {
        return res.status(403).json({
          success: false,
          msg:     error.message,
          data:    error.data,
        });
      }
  
      return res.status(500).send({ msg: 'Initialisation failed', success: false, error });
    }
  }

  async getRatebyPair(req: Request, res: Response) {
    const { pairId } = req.query;

    try {
      console.log('query',req.query)

      if (!pairId) {
        return res.status(400).json({ 
          success: false, 
          msg: "Pair Id required." 
        });
      }

      const pair = await prisma.pair.findUnique({
        where:{id: pairId as string},
        include:{
          baseCurrency: true,
          quoteCurrency: true
        }
      })

      if (!pair) {
        return res.status(400).json({ 
          success: false, 
          msg: "Pair not found." 
        });
      }
  

      const response = await walletService.getRate(pair?.baseCurrency?.ISO as string, pair?.quoteCurrency?.ISO as string)

      // let convertedAmount: any | undefined;

      

      return res
        .status(200)
        .json({
          msg:`rate fetched successfully`,
          success: true,
          rate: response
        });


    } catch (error) {
      console.log(error);
      res.status(500).send(error);
    }
  }


  async fetchOrder(req: Request | any, res: Response) {
    const orderId = req.params.id

    if (!orderId) {
      return res.status(400)
        .json({
          msg: 'order Id required',
          success: false,
        });
    }

    try {

      const order = await prisma.order.findUnique({
        where:{
          id: orderId
        },
        select:{
          id: true,
          type: true,
          isSynthetic: true,
          user:{
            select:{
              id: true,
              firstName: true,
              lastName: true,
              photoUrl: true,
            }
          },
          pair:{
            select:{
              name: true,
              baseCurrency:{
                select:{
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
              quoteCurrency:{
                select:{
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
      })


      return res
        .status(200)
        .json({
          msg: 'Successful',
          success: true,
          order:{...order,paymentMethods: getPaymentSystems(order?.pair?.quoteCurrency?.ISO as string)},
        });

    } catch (error) {
      console.error(error);
      return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
    }
  }

  async cancelOrder(req: Request | any, res: Response) {
    const { user } = req;
    const orderId = req.params.id

    if (!orderId) {
      return res.status(400)
        .json({
          msg: 'order Id required',
          success: false,
        });
    }

    try {

      const order = await prisma.order.findUnique({
        where:{
          id: orderId
        },
        select:{
          id: true,
          type: true,
          amount: true
        },
      })

      if (!order) {
        return res.status(400)
          .json({
            msg: 'order not found',
            success: false,
          });
      }

      const pendingOrders = await prisma.awaiting.findMany({
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

      const canceledOrder = await orderService.cancelOrder({orderId, userId:user.id})


      return res
        .status(200)
        .json({
          msg: 'Successful',
          success: true,
          order: canceledOrder,
        });

    } catch (error: any) {
      console.error(error);
      return res.status(500).send({ msg: error.message, success: false, error });
    }
  }


  async fetchOrders(req: Request | any, res: Response) {
    const { cursor, type, pairId, priceMin, priceMax } = req.query;

    console.log(req.query)

    try {
      // Build the where clause dynamically
      const whereClause: any = {
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

      const totalCount = await prisma.order.count({
        where: whereClause
      });

      const orders = await prisma.order.findMany({
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
            select:{
              name: true,
              baseCurrency:{
                select:{
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
              quoteCurrency:{
                select:{
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
        skip: cursor ? 1 : 0,  // Only skip if cursor is provided
        take: 20,
        ...(cursor && {
          cursor: {
            id: cursor
          }
        }),
        orderBy: {
          createdAt: 'desc'  // Assuming you want newest orders first
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

    } catch (error) {
      console.error(error);
      return res.status(500).send({ 
        msg: 'Internal Server Error', 
        success: false
      });
    }
  }

  async fetch_user_orders(req: Request | any, res: Response) {

    const user = req.user

    console.log(req.query)

    try {

      const orders = await prisma.order.findMany({
        where: {userId: user.id},
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
            select:{
              name: true,
              baseCurrency:{
                select:{
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
              quoteCurrency:{
                select:{
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
          createdAt: 'desc'  // Assuming you want newest orders first
        }
      });

      return res.status(200).json({
        msg: 'Successful',
        success: true,
        orders
      });

    } catch (error) {
      console.error(error);
      return res.status(500).send({ 
        msg: 'Internal Server Error', 
        success: false
      });
    }
  }

  async fetchPairs(req: Request | any, res: Response) {
    // const { limit, page, type, pairId } = req.query;

    try {

      const totalCount = await prisma.order.count();

      // const itemLimit = (limit ? parseInt(limit as string) : 20) || 20;
      // console.log(limit)
      // const totalPages = Math.ceil(totalCount / itemLimit);

      // const currentPage = page ? Math.max(parseInt(page as string), 1) : 1;
      // const skip = (currentPage - 1) * itemLimit;

      const pairs = await prisma.pair.findMany({
          select:{
            id: true,
            name: true,
            baseCurrency:{
              select:{
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
            quoteCurrency:{
              select:{
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
      })

      return res
        .status(200)
        .json({
          msg: 'Successful',
          success: true,
          totalCount: totalCount,
          pairs
        });

    } catch (error) {
      console.error(error);
      return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
    }
  }

  async fetchPairWallets(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const { pairId } = req.query;

    try {

      let baseWallet;
      let quoteWallet;

      const pair = await prisma.pair.findFirst({
        where:{id: pairId as string},
        include:{
          baseCurrency:true,
          quoteCurrency:true,
        }
      })

      if (!pair) {
        return res.status(400)
          .json({
            msg: 'pair not found',
            success: false,
          });
      }

      baseWallet = await prisma.wallet.findFirst({
        where:{
          userId: user.id, 
          currencyId: pair?.baseCurrency?.id
        },
        include:{
          currency: true
        }
      })
      quoteWallet = await prisma.wallet.findFirst({
        where:{
          userId: user.id, 
          currencyId: pair?.quoteCurrency?.id
        },
        include:{
          currency: true
        }
      })

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
            msg: `please create your ${pair?.quoteCurrency?.ISO} wallet` ,
            success: false,
          });
      }

      baseWallet = await walletService.getAccount(baseWallet?.id as string)
      quoteWallet = await walletService.getAccount(quoteWallet?.id as string)
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
    } catch (error) {
      console.log(error);
      return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
    }
  }

  // async assertRegisteredKycLimit({
  //   user,
  //   order,
  //   amount,
  // }: {
  //   user:   any;
  //   order:  any;   // already fetched with pair.baseCurrency + pair.quoteCurrency
  //   amount: string;
  // }): Promise<void> {
  //   // Registered users: kycTier comes directly from req.user (set by JWT middleware)
  //   // No extra DB lookup needed — order already fetched with pair currencies
  
  //   const currencyIso = order.type === 'SELL'
  //     ? (order.pair?.quoteCurrency?.ISO ?? 'NGN')   // user sends fiat
  //     : (order.pair?.baseCurrency?.ISO  ?? 'USDC'); // user sends crypto
  
  //   const tradeAmountUsd = toUsd({
  //     amount:     parseFloat(amount),
  //     currencyIso,
  //     ratePerUsd: Number(order.price ?? 1),
  //   });
  
  //   const limitCheck = await checkKycLimit({
  //     userId:         user.id,
  //     kycTier:        user.kycTier ?? 0,
  //     tradeAmountUsd,
  //   });
  
  //   if (!limitCheck.allowed) {
  //     throw Object.assign(new Error(limitCheck.reason ?? 'Trading limit exceeded'), {
  //       code: 'KYC_LIMIT_EXCEEDED',
  //       data: {
  //         code:            'KYC_LIMIT_EXCEEDED',
  //         kycTier:         user.kycTier ?? 0,
  //         remainingUsd:    limitCheck.remainingUsd ?? null,
  //         limitUsd:        limitCheck.limitUsd     ?? null,
  //         usedUsd:         limitCheck.usedUsd      ?? null,
  //         upgradeRequired: (user.kycTier ?? 0) < 3,
  //       }
  //     });
  //   }
  // }

  // private async assertAnonKycLimit({
  //   email,
  //   order,
  //   amount,
  // }: {
  //   email:  string;
  //   order:  { type: string; price: any; pair?: { baseCurrency?: { ISO: string } | null; quoteCurrency?: { ISO: string } | null } | null };
  //   amount: string;
  // }): Promise<void> {
  
  //   // Silent lookup — default Tier 0 if no registered account found
  //   const registeredUser = await prisma.user.findFirst({
  //     where: {
  //       realEmail:     email,
  //       isAnonymous:   false,
  //       isDeactivated: false,
  //     },
  //     select: { id: true, kycTier: true },
  //   });
  
  //   const kycTier = (() => {
  //     const t = Number(registeredUser?.kycTier ?? 0);
  //     return (t === 1 || t === 2 || t === 3 ? t : 0) as 0 | 1 | 2 | 3;
  //   })();
  
  //   const kycUserId = registeredUser?.id ?? null;
  
  //   // SELL: user sends fiat (quoteCurrency) → convert to USD
  //   // BUY:  user sends crypto (baseCurrency) → already USD
  //   const currencyIso = order.type === 'SELL'
  //     ? (order.pair?.quoteCurrency?.ISO ?? 'NGN')
  //     : (order.pair?.baseCurrency?.ISO  ?? 'USDC');
  
  //   const tradeAmountUsd = toUsd({
  //     amount:     parseFloat(amount),
  //     currencyIso,
  //     ratePerUsd: Number(order.price ?? 1),
  //   });
  
  //   const limitCheck = await checkKycLimit({
  //     userId:         kycUserId,
  //     kycTier,
  //     tradeAmountUsd,
  //   });
  
  //   if (!limitCheck.allowed) {
  //     throw Object.assign(new Error(limitCheck.reason ?? 'Trading limit exceeded'), {
  //       code: 'KYC_LIMIT_EXCEEDED',
  //       data: {
  //         code:            'KYC_LIMIT_EXCEEDED',
  //         kycTier,
  //         remainingUsd:    limitCheck.remainingUsd ?? null,
  //         limitUsd:        limitCheck.limitUsd     ?? null,
  //         usedUsd:         limitCheck.usedUsd      ?? null,
  //         upgradeRequired: kycTier < 3,
  //       }
  //     });
  //   }
  // }
 

  // async updateOrder(req: Request & Record<string, any>, res: Response) {
  //   const user = req.user;
  //   const { orderId, method } = req.body;
  //   const now = new Date();

  //   console.log(user)

  //   if (!orderId) {
  //     return res.status(400).send({ msg: 'Order ID required', success: false });
  //   }

  //   console.log('started operation')

  //   const cart = await prisma.cart.findUnique({
  //     where: { userId: user.id }
  //   })

  //   const order = await prisma.order.findUnique({
  //     where: { id: orderId as string },
  //     include: { store: true }
  //   })

  //   const store = await prisma.store.findUnique({
  //     where: { id: (order?.storeId) },
  //     include: {
  //       organisation: true,
  //       wallet: true,
  //       admins: {
  //         include: { user: true }
  //       }
  //     }
  //   })

  //   const Amount: number = Number(order?.price)

  //   try {

  //     console.log('started operation 2')

  //     if (method === 'WALLET') {

  //       const userBalance = await walletService.getUserbalance(user.id);
  //       console.log('user balance', userBalance)
  //       const reference = generateRefCode('trn', 15).toLocaleLowerCase()

  //       // console.log('cart', cart?.products)

  //       if (userBalance && Number(userBalance) < Amount) {
  //         return res
  //           .status(200)
  //           .json({
  //             msg: 'Balance insufficient',
  //             success: true,
  //           });
  //       }

  //       console.log('entering transaction operation')

  //       const result = await prisma.$transaction(
  //         async (prisma) => {


  //           // update user wallet
  //           await prisma.wallet.update({
  //             where: { userId: user.id },
  //             data: {
  //               balance: Number(userBalance) - Amount
  //             }
  //           })

  //           //update store wallet
  //           await prisma.wallet.update({
  //             where: { storeId: store?.id },
  //             data: {
  //               balance: Number(store?.wallet?.balance) + Amount
  //             }
  //           })

  //           //update organization wallet
  //           await prisma.wallet.upsert({
  //             where: { organisationId: store?.organisationId },
  //             update: {
  //               balance: Number(store?.wallet?.balance) + Amount
  //             },
  //             create: {
  //               organisationId: store?.organisationId,
  //               currency: config.defaultCurrency
  //             }
  //           })

  //           //save user transaction
  //           await prisma.transaction.create({
  //             data: {
  //               userId: user.id,
  //               reference,
  //               amount: Amount,
  //               status: 'SUCCESSFUL',
  //               paymentMethod: 'WALLET',
  //               type: 'DEBIT',
  //               description: 'Payment for order'
  //             }
  //           })

  //           //create store transaction
  //           await prisma.transaction.create({
  //             data: {
  //               storeId: store?.id,
  //               reference,
  //               amount: Amount,
  //               status: 'SUCCESSFUL',
  //               paymentMethod: 'WALLET',
  //               type: 'CREDIT',
  //               description: 'Payment for order'
  //             }
  //           })

  //           console.log('debited')

  //           const updatedOrder = await prisma.order.update({
  //             where: { id: order?.id },
  //             data: {
  //               Status: 'PAID',
  //               updatedAt: now
  //             }
  //           })

  //           // delete cart
  //           await prisma.cartProduct.deleteMany({
  //             where: { cartId: cart?.id },
  //           });

  //           await prisma.cart.delete({
  //             where: { userId: user.id },
  //           });

  //           return {
  //             order: updatedOrder
  //           }
  //         },
  //         {
  //           maxWait: 50000, // default: 2000
  //           timeout: 50000, // default: 5000
  //         }
  //       )

  //       const updatedUser = await prisma.user.findUnique({
  //         where: { id: user.id },
  //         include:{
  //           wallet: true
  //         }
  //       })

  //       return res
  //         .status(200)
  //         .json({
  //           msg: 'order updated Successfully',
  //           success: true,
  //           user: updatedUser,
  //           order: result.order,
  //       });

  //     } else {

  //       const result = await paystackService.verifyTransaction(orderId as string)
  //       console.log(result)

  //       const updatedOrder = await prisma.order.update({
  //         where: { id: orderId as string },
  //         data: {
  //           Status: result?.data?.status == 'success' ? 'PAID' : 'FAILED',
  //           paymentMethod: 'TRANSFER',
  //           updatedAt: now
  //         },
  //       });

  //       console.log('Updated order: ', updatedOrder);

  //         // delete cart
  //         await prisma.cartProduct.deleteMany({
  //           where: { cartId: cart?.id },
  //         });

  //         await prisma.cart.delete({
  //           where: { userId: user.id },
  //         });

  //       return res
  //         .status(200)
  //         .json({
  //           msg: 'order updated Successfully',
  //           success: true,
  //           order: updatedOrder,
  //         });

  //     }

  //     // const result = await this.paystack.transaction.verify(orderId as string);

  //   } catch (error) {
  //     console.log(error);
  //     return res.status(500).send({ msg: 'Internal Server Error', success: false, error });

  //   }
  // }

  // async fetchOrder(req: Request & Record<string, any>, res: Response) {
  //   const { user } = req;
  //   const { orderId } = req.query;

  //   if (!orderId) {
  //     return res.status(400).send('Order ID required');
  //   }

  //   try {
  //     const order = await prisma.order.findUnique({
  //       where: {
  //         id: orderId as string,
  //       },
  //       include: {
  //         products: {
  //           include : {
  //             product: {
  //               include: { images: true }
  //             }
  //           }
  //         },
  //         user: true
  //       },
  //     });

  //     console.log('Fetched order: ', order);

  //     return res
  //       .status(200)
  //       .json({
  //         msg: 'order fetched Successfully',
  //         success: true,
  //         order: order,
  //       });
  //   } catch (error) {
  //     console.log(error);
  //     return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
  //   }
  // }

  // async fetchStores(req: Request, res: Response) {
  //   const { longitude, latitude } = req.query;

  //   if (!longitude || !latitude) {
  //     return res.status(400).send('Location required');
  //   }

  //   try {
  //     const stores = await prisma.store.findMany();

  //     res.status(200).send(stores);
  //   } catch (error) {
  //     console.log(error);
  //     res.status(500).send(error);
  //   }
  // }

  // async fetchOrders(req: Request & Record<string, any>, res: Response) {
  //   const { user } = req;
  //   const cursor = req.query.cursor as string | null;
  //   const limit = req.query.limit as string | null;
  //   // const status = req.query.status as string|null;

  //   try {
  //     let orders;
  //     // orders = await orderService.getUserOrders(cursor, status, limit, user.id)
  //     if (cursor) {
  //       orders = await prisma.order.findMany({
  //         take: limit ? parseInt(limit as string) : 20,
  //         skip: 1,
  //         cursor: {
  //           id: cursor as string,
  //         },
  //         where: {
  //           userId: user.id,
  //         },
  //         include: {
  //           products: {
  //           include : {
  //             product: {
  //               include: { images: true }
  //             }
  //           }
  //         },
  //         },
  //         orderBy: { createdAt: "desc" }
  //       });
  //     } else {

  //       orders = await prisma.order.findMany({
  //         take: limit ? parseInt(limit as string) : 20,
  //         where: {
  //           userId: user.id,
  //         },
  //         include: {
  //           products: true,
  //         },
  //         orderBy: { createdAt: "desc" }
  //       });
  //     }


  //     console.log('Fetched orders: ', orders);

  //     return res
  //       .status(200)
  //       .json({
  //         msg: 'Successful',
  //         success: true,
  //         orders: orders,
  //       });

  //   } catch (error) {
  //     console.log(error);
  //     return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
  //   }
  // }

  // async sendOrderNotifications() {
  //   const now = new Date();

  //   try {
  //     const orders = await prisma.order.findMany({
  //       where: {
  //         updatedAt: {
  //           lte: now,
  //         },
  //         Status: 'PAID',
  //         isNotificationSent: false,
  //       },
  //     });

  //     // console.log('Orders:', orders);

  //     if (orders.length) {
  //       orders.forEach(async order => {
  //         //send notifications
  //         const user = await prisma.user.findUnique({
  //           where: { id: order.userId }
  //         })

  //         const store = await prisma.store.findUnique({
  //           where: { id: order.storeId },
  //           include: { 
  //             admins: {
  //               include: { user: true }
  //             } 
  //           }
  //         })

  //         const storeAdmins = store?.admins
  //         const storeAdminTokens: any = []
  //         storeAdmins?.forEach(storeAdmin => {
  //           if (storeAdmin.user.pushToken) {
  //             storeAdminTokens.push(storeAdmin.user.pushToken)
  //           }
  //         })

  //         const userMessage = 'Your Order has been placed successfully. You will be updated';
          
  //         //create user inapp notification
  //         await prisma.notification.create({
  //           data: {
  //             userId: user?.id,
  //             title: 'Order Placed',
  //             content: userMessage,
  //             type: 'ORDER'
  //           }
  //         })

  //         // create store inapp notification
  //         await prisma.notification.create({
  //           data: {
  //             storeId: store?.id ?? null,
  //             title: 'Order Placed',
  //             content: 'You have a new order from ' + user?.firstName + ' . OrderID: ' + order.id,
  //             type: 'ORDER'
  //           }
  //         })

  //         // send user sms notification
  //         // if(user?.phoneNumber){
  //         //   await smsService.send({
  //         //     api_key: config.termiiLiveKey,
  //         //     to: user?.phoneNumber.replace(/^\+/, ''),
  //         //     from: 'Qaya',
  //         //     sms: userMessage,
  //         //     type: "plain",
  //         //     channel: "generic",
  //         //   })
  //         // }

  //         //send user push notification
  //         await mobilePushService.singlePush('Order Placed', userMessage, user?.pushToken!)

  //         //send store  push notification
  //         await notificationService.sendMulticastPushNotification(
  //           storeAdminTokens,
  //           'Order',
  //           'You have a new order from ' + user?.firstName + ' . OrderID: ' + order.id
  //         )

  //         //update order
  //         await prisma.order.update({
  //           where: { id: order.id },
  //           data: { isNotificationSent: true }
  //         })

  //         console.log("Notification successfully sent for order "+ order.id)
  //       })
  //     }
  //   } catch (error) {
  //     console.log(error)
  //   }
  // }
}

export default new OrderController();
