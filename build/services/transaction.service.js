"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_config_1 = __importDefault(require("../config/prisma.config"));
const date_fns_1 = require("date-fns");
class TransactionService {
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
    async getUserRecords(userId, limit) {
        return await prisma_config_1.default.transaction.findMany({
            where: {
                userId
            },
            take: limit ? limit : 20,
            orderBy: { createdAt: "desc" }
        });
    }
    async getwalletRecords(walletId, limit) {
        return await prisma_config_1.default.transaction.findMany({
            where: {
                walletId
            },
            take: limit ? limit : 20,
            orderBy: { createdAt: "desc" }
        });
    }
    async filterByDate(userId, limit, dateFrom, dateTo) {
        return await prisma_config_1.default.transaction.findMany({
            where: {
                userId,
                createdAt: {
                    gte: (0, date_fns_1.startOfDay)(dateFrom),
                    lte: (0, date_fns_1.endOfDay)(dateTo)
                }
            },
            include: {
                user: true
            },
            take: limit ? parseInt(limit) : 20,
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
    async filterByStatus(userId, limit, status) {
        return await prisma_config_1.default.transaction.findMany({
            where: {
                userId,
                status: status
            },
            include: {
                user: true
            },
            take: limit ? parseInt(limit) : 20,
            orderBy: { createdAt: "desc" }
        });
    }
    async filterByType(userId, limit, type) {
        return await prisma_config_1.default.transaction.findMany({
            where: {
                userId,
                type: type
            },
            take: limit ? parseInt(limit) : 20,
            orderBy: { createdAt: "desc" }
        });
    }
}
exports.default = new TransactionService();
