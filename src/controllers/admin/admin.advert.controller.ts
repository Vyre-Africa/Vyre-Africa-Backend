import { Request, Response } from 'express';
import prisma from '../../config/prisma.client';

import mailService from '../../services/mail.service';
import { endOfDay, startOfDay } from 'date-fns';
import NotificationService from '../../services/notification.service'

class AdminAdvertController {
    async fetchpublished(req: Request & Record<string, any>, res: Response) {
        const { limit, page } = req.query;

        try {

            const totalCount = await prisma.advert.count();

            const itemLimit = limit ? parseInt(limit as string) : 20;
            const totalPages = Math.ceil(totalCount / itemLimit);
            const currentPage = page ? Math.max(parseInt(page as string), 1) : 1;
            const skip = (currentPage - 1) * itemLimit;


            const adverts = await prisma.advert.findMany({
                skip: skip,
                take: itemLimit
            });


            console.log('Fetched adverts: ', adverts);

            return res
                .status(200)
                .json({
                    msg: 'Successful',
                    success: true,
                    totalCount: totalCount,
                    totalPages: totalPages,
                    limit: itemLimit,
                    currentPage: currentPage,
                    adverts: adverts,
                });
        } catch (error) {
            console.log(error);
            return res.status(500).json({ msg: 'Something went wrong', error });
        }
    }

    async fetchDrafts(req: Request & Record<string, any>, res: Response) {
        const { limit, page } = req.query;

        try {

            const totalCount = await prisma.advertDraft.count();

            const itemLimit = limit ? parseInt(limit as string) : 20;
            const totalPages = Math.ceil(totalCount / itemLimit);
            const currentPage = page ? Math.max(parseInt(page as string), 1) : 1;
            const skip = (currentPage - 1) * itemLimit;


            const adverts = await prisma.advertDraft.findMany({
                skip: skip,
                take: itemLimit
            });


            console.log('Fetched adverts: ', adverts);

            return res
                .status(200)
                .json({
                    msg: 'Successful',
                    success: true,
                    totalCount: totalCount,
                    totalPages: totalPages,
                    limit: itemLimit,
                    currentPage: currentPage,
                    adverts: adverts,
                });
        } catch (error) {
            console.log(error);
            return res.status(500).json({ msg: 'Something went wrong', error });
        }
    }

    async createAdvert(req: Request, res: Response) {
        const { title, imgUrl } = req.body;

        try {

            const advert = await prisma.advert.create({
                data: {
                    title: title,
                    imgUrl: imgUrl
                }
            })

            return res.status(200).send({
                success: true,
                msg: 'Advert created successfully',
                advert
            });


        } catch (error) {
            console.log(error)
            return res
                .status(500)
                .json({ msg: 'something went wrong, please try again', success: false, error });
        }
    }

    async createDraft(req: Request, res: Response) {
        const { title, imgUrl } = req.body;

        try {

            const advertDraft = await prisma.advertDraft.create({
                data: {
                    title: title,
                    imgUrl: imgUrl
                }
            })

            return res.status(200).send({
                success: true,
                msg: 'Draft created successfully',
                advert: advertDraft
            });


        } catch (error) {
            return res
                .status(500)
                .json({ msg: 'something went wrong, please try again', success: false, error });
        }
    }

    async update(req: Request, res: Response) {
        const { title, imgUrl, type } = req.body
        const id = req.params.id
        let updatedAdvert;

        try {

            switch (type) {
                case 'published':
                    await prisma.advert.update({
                        where: { id },
                        data: { title, imgUrl }
                    })

                    updatedAdvert = await prisma.advert.findUnique({
                        where: { id }
                    })
                    break;

                case 'draft':
                    await prisma.advertDraft.update({
                        where: { id },
                        data: { title, imgUrl }
                    })

                    updatedAdvert = await prisma.advertDraft.findUnique({
                        where: { id }
                    })
                    break;

                default:
                    return res.status(400).json({ msg: 'type is undefined', success: false });
            }

            return res.status(200).send({
                success: true,
                msg: 'Draft updated successfully',
                advert: updatedAdvert
            });


        } catch (error) {
            return res
                .status(500)
                .json({ msg: 'something went wrong, please try again', success: false, error });
        }
    }

    async delete(req: Request, res: Response) {
        const { type } = req.body
        const id = req.params.id

        try {

            switch (type) {
                case 'published':
                    await prisma.advert.delete({
                        where: { id },
                    })
                    break;

                case 'draft':
                    await prisma.advertDraft.delete({
                        where: { id },
                    })
                    break;

                default:
                    return res.status(400).json({ msg: 'type is undefined', success: false });
            }

            return res.status(200).send({
                success: true,
                msg: 'Draft deleted successfully',
            });


        } catch (error) {
            return res
                .status(500)
                .json({ msg: 'something went wrong, please try again', success: false, error });
        }
    }
}


export default new AdminAdvertController()