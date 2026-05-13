import { Request, Response } from 'express';
import prisma from '../../config/prisma.client';
import { endOfDay, endOfWeek, startOfDay, startOfWeek, subDays } from 'date-fns';

class AdminNotificationController {
    // async fetchAll(req: Request | any, res: Response) {

    //     try {
    //         const today = new Date();
    //         const yesterday = subDays(today, 1);
    //         const lastWeek = subDays(today, 7);

    //         // console.log('lastweek', endOfWeek(lastWeek))

    //         const todayNotifications = await prisma.notification.findMany({
    //             where: {
    //                 createdAt: {
    //                     gte: startOfDay(today),
    //                     lte: endOfDay(today)
    //                 }
    //             },
    //             include: { user: true, store: true }
    //         })

    //         const yesterdayNotifications = await prisma.notification.findMany({
    //             where: {
    //                 createdAt: {
    //                     gte: startOfDay(yesterday),
    //                     lte: endOfDay(yesterday)
    //                 }
    //             },
    //             include: { user: true, store: true }
    //         });

    //         const lastWeekNotifications = await prisma.notification.findMany({
    //             where: {
    //                 createdAt: {
    //                     gte: startOfWeek(lastWeek),
    //                     lte: endOfWeek(lastWeek)
    //                 }
    //             },
    //             include: { user: true, store: true }
    //         });

    //         return res
    //             .status(200)
    //             .json({
    //                 msg: 'Successful',
    //                 success: true,
    //                 todayNotifications,
    //                 yesterdayNotifications,
    //                 lastWeekNotifications
    //             });

    //     } catch (error) {
    //         console.log(error);
    //         return res.status(500).json({ msg: 'Something went wrong', error });
    //     }

    // }

    // async filterByDate(req: Request, res: Response) {
    //     const { date_from, date_to } = req.query;

    //     try {

    //         if (!date_from || !date_to) {
    //             return res.status(400).json({ msg: 'Date from and Date to are required', success: false })
    //         }

    //         const dateFrom = new Date(date_from as string);
    //         const dateTo = new Date(date_to as string);

    //         const notifications = await prisma.notification.findMany({
    //             where: {
    //                 createdAt: {
    //                     gte: startOfDay(dateFrom),
    //                     lte: endOfDay(dateTo),
    //                 },
    //             },
    //             include: { user: true, store: true },
    //         });

    //         return res
    //             .status(200)
    //             .json({
    //                 msg: 'Successful',
    //                 success: true,
    //                 notifications
    //             });

    //     } catch (error) {
    //         console.log(error);
    //         return res.status(500).json({ msg: 'Something went wrong', error });
    //     }
    // }

}

export default new AdminNotificationController()