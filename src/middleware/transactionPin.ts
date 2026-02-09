import { Request, Response, NextFunction } from 'express';
import pinService from '../services/pin.service';

export async function requireTransactionPin(
    req: Request & { user?: any }, 
    res: Response, 
    next: NextFunction
) {
    const { user } = req;
    const { transactionPin } = req.body; // ✅ Different field name

    try {
        // Check if user has transaction PIN
        const hasPin = await pinService.hasTransactionPin(user.id);
        
        if (!hasPin) {
            return res.status(400).json({
                success: false,
                message: 'Please create a transaction PIN first',
                requiresTransactionPin: true
            });
        }

        // Check if PIN provided
        if (!transactionPin) {
            return res.status(400).json({
                success: false,
                message: 'Transaction PIN is required for transfers',
                requiresTransactionPin: true
            });
        }

        // Verify PIN
        await pinService.verifyTransactionPin(user.id, transactionPin, {
            ipAddress: req.ip,
            userAgent: req.get('user-agent')
        });

        // PIN verified, continue
        next();

    } catch (error: any) {
        return res.status(400).json({
            success: false,
            message: error.message,
            requiresTransactionPin: true
        });
    }
}