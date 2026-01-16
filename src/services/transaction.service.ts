import { Request, Response } from 'express';
import prisma from '../config/prisma.config';
import { generateRefCode } from '../utils'
import { TransactionStatus, TransactionType } from '@prisma/client';
import { endOfDay, startOfDay } from 'date-fns';

class TransactionService
{
    // async create(
    //     userId:string|null, 
    //     orderId:string|null, 
    //     amount:number,
    //     status:any,
    //     // paymentMethod:any,
    //     type:any,
    //     description:string,
    //     customer: []
    // )
    // {
    //     const reference = generateRefCode();

    //     return await prisma.transaction.create({
    //         data: {
    //             userId,
    //             // orderId,
    //             reference,
    //             amount,
    //             status,
    //             // paymentMethod,
    //             type,
    //             description,
    //         }
    //     });
    // }

    async getUserRecords(
        userId:string|null,
        limit: number,
    )
    {
        return await prisma.transaction.findMany({
            where: {
              userId
            },
            take: limit ? limit : 20,
            orderBy: { createdAt: "desc" }
        });
    }

    async getwalletRecords(
        walletId:string|null,
        limit: number,
    )
    {
        return await prisma.transaction.findMany({
            where: {
              walletId
            },
            take: limit ? limit : 20,
            orderBy: { createdAt: "desc" }
        });
    }



    async filterByDate(
        userId:string|null,
        limit: string,
        dateFrom: Date,
        dateTo: Date
    )
    {
        return await prisma.transaction.findMany({
            where: {
                userId,
                createdAt: {
                    gte: startOfDay(dateFrom),
                    lte: endOfDay(dateTo)
                }
            },
            include:{
                user: true
            },
            take: limit ? parseInt(limit as string) : 20,
            orderBy: { createdAt: "desc" }
        });
    }

    // async filterByStatusDateType(
    //     userId:string|null, 
    //     limit: string|null,
    //     dateFrom: Date|null,
    //     dateTo: Date|null,
    //     type: string|null,
    //     status: string|null
    // ){
    //     const whereClause: any = {
    //         userId,

    //         ...(dateFrom && dateTo && {
    //             createdAt: {
    //               gte: startOfDay(dateFrom),
    //               lte: endOfDay(dateTo),
    //             },
    //         }),

    //         ...(type && {
    //             type: type as TransactionType
    //         }),

    //         ...(status && {
    //             status: status as TransactionStatus
    //         }),
    //     }
        
    //     const transactions = await prisma.transaction.findMany({
    //         where: whereClause,
    //         take: limit ? parseInt(limit) : 20,
    //         orderBy: {createdAt: "desc"},
    //         include:{
    //             store: {
    //                 include: { organisation: true}
    //             },
    //             user: true,
    //             organisation: true,
    //         },
    //     });

    //     return transactions;
    // }

    async filterByStatus(
        userId:string|null, 
        limit: string,
        status: string,
    )
    {
        return await prisma.transaction.findMany({
            where: {
                userId,
                status: status as TransactionStatus
            },
            include:{
                user: true
            },
            take: limit ? parseInt(limit as string) : 20,
            orderBy: { createdAt: "desc" }
        });
    }

    async filterByType(
        userId:string|null,
        limit: string,
        type: string,
    )
    {
        return await prisma.transaction.findMany({
            where: {
                userId,
                type: type as TransactionType
            },
            take: limit ? parseInt(limit as string) : 20,
            orderBy: { createdAt: "desc" }
        });
    }
}

export default new TransactionService()