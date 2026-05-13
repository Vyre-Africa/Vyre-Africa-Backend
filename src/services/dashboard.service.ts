import { Request, Response } from "express";
import prisma from "../config/prisma.client";
import { startOfYear, endOfYear, subDays, subMonths, startOfMonth, startOfDay, endOfDay, endOfMonth, subYears, startOfToday } from 'date-fns';

class DashboardService {
    // async getDateRange(dateFilter: string) {
    //     const today = new Date();
    //     let dateFrom: Date | null;
    //     let dateTo: Date | null = today;

    //     switch (dateFilter) {
    //         case 'today':
    //             dateFrom = startOfDay(new Date());
    //             dateTo = endOfDay(new Date());
    //             break;

    //         case 'last7days':
    //             dateFrom = subDays(today, 7);
    //             dateTo = endOfDay(today);
    //             break;

    //         case 'last30days':
    //             dateFrom = subDays(today, 30);
    //             break;

    //         case 'last3months':
    //             dateFrom = subMonths(today, 3);
    //             break;

    //         case 'last12months':
    //             dateFrom = subMonths(today, 12);
    //             break;

    //         case 'monthToDate':
    //             dateFrom = startOfMonth(today);
    //             break;

    //         case 'yearToDate':
    //             dateFrom = startOfYear(today);
    //             break;
    //         case 'alltime' :
    //             dateFrom = null;
    //             dateTo = null;
    //         break;

    //         default:
    //             throw new Error('Invalid date filter');
    //     }

    //     return { dateFrom, dateTo };
    // }

    // async getPreviousDateRange(dateFilter: string) {
    //     const today = new Date();
    //     let dateFrom: Date | null;
    //     let dateTo: Date | null = today;
      
    //     switch (dateFilter) {
    //     case 'today':
    //         dateFrom = startOfDay(subDays(today, 1) );
    //         dateTo = endOfDay(subDays(today, 1));
    //         break;

    //     case 'last7days':
    //         dateFrom = subDays(today, 13);
    //         dateTo = subDays(startOfToday(), 7);
    //         break;

    //       case 'last30days':
    //         dateFrom = subDays(today, 60);
    //         dateTo = subDays(today, 30);
    //         break;
      
    //       case 'last3months':
    //         dateFrom = subMonths(today, 6);
    //         dateTo = subMonths(today, 3);
    //         break;
      
    //       case 'last12months':
    //         dateFrom = subMonths(today, 24);
    //         dateTo = subMonths(today, 12);
    //         break;
      
    //       case 'monthToDate':
    //         dateFrom = startOfMonth(subMonths(today, 1));
    //         dateTo = endOfMonth(subMonths(today, 1));
    //         break;
      
    //       case 'yearToDate':
    //         dateFrom = startOfYear(subYears(today, 1));
    //         dateTo = endOfYear(subYears(today, 1));
    //         break;
    //     case 'alltime' :
    //         dateFrom = null;
    //         dateTo = null;
    //         break;
      
    //       default:
    //         throw new Error('Invalid date filter');
    //     }

    //     return { dateFrom, dateTo };
    // }

    // async calculateRevenuePercentageChange(currentRevenue:number, previousRevenue:number)
    // {
    //     let percentageChange = 0;
    //     if (previousRevenue !== 0) {
    //         percentageChange = ((currentRevenue - previousRevenue) / previousRevenue) * 100;
    //     } else {
    //         percentageChange = currentRevenue > 0 ? 100 : 0;
    //     }

    //     return percentageChange;
    // }

    // async calculateStorePercentageChange(currentStoreCount:number, previousStoreCount:number)
    // {
    //     let percentageChange = 0;
    //     if (previousStoreCount !== 0) {
    //         percentageChange = ((currentStoreCount - previousStoreCount) / previousStoreCount) * 100;
    //     } else {
    //         percentageChange = currentStoreCount > 0 ? 100 : 0;
    //     }

    //     return percentageChange;
    // }

    // async calculateProductPercentageChange(currentProductCount:number, previousProductCount:number)
    // {
    //     let percentageChange = 0;
    //     if (previousProductCount !== 0) {
    //         percentageChange = ((currentProductCount - previousProductCount) / previousProductCount) * 100;
    //     } else {
    //         percentageChange = currentProductCount > 0 ? 100 : 0; // If no revenue in the previous period
    //     }

    //     return percentageChange;
    // }

    // async calculateOrderPercentageChange(currentOrderCount:number, previousOrderCount:number)
    // {
    //     let percentageChange = 0;
    //     if (previousOrderCount !== 0) {
    //         percentageChange = ((currentOrderCount - previousOrderCount) / previousOrderCount) * 100;
    //     } else {
    //         percentageChange = currentOrderCount > 0 ? 100 : 0;
    //     }

