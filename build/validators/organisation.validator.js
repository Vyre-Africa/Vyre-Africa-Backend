"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_validator_1 = require("express-validator");
class OrganisationValidator {
    createNewOrgUser() {
        return [
            (0, express_validator_1.body)('firstName').notEmpty().withMessage('firstName is required'),
            (0, express_validator_1.body)('lastName').notEmpty().withMessage('lastName is required'),
            (0, express_validator_1.body)('email').notEmpty().isEmail().withMessage('Email is required'),
            // body('phoneNumber').isMobilePhone('any').notEmpty(),
            (0, express_validator_1.body)('organisation').isObject({ strict: true }),
            (0, express_validator_1.body)('organisation.name')
                .notEmpty()
                .withMessage('Organisation name is required'),
            (0, express_validator_1.body)('organisation.cacRegNo')
                .notEmpty()
                .withMessage('Organisation cacRegNo is required'),
        ];
    }
    createUserPassword() {
        return [
            (0, express_validator_1.body)('userId').notEmpty().withMessage('userId is required'),
            (0, express_validator_1.body)('password')
                .notEmpty()
                // .isStrongPassword()
                .withMessage('Password is not strong'),
            (0, express_validator_1.body)('code').notEmpty().withMessage('otp code is required'),
        ];
    }
    resendEmail() {
        return [
            (0, express_validator_1.body)('email').notEmpty().withMessage('Email is requried').isEmail(),
        ];
    }
    updateOrg() {
        return [
            (0, express_validator_1.body)('organizationName')
                .notEmpty()
                .withMessage('Organisation name is required'),
            (0, express_validator_1.body)('organizationCacRegNo')
                .notEmpty()
                .withMessage('Organisation cacRegNo is required'),
            (0, express_validator_1.body)('logo'),
        ];
    }
    withdrawRevenue() {
        return [
            (0, express_validator_1.body)('amount')
                .notEmpty()
                .withMessage('amount is required')
                .isNumeric(),
            (0, express_validator_1.body)('bankId')
                .notEmpty()
                .withMessage('bank is required'),
        ];
    }
}
exports.default = new OrganisationValidator();
