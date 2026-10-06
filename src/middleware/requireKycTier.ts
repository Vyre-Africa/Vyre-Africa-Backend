import { Request, Response, NextFunction } from 'express';
import prisma from '../config/prisma.client';
 
export const requireKycTier = (minTier = 2) =>
  async (req: Request | any, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      const user = req.user;

      if (!userId) {
        return res.status(401).json({ success: false, msg: 'Not signed in.' });
      }
 
    //   const user = await prisma.user.findUnique({
    //     where: { id: userId },
    //     select: { kycTier: true },
    //   });
 
      if ((user?.kycTier ?? 0) < minTier) {
        return res.status(403).json({
          success: false,
          msg: 'Verify your identity before creating a wallet.',
          requiresKyc: true,
        });
      }
 
      next();
    } catch (error) {
      // Fail closed. If the check itself breaks, nobody gets through.
      return res.status(500).json({ success: false, msg: 'Could not verify your account status.' });
    }
  };