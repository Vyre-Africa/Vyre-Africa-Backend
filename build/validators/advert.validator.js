"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_validator_1 = require("express-validator");
class AdvertValidator {
    createAdvert() {
        return [
            (0, express_validator_1.body)('title')
                .notEmpty()
                .withMessage('title is required'),
            (0, express_validator_1.body)('imgUrl')
                .notEmpty()
                .withMessage('imgUrl is required')
        ];
    }
    updateAdvert() {
        return [
            (0, express_validator_1.body)('title')
                .notEmpty()
                .withMessage('title is required'),
            (0, express_validator_1.body)('imgUrl')
                .notEmpty()
                .withMessage('imgUrl is required'),
            (0, express_validator_1.body)('type').notEmpty().withMessage('type is required').isIn(['published', 'draft']).withMessage('type must either be published or draft')
        ];
    }
    deleteAdvert() {
        return [
            (0, express_validator_1.body)('type').notEmpty().withMessage('type is required').isIn(['published', 'draft']).withMessage('type must either be published or draft')
        ];
    }
}
exports.default = new AdvertValidator();
