import { Request, Response } from 'express';
import prisma from '../../config/prisma.client';
import { endOfDay, startOfDay } from 'date-fns';
// import { OrderStatus } from '@prisma/client';

class AdminOrderController {
    // async fetchAll(req: Request & Record<string, any>, res: Response) {
    //     const { limit, page } = req.query;

    //     try {

    //         const totalCount = await prisma.order.count();

    //         const itemLimit = limit ? parseInt(limit as string) : 20;
    //         const totalPages = Math.ceil(totalCount / itemLimit);
    //         const currentPage = page ? Math.max(parseInt(page as string), 1) : 1;
    //         const skip = (currentPage - 1) * itemLimit;


    //         const orders = await prisma.order.findMany({
    //             include: { user: true, store: true, products: true },
    //             skip: skip,
    //             take: itemLimit
    //         });


    //         console.log('Fetched orders: ', orders);

    //         return res
    //             .status(200)
    //             .json({
    //                 msg: 'Successful',
    //                 success: true,
    //                 totalCount: totalCount,
    //                 totalPages: totalPages,
    //                 limit: itemLimit,
    //                 currentPage: currentPage,
    //                 orders: orders,
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

    //         const totalCount = await prisma.order.count({
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

    //         const orders = await prisma.order.findMany({
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
    //                 products: true,
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
    //                 orders,
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

    //         const totalCount = await prisma.order.count({
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

    //         const orders = await prisma.order.findMany({
    //             where: {
    //                 createdAt: {
    //                     gte: startOfDay(dateFrom),
    //                     lte: endOfDay(dateTo),
    //                 },
    //             },
    //             include: { user: true, store: true, products: true },
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
    //                 orders,
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

    //         const totalCount = await prisma.order.count({
    //             where: {
    //                 Status: status as OrderStatus,
    //             }
    //         });

    //         const itemLimit = (limit ? parseInt(limit as string) : 20) || 20;
    //         console.log(limit)
    //         const totalPages = Math.ceil(totalCount / itemLimit);

    //         const currentPage = page ? Math.max(parseInt(page as string), 1) : 1;
    //         const skip = (currentPage - 1) * itemLimit;

    //         const orders = await prisma.order.findMany({
    //             where: {
    //                 Status: status as OrderStatus
    //             },
    //             include: { user: true, store: true, products: true },
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
    //                 orders,
    //             });

    //     } catch (error) {
    //         console.log(error);
    //         return res.status(500).json({ msg: 'Something went wrong', error });
    //     }
    // }

    // async fetchUserOrder(req: Request & Record<string, any>, res: Response) {
    //     const { limit, page } = req.query;
    //     const userId = req.params.user_id as string

    //     try {

    //         //find user
    //         const user = await prisma.user.findUnique({
    //             where: {id: userId}
    //         })

    //         if(!userId || !user){
    //             return res
    //             .status(400)
    //             .json({ msg: 'User not found', success: false });
    //         }

    //         const totalCount = await prisma.order.count({
    //             where: {userId}
    //         });

    //         const itemLimit = limit ? parseInt(limit as string) : 20;
    //         const totalPages = Math.ceil(totalCount / itemLimit);
    //         const currentPage = page ? Math.max(parseInt(page as string), 1) : 1;
    //         const skip = (currentPage - 1) * itemLimit;


    //         const orders = await prisma.order.findMany({
    //             where: {userId},
    //             include: { user: true, store: true, products: true },
    //             skip: skip,
    //             take: itemLimit
    //         });
            
    //         console.log('Fetched orders: ', orders);

    //         return res
    //             .status(200)
    //             .json({
    //                 msg: 'Successful',
    //                 success: true,
    //                 totalCount: totalCount,
    //                 totalPages: totalPages,
    //                 limit: itemLimit,
    //                 currentPage: currentPage,
    //                 orders,
    //                 user
    //             });
    //     } catch (error) {
    //         console.log(error);
    //         return res.status(500).json({ msg: 'Something went wrong', error });
    //     }
    // }

    // async searchUserOrder(req: Request | any, res: Response) {
    //     const { limit, page, keyword } = req.query;
    //     const userId = req.params.user_id as string

    //     try {

    //         if (!keyword) {
    //             return res.status(400).json({ msg: 'Search keyword is required', success: false })
    //         }

    //         //find user
    //         const user = await prisma.user.findUnique({
    //             where: {id: userId}
    //         })

    //         if(!userId || !user){
    //             return res
    //             .status(400)
    //             .json({ msg: 'User not found', success: false });
    //         }

    //         const totalCount = await prisma.order.count({
    //             where: {
    //                 userId,
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

    //         const orders = await prisma.order.findMany({
    //             where: {
    //                 userId,
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
    //                 products: true,
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
    //                 orders: orders,
    //                 user
    //             });

    //     } catch (error) {
    //         console.log(error);
    //         return res.status(500).json({ msg: 'Something went wrong', error });
    //     }
    // }

    // async filterUserOrderByDate(req: Request, res: Response) {
    //     const { limit, page, date_from, date_to } = req.query;
    //     const userId = req.params.user_id as string

    //     try {

    //         if (!date_from || !date_to) {
    //             return res.status(400).json({ msg: 'Date from and Date to are required', success: false })
    //         }

    //         //find user
    //         const user = await prisma.user.findUnique({
    //             where: {id: userId}
    //         })

    //         if(!userId || !user){
    //             return res
    //             .status(400)
    //             .json({ msg: 'User not found', success: false });
    //         }

    //         const dateFrom = new Date(date_from as string);
    //         const dateTo = new Date(date_to as string);

    //         const totalCount = await prisma.order.count({
    //             where: {
    //                 userId,
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

    //         const users = await prisma.order.findMany({
    //             where: {
    //                 userId,
    //                 createdAt: {
    //                     gte: startOfDay(dateFrom),
    //                     lte: endOfDay(dateTo),
    //                 },
    //             },
    //             include: { user: true, store: true, products: true },
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
    //                 users: users,
    //             });

    //     } catch (error) {
    //         console.log(error);
    //         return res.status(500).json({ msg: 'Something went wrong', error });
    //     }
    // }

    // async filterUserOrderByStatus(req: Request, res: Response) {
    //     const { limit, page, status } = req.query;
    //     const userId = req.params.user_id as string

    //     try {

    //         if (!status) {
    //             return res.status(400).json({ msg: 'Status is required', success: false })
    //         }

    //          //find user
    //         const user = await prisma.user.findUnique({
    //             where: {id: userId}
    //         })

    //         if(!userId || !user){
    //             return res
    //             .status(400)
    //             .json({ msg: 'User not found', success: false });
    //         }

    //         const totalCount = await prisma.order.count({
    //             where: {
    //                 userId,
    //                 Status: status as OrderStatus,
    //             }
    //         });

    //         const itemLimit = (limit ? parseInt(limit as string) : 20) || 20;
    //         console.log(limit)
    //         const totalPages = Math.ceil(totalCount / itemLimit);

    //         const currentPage = page ? Math.max(parseInt(page as string), 1) : 1;
    //         const skip = (currentPage - 1) * itemLimit;

    //         const users = await prisma.order.findMany({
    //             where: {
    //                 userId,
    //                 Status: status as OrderStatus
    //             },
    //             include: { user: true, store: true, products: true },
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
    //                 users: users,
    //             });

    //     } catch (error) {
    //         console.log(error);
    //         return res.status(500).json({ msg: 'Something went wrong', error });
    //     }
    // }
}

export default new AdminOrderController()