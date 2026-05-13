import { Request, Response } from 'express';
import prisma from '../../config/prisma.client';
import {
    OTP_CODE_EXP,
    compareHashedData,
    generateAccessToken,
    generateOtp,
    generateRefCode,
    hashData,
} from '../../utils';
import mailService from '../../services/mail.service';
import { endOfDay, startOfDay, subMinutes } from 'date-fns';
import NotificationService from '../../services/notification.service'

class AdminBroadCastController {

    // async fetchAll(req: Request | any, res: Response) {
    //     const { limit, page, status } = req.query;
    
    //     try {
    //       const totalCount = await prisma.broadcast.count({
    //         where:{
    //           status: status
    //         },
    //       });
    
    //       const itemLimit = (limit ? parseInt(limit as string) : 20) || 20;
    //       console.log(limit)
    //       const totalPages = Math.ceil(totalCount / itemLimit);
    
    //       const currentPage = page ? Math.max(parseInt(page as string), 1) : 1;
    //       const skip = (currentPage - 1) * itemLimit;
    
    //       const broadcasts = await prisma.broadcast.findMany({
    //         where:{
    //           status: status
    //         },
    //         skip: skip,
    //         take: itemLimit || 20
    //       })
    
    //       return res
    //         .status(200)
    //         .json({
    //           msg: 'Successful',
    //           success: true,
    //           totalCount: totalCount,
    //           totalPages: totalPages,
    //           limit: itemLimit,
    //           currentPage: currentPage,
    //           broadcasts: broadcasts,
    //         });
    
    //     } catch (error) {
    //       console.error(error);
    //       return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
    //     }
    //   }
    

    // async publishBroadcast(req: Request, res: Response){
    //     const { type, title, body, recipient, mode } = req.body;
    //     let scheduledAt = null 

    //     if(req.body.scheduledAt){
    //         scheduledAt = new Date(req.body.scheduledAt as string).toISOString()
    //     }

    //     //type is either instant or scheduled

    //     try {

    //         if(type == 'INSTANT'){
    //             if(mode === 'PUSH'){
    //                 const published = await NotificationService.sendPushNotification(recipient,title,body)
    //                 console.log(published)
    //             }
    
    //             if(mode === 'EMAIL'){
    //                 const published = await NotificationService.sendEmailNotification(recipient,title,body)
    //                 console.log(published)
    //             }

    //             if(mode === 'SMS'){
    //                 const published = await NotificationService.sendSmsNotification(recipient,title,body)
    //                 console.log(published)

    //                 if(!published){
    //                     return res.status(400).json({
    //                         msg: 'Error sending broadcast',
    //                         success: false,
    //                     }); 
    //                 }
    //             }
    //         }

    //         const broadcast = await prisma.broadcast.create({
    //             data: {
    //                 type,
    //                 title,
    //                 body,
    //                 recipient,
    //                 mode,
    //                 status : 'PUBLISHED',
    //                 scheduledAt
    //             }
    //         })
               
    //         return res.status(200).send({
    //             success: true,
    //             msg: 'Broadcast published successfully',
    //             broadcast
    //         });

    //     } catch (error) {
    //         console.log(error)
    //         return res
    //             .status(500)
    //             .json({ msg: 'something went wrong, please try again', success: false, error });
    //     }
    // }

    // async draftBroadcast(req: Request, res: Response){
    //     const { type, title, body, recipient, mode } = req.body;
    //     let scheduledAt = null 

    //     if(req.body.scheduledAt){
    //         scheduledAt = new Date(req.body.scheduledAt as string)
    //     }

    //     //type is either instant or scheduled

    //     try {
    //         const broadcast = await prisma.broadcast.create({
    //             data: {
    //                 type,
    //                 title,
    //                 body,
    //                 recipient,
    //                 mode,
    //                 status : 'DRAFTED',
    //                 scheduledAt
    //             }
    //         })
               
    //         return res.status(200).send({
    //             success: true,
    //             msg: 'Broadcast drafted successfully',
    //             broadcast
    //         });

    //     } catch (error) {
    //         return res
    //             .status(500)
    //             .json({ msg: 'something went wrong, please try again', success: false, error });
    //     }
    // }

    // async sendScheduledBroadcast(){
    //     const now = new Date();
    //     let published:boolean;

    //     const scheduledBroadcast = await prisma.broadcast.findMany({
    //         where: {
    //             type: 'SCHEDULED',
    //             scheduledAt: {
    //                 gte: subMinutes(now, 1),
    //                 lte: now,
    //             },
    //             isSent: false,
    //         },
    //     });

    //     // console.log('Scheduled Broadcasts:', scheduledBroadcast);

    //     if(scheduledBroadcast.length){
    //         scheduledBroadcast.forEach(async (broadcast) => {
    //             if(broadcast.mode === 'PUSH'){
    //                 published = await NotificationService.sendPushNotification(broadcast.recipient,broadcast.title,broadcast.body)
    //                 console.log(published)
    //             }
    
    //             if(broadcast.mode === 'EMAIL'){
    //                 published = await NotificationService.sendEmailNotification(broadcast.recipient,broadcast.title,broadcast.body)
    //                 console.log(published)
    //             }
    
    //             if(broadcast.mode === 'SMS'){
    //                 published = await NotificationService.sendSmsNotification(broadcast.recipient,broadcast.title,broadcast.body)
    //                 console.log(published)
    //             }
    
    //             if(!published){
    //                 console.log('Notification sending failed for broadcast:', broadcast.id);
    //                 return;
    //             }
    
    //             await prisma.broadcast.update({
    //                 where: { id: broadcast.id },
    //                 data: { isSent: true },
    //             });
        
    //             console.log(`Notification with ID ${broadcast.id} sent.`);
    //         });
    //     }
    // }
}   
    

export default new AdminBroadCastController()