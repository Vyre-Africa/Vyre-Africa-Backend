"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_validator_1 = require("express-validator");
class StoreValidator {
    createStore() {
        return [
            (0, express_validator_1.body)('name').notEmpty().withMessage('Store name is required'),
            (0, express_validator_1.body)('latitude')
                .notEmpty()
                .withMessage('Store latitude is required'),
            (0, express_validator_1.body)('longitude')
                .notEmpty()
                .withMessage('Store longitude is required'),
            (0, express_validator_1.body)('location')
                .notEmpty()
                .withMessage('Store location is required'),
            (0, express_validator_1.body)('admin').isObject(),
            (0, express_validator_1.body)('admin.firstName')
                .notEmpty()
                .withMessage('store admin first name is required'),
            (0, express_validator_1.body)('admin.lastName')
                .notEmpty()
                .withMessage('store admin last name is required'),
            (0, express_validator_1.body)('admin.email')
                .notEmpty()
                .withMessage('store admin email address is required'),
            (0, express_validator_1.body)('admin.phoneNo')
                .notEmpty()
                .withMessage('store admin phone number is required'),
        ];
    }
    updateStore() {
        return [
            (0, express_validator_1.body)('name').notEmpty().withMessage('Store name is required'),
            (0, express_validator_1.body)('latitude')
                .notEmpty()
                .withMessage('Store latitude is required'),
            (0, express_validator_1.body)('longitude')
                .notEmpty()
                .withMessage('Store longitude is required'),
            (0, express_validator_1.body)('location')
                .notEmpty()
                .withMessage('Store location is required'),
        ];
    }
    createAdmin() {
        return [
            (0, express_validator_1.body)('firstName').notEmpty().withMessage('firstName is required'),
            (0, express_validator_1.body)('lastName').notEmpty().withMessage('lastName is required'),
            (0, express_validator_1.body)('email').notEmpty().withMessage('email is required'),
            (0, express_validator_1.body)('password').notEmpty().withMessage('password is required'),
            (0, express_validator_1.body)('roleId').notEmpty().withMessage('roleId is required')
        ];
    }
}
exports.default = new StoreValidator();
