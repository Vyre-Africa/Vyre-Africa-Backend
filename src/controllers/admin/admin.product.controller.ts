import { Request, Response } from 'express';
import prisma from '../../config/prisma.client';
import { endOfDay, startOfDay } from 'date-fns';

class AdminProductController {
  // async fetchAll(req: Request | any, res: Response) {
  //   const { limit, page } = req.query;

  //   try {
  //     const totalCount = await prisma.product.count();

  //     const itemLimit = (limit ? parseInt(limit as string) : 20) || 20;
  //     console.log(limit)
  //     const totalPages = Math.ceil(totalCount / itemLimit);

  //     const currentPage = page ? Math.max(parseInt(page as string), 1) : 1;
  //     const skip = (currentPage - 1) * itemLimit;

  //     const products = await prisma.product.findMany({
  //       include: { store: true, images: true },
  //       skip: skip,
  //       take: itemLimit || 20
  //     })

  //     return res
  //       .status(200)
  //       .json({
  //         msg: 'Successful',
  //         success: true,
  //         totalCount: totalCount,
  //         totalPages: totalPages,
  //         limit: itemLimit,
  //         currentPage: currentPage,
  //         products: products,
  //       });

  //   } catch (error) {
  //     console.error(error);
  //     return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
  //   }
  // }

  // async search(req: Request | any, res: Response) {
  //   const { limit, page, keyword } = req.query;

  //   try {

  //     if (!keyword) {
  //       // return res.status(400).json({ msg: 'Search keyword is required', success: false })
  //        return res
  //       .status(200)
  //       .json({
  //         msg: 'Successful',
  //         success: true,
  //         totalCount: 0,
  //         totalPages: 1,
  //         limit: 10,
  //         currentPage: 1,
  //         products: [],
  //       });
  //     }

  //     const totalCount = await prisma.product.count({
  //       where: {
  //         OR: [
  //           {
  //             name: {
  //               contains: keyword,
  //               mode: 'insensitive'
  //             }
  //           },
  //           {
  //             SKU: {
  //               contains: keyword,
  //               mode: 'insensitive'
  //             }
  //           },
  //         ]
  //       }
  //     });

  //     const itemLimit = (limit ? parseInt(limit as string) : 20) || 20;
  //     console.log(limit)
  //     const totalPages = Math.ceil(totalCount / itemLimit);

  //     const currentPage = page ? Math.max(parseInt(page as string), 1) : 1;
  //     const skip = (currentPage - 1) * itemLimit;

  //     const products = await prisma.product.findMany({
  //       where: {
  //         OR: [
  //           {
  //             name: {
  //               contains: keyword,
  //               mode: 'insensitive'
  //             }
  //           },
  //           {
  //             SKU: {
  //               contains: keyword,
  //               mode: 'insensitive'
  //             }
  //           },
  //         ]
  //       },
  //       include: { store: true, images: true },
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
  //         products: products,
  //       });

  //   } catch (error) {
  //     console.log(error);
  //     return res.status(500).json({ msg: 'Something went wrong', error });
  //   }
  // }

  // async filterByDate(req: Request, res: Response) {
  //   const { limit, page, date_from, date_to } = req.query;

  //   try {

  //     if (!date_from || !date_to) {
  //       return res.status(400).json({ msg: 'Date from and Date to are required', success: false })
  //     }

  //     const dateFrom = new Date(date_from as string);
  //     const dateTo = new Date(date_to as string);

  //     const totalCount = await prisma.product.count({
  //       where: {
  //         createdAt: {
  //           gte: startOfDay(dateFrom),
  //           lte: endOfDay(dateTo),
  //         },
  //       }
  //     });

  //     const itemLimit = (limit ? parseInt(limit as string) : 20) || 20;
  //     console.log(limit)
  //     const totalPages = Math.ceil(totalCount / itemLimit);

  //     const currentPage = page ? Math.max(parseInt(page as string), 1) : 1;
  //     const skip = (currentPage - 1) * itemLimit;

  //     const products = await prisma.product.findMany({
  //       where: {
  //         createdAt: {
  //           gte: startOfDay(dateFrom),
  //           lte: endOfDay(dateTo),
  //         },
  //       },
  //       include: { store: true, images: true },
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
  //         products: products,
  //       });

  //   } catch (error) {
  //     console.log(error);
  //     return res.status(500).json({ msg: 'Something went wrong', error });
  //   }
  // }
}

export default new AdminProductController()