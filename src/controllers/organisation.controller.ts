// import { UserType } from '@prisma/client';
import { Request, Response } from 'express';
import moment from 'moment';
import slugify from 'slugify';
import config from '../config/env.config';
import prisma from '../config/prisma.client';
import { OTP_CODE_EXP, generateRefCode, hashData } from '../utils';
import mailService from '../services/mail.service';
import dashboardService from '../services/dashboard.service';
import paystackService from '../services/paystack.service';
import transactionService from '../services/transaction.service';
import { endOfDay, endOfWeek, startOfDay, startOfWeek, subDays, subWeeks } from 'date-fns';

class OrganisationController {
  // async createOrgUser(req: Request, res: Response) {
  //   const user = req.body;
  //   const otpCode = generateRefCode();

  //   const userExist = await prisma.user.findUnique({
  //     where: { email: user.email },
  //   });
  //   let newUser: any;

  //   if (userExist) {
  //     return res.status(400).json({
  //       msg: 'User already exist',
  //       success: false,
  //       user: userExist,
  //     });
  //   }

  //   try {
  //     const slug = slugify(user.organisation.name);
  //     const transaction = await prisma.$transaction(async (prisma) => {
  //       const newOrg = await prisma.organisation.create({
  //         data: {
  //           name: user.organisation.name,
  //           type: user.organisation.type,
  //           slug: slug,
  //           logo: config.defaultOrganisationUrl,
  //           regNo: user.organisation.cacRegNo,
  //           wallet: {
  //             create: {
  //               currency: config.defaultCurrency
  //             }
  //           }
  //         },
  //       });
  //       newUser = await prisma.user.create({
  //         data: {
  //           firstName: user.firstName,
  //           lastName: user.lastName,
  //           email: user.email,
  //           phoneNumber: user.phoneNumber,
  //           type: UserType.ORGANISATIONADMIN,
  //           organisationId: newOrg.id,
  //           otpCode: otpCode,
  //           otpCodeExpiryTime: OTP_CODE_EXP,
  //           photoUrl: config.defaultPhotoUrl,
  //           roleId: "clycs1ims0000ts0z4fdvvflp"
  //         },
  //       });

  //       return { organization: newOrg, user: newUser };
  //     });
  //     const url = `${config.urls.salesDashboard}/signup?tab=password&user=${newUser?.id}&code=${otpCode}`;
  //     await mailService.sendVerificationLink(user.email, user.firstName, url);
  //     return res.status(201).json({
  //       msg: "We've sent you an email with a link to create password",
  //       success: true,
  //       data: transaction,
  //     });
  //   } catch (error) {
  //     console.log(error);

  //     return res
  //       .status(500)
  //       .json({ msg: 'Failed to create user', success: false, error });
  //   }
  // }

  // async createPassword(req: Request, res: Response) {
  //   const { userId, password, code } = req.body;
  //   const user = await prisma.user.findUnique({ where: { id: userId } });
  //   console.log(user);
  //   if (
  //     user?.otpCode !== code ||
  //     user?.otpCodeUsed
  //     // moment().isAfter(user?.otpCodeExpiryTime)
  //   ) {
  //     return res
  //       .status(400)
  //       .json({ msg: 'Otp code used or link expired', success: false });
  //   }
  //   const hashedPwd = await hashData(password);
  //   await prisma.user.update({
  //     where: { id: userId },
  //     data: { password: hashedPwd, otpCodeUsed: true, verified: true },
  //   });
  //   return res
  //     .status(200)
  //     .json({ msg: 'Password created successfully', success: true });
  // }

  // async orgResendEmail(req: Request, res: Response) {
  //   const { email } = req.body;
  //   const user = await prisma.user.findUnique({ where: { email: email } });
  //   if (!user) {
  //     return res.status(400).json({
  //       msg: 'user not found',
  //       success: false,
  //     });
  //   }

  //   if (
  //     !user.otpCode ||
  //     user?.otpCodeUsed === true
  //     // moment().isAfter(user?.otpCodeExpiryTime)
  //   ) {
  //     const otpCode = generateRefCode();
  //     const url = `${config.urls.salesDashboard}/signup?tab=password&user=${user?.id}&code=${otpCode}`;
  //     await prisma.user.update({
  //       where: { email: email },
  //       data: {
  //         otpCode: otpCode,
  //         otpCodeUsed: false,
  //         otpCodeExpiryTime: OTP_CODE_EXP,
  //       },
  //     });

  //     await mailService.sendVerificationLink(user?.email, user.firstName, url);
  //   } else {
  //     const url = `${config.urls.salesDashboard}/signup?tab=password&user=${user?.id}&code=${user.otpCode}`;
  //     await mailService.sendVerificationLink(user?.email, user.firstName, url);
  //   }
  //   return res.status(200).json({
  //     msg: 'Email successfully sent to your email',
  //     success: true,
  //   });
  // }

  // async updateOrgProfile(req: Request & Record<string, any>, res: Response) {
  //   const { organizationName, organizationCacRegNo, logo } = req.body
  //   const user = req.user
  //   console.log(user)

