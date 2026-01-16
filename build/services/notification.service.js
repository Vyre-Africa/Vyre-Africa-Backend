"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_config_1 = __importDefault(require("../config/prisma.config"));
const mail_service_1 = __importDefault(require("./mail.service"));
const date_fns_1 = require("date-fns");
const bullmq_1 = require("bullmq");
const ably_service_1 = __importDefault(require("./ably.service"));
const redis_config_1 = __importDefault(require("../config/redis.config"));
// import connection from '../config/redis.config';
class NotificationService {
    constructor() {
        // Initialize the processing queue
        this.generalQueue = new bullmq_1.Queue('general-process', {
            connection: redis_config_1.default
        });
    }
    async UserNotify(payload) {
        console.log('new notification here');
        try {
            const [user, tempUser] = await Promise.all([
                prisma_config_1.default.user.findUnique({
                    where: { id: payload.userId },
                    select: {
                        firstName: true,
                        lastName: true,
                        email: true
                    }
                }),
                prisma_config_1.default.tempUser.findFirst({
                    where: {
                        id: payload.userId
                    },
                    select: {
                        id: true,
                        email: true,
                        phoneNumber: true,
                        accessPin: true,
                        pinExpiresAt: true
                    }
                })
            ]);
            const userRecord = user || tempUser;
            if (user) {
                await prisma_config_1.default.notification.create({
                    data: {
                        userId: payload.userId,
                        title: payload.title,
                        content: payload.content,
                        type: payload.type,
                    }
                });
            }
            await mail_service_1.default.general(user?.email, user?.firstName || 'there', payload.title, payload.content);
            await ably_service_1.default.notifyUser(payload.userId, payload.title, payload.content);
        }
        catch (error) {
            console.log(error);
        }
    }
    async queue(payload) {
        console.log('new notification queue');
        return await this.generalQueue.add('user-notification', payload);
    }
    async create(userId, storeId, title, content, type) {
        // if(userId){
        return await prisma_config_1.default.notification.create({
            data: {
                userId,
                title,
                content,
                type
            }
        });
        // }else{
        //     return await prisma.notification.create({
        //         data: {
        //             storeId,
        //             title,
        //             content,
        //             type,
        //         }
        //     });
        // }
    }
    async getUserNotification(userId, limit) {
        return await prisma_config_1.default.notification.findMany({
            where: {
                userId,
            },
            take: limit ? parseInt(limit) : 20,
            orderBy: { createdAt: 'desc' }
        });
    }
    async filterUserNotification(userId, limit, dateFrom, dateTo, type) {
        const whereClause = {
            userId,
            ...(dateFrom && dateTo && {
                createdAt: {
                    gte: (0, date_fns_1.startOfDay)(dateFrom),
                    lte: (0, date_fns_1.endOfDay)(dateTo),
                },
            }),
            ...(type && {
                type: type
            }),
        };
        const notifications = await prisma_config_1.default.notification.findMany({
            where: whereClause,
            take: limit ? parseInt(limit) : 20,
            orderBy: { createdAt: "desc" }
        });
        return notifications;
    }
}
exports.default = new NotificationService();
