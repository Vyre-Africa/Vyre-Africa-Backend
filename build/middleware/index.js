"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Middleware = void 0;
const express_validator_1 = require("express-validator");
// import { defineAbilitiesFor } from '../globals';
// import { ForbiddenError } from '@casl/ability';
class Middleware {
    handleValidationError(req, res, next) {
        const errors = (0, express_validator_1.validationResult)(req);
        if (!errors.isEmpty()) {
            return res.status(400).json(errors.array());
        }
        next();
    }
}
exports.Middleware = Middleware;
exports.default = new Middleware();
