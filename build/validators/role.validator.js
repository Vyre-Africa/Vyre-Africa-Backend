"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_validator_1 = require("express-validator");
class UserRoleValidator {
    createRole() {
        return [
            (0, express_validator_1.body)('name').notEmpty().withMessage('Role name is required'),
            (0, express_validator_1.body)('description')
                .notEmpty()
                .withMessage('Role description is required'),
            (0, express_validator_1.body)('permissions').isArray().notEmpty(),
        ];
    }
    createPermission() {
        return [
            (0, express_validator_1.body)('action').notEmpty().withMessage('Action is required'),
            (0, express_validator_1.body)('subject').notEmpty().withMessage('Subject is required'),
        ];
    }
    assignRole() {
        return [
            (0, express_validator_1.body)('userId')
                .notEmpty()
                .withMessage('userId required to assign role'),
            (0, express_validator_1.body)('roleId')
                .notEmpty()
                .withMessage('roleId is required to assign role'),
        ];
    }
    updateUserRole() {
        return [(0, express_validator_1.body)('userId').notEmpty().withMessage('userId is missing')];
    }
    deleteRole() {
        return [
            (0, express_validator_1.body)('userId').notEmpty().withMessage('userId is missing'),
            (0, express_validator_1.body)('roleId').notEmpty().withMessage('roleId is missing.'),
        ];
    }
    updateAdminRole() {
        return [
            (0, express_validator_1.body)('name').notEmpty().withMessage('Role name is required'),
            (0, express_validator_1.body)('description')
                .notEmpty()
                .withMessage('Role description is required'),
            (0, express_validator_1.body)('permissions').isArray().notEmpty(),
        ];
    }
}
exports.default = new UserRoleValidator();
