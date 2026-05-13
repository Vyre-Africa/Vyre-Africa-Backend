// import { OrderStatus, PrismaClient, StoreStatus, TransactionStatus, UserType } from '@prisma/client';
import { Request, Response } from 'express';
import prisma from '../config/prisma.client';
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

class AccountController {

  async deleteAccountById(accountId: string): Promise<boolean> {
    try {
      // First try to delete from fiat accounts
      const deletedFiatAccount = await prisma.fiatAccount.deleteMany({
        where: {
          id: accountId
        }
      })
  
      // If a fiat account was deleted, return true
      if (deletedFiatAccount.count > 0) {
        return true
      }
  
      // If no fiat account was found, try crypto accounts
      const deletedCryptoAccount = await prisma.cryptoAccount.deleteMany({
        where: {
          id: accountId
        }
      })
  
      // Return true if a crypto account was deleted
      return deletedCryptoAccount.count > 0
    } catch (error) {
      console.error('Error deleting account:', error)
      return false
    }
  }
  
}

export default new AccountController();
