import { Prisma, Wallet } from '@prisma/client';
import prisma from '../config/prisma.client';
import notificationService from './notification.service';
import logger from '../config/logger';



// src/services/vendor.service.ts
class VendorService {

    async applyForVendor(userId: string, payload: {
        businessName?:  string
        businessType:   string
        country:        string
        monthlyVolume?: string
        description?:   string
    }) {
        // Check if already applied
        const existing = await prisma.vendorApplication.findUnique({
            where: { userId }
        });

        if (existing) {
            if (existing.status === 'PENDING') {
                throw new Error('You already have a pending application.');
            }
            if (existing.status === 'APPROVED') {
                throw new Error('You are already an approved vendor.');
            }
            if (existing.status === 'REJECTED') {
                // Allow reapplication — update existing
                return await prisma.vendorApplication.update({
                    where: { userId },
                    data: {
                        ...payload,
                        status:         'PENDING',
                        reviewedBy:     null,
                        reviewedAt:     null,
                        rejectionReason: null
                    }
                });
            }
        }

        return await prisma.vendorApplication.create({
            data: { userId, ...payload }
        });
    }

    // ── Admin: approve vendor ─────────────────────────────
    async approveVendor(adminId: string, userId: string) {
        await prisma.$transaction(async (tx) => {
            await tx.vendorApplication.update({
                where: { userId },
                data: {
                    status:     'APPROVED',
                    reviewedBy: adminId,
                    reviewedAt: new Date()
                }
            });

            await tx.user.update({
                where: { id: userId },
                data: { isVendor: true }
            });
        });

        // Notify user
        await notificationService.queue({
            userId,
            title:   'Vendor Application Approved 🎉',
            type:    'GENERAL',
            content: 'Congratulations! Your vendor application has been approved. You can now create orders on the Vyre marketplace.'
        });

        logger.info('Vendor approved', { userId, adminId });
    }

    // ── Admin: reject vendor ──────────────────────────────
    async rejectVendor(adminId: string, userId: string, reason: string) {
        await prisma.vendorApplication.update({
            where: { userId },
            data: {
                status:          'REJECTED',
                reviewedBy:      adminId,
                reviewedAt:      new Date(),
                rejectionReason: reason
            }
        });

        await notificationService.queue({
            userId,
            title:   'Vendor Application Update',
            type:    'GENERAL',
            content: `Your vendor application was not approved at this time. Reason: ${reason}. You may reapply after addressing the feedback.`
        });

        logger.info('Vendor rejected', { userId, adminId, reason });
    }

    // ── Admin: suspend vendor ─────────────────────────────
    async suspendVendor(adminId: string, userId: string, reason: string) {
        await prisma.$transaction(async (tx) => {
            await tx.vendorApplication.update({
                where: { userId },
                data: {
                    status:           'SUSPENDED',
                    reviewedBy:       adminId,
                    reviewedAt:       new Date(),
                    suspensionReason: reason
                }
            });

            await tx.user.update({
                where: { id: userId },
                data: { isVendor: false }
            });

            // Cancel all active orders for suspended vendor
            await tx.order.updateMany({
                where: { userId, status: { in: ['OPEN'] } },
                data:  { status: 'CANCELED' }
            });
        });

        await notificationService.queue({
            userId,
            title:   'Account Suspended',
            type:    'GENERAL',
            content: `Your vendor account has been suspended. Reason: ${reason}. Please contact support for more information.`
        });

        logger.info('Vendor suspended', { userId, adminId, reason });
    }

    // ── Get all pending applications (admin) ──────────────
    async getPendingApplications(page = 1, limit = 20) {
        const skip = (page - 1) * limit;

        const [applications, total] = await Promise.all([
            prisma.vendorApplication.findMany({
                where:   { status: 'PENDING' },
                include: {
                    user: {
                        select: {
                            id:          true,
                            email:       true,
                            firstName:   true,
                            lastName:    true,
                            phoneNumber: true,
                            createdAt:   true
                        }
                    }
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit
            }),
            prisma.vendorApplication.count({ where: { status: 'PENDING' } })
        ]);

        return { applications, total, page, limit };
    }

    // ── Check vendor status ───────────────────────────────
    async getVendorStatus(userId: string) {
        const application = await prisma.vendorApplication.findUnique({
            where: { userId }
        });

        if (!application) return { status: 'NOT_APPLIED', application: null };
        return { status: application.status, application };
    }
}

export default new VendorService();