    //     return percentageChange;
    // }

    // async getOrganisationDashboardOverview(organisationId: string, dateFrom: Date | null, dateTo: Date | null) {
    //     let revenue;
    //     let stores;
    //     let orders;
    //     let products;

    //     if (dateFrom !== null && dateTo !== null) {
    //         revenue = await prisma.wallet.aggregate({
    //             _sum: {
    //                 balance: true,
    //             },
    //             where: {
    //                 organisationId,
    //                 createdAt: {
    //                     gte: dateFrom,
    //                     lte: dateTo,
    //                 },
    //             },
    //         });

    //         products = await prisma.product.count({
    //             where: {
    //                 store: {
    //                     organisationId,
    //                 },
    //                 createdAt: {
    //                     gte: dateFrom,
    //                     lte: dateTo,
    //                 },
    //             }
    //         });

    //         orders = await prisma.order.count({
    //             where: {
    //                 store: {
    //                     organisationId,
    //                 },
    //                 createdAt: {
    //                     gte: dateFrom,
    //                     lte: dateTo,
    //                 },
    //             }
    //         })

    //         stores = await prisma.store.count({
    //             where: {
    //                 organisationId,
    //                 createdAt: {
    //                     gte: dateFrom,
    //                     lte: dateTo,
    //                 },
    //             }
    //         })

    //     } else {
    //         revenue = await prisma.wallet.aggregate({
    //             _sum: {
    //                 balance: true,
    //             },
    //             where: {
    //                 organisationId,
    //             },
    //         });

    //         products = await prisma.product.count({
    //             where: {
    //                 store: {
    //                     organisationId,
    //                 }
    //             }
    //         });

    //         orders = await prisma.order.count({
    //             where: {
    //                 store: {
    //                     organisationId,
    //                 }
    //             }
    //         });

    //         stores = await prisma.store.count({
    //             where: { organisationId }
    //         });
    //     }

    //     return {
    //         revenue : revenue?._sum.balance ?? 0,
    //         stores,
    //         products,
    //         orders
    //     }
    // }

    // async getStoreDashboardOverview(storeId: string | null, dateFrom: Date | null, dateTo: Date | null) {
    //     let revenue;
    //     let orders;
    //     let products;

    //     if (storeId !== null) {
    //         if (dateFrom !== null && dateTo !== null) {

    //             revenue = await prisma.wallet.aggregate({
    //                 _sum: {
    //                     balance: true,
    //                 },
    //                 where: {
    //                     storeId,
    //                     createdAt: {
    //                         gte: dateFrom,
    //                         lte: dateTo,
    //                     },
    //                 },
    //             });

    //             products = await prisma.product.count({
    //                 where: {
    //                     storeId,
    //                     createdAt: {
    //                         gte: dateFrom,
    //                         lte: dateTo,
    //                     },
    //                 }
    //             });

    //             orders = await prisma.order.count({
    //                 where: {
    //                     storeId,
    //                     createdAt: {
    //                         gte: dateFrom,
    //                         lte: dateTo,
    //                     },
    //                 }
    //             })

    //         } else {
    //             revenue = await prisma.wallet.aggregate({
    //                 _sum: {
    //                     balance: true,
    //                 },
    //                 where: {
    //                     storeId
    //                 },
    //             });

    //             products = await prisma.product.count({
    //                 where: {
    //                     storeId
    //                 }
    //             });

    //             orders = await prisma.order.count({
    //                 where: {
    //                     storeId
    //                 }
    //             });
    //         }
    //     }

    //     return {
    //         revenue: revenue?._sum.balance ?? 0,
    //         products,
    //         orders
    //     }
    // }

    // async getMonthlySalesInflow(organisationId: string | null, storeId: string | null, year: number) {

    //     if (organisationId !== null) {
    //         return await prisma.transaction.groupBy({
    //             by: ['storeId', 'createdAt'],
    //             _sum: {
    //                 amount: true,
    //             },
    //             where: {
    //                 type: 'CREDIT',
    //                 store: {
    //                     organisationId,
    //                 },
    //                 createdAt: {
    //                     gte: startOfYear(new Date(year, 0, 1)),
    //                     lte: endOfYear(new Date(year, 11, 31)),
    //                 },
    //             },
    //             orderBy: {
    //                 createdAt: 'asc',
    //             },
    //         });
    //     }


    //     if (storeId !== null) {

