"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_validator_1 = require("express-validator");
class SwapValidator {
    addFiatAccount() {
        return [
            (0, express_validator_1.body)('accountNumber').notEmpty().withMessage('accountNumber is required'),
            (0, express_validator_1.body)('accountName').notEmpty().withMessage('accountName is required'),
            (0, express_validator_1.body)('bankId').notEmpty().withMessage('bankId is required'),
        ];
    }
    addCryptoAccount() {
        return [
            (0, express_validator_1.body)('chain').notEmpty().withMessage('chain is required'),
            (0, express_validator_1.body)('address').notEmpty().withMessage('address is required'),
            (0, express_validator_1.body)('currency').notEmpty().withMessage('currency is required')
        ];
    }
    generateQuote() {
        return [
            (0, express_validator_1.body)('source').isObject(),
            (0, express_validator_1.body)('admin.sourcePaymentAccountId')
                .optional(),
            (0, express_validator_1.body)('source.sourceCurrency')
                .notEmpty().withMessage('sourceCurrency is required'),
            (0, express_validator_1.body)('source.sourcePaymentMethod')
                .notEmpty().withMessage('sourcePaymentMethod is required'),
            (0, express_validator_1.body)('source.sourceAmount')
                .notEmpty().withMessage('sourceAmount is required'),
            (0, express_validator_1.body)('destination').isObject(),
            (0, express_validator_1.body)('destination.destinationPaymentAccountId')
                .notEmpty().withMessage('destinationPaymentAccountId is required'),
            (0, express_validator_1.body)('destination.destinationCurrency')
                .notEmpty().withMessage('destinationCurrency is required'),
            (0, express_validator_1.body)('destination.destinationPaymentMethod')
                .notEmpty().withMessage('destinationPaymentMethod is required')
        ];
    }
    initiateSwap() {
        return [
            (0, express_validator_1.body)('quoteId').notEmpty().withMessage('quoteId is required')
        ];
    }
}
exports.default = new SwapValidator();
