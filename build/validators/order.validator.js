"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_validator_1 = require("express-validator");
class OrderValidator {
    createOrder() {
        return [
            // body('price')
            //   .notEmpty()
            //   .withMessage('Price is required')
            //   .isFloat()
            //   .withMessage('Invalid price'),
            // body('cartId').notEmpty().withMessage('Cart ID is required'),
            // body('products').isArray(),
            // body('products.*.name')
            //   .notEmpty()
            //   .withMessage('Product name is required'),
            // body('products.*.cart_Quantity')
            //   .notEmpty()
            //   .withMessage('Product quantity is required')
            //   .isInt({ min: 1 })
            //   .withMessage('Invalid quantity. Must be a positive integer'),
            // body('products.*.price')
            //   .notEmpty()
            //   .withMessage('Product price is required')
            //   .isFloat()
            //   .withMessage('Invalid product price'),
            // body('products.*.SKU').notEmpty().withMessage('Product SKU is required'),
            (0, express_validator_1.body)('price').notEmpty().withMessage('price is required'),
            (0, express_validator_1.body)('amount').notEmpty().withMessage('order amount is required'),
            (0, express_validator_1.body)('type').notEmpty().withMessage('order type is required'),
            (0, express_validator_1.body)('pairId').notEmpty().withMessage('pairId is required'),
        ];
    }
    initializeAnon() {
        return [
            (0, express_validator_1.body)('amount').notEmpty().withMessage('Amount is required').isFloat().withMessage('Invalid amount'),
            (0, express_validator_1.body)('user').isObject().withMessage('User must be an object'),
            (0, express_validator_1.body)('user.firstName').notEmpty().withMessage('first name is required'),
            (0, express_validator_1.body)('user.lastName').notEmpty().withMessage('last name is required'),
            (0, express_validator_1.body)('user.phoneNumber').notEmpty().withMessage('phone number is required'),
            (0, express_validator_1.body)('user.email').notEmpty().withMessage('user email is required').isEmail().withMessage('user email is invalid'),
            (0, express_validator_1.body)('user.pin').notEmpty().withMessage('user pin is required'),
            (0, express_validator_1.body)('orderId').notEmpty().withMessage('order ID is required').isString().withMessage('order Id is invalid'),
            (0, express_validator_1.body)('currencyId').notEmpty().withMessage('currency ID is required').isString().withMessage('currency Id is invalid'),
            // user bank details
            (0, express_validator_1.body)('bank').isObject().optional(),
            (0, express_validator_1.body)('bank.accountNumber').optional(),
            (0, express_validator_1.body)('bank.bankCode').optional(),
            (0, express_validator_1.body)('bank.recipient').optional(),
            // user crypto wallet details
            (0, express_validator_1.body)('crypto').isObject().optional(),
            (0, express_validator_1.body)('crypto.address').optional()
        ];
    }
    processOrder() {
        return [
            (0, express_validator_1.body)('amount').notEmpty().withMessage('amount is required'),
            (0, express_validator_1.body)('orderId').notEmpty().withMessage('orderId is required')
        ];
    }
}
exports.default = new OrderValidator();
