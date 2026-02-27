// import { OrderStatus, PrismaClient, StoreStatus, TransactionStatus, UserType } from '@prisma/client';
import { Request, Response } from 'express';
import prisma from '../config/prisma.config';
import config from '../config/env.config';
import mailService from '../services/mail.service';
import { generateRefCode, OTP_CODE_EXP, hashData } from '../utils';
import transactionService from '../services/transaction.service';
import dashboardService from '../services/dashboard.service';
import notificationService from '../services/notification.service';
import walletService from '../services/wallet.service';
import orderService from '../services/order.service';
import { calculateDistance } from '../utils';

import { serve } from 'swagger-ui-express';
import { endOfDay, startOfDay } from 'date-fns';
import { configDotenv } from 'dotenv';

const VALID_STATUSES    = ['pending', 'in_review', 'contacted', 'completed', 'cancelled'];
const VALID_TRADE_TYPES = ['crypto_to_fiat', 'fiat_to_crypto', 'fiat_to_fiat'];
const VALID_USER_TYPES  = ['individual', 'business'];
const VALID_CONTACTS    = ['whatsapp', 'email', 'call'];

class OtcController {

  async submitOtcRequest(req: Request & Record<string, any>, res: Response){
    // const validationError = handleValidationErrors(req, res);
    // if (validationError) return;

    try {
      const {
        fullName, email, phoneNumber, userType,
        preferredContact, tradeType, fromCurrency, toCurrency,
        amount, additionalNotes, receivingDetails,
        idDocumentUrl, proofOfAddressUrl, invoiceUrl,
      } = req.body;

      if (userType === 'business' && !invoiceUrl) {
        return res.status(400).json({
          success: false,
          message: 'Business accounts must provide an invoice URL.',
        });
      }

      const otcRequest = await prisma.otcRequest.create({
        data: {
          fullName,
          email,
          phoneNumber,
          userType,
          preferredContact,
          tradeType,
          fromCurrency:     fromCurrency.toUpperCase(),
          toCurrency:       toCurrency.toUpperCase(),
          amount,
          additionalNotes:  additionalNotes || null,
          receivingDetails: receivingDetails.map(({ label, value }:{label:string; value:string}) => ({
            label: label.trim(),
            value: value.trim(),
          })),
          idDocumentUrl,
          proofOfAddressUrl,
          invoiceUrl:       invoiceUrl || null,
        },
      });

      // Fire-and-forget — don't block the response
      // sendOtcRequestNotification(otcRequest).catch((err) => {
      //   console.error('[OTC] Team email notification failed:', err.message);
      // });

      await Promise.all([
        notificationService.queue({
          userId:'cmbqddgo70001tnzzofxat7r9',
          title:'OTC Request Placed',
          content:`you have an OTC request with Id request reference is <strong>${otcRequest.id}</strong> —`,
          type:'GENERAL'
        }),

        notificationService.queue({
          userId:'user_38OI3Y47pS0u4gKiRoee5GySGiV',
          title:'OTC Request Placed',
          content:`you have an OTC request with Id request reference is <strong>${otcRequest.id}</strong> —`,
          type:'GENERAL'
        }),

        notificationService.queue({
          userId:'user_39bKMIkrHqCtZlr0DoKPQ9ikkWU',
          title:'OTC Request Placed',
          content:`you have an OTC request with Id request reference is <strong>${otcRequest.id}</strong> —`,
          type:'GENERAL'
        })


      ])

      mailService.general(
        email as string,
        fullName || 'there',
        'OTC Request Received – We\'re On It',
        `Thanks for submitting your OTC request. Here's what happens next:

        1. Our desk will review your request within the next few hours
        2. We'll reach out to you via ${preferredContact} to confirm the details and agree on a rate
        3. Once confirmed, we'll process your trade and send you a completion update

        Your request reference is <strong>${otcRequest.id}</strong> — keep this handy in case you need to follow up.

        If you have any urgent questions in the meantime, reply to this email or contact us directly.`
      ).catch((err: Error) => {
        console.error('[OTC] User confirmation email failed:', err.message);
      });

      mailService.general(
        email as string,
        'Team',
        'OTC Request Received – We\'re On It',
        `Thanks for submitting your OTC request. Here's what happens next:

        1. Our desk will review your request within the next few hours
        2. We'll reach out to you via ${preferredContact} to confirm the details and agree on a rate
        3. Once confirmed, we'll process your trade and send you a completion update

        Your request reference is <strong>${otcRequest.id}</strong> — keep this handy in case you need to follow up.

        If you have any urgent questions in the meantime, reply to this email or contact us directly.`
      ).catch((err: Error) => {
        console.error('[OTC] User confirmation email failed:', err.message);
      });

      return res.status(201).json({
        success: true,
        message: 'OTC request submitted. Our team will be in touch shortly.',
        data: {
          requestId: otcRequest.id,
          status:    otcRequest.status,
          createdAt: otcRequest.createdAt,
        },
      });
    } catch (err) {
      console.error('[OTC] submitOtcRequest error:', err);
      return res.status(500).json({
        success: false,
        message: 'Failed to submit OTC request. Please try again.',
      });
    }
  };

