import { Request, Response } from 'express';
import prisma from '../config/prisma.config';

class AccountService {
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
          // console.error('Error deleting account:', error)
          return false
        }
    }
      
    
}

export default new AccountService()