"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const utils_1 = require("../utils");
const prisma_config_1 = __importDefault(require("../config/prisma.config"));
dotenv_1.default.config();
const authMiddleware = async (req, res, next) => {
    // 1. Extract Token
    const { authorization } = req.headers;
    if (!authorization) {
        return res.status(401).json({
            success: false,
            error: 'Missing authorization token'
        });
    }
    const token = authorization.split(' ')[1];
    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'Malformed authorization header'
        });
    }
    try {
        // 2. Validate Token (choose ONE approach)
        // OPTION A: Local verification (recommended)
        const { success, data } = (0, utils_1.verifyAccessToken)(token);
        if (!success || !data?.userId) {
            console.log('token data', data);
            return res.status(403).json({
                success: false,
                error: 'Invalid or expired token'
            });
        }
        // OPTION B: Remote verification (if you need fresh claims)
        // const userInfo = await userInfoClient.getUserInfo(token);
        // if (!userInfo.data?.sub) {
        //   return res.status(403).json(...);
        // }
        // const authId = userInfo.data.sub;
        // 3. Find/Create User
        let user = await prisma_config_1.default.user.findUnique({
            where: { id: data?.userId },
            select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true
            }
        });
        // 4. Create new user if not exists
        if (!user) {
            user = await prisma_config_1.default.user.create({
                data: {
                    id: data.userId,
                    email: data.email,
                    firstName: data.firstName || '',
                    lastName: data.lastName || '',
                    emailVerified: data.emailVerified || false,
                    photoUrl: data.photoUrl
                },
                select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    email: true
                }
            });
            // Optionally return 201 for new users
            req.isNewUser = true;
        }
        // 5. Attach user and proceed
        req.user = user;
        next();
    }
    catch (error) {
        console.error('Authentication error:', error);
        return res.status(500).json({
            success: false,
            error: 'Authentication failed'
        });
    }
};
exports.authMiddleware = authMiddleware;
