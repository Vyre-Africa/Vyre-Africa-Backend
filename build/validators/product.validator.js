"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_validator_1 = require("express-validator");
class ProductValidator {
    createProduct() {
        return ((0, express_validator_1.body)('name').notEmpty().withMessage('Product name is required'),
            (0, express_validator_1.body)('price').notEmpty().withMessage('Product price is required'),
            (0, express_validator_1.body)('description')
                .notEmpty()
                .withMessage('Product description is required'),
            (0, express_validator_1.body)('quantity').notEmpty().withMessage('Product quantity is required'),
            (0, express_validator_1.body)('expiry_date').notEmpty().withMessage('expiry_date is required'),
            (0, express_validator_1.body)('status').notEmpty().withMessage('status is required').isIn(['PUBLISHED', 'DRAFTED'])
        // body('barCode').notEmpty().withMessage('bar code is required')
        );
    }
    updateProduct() {
        return ((0, express_validator_1.body)('name').notEmpty().withMessage('Product name is required'),
            (0, express_validator_1.body)('price').notEmpty().withMessage('Product price is required'),
            (0, express_validator_1.body)('description')
                .notEmpty()
                .withMessage('Product description is required'),
            (0, express_validator_1.body)('quantity').notEmpty().withMessage('Product quantity is required'),
            (0, express_validator_1.body)('expiry_date').notEmpty().withMessage('expiry_date is required'),
            (0, express_validator_1.body)('status').notEmpty().withMessage('status is required').isIn(['PUBLISHED', 'DRAFTED'])
        // body('barCode').notEmpty().withMessage('bar code is required')
        );
    }
    createCategory() {
        return ((0, express_validator_1.body)('name').notEmpty().withMessage('category name is required'));
    }
    createSubCategory() {
        return ((0, express_validator_1.body)('name').notEmpty().withMessage('subCategory name is required'),
            (0, express_validator_1.body)('parentId').notEmpty().withMessage('category Id name is required'));
    }
    submitReview() {
        return ((0, express_validator_1.body)('rating').notEmpty().withMessage('rating is required').isNumeric(),
            (0, express_validator_1.body)('feedback').notEmpty().withMessage('feedback is required'));
    }
    addToCart() {
        return ((0, express_validator_1.body)('product').notEmpty().withMessage('product is required')
        // body('total').notEmpty().withMessage('total is required').isNumeric()
        );
    }
    removeFromCart() {
        return ((0, express_validator_1.body)('product').notEmpty().withMessage('product is required'));
    }
}
exports.default = new ProductValidator();
