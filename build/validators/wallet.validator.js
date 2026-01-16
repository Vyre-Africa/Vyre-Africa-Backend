"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_validator_1 = require("express-validator");
class walletValidator {
    initDeposit() {
        return [
            (0, express_validator_1.body)('currencyId').notEmpty().withMessage('currency Id is required'),
            (0, express_validator_1.body)('amount').notEmpty().withMessage('amount is required')
        ];
    }
    initBlockchainTransfer() {
        return [
            (0, express_validator_1.body)('currencyId').notEmpty().withMessage('currency id is required'),
            (0, express_validator_1.body)('amount').notEmpty().withMessage('amount is required'),
            (0, express_validator_1.body)('address').notEmpty().withMessage('blockchain is required'),
            (0, express_validator_1.body)('destinationTag').optional()
        ];
    }
    initVyreTransfer() {
        return [
            (0, express_validator_1.body)('currencyId').notEmpty().withMessage('currency id is required'),
            (0, express_validator_1.body)('amount').notEmpty().withMessage('amount is required'),
            (0, express_validator_1.body)('receipient_id').notEmpty().withMessage('receipient_id is required'),
        ];
    }
    initBankTransfer() {
        return [
            (0, express_validator_1.body)('account_number').notEmpty().withMessage('account_number is required'),
            (0, express_validator_1.body)('bank_code').notEmpty().withMessage('bank_code is required'),
            (0, express_validator_1.body)('recipient_name').notEmpty().withMessage('recipient_name is required'),
            (0, express_validator_1.body)('endpoint_url').notEmpty().withMessage('endpoint_url is required'),
        ];
    }
}
exports.default = new walletValidator();