  async listOtcRequests(req: Request & Record<string, any>, res: Response) {
    try {
      const { status, tradeType, search, page = '1', limit = '20', sort = 'desc' } = req.query;

      const take = Math.min(Math.max(parseInt(limit as string) || 20, 1), 100);
      const skip = (Math.max(parseInt(page as string) || 1, 1) - 1) * take;

      const where:any = {};
      if (status    && VALID_STATUSES.includes(status as string))       where.status    = status;
      if (tradeType && VALID_TRADE_TYPES.includes(tradeType as string)) where.tradeType = tradeType;
      if (search) {
        where.OR = [
          { fullName: { contains: search, mode: 'insensitive' } },
          { email:    { contains: search, mode: 'insensitive' } },
          { id:       { contains: search, mode: 'insensitive' } },
        ];
      }

      const [requests, total] = await prisma.$transaction([
        prisma.otcRequest.findMany({
          where,
          orderBy: { createdAt: sort === 'asc' ? 'asc' : 'desc' },
          skip,
          take,
          select: {
            id: true, fullName: true, email: true, phoneNumber: true,
            userType: true, tradeType: true, fromCurrency: true, toCurrency: true,
            amount: true, preferredContact: true, status: true, createdAt: true,
          },
        }),
        prisma.otcRequest.count({ where }),
      ]);

      return res.status(200).json({
        success: true,
        data: requests,
        pagination: {
          total,
          page:       parseInt(page as any),
          limit:      take,
          totalPages: Math.ceil(total / take),
          hasNext:    skip + take < total,
          hasPrev:    skip > 0,
        },
      });
    } catch (err) {
      console.error('[OTC] listOtcRequests error:', err);
      return res.status(500).json({ success: false, message: 'Failed to fetch OTC requests.' });
    }
  };

  async getOtcRequest(req: Request & Record<string, any>, res: Response) {
    try {
      const request = await prisma.otcRequest.findUnique({ where: { id: req.params.id } });
      if (!request) {
        return res.status(404).json({ success: false, message: 'OTC request not found.' });
      }
      return res.status(200).json({ success: true, data: request });
    } catch (err) {
      console.error('[OTC] getOtcRequest error:', err);
      return res.status(500).json({ success: false, message: 'Failed to fetch OTC request.' });
    }
  };

  async updateOtcStatus(req: Request & Record<string, any>, res: Response) {
    try {
      const { status, adminNotes } = req.body;

      const existing = await prisma.otcRequest.findUnique({ where: { id: req.params.id } });
      if (!existing) {
        return res.status(404).json({ success: false, message: 'OTC request not found.' });
      }

      const updated = await prisma.otcRequest.update({
        where: { id: req.params.id },
        data: {
          status,
          adminNotes: adminNotes?.trim() || null,
        },
      });

      // Notify user only if status actually changed
      if (status !== existing.status) {

        const STATUS_COPY: Record<string, { title: string; message: string }> = {
          in_review: {
            title: 'Your OTC Request is Under Review',
            message: `Good news — our OTC desk has picked up your request and is currently reviewing the details.
            
              We'll reach out to you via <strong>${existing.preferredContact}</strong> shortly to confirm the rate and agree on next steps. Please keep an eye out for our message.

              Your reference: <strong>${existing.id}</strong>`,
          },
          contacted: {
            title: 'We\'ve Reached Out – Please Respond',
            message: `Our OTC desk has attempted to contact you via <strong>${existing.preferredContact}</strong>.

              Please respond so we can lock in your rate and move forward with the trade. Rates are subject to market movement, so the sooner we hear back, the better.

              If you haven't received anything, double-check your ${existing.preferredContact === 'email' ? 'inbox and spam folder' : `${existing.preferredContact} messages`} or reply to this email and we'll follow up.

              Your reference: <strong>${existing.id}</strong>`,
          },
          completed: {
            title: 'Your OTC Trade is Complete 🎉',
            message: `Great news — your trade has been completed successfully.

            <strong>${existing.fromCurrency} → ${existing.toCurrency}</strong> | ${Number(existing.amount).toLocaleString()} ${existing.fromCurrency}

            The funds should reflect on your end shortly. If you experience any issues or don't see the funds within the expected timeframe, please reach out to us immediately.

            Thank you for trading with Vyre Africa. We look forward to working with you again.

            Your reference: <strong>${existing.id}</strong>`,
          },
          cancelled: {
            title: 'Your OTC Request Has Been Cancelled',
            message: `Unfortunately your OTC request has been cancelled.

              <strong>${existing.fromCurrency} → ${existing.toCurrency}</strong> | ${Number(existing.amount).toLocaleString()} ${existing.fromCurrency}

              If you believe this was a mistake or would like to understand why, please reply to this email and our team will assist you.

              You're welcome to submit a new request at any time.

              Your reference: <strong>${existing.id}</strong>`,
          },
        };

        const copy = STATUS_COPY[status];

        if (copy) {
          mailService.general(
            existing.email as string,
            existing.fullName || 'there',
            copy.title,
            copy.message,
          ).catch((err: Error) => {
            console.error('[OTC] Status update email failed:', err.message);
          });
        }
      }

      return res.status(200).json({
        success: true,
        message: `Status updated to "${status}".`,
        data: updated,
      });

    } catch (err: any) {
      if (err.code === 'P2025') {
        return res.status(404).json({ success: false, message: 'OTC request not found.' });
      }
      console.error('[OTC] updateOtcStatus error:', err);
      return res.status(500).json({ success: false, message: 'Failed to update status.' });
    }
  };
  
}

export default new OtcController();