  //   if (!user.organisationId) {
  //     return res.status(400).json({
  //       msg: 'user organisation not found',
  //       success: false,
  //     });
  //   }

  //   try {
  //     const updatedOrganisation = await prisma.organisation.update({
  //       where: { id: user.organisationId },
  //       data: {
  //         name: organizationName,
  //         regNo: organizationCacRegNo,
  //         logo: logo
  //       },
  //     });

  //     return res.status(201).json({
  //       msg: 'Organization profile updated successfully',
  //       success: true,
  //       organisation: updatedOrganisation
  //     });

  //   } catch (error) {
  //     return res
  //       .status(500)
  //       .json({ msg: 'Internal Server Error', success: false, error });
  //   }
  // }

  // async fetchDashboardData(req: Request & Record<string, any>, res: Response) {
  //   const user = req.user
  //   const { filter } = req.query
  //   const organisationId = user.organisationId

  //   let data;
  //   let revenueCategory;

  //   let currentDateFrom: Date | null = null;
  //   let currentDateTo: Date | null = null;

  //   let previousDateFrom: Date | null = null;
  //   let previousDateTo: Date | null = null;
    
  //   let dateFilter: string = 'alltime'

  //   try {

  //     if(filter){
  //       dateFilter = filter as string
  //     }

  //     const getDateRange = await dashboardService.getDateRange(dateFilter as string) 
  //     currentDateFrom = getDateRange.dateFrom
  //     currentDateTo = getDateRange.dateTo

  //     const getPreviousDateRange = await dashboardService.getPreviousDateRange(dateFilter as string)
  //     previousDateFrom = getPreviousDateRange.dateFrom
  //     previousDateTo = getPreviousDateRange.dateTo

  //     const currentOverview = await dashboardService.getOrganisationDashboardOverview(organisationId, currentDateFrom, currentDateTo)
  //     const previousOverview = await dashboardService.getOrganisationDashboardOverview(organisationId, previousDateFrom, previousDateTo)

  //     const revenuePercentageChange = await dashboardService.calculateRevenuePercentageChange(Number(currentOverview.revenue), Number(previousOverview.revenue))
  //     const storePercentageChange = await dashboardService.calculateStorePercentageChange(Number(currentOverview.stores), Number(previousOverview.stores))
  //     const productPercentageChange = await dashboardService.calculateProductPercentageChange(Number(currentOverview.products), Number(previousOverview.products))
  //     const orderPercentageChange = await dashboardService.calculateOrderPercentageChange(Number(currentOverview.orders), Number(previousOverview.orders))

  //     const monthlySalesInflow: any = {
  //       January: 0, February: 0, March: 0,
  //       April: 0, May: 0, June: 0,
  //       July: 0, August: 0, September: 0,
  //       October: 0, November: 0, December: 0,
  //     }

  //     const monthlySalesOutflow: any = {
  //       January: 0, February: 0, March: 0,
  //       April: 0, May: 0, June: 0,
  //       July: 0, August: 0, September: 0,
  //       October: 0, November: 0, December: 0,
  //     }

  //     const currentYear = new Date().getFullYear();

  //     const salesInflow = await dashboardService.getMonthlySalesInflow(organisationId, null, currentYear)
  //     salesInflow.forEach((transaction) => {
  //       const month = new Date(transaction.createdAt).toLocaleString('default', { month: 'long' });
  //       if (monthlySalesInflow[month] !== undefined) {
  //         monthlySalesInflow[month] += Number(transaction._sum.amount);
  //       }
  //     });

  //     const salesOutflow = await dashboardService.getMonthlySalesOutflow(organisationId, null, currentYear)
  //     salesOutflow.forEach((transaction) => {
  //       const month = new Date(transaction.createdAt).toLocaleString('default', { month: 'long' });
  //       if (monthlySalesOutflow[month] !== undefined) {
  //         monthlySalesOutflow[month] += Number(transaction._sum.amount);
  //       }
  //     });

  //     const topSellingProducts = await dashboardService.getTopSellingProducts(organisationId, null)
  //     const topSelling = await Promise.all(topSellingProducts.map(async (item) => {
  //       const product = await prisma.product.findUnique({
  //         where: { id: item.productId as string },
  //         include: { images: true }
  //       });
  //       return {
  //         product,
  //         amountSold: item._sum.price || 0,
  //         quantitySold: item._sum.cart_Quantity || 0,
  //       };
  //     }));

  //     const revenueCategoryCount = await dashboardService.getRevenueCategories(organisationId, null)
      
  //     if(revenueCategoryCount){
  //       revenueCategory = await Promise.all(revenueCategoryCount.map(async (item) => {
  //         const product = await prisma.product.findUnique({
  //           where: { id: item.productId as string },
  //           include: { categories: true, images: true }
  //         });
  //         return {
  //           // product,
  //           category: product?.categories[0] ?? [],
  //           count: item._count
  //         };
  //       }));
  //     }

  //     const lowStockProducts = await dashboardService.getLowQuantityStock(organisationId, null);

