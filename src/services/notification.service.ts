import { Request, Response } from 'express';
import prisma from '../config/prisma.config';
import {adminBase} from '../config/firebaseConfig'
import {messaging} from 'firebase-admin'
import mailService from './mail.service';
import {NotificationType} from '@prisma/client';
import smsService from './sms.service';
import config from '../config/env.config';
import mobilePushService from './mobilePush.service';
import { endOfDay, startOfDay } from 'date-fns';
import { Queue } from 'bullmq';
import ablyService from './ably.service';
import connection from '../config/redis.config';

// import connection from '../config/redis.config';

class NotificationService
{

    private generalQueue: Queue;

    constructor() {
        // Initialize the processing queue
        this.generalQueue = new Queue('general-process', {
            connection
        });
    }

    async UserNotify(payload:{
        userId: string,
        title: string, 
        content: string, 
        type: NotificationType
    }) {

        console.log('new notification here')

        try {

            const user = await prisma.user.findUnique({
                where:{id: payload.userId},
                select:{
                    firstName:true,
                    lastName: true,
                    email:true
                }
            })

            await prisma.notification.create({
                data: {
                    userId: payload.userId,
                    title: payload.title,
                    content: payload.content,
                    type: payload.type,
                }
            });


            await mailService.general(
                user?.email as string,
                user?.firstName as string,
                payload.title,
                payload.content
            )
            
            await ablyService.notifyUser(
                payload.userId,
                payload.title,
                payload.content
            )

            
        } catch (error) {
            console.log(error)
        }

    }

    async queue(payload:{
        userId?: string, 
        title: string, 
        content: string,
        type: NotificationType
    }){
        console.log('new notification queue')
       return await this.generalQueue.add('user-notification', payload);
    }


    async create(userId:string|null, storeId:string|null, title:string|null, content:string, type:NotificationType)
    {
        // if(userId){
            return await prisma.notification.create({
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

    async getUserNotification(userId:string, limit:string)
    {
        return await prisma.notification.findMany({
            where: {
                userId,
            },
            take: limit ? parseInt(limit) : 20,
            orderBy: {createdAt: 'desc'}
        });
    }

    async filterUserNotification(
        userId:string, 
        limit: string, 
        dateFrom:Date|null, 
        dateTo:Date|null, 
        type:string|null
    ){
        const whereClause: any = {
            userId,

            ...(dateFrom && dateTo && {
                createdAt: {
                  gte: startOfDay(dateFrom),
                  lte: endOfDay(dateTo),
                },
            }),

            ...(type && {
                type: type as NotificationType
            }),
        }

        const notifications = await prisma.notification.findMany({
            where: whereClause,
            take: limit ? parseInt(limit) : 20,
            orderBy: {createdAt: "desc"}
        });

        return notifications
    }

    // async getStoreNotification(storeId:string|null, dateFrom:Date|null, dateTo:Date|null,)
    // {
    //     if(storeId !== null){
    //         if(dateFrom !== null && dateTo !== null){
    //             return await prisma.notification.findMany({
    //                 where: {
    //                     storeId,
    //                     createdAt: {
    //                         gte: dateFrom,
    //                         lte: dateTo,
    //                     },
    //                 },
    //             });
    //         }
    
    //         return await prisma.notification.findMany({
    //             where: {storeId}
    //         });
    //     }

    //     return [];
    // }
}

export default new NotificationService()