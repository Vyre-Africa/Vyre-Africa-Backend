import { Request, Response } from 'express';
import prisma from '../config/prisma.client';

class BankAccountController {

  // POST /wallet/bank-account
  // Persists the user's payout bank account — asked for exactly once.
  // No verification call is made here: Qorepay's own account-creation flow
  // (PENDING -> ACTIVE) is the verification step, per product decision.
  async addBankAccount(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const { bankId, accountNumber } = req.body as {
      bankId?: string;
      accountNumber?: string;
    };

    try {
      if (!bankId || !accountNumber) {
        return res.status(400).json({
          success: false,
          msg: 'bankId and accountNumber are required',
        });
      }

      const bank = await prisma.bank.findUnique({ where: { id: bankId } });
      if (!bank) {
        return res.status(400).json({ success: false, msg: 'Bank not found' });
      }

      await prisma.user.update({
        where: { id: user.id },
        data: {
          bankId,
          bankCode: bank.code,
          bankAccountNumber: accountNumber,
        },
      });

      return res.status(200).json({
        success: true,
        msg: 'Bank account saved',
      });

    } catch (error) {
      console.log(error);
      return res.status(500).json({ msg: 'Internal Server Error', success: false });
    }
  }

}

export default new BankAccountController();