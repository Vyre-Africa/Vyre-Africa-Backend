"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerMiddleware = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const auth0_1 = require("auth0");
const utils_1 = require("../utils");
dotenv_1.default.config();
const userInfoClient = new auth0_1.UserInfoClient({
    domain: 'auth.vyre.africa', // Your Auth0 domain
});
const registerMiddleware = async (req, res, next) => {
    console.log(req.headers);
    const { authorization } = req.headers;
    if (!authorization) {
        return res
            .status(401)
            .json({ msg: 'Authentication token required', success: false });
    }
    const token = authorization.split(' ')[1];
    console.log(token);
    // const result = verifyAccessToken(token as string);
    const { success, data, error } = await (0, utils_1.verifyAccessToken)(token);
    console.log(success);
    let newUser;
    if (success) {
        console.log(data?.sub); // "auth0|123456"
        // console.log(data?.email);    // "user@example.com"
        try {
            const userDetails = await userInfoClient.getUserInfo(token);
            newUser = userDetails.data;
            console.log('userDetails', userDetails.data);
        }
        catch (error) {
            console.error('user retrieval error:', error);
            return res.status(401).json({ msg: 'User not found', success: false });
        }
    }
    else {
        return res.status(403).json({ error });
    }
    req.user = newUser;
    next();
};
exports.registerMiddleware = registerMiddleware;
