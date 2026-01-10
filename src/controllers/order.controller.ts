import { PrismaClient } from '@prisma/client';
import { Paystack } from 'paystack-sdk';
import { Request, Response } from 'express';
import prisma from '../config/prisma.config';
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
import Decimal from 'decimal.js';


class OrderController {


  async createOrder(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const { price, amount, type, pairId, minimumAmount } = req.body;

    console.log(price, amount, type, pairId)

    try {

      //  const userData = await prisma.user.findUnique({
      //     where: { id: user.id }
      //   })

        // fetch pair
        // check if user has both wallets
        // check the base currency balance of the user if its sufficient for the order
        // block the amount for the order
        // create the order using a prisma transaction

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

        // ✅ Quick balance check before queuing
        const amountDecimal = new Decimal(amount);
        const walletToCheck = type === 'SELL' ? baseWallet : quoteWallet;
        const availableBalance = new Decimal(walletToCheck.availableBalance);

        if (availableBalance.lessThan(amountDecimal)) {
          return res.status(400).json({
            msg: `Insufficient ${type === 'SELL' ? 'base' : 'quote'} balance`,
            success: false,
          });
        }

        // ✅ PHASE 2: Generate order ID immediately
        const orderId = generateOrderId();

        // ✅ Queue the heavy work (transaction, blocking, etc.)
        await orderService.queue({
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
        msg:'Order creation unsuccessful',
        success: false
      });
    }
  }


  async processOrder(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const {amount, orderId } = req.body;
   

    const userData = await prisma.user.findUnique({
      where: { id: user.id }
    })

    const order = await prisma.order.findUnique({
      where:{id: orderId}
    })

    const pair = await prisma.pair.findFirst({
      where:{id: order?.pairId},
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
          msg: 'order pair not found',
          success: false,
        });
    }

    const userBaseWallet = await prisma.wallet.findFirst({
      where:{
        currencyId: pair?.baseCurrency?.id,
        userId: user.id
      }
    })

    const userQuoteWallet = await prisma.wallet.findFirst({
      where:{
        currencyId: pair?.quoteCurrency?.id,
        userId: user.id
      }
    })

    if (!userBaseWallet || !userQuoteWallet) {
      return res.status(400)
        .json({
          msg: 'User wallet does not exist',
          success: false,
        });
    }

    // check for single minimum amount required per trade
    if(!amountSufficient(amount, Number(order?.amountMinimum))){
      return res.status(400)
        .json({
          msg: 'Minimum Order Amount not sufficient',
          success: false,
        });
    }

    try {

      const order = await orderService.processOrder({
        userId: user.id,
        orderId,
        amount, 
        userBaseWallet,
        userQuoteWallet
      })

      return res
        .status(200)
        .json({
          msg: 'Order Processed Successfully',
          success: true,
          order
        });

    } catch (error) {
      console.log(error)
      res.status(500)
        .json({
          msg: 'Internal Server Error',
          success: false,
        });
    }
  }


  async initiateAnonymous(req: Request & Record<string, any>, res: Response) {
    // const { user } = req;
    const { orderId, currencyId, amount, user, bank, crypto, paymentMethod } = req.body;

    try {

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select:{
          id: true,
          type: true
        }
      });

      if(!order ){
        return res.status(400)
            .json({
              msg: 'order not found',
              success: false
        });
      }

      const currency = await prisma.currency.findUnique({
        where: { id: currencyId },
        select:{
          id:true
        }
      });

      if(!currency ){
        return res.status(400)
            .json({
              msg: 'currency not found',
              success: false
        });
      }

      if(order?.type === 'BUY' && (!bank.accountNumber || !bank.bankCode || !bank.recipient)){
          return res.status(400)
            .json({
              msg: 'bank details required',
              success: false
            });
      }

      if(order?.type === 'SELL' && !crypto.address){
        return res.status(400)
            .json({
              msg: 'crypto details required',
              success: false
        });

      }

      const transferDetails = await anonService.preActions({
        orderId,
        currencyId,
        amount,
        userDetails: user,
        paymentMethod,

        bank:{
          accountNumber: bank.accountNumber,
          bank_code: bank.bankCode,
          recipient: bank.recipient
        },
        crypto:{
          address: crypto.address
          // chain: crypto.chain
        },
        
      })


      return res
        .status(200)
        .json({
          msg: 'Order initialization Successful',
          success: true,
          details: transferDetails
        });

    } catch (error) {
      console.log(error);
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
          user:{
            select:{
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

    } catch (error) {
      console.error(error);
      return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
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
