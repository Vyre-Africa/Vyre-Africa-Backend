import { Request, Response } from 'express';
import prisma from '../../config/prisma.client';

class MobileAdvertController {
    async get(req: Request, res: Response){
        try {

            const adverts = await prisma.advert.findMany()

            return res.status(201).json({
                msg: 'adverts fetched successfully',
                success: true,
                adverts
            });
            
        } catch (error) {
            console.log(error)
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }
}

export default new MobileAdvertController()