import { Request, Response } from 'express';
import prisma from '../../config/prisma.client';
import { endOfDay, startOfDay } from 'date-fns';
// import { TransactionStatus } from '@prisma/client';

class AdminTransactionController {
    // async fetchAll(req: Request & Record<string, any>, res: Response) {
    //     const { limit, page } = req.query;

    //     try {

    //         const totalCount = await prisma.transaction.count();

    //         const itemLimit = limit ? parseInt(limit as string) : 20;
    //         const totalPages = Math.ceil(totalCount / itemLimit);
    //         const currentPage = page ? Math.max(parseInt(page as string), 1) : 1;
    //         const skip = (currentPage - 1) * itemLimit;


    //         const transactions = await prisma.transaction.findMany({
    //             include: { user: true, store: true,},
    //             skip: skip,
    //             take: itemLimit
    //         });


    //         console.log('Fetched transactions: ', transactions);

    //         return res
    //             .status(200)
    //             .json({
    //                 msg: 'Successful',
    //                 success: true,
    //                 totalCount: totalCount,
    //                 totalPages: totalPages,
    //                 limit: itemLimit,
    //                 currentPage: currentPage,
    //                 transactions: transactions,
    //             });
    //     } catch (error) {
    //         console.log(error);
    //         return res.status(500).json({ msg: 'Something went wrong', error });
    //     }
    // }

    // async search(req: Request | any, res: Response) {
    //     const { limit, page, keyword } = req.query;

    //     try {

    //         if (!keyword) {
    //             return res.status(400).json({ msg: 'Search keyword is required', success: false })
    //         }

    //         const totalCount = await prisma.transaction.count({
    //             where: {
    //                 OR: [
    //                     {
    //                         user: {
    //                             firstName: {
    //                                 contains: keyword,
    //                                 mode: 'insensitive'
    //                             }
    //                         },
    //                     },
    //                     {
    //                         user: {
    //                             lastName: {
    //                                 contains: keyword,
    //                                 mode: 'insensitive'
    //                             }
    //                         },
    //                     },
    //                     {
    //                         id: {
    //                             contains: keyword,
    //                             mode: 'insensitive'
    //                         },
    //                     },
    //                 ]
    //             }
    //         });

    //         const itemLimit = (limit ? parseInt(limit as string) : 20) || 20;
    //         console.log(limit)
    //         const totalPages = Math.ceil(totalCount / itemLimit);

    //         const currentPage = page ? Math.max(parseInt(page as string), 1) : 1;
    //         const skip = (currentPage - 1) * itemLimit;

    //         const transactions = await prisma.transaction.findMany({
    //             where: {
    //                 OR: [
    //                     {
    //                         user: {
    //                             firstName: {
    //                                 contains: keyword,
    //                                 mode: 'insensitive'
    //                             }
    //                         },
    //                     },
    //                     {
    //                         user: {
    //                             lastName: {
    //                                 contains: keyword,
    //                                 mode: 'insensitive'
    //                             }
    //                         },
    //                     },
    //                     {
    //                         id: {
    //                             contains: keyword,
    //                             mode: 'insensitive'
    //                         },
    //                     },
    //                 ]
    //             },
    //             include: {
    //                 user: true,
    //                 store: true,
    //             },
    //             skip: skip,
    //             take: itemLimit || 20
    //         });

    //         return res
    //             .status(200)
    //             .json({
    //                 msg: 'Successful',
    //                 success: true,
    //                 totalCount: totalCount,
    //                 totalPages: totalPages,
    //                 limit: itemLimit,
    //                 currentPage: currentPage,
    //                 transactions,
    //             });

    //     } catch (error) {
    //         console.log(error);
    //         return res.status(500).json({ msg: 'Something went wrong', error });
    //     }
    // }

    // async filterByDate(req: Request, res: Response) {
    //     const { limit, page, date_from, date_to } = req.query;

    //     try {

    //         if (!date_from || !date_to) {
    //             return res.status(400).json({ msg: 'Date from and Date to are required', success: false })
    //         }

    //         const dateFrom = new Date(date_from as string);
    //         const dateTo = new Date(date_to as string);

    //         const totalCount = await prisma.transaction.count({
    //             where: {
    //                 createdAt: {
    //                     gte: startOfDay(dateFrom),
    //                     lte: endOfDay(dateTo),
    //                 },
    //             }
    //         });

    //         const itemLimit = (limit ? parseInt(limit as string) : 20) || 20;
    //         console.log(limit)
    //         const totalPages = Math.ceil(totalCount / itemLimit);

    //         const currentPage = page ? Math.max(parseInt(page as string), 1) : 1;
    //         const skip = (currentPage - 1) * itemLimit;

    //         const transactions = await prisma.transaction.findMany({
    //             where: {
    //                 createdAt: {
    //                     gte: startOfDay(dateFrom),
    //                     lte: endOfDay(dateTo),
    //                 },
    //             },
    //             include: { user: true, store: true },
    //             skip: skip,
    //             take: itemLimit || 20
    //         });

    //         return res
    //             .status(200)
    //             .json({
    //                 msg: 'Successful',
    //                 success: true,
    //                 totalCount: totalCount,
    //                 totalPages: totalPages,
    //                 limit: itemLimit,
    //                 currentPage: currentPage,
    //                 transactions,
    //             });

    //     } catch (error) {
    //         console.log(error);
    //         return res.status(500).json({ msg: 'Something went wrong', error });
    //     }
    // }

    // async filterByStatus(req: Request, res: Response) {
    //     const { limit, page, status } = req.query;

    //     try {

    //         if (!status) {
    //             return res.status(400).json({ msg: 'Status is required', success: false })
    //         }

    //         const totalCount = await prisma.transaction.count({
    //             where: {
    //                 status: status as TransactionStatus,
    //             }
    //         });

    //         const itemLimit = (limit ? parseInt(limit as string) : 20) || 20;
    //         console.log(limit)
    //         const totalPages = Math.ceil(totalCount / itemLimit);

    //         const currentPage = page ? Math.max(parseInt(page as string), 1) : 1;
    //         const skip = (currentPage - 1) * itemLimit;

    //         const transactions = await prisma.transaction.findMany({
    //             where: {
    //                 status: status as TransactionStatus
    //             },
    //             include: { user: true, store: true },
    //             skip: skip,
    //             take: itemLimit || 20
    //         });

    //         return res
    //             .status(200)
    //             .json({
    //                 msg: 'Successful',
    //                 success: true,
    //                 totalCount: totalCount,
    //                 totalPages: totalPages,
    //                 limit: itemLimit,
    //                 currentPage: currentPage,
    //                 transactions,
    //             });

    //     } catch (error) {
    //         console.log(error);
    //         return res.status(500).json({ msg: 'Something went wrong', error });
    //     }
    // }

    
}

export default new AdminTransactionController()