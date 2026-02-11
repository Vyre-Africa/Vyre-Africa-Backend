import { Request, Response } from 'express';
import pinService from '../services/pin.service';

class PinController {
    
    // ============================================
    // TRANSACTION PIN (4-digit for transfers)
    // ============================================
    
    async createTransactionPin(req: Request & { user?: any }, res: Response) {
        const { user } = req;
        const { pin } = req.body;

        try {
            // Check if user already has a transaction PIN
            const hasPin = await pinService.hasTransactionPin(user.id);
            if (hasPin) {
                return res.status(400).json({
                    success: false,
                    message: 'Transaction PIN already exists. Use change PIN endpoint to update'
                });
            }

            await pinService.createTransactionPin(user.id, pin);

            return res.status(201).json({
                success: true,
                message: 'Transaction PIN created successfully'
            });

        } catch (error: any) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }
    }

    async verifyTransactionPin(req: Request & { user?: any }, res: Response) {
        const { user } = req;
        const { pin } = req.body;

        try {
            await pinService.verifyTransactionPin(user.id, pin, {
                ipAddress: req.ip,
                userAgent: req.get('user-agent')
            });

            return res.status(200).json({
                success: true,
                message: 'Transaction PIN verified successfully'
            });

        } catch (error: any) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }
    }

    async changeTransactionPin(req: Request & { user?: any }, res: Response) {
        const { user } = req;
        const { oldPin, newPin } = req.body;

        try {
            await pinService.changeTransactionPin(user.id, oldPin, newPin);

            return res.status(200).json({
                success: true,
                message: 'Transaction PIN changed successfully'
            });

        } catch (error: any) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }
    }

    async checkTransactionPin(req: Request & { user?: any }, res: Response) {
        const { user } = req;

        try {
            const hasPin = await pinService.hasTransactionPin(user.id);

            return res.status(200).json({
                success: true,
                hasTransactionPin: hasPin
            });

        } catch (error: any) {
            return res.status(500).json({
                success: false,
                message: 'Internal server error'
            });
        }
    }

    // ============================================
    // Keep your existing ACCESS PIN methods
    // ============================================
    // generatePin, verifyPin (6-digit) - unchanged
}

export default new PinController();