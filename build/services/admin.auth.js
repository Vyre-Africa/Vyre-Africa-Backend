"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminAuthMiddleware = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const utils_1 = require("../utils");
dotenv_1.default.config();
const adminAuthMiddleware = async (req, res, next) => {
    const { authorization } = req.headers;
    if (!authorization) {
        return res
            .status(401)
            .json({ msg: 'Authentication token required', success: false });
    }
    const token = authorization.split(' ')[1];
    const result = await (0, utils_1.verifyAccessToken)(token);
    if (!result.success) {
        return res.status(403).json({ error: result.error });
    }
    req.user = result.data;
    if (req.user.type !== 'SUPERADMIN') {
        return res
            .status(401)
            .json({ msg: 'Unauthorized Access', success: false });
    }
    next();
};
exports.adminAuthMiddleware = adminAuthMiddleware;
