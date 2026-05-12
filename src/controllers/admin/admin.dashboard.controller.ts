import { Request, Response } from 'express';
import prisma from '../../config/prisma.client';
import { endOfYear, startOfYear } from 'date-fns';

class AdminDashboardController {
    // async get(req: Request & Record<string, any>, res: Response) {

    //     try {
    //         //overview
    //         const revenue = await prisma.adminRevenue.aggregate({
    //             _sum: {
    //                 amount: true
    //             }
    //         })
    //         const products = await prisma.product.count()
    //         const orders = await prisma.order.count()
    //         const stores = await prisma.store.count()

    //         //sales performance
    //         const monthlySalesInflow: any = {
    //             January: 0, February: 0, March: 0,
    //             April: 0, May: 0, June: 0,
    //             July: 0, August: 0, September: 0,
    //             October: 0, November: 0, December: 0,
    //         }

    //         const monthlySalesOutflow: any = {
    //             January: 0, February: 0, March: 0,
    //             April: 0, May: 0, June: 0,
    //             July: 0, August: 0, September: 0,
    //             October: 0, November: 0, December: 0,
    //         }

    //         const currentYear = new Date().getFullYear();

    //         const salesInflow = await prisma.transaction.groupBy({
    //             by: ['createdAt'],
    //             _sum: {
    //                 amount: true,
    //             },
    //             where: {
    //                 type: 'CREDIT',
    //                 store: {
    //                     isNot: null,
    //                 },
    //                 createdAt: {
    //                     gte: startOfYear(new Date(currentYear, 0, 1)),
    //                     lte: endOfYear(new Date(currentYear, 11, 31)),
    //                 },
    //             },
    //             orderBy: {
    //                 createdAt: 'asc',
    //             },
    //         });
            
    //         salesInflow.forEach((transaction) => {
    //             const month = new Date(transaction.createdAt).toLocaleString('default', { month: 'long' });
    //             if (monthlySalesInflow[month] !== undefined) {
    //                 monthlySalesInflow[month] += Number(transaction._sum.amount);
    //             }
    //         });

    //         const salesOutflow = await prisma.transaction.groupBy({
    //             by: ['createdAt'],
    //             _sum: {
    //                 amount: true,
    //             },
    //             where: {
    //                 type: 'DEBIT',
    //                 store: {
    //                     isNot: null,
    //                 },
    //                 createdAt: {
    //                     gte: startOfYear(new Date(currentYear, 0, 1)),
    //                     lte: endOfYear(new Date(currentYear, 11, 31)),
    //                 },
    //             },
    //             orderBy: {
    //                 createdAt: 'asc',
    //             },
    //         });

    //         salesOutflow.forEach((transaction) => {
    //             const month = new Date(transaction.createdAt).toLocaleString('default', { month: 'long' });
    //             if (monthlySalesOutflow[month] !== undefined) {
    //                 monthlySalesOutflow[month] += Number(transaction._sum.amount);
    //             }
    //         });

    //         //revenue category
    //         const revenueCategory = await prisma.orderProduct.groupBy({
    //             by: ['categories'],
    //             _count: {
    //               categories: true,
    //             },
    //             orderBy: {
    //               _count: {
    //                 categories: 'desc',
    //               },
    //             },
    //         });

    //         const data = {
    //             revenue,
    //             products,
    //             orders,
    //             stores,
    //             monthlySalesInflow,
    //             monthlySalesOutflow,
    //             revenueCategory,
    //         }

    //         return res.status(201).json({
    //             msg: 'Dashboard data fetched successfully',
    //             success: true,
    //             data
    //         });

    //     } catch (error) {
    //         console.log(error)
    //         return res.status(500).json({ msg: 'Something went wrong', error });
    //     }
    // }
}

export default new AdminDashboardController()