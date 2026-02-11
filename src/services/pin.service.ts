import crypto from 'crypto';
import prisma from '../config/prisma.config';
import logger from '../config/logger';

class PinService {
    
    // ============================================
    // TRANSACTION PIN (4-digit for transfers)
    // ============================================
    
    async createTransactionPin(userId: string, pin: string) {
        // Validate PIN
        if (!/^\d{4}$/.test(pin)) {
            throw new Error('Transaction PIN must be exactly 4 digits');
        }

        // Check for weak PINs
        const weakPins = [
            '0000', '1111', '2222', '3333', '4444', 
            '5555', '6666', '7777', '8888', '9999', 
            '1234', '4321'
        ];
        if (weakPins.includes(pin)) {
            throw new Error('PIN is too weak. Please choose a different PIN');
        }

        // Generate salt and hash
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = this.hashTransactionPin(pin, salt);

        // Save to database
        await prisma.user.update({
            where: { id: userId },
            data: {
                transactionPin: hash,
                transactionPinSalt: salt,
                transactionPinCreatedAt: new Date(),
                transactionPinLastChangedAt: new Date(),
                transactionPinFailedAttempts: 0,
                transactionPinLockedUntil: null
            }
        });

        logger.info('✅ Transaction PIN created', { userId });

        return { success: true };
    }

    async verifyTransactionPin(
        userId: string, 
        pin: string, 
        metadata?: { ipAddress?: string; userAgent?: string }
    ) {
        // Get user
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                transactionPin: true,
                transactionPinSalt: true,
                transactionPinFailedAttempts: true,
                transactionPinLockedUntil: true
            }
        });

        if (!user) {
            throw new Error('User not found');
        }

        if (!user.transactionPin || !user.transactionPinSalt) {
            throw new Error('Transaction PIN not set. Please create a PIN first');
        }

        // Check if PIN is locked
        if (user.transactionPinLockedUntil && user.transactionPinLockedUntil > new Date()) {
            const remainingSeconds = Math.ceil(
                (user.transactionPinLockedUntil.getTime() - Date.now()) / 1000
            );
            throw new Error(`PIN is locked. Try again in ${remainingSeconds} seconds`);
        }

        // Hash provided PIN
        const hash = this.hashTransactionPin(pin, user.transactionPinSalt);

        // Compare
        const isValid = hash === user.transactionPin;

        if (isValid) {
            // ✅ Success - Reset failed attempts
            await prisma.user.update({
                where: { id: userId },
                data: {
                    transactionPinFailedAttempts: 0,
                    transactionPinLockedUntil: null
                }
            });

            logger.info('✅ Transaction PIN verified', { userId });

            return { success: true };

        } else {
            // ❌ Failed - Increment attempts
            const newFailedAttempts = user.transactionPinFailedAttempts + 1;
            let lockUntil = null;

            // Lock after 3 failed attempts for 5 minutes
            if (newFailedAttempts >= 3) {
                lockUntil = new Date(Date.now() + 5 * 60 * 1000);
            }

            await prisma.user.update({
                where: { id: userId },
                data: {
                    transactionPinFailedAttempts: newFailedAttempts,
                    transactionPinLockedUntil: lockUntil
                }
            });

            const attemptsLeft = 3 - newFailedAttempts;
            
            logger.warn('❌ Transaction PIN verification failed', { 
                userId, 
                attempts: newFailedAttempts 
            });

            if (attemptsLeft > 0) {
                throw new Error(`Incorrect PIN. ${attemptsLeft} attempt(s) remaining`);
            } else {
                throw new Error('Too many failed attempts. PIN locked for 5 minutes');
            }
        }
    }

    async changeTransactionPin(userId: string, oldPin: string, newPin: string) {
        // Verify old PIN first
        await this.verifyTransactionPin(userId, oldPin);

        // Create new PIN
        await this.createTransactionPin(userId, newPin);

        logger.info('✅ Transaction PIN changed', { userId });

        return { success: true };
    }

    async hasTransactionPin(userId: string): Promise<boolean> {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { transactionPin: true }
        });

        return !!user?.transactionPin;
    }

    private hashTransactionPin(pin: string, salt: string): string {
        return crypto.pbkdf2Sync(pin, salt, 10000, 64, 'sha512').toString('hex');
    }

    // ============================================
    // Keep your existing ACCESS PIN methods
    // ============================================
    // generatePin, verifyPin (6-digit) - unchanged
}

export default new PinService();