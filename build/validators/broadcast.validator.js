"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_validator_1 = require("express-validator");
class BroadcastValidator {
    createBroadCast() {
        return [
            (0, express_validator_1.body)('type')
                .notEmpty()
                .withMessage('type is required')
                .isIn(['INSTANT', 'SCHEDULED']),
            (0, express_validator_1.body)('title')
                .notEmpty()
                .withMessage('title is required'),
            (0, express_validator_1.body)('body')
                .notEmpty()
                .withMessage('body content is required'),
            (0, express_validator_1.body)('recipient')
                .notEmpty()
                .withMessage('recipient is required'),
            (0, express_validator_1.body)('mode')
                .notEmpty()
                .withMessage('mode is required')
                .isIn(['PUSH', 'EMAIL', 'SMS'])
        ];
    }
}
exports.default = new BroadcastValidator();
