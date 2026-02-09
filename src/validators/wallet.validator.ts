import { body } from 'express-validator';
import Decimal from 'decimal.js';

class walletValidator {
  initDeposit() {
    return [
      body('currencyId').notEmpty().withMessage('currency Id is required'),
      body('amount').notEmpty().withMessage('amount is required')
    ];
  }

  initBlockchainTransfer() {
      return [
          body('idempotencyKey')
              .notEmpty()
              .withMessage('Idempotency key is required')
              .isString()
              .isLength({ min: 10, max: 100 }),

          body('currencyId')
              .notEmpty()
              .withMessage('Currency ID is required')
              .isUUID(),

          body('amount')
              .notEmpty()
              .withMessage('Amount is required')
              .custom((value) => {
                  const amount = new Decimal(String(value));
                  if (amount.lessThanOrEqualTo(0)) {
                      throw new Error('Amount must be greater than 0');
                  }
                  return true;
              }),

          body('address')
              .notEmpty()
              .withMessage('Crypto address is required')
              .isString()
              .trim()
              .isLength({ min: 26, max: 90 })
              .withMessage('Invalid address length'),

          body('destinationTag')
              .optional({ values: 'falsy' })
              .isInt({ min: 0, max: 4294967295 })
              .withMessage('Destination tag must be a valid positive integer'),
      ];
  }

  initVyreTransfer() {
    return [
        // ✅ Idempotency Key
        body('idempotencyKey')
            .notEmpty()
            .withMessage('Idempotency key is required')
            .isString()
            .withMessage('Idempotency key must be a string')
            .isLength({ min: 10, max: 100 })
            .withMessage('Idempotency key must be between 10 and 100 characters')
            .matches(/^[a-zA-Z0-9\-_]+$/)
            .withMessage('Idempotency key can only contain alphanumeric characters, hyphens, and underscores'),

        // ✅ Currency ID
        body('currencyId')
            .notEmpty()
            .withMessage('Currency ID is required')
            .isString()
            .withMessage('Currency ID must be a string')
            .isUUID()
            .withMessage('Currency ID must be a valid UUID'),

        // ✅ Amount
        body('amount')
            .notEmpty()
            .withMessage('Amount is required')
            .custom((value) => {
                // Accept string or number
                if (typeof value !== 'string' && typeof value !== 'number') {
                    throw new Error('Amount must be a string or number');
                }
                
                // Convert to string for Decimal validation
                const amountStr = String(value);
                
                // Check if it's a valid decimal
                if (!/^\d+(\.\d+)?$/.test(amountStr)) {
                    throw new Error('Amount must be a valid positive number');
                }
                
                // Check if it's greater than 0
                const amount = new Decimal(amountStr);
                if (amount.lessThanOrEqualTo(0)) {
                    throw new Error('Amount must be greater than 0');
                }
                
                return true;
            }),

        // ✅ Recipient ID
        body('recipient_id')
            .notEmpty()
            .withMessage('Recipient ID is required')
            .isString()
            .withMessage('Recipient ID must be a string')
            .isUUID()
            .withMessage('Recipient ID must be a valid UUID')
            .custom((value, { req }) => {
                // Prevent self-transfers
                if (value === req.user?.id) {
                    throw new Error('Cannot transfer to yourself');
                }
                return true;
            }),
    ];  
  
  }

  initBankTransfer() {
        return [
            // ✅ Idempotency Key
            body('idempotencyKey')
                .notEmpty()
                .withMessage('Idempotency key is required')
                .isString()
                .withMessage('Idempotency key must be a string')
                .isLength({ min: 10, max: 100 })
                .withMessage('Idempotency key must be between 10 and 100 characters')
                .matches(/^[a-zA-Z0-9\-_]+$/)
                .withMessage('Idempotency key can only contain alphanumeric characters, hyphens, and underscores'),

            // ✅ Currency ID
            body('currencyId')
                .notEmpty()
                .withMessage('Currency ID is required')
                .isString()
                .withMessage('Currency ID must be a string')
                .isUUID()
                .withMessage('Currency ID must be a valid UUID'),

            // ✅ Amount
            body('amount')
                .notEmpty()
                .withMessage('Amount is required')
                .custom((value) => {
                    // Accept string or number
                    if (typeof value !== 'string' && typeof value !== 'number') {
                        throw new Error('Amount must be a string or number');
                    }
                    
                    // Convert to string for validation
                    const amountStr = String(value);
                    
                    // Check if it's a valid decimal
                    if (!/^\d+(\.\d+)?$/.test(amountStr)) {
                        throw new Error('Amount must be a valid positive number');
                    }
                    
                    // Check if it's greater than 0
                    const amount = new Decimal(amountStr);
                    if (amount.lessThanOrEqualTo(0)) {
                        throw new Error('Amount must be greater than 0');
                    }
                    
                    return true;
                }),

            // ✅ Account Number
            body('account_number')
                .notEmpty()
                .withMessage('Account number is required')
                .isString()
                .withMessage('Account number must be a string')
                .trim()
                .isLength({ min: 5, max: 34 })
                .withMessage('Account number must be between 5 and 34 characters')
                .matches(/^[0-9A-Z]+$/)
                .withMessage('Account number can only contain alphanumeric characters (uppercase letters and numbers)'),

            // ✅ Account Name (Recipient Name)
            body('account_name')
                .notEmpty()
                .withMessage('Account name is required')
                .isString()
                .withMessage('Account name must be a string')
                .trim()
                .isLength({ min: 2, max: 100 })
                .withMessage('Account name must be between 2 and 100 characters')
                .matches(/^[a-zA-Z\s\-'.]+$/)
                .withMessage('Account name can only contain letters, spaces, hyphens, apostrophes, and periods'),

            // ✅ Bank Name
            body('bank_name')
                .notEmpty()
                .withMessage('Bank name is required')
                .isString()
                .withMessage('Bank name must be a string')
                .trim()
                .isLength({ min: 2, max: 100 })
                .withMessage('Bank name must be between 2 and 100 characters'),

            // ✅ Bank Code (Optional for some countries/banks)
            body('bank_code')
              .optional({ values: 'falsy' }) // ✅ Allows null, undefined, empty string
              .isString()
              .trim()
              .customSanitizer((value) => {
                  if (!value) return value;
                  return value.replace(/[\s\-]/g, '').toUpperCase();
              })
              .isLength({ max: 20 })
              .withMessage('Bank code must not exceed 20 characters'),

            // body('swiftCode')
            //   .optional({ values: 'falsy' }) // ✅ Updated
            //   .isString()
            //   .trim()
            //   .toUpperCase()
            //   .isLength({ min: 8, max: 11 })
            //   .matches(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/),

            // body('iban')
            //     .optional({ values: 'falsy' }) // ✅ Updated
            //     .isString()
            //     .trim()
            //     .toUpperCase()
            //     .isLength({ min: 15, max: 34 })
            //     .matches(/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/),

            // body('routingNumber')
            //     .optional({ values: 'falsy' }) // ✅ Updated
            //     .isString()
            //     .trim()
            //     .isLength({ min: 9, max: 9 })
            //     .matches(/^[0-9]{9}$/),

            // body('sortCode')
            //     .optional({ values: 'falsy' }) // ✅ Updated
            //     .isString()
            //     .trim()
            //     .matches(/^[0-9]{6}$/),

        
        ];
  }

}

export default new walletValidator();
