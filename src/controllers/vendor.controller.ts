import { Prisma, Wallet } from '@prisma/client';
import prisma from '../config/prisma.client';
import logger from '../config/logger';
import { PrismaClient } from '@prisma/client';
import { Request, Response } from 'express';
import vendorService from '../services/vendor.service';



class VendorController {

    async apply(req: Request & Record<string, any>, res: Response) {
        try {
            const userId = req.user.id;
            const { businessName, businessType, country, monthlyVolume, description } = req.body;

            if (!businessType || !country) {
                return res.status(400).json({ msg: 'Business type and country are required', success: false });
            }

            const application = await vendorService.applyForVendor(userId, {
                businessName, businessType, country, monthlyVolume, description
            });

            return res.status(200).json({
                msg:     'Application submitted successfully. We will review and notify you within 24-48 hours.',
                success: true,
                data:    application
            });
        } catch (error: any) {
            return res.status(400).json({ msg: error.message, success: false });
        }
    }

    async getStatus(req: Request & Record<string, any>, res: Response) {
        try {
            const result = await vendorService.getVendorStatus(req.user.id);
            return res.status(200).json({ success: true, data: result });
        } catch (error: any) {
            return res.status(500).json({ msg: error.message, success: false });
        }
    }

    async getPending(req: Request & Record<string, any>, res: Response) {
        try {
            const page  = parseInt(req.query.page as string)  || 1;
            const limit = parseInt(req.query.limit as string) || 20;
            const result = await vendorService.getPendingApplications(page, limit);
            return res.status(200).json({ success: true, data: result });
        } catch (error: any) {
            return res.status(500).json({ msg: error.message, success: false });
        }
    }

    async approve(req: Request & Record<string, any>, res: Response) {
        try {
            const { userId } = req.params;
            await vendorService.approveVendor(req.user.id, userId);
            return res.status(200).json({ msg: 'Vendor approved successfully', success: true });
        } catch (error: any) {
            return res.status(400).json({ msg: error.message, success: false });
        }
    }

    async reject(req: Request & Record<string, any>, res: Response) {
        try {
            const { userId } = req.params;
            const { reason }  = req.body;
            if (!reason) return res.status(400).json({ msg: 'Rejection reason is required', success: false });
            await vendorService.rejectVendor(req.user.id, userId, reason);
            return res.status(200).json({ msg: 'Vendor rejected', success: true });
        } catch (error: any) {
            return res.status(400).json({ msg: error.message, success: false });
        }
    }

    async suspend(req: Request & Record<string, any>, res: Response) {
        try {
            const { userId } = req.params;
            const { reason }  = req.body;
            if (!reason) return res.status(400).json({ msg: 'Suspension reason is required', success: false });
            await vendorService.suspendVendor(req.user.id, userId, reason);
            return res.status(200).json({ msg: 'Vendor suspended', success: true });
        } catch (error: any) {
            return res.status(400).json({ msg: error.message, success: false });
        }
    }
}

export default new VendorController();