import { body } from 'express-validator';

const VALID_STATUSES    = ['pending', 'in_review', 'contacted', 'completed', 'cancelled'];
const VALID_TRADE_TYPES = ['crypto_to_fiat', 'fiat_to_crypto', 'fiat_to_fiat'];
const VALID_USER_TYPES  = ['individual', 'business'];
const VALID_CONTACTS    = ['whatsapp', 'email', 'call'];

class OtcValidator {
  submitOtc() {
    return [
        body('fullName').trim().notEmpty().withMessage('Full name is required'),
        body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
        body('phoneNumber').trim().notEmpty().withMessage('Phone number is required'),
        body('userType').isIn(VALID_USER_TYPES).withMessage('Invalid account type'),
        body('preferredContact').isIn(VALID_CONTACTS).withMessage('Invalid contact method'),
        body('tradeType').isIn(VALID_TRADE_TYPES).withMessage('Invalid trade type'),
        body('fromCurrency').trim().notEmpty().withMessage('Source currency is required'),
        body('toCurrency').trim().notEmpty().withMessage('Target currency is required'),
        body('amount').isFloat({ gt: 0 }).withMessage('Amount must be a positive number'),
        body('receivingDetails')
          .isArray({ min: 1 }).withMessage('At least one receiving detail is required')
          .custom((details) => {
            const valid = details.every(
              (d:any) => typeof d.label === 'string' && d.label.trim() &&
                    typeof d.value === 'string' && d.value.trim()
            );
            if (!valid) throw new Error('Each receiving detail must have a non-empty label and value');
            return true;
          }),
        body('idDocumentUrl').trim().notEmpty().isURL().withMessage('ID document URL is required'),
        body('proofOfAddressUrl').trim().notEmpty().isURL().withMessage('Proof of address URL is required'),
        body('invoiceUrl').optional({ nullable: true }).isURL().withMessage('Invoice URL must be a valid URL'),
        body('additionalNotes').optional({ nullable: true }).trim()

    ];
  }


}

export default new OtcValidator();
