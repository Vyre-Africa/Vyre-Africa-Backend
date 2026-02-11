import { body } from 'express-validator';

export class PinValidators {
    
    // Transaction PIN validators (4-digit)
    createTransactionPin() {
        return [
            body('pin')
                .notEmpty()
                .withMessage('PIN is required')
                .isString()
                .matches(/^\d{4}$/)
                .withMessage('Transaction PIN must be exactly 4 digits')
        ];
    }

    verifyTransactionPin() {
        return [
            body('pin')
                .notEmpty()
                .withMessage('PIN is required')
                .isString()
                .matches(/^\d{4}$/)
                .withMessage('Transaction PIN must be exactly 4 digits')
        ];
    }

    changeTransactionPin() {
        return [
            body('oldPin')
                .notEmpty()
                .withMessage('Old PIN is required')
                .isString()
                .matches(/^\d{4}$/)
                .withMessage('Old PIN must be exactly 4 digits'),
            
            body('newPin')
                .notEmpty()
                .withMessage('New PIN is required')
                .isString()
                .matches(/^\d{4}$/)
                .withMessage('New PIN must be exactly 4 digits')
                .custom((value, { req }) => {
                    if (value === req.body.oldPin) {
                        throw new Error('New PIN must be different from old PIN');
                    }
                    return true;
                })
        ];
    }
}

export default new PinValidators();