    //         return await prisma.transaction.groupBy({
    //             by: ['storeId', 'createdAt'],
    //             _sum: {
    //                 amount: true,
    //             },
    //             where: {
    //                 type: 'CREDIT',
    //                 storeId,
    //                 createdAt: {
    //                     gte: startOfYear(new Date(year, 0, 1)),
    //                     lte: endOfYear(new Date(year, 11, 31)),
    //                 },
    //             },
    //             orderBy: {
    //                 createdAt: 'asc',
    //             },
    //         });
    //     }

    //     return [];
    // }

    // async getMonthlySalesOutflow(organisationId: string | null, storeId: string | null, year: number) {

    //     if (organisationId !== null) {
    //         return await prisma.transaction.groupBy({
    //             by: ['storeId', 'createdAt'],
    //             _sum: {
    //                 amount: true,
    //             },
    //             where: {
    //                 type: 'DEBIT',
    //                 store: {
    //                     organisationId,
    //                 },
    //                 createdAt: {
    //                     gte: startOfYear(new Date(year, 0, 1)),
    //                     lte: endOfYear(new Date(year, 11, 31)),
    //                 },
    //             },
    //             orderBy: {
    //                 createdAt: 'asc',
    //             },
    //         });
    //     }

    //     if (storeId !== null) {

    //         return await prisma.transaction.groupBy({
    //             by: ['storeId', 'createdAt'],
    //             _sum: {
    //                 amount: true,
    //             },
    //             where: {
    //                 type: 'DEBIT',
    //                 storeId,
    //                 createdAt: {
    //                     gte: startOfYear(new Date(year, 0, 1)),
    //                     lte: endOfYear(new Date(year, 11, 31)),
    //                 },
    //             },
    //             orderBy: {
    //                 createdAt: 'asc',
    //             },
    //         });
    //     }

    //     return [];
    // }

    // async getTopSellingProducts(organisationId: string | null, storeId: string | null) {

    //     if (organisationId !== null) {

    //         return await prisma.orderProduct.groupBy({
    //             by: ['productId'],
    //             _count: {
    //                 productId: true,
    //             },
    //             _sum: {
    //                 cart_Quantity: true,
    //                 price: true,
    //             },
    //             where: {
    //                 Order: {
    //                     store: {
    //                         organisationId
    //                     },
    //                 },
    //             },
    //             orderBy: {
    //                 _count: {
    //                     productId: 'desc',
    //                 },
    //             },
    //             take: 5,
    //         });
    //     }

    //     if (storeId !== null) {
    //         return await prisma.orderProduct.groupBy({
    //             by: ['productId'],
    //             _count: true,
    //             _sum: {
    //                 cart_Quantity: true,
    //                 price: true,
    //             },
    //             where: {
    //                 Order: {
    //                     storeId
    //                 },
    //             },
    //             orderBy: {
    //                 _count: {
    //                     productId: 'desc',
    //                 },
    //             },
    //             take: 5
    //         });
    //     }

    //     return [];
    // }

    // async getLowQuantityStock(organisationId: string | null, storeId: string | null) {
    //     if (organisationId !== null) {

    //         return await prisma.product.findMany({
    //             where: {
    //                 store: {
    //                     organisationId,
    //                 },
    //                 Quantity: {
    //                     lte: prisma.product.fields.alertQuantity,
    //                 },
    //             },
    //             include: {
    //                 store: true,
    //                 images: true,
    //             }
    //         })
    //     }

    //     if (storeId !== null) {

    //         return await prisma.product.findMany({
    //             where: {
    //                 storeId,
    //                 Quantity: {
    //                     lte: prisma.product.fields.alertQuantity,
    //                 },
    //             },
    //             include: {
    //                 store: true,
    //                 images: true
    //             }
    //         })
    //     }
    // }

    // async getRevenueCategories(organisationId: string | null, storeId: string | null) {
    //     if (organisationId !== null) {

    //         return await prisma.orderProduct.groupBy({
    //             by: ['productId'],
    //             _count: true,
    //             where: {
    //                 Order: {
    //                     store: {
    //                         organisationId
    //                     },
    //                 },
    //             },
    //             orderBy: {
    //                 _count: {
    //                     productId: 'desc',
    //                 },
    //             },
    //             take: 5,
    //         });
    //     }

    //     if (storeId !== null) {

    //         return await prisma.orderProduct.groupBy({
    //             by: ['productId'],
    //             _count: true,
    //             where: {
    //                 Order: {
    //                     storeId
    //                 },
    //             },
    //             orderBy: {
    //                 _count: {
    //                     productId: 'desc',
    //                 },
    //             },
    //             take: 5
    //         });
    //     }
    // }
}

export default new DashboardService()