  //     data = {
  //       revenue: currentOverview.revenue,
  //       products: currentOverview.products,
  //       orders: currentOverview.orders,
  //       stores: currentOverview.stores,
  //       revenuePercentageChange,
  //       storePercentageChange,
  //       productPercentageChange,
  //       orderPercentageChange,
  //       monthlySalesInflow,
  //       monthlySalesOutflow,
  //       topSelling,
  //       revenueCategory,
  //       lowStockProducts
  //     }

  //     return res.status(201).json({
  //       msg: 'Dashboard data fetched successfully',
  //       success: true,
  //       data
  //     });

  //   } catch (error) {
  //     console.log(error)
  //     return res.status(500).json({ msg: 'Something went wrong', error });
  //   }
  // }

  // async fetchAdministrators(req: Request | any, res: Response) {
  //   const { limit, page } = req.query;

  //   const creator = req.user;
  //   console.log(creator)

  //   if (creator.type !== "ORGANISATIONADMIN") {
  //     return res
  //       .status(403)
  //       .json({ msg: 'user not authorised', success: false });
  //   }

  //   try {

  //     const totalCount = await prisma.user.count({
  //       where: {
  //         organisationId: creator.organisationId
  //       }
  //     });

  //     const itemLimit = (limit ? parseInt(limit as string) : 20) || 20;
  //     console.log(limit)
  //     const totalPages = Math.ceil(totalCount / itemLimit);

  //     const currentPage = page ? Math.max(parseInt(page as string), 1) : 1;
  //     const skip = (currentPage - 1) * itemLimit;

  //     const users = await prisma.user.findMany({
  //       where: {
  //         organisationId: creator.organisationId
  //       },
  //       include: {
  //         role: true
  //       },
  //       skip: skip,
  //       take: itemLimit || 20
  //     });

  //     return res
  //       .status(200)
  //       .json({
  //         msg: 'Successful',
  //         success: true,
  //         totalCount: totalCount,
  //         totalPages: totalPages,
  //         limit: itemLimit,
  //         currentPage: currentPage,
  //         users: users,
  //       });

  //   } catch (error) {
  //     console.log(error);
  //     return res.status(500).json({ msg: 'Something went wrong', error });
  //   }
  // }

  // async withdrawRevenue(req: Request & Record<string, any>, res: Response) {
  //   const user = req.user
  //   const { amount, bankId } = req.body
  //   let transaction

  //   if (user.type !== 'ORGANISATIONADMIN') {
  //     return res.status(400).json({
  //       msg: 'You cannot perform this action',
  //       success: false
  //     });
  //   }

  //   try {
  //     //get bank
  //     const userBank = await prisma.userBank.findUnique({
  //       where: { id: bankId },
  //       include: {
  //         bank: true,
  //         user: true,
  //       }
  //     })

  //     if (!userBank) {
  //       return res.status(400).json({
  //         msg: 'User bank not found',
  //         success: false
  //       });
  //     }

  //     const organisation = await prisma.organisation.findUnique({
  //       where: { id: user.organisationId },
  //       include: { wallet: true }
  //     })

  //     if (organisation && organisation.wallet) {
  //       if (organisation?.wallet.balance < amount) {
  //         return res.status(400).json({
  //           msg: 'Insufficent balance',
  //           success: false
  //         });
  //       }

  //       //withdraw
  //       const revenue = (10 / 100) * amount;
  //       const amountToWithdraw = amount - revenue;
  //       const reference = generateRefCode('trn', 15).toLocaleLowerCase()
  //       const withdraw = await paystackService.makeTransfer(amountToWithdraw, reference, userBank)
        
  //       console.log('withdraw', withdraw)

  //       if (!withdraw || !withdraw?.status) {
  //         return res.status(400).json({
  //           msg: 'Error initiating withdrawal, please try again later',
  //           success: false
  //         });
  //       }

  //       //deduct from orgnanization wallet
  //       await prisma.wallet.update({
  //         where: { organisationId: user.organisationId },
  //         data: {
  //           balance: Number(organisation?.wallet?.balance) - amount
  //         }
  //       })

  //       //save transaction
  //       transaction = await prisma.transaction.create({
  //         data: {
  //           organisationId: user.organisationId,
  //           reference,
  //           amount,
  //           status: 'PENDING',
  //           paymentMethod: 'WALLET',
  //           type: 'DEBIT',
  //           description: 'Revenue withdrawal'
  //         }
  //       })

  //       //save revenue
  //       await prisma.adminRevenue.create({
  //         data: {
  //           organisationId: user.organisationId,
  //           amount: revenue,
  //           currency: config.defaultCurrency
  //         }
  //       })
  //     } else {
  //       return res.status(400).json({
  //         msg: 'Organisation/wallet not found',
  //         success: false
  //       });
  //     }

  //     return res
  //       .status(200)
  //       .json({
  //         msg: 'Withdrawal initiated successfully',
  //         success: true,
  //         wallet: organisation?.wallet,
  //         transaction
  //       });

  //   } catch (error) {
  //     console.log(error);
  //     return res.status(500).json({ msg: 'Something went wrong', error });
  //   }
  // }

}

export default new OrganisationController();
