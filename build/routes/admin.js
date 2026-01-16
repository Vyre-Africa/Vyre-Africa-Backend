"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminRouter = void 0;
const express_1 = require("express");
const user_validator_1 = __importDefault(require("../validators/user.validator"));
const middleware_1 = __importDefault(require("../middleware"));
const user_controller_1 = __importDefault(require("../controllers/user.controller"));
const admin_auth_1 = require("../services/admin.auth");
// import rolesController from '../controllers/roles.controller';
// import adminRoleController from '../controllers/admin/admin.role.controller';
const adminRouter = (0, express_1.Router)();
exports.adminRouter = adminRouter;
// adminRouter.post(
//     '/admin/login',
//     userValidator.login(),
//     middleware.handleValidationError,
//     adminUserController.loginUser,
// );
adminRouter.post('/admin/forgot-password', user_validator_1.default.resendOtpCode(), middleware_1.default.handleValidationError, user_controller_1.default.forgotPassword);
adminRouter.post('/admin/resend-otp', user_validator_1.default.resendOtpCode(), middleware_1.default.handleValidationError, user_controller_1.default.resendOtpCode);
adminRouter.post('/admin/verify-otp', user_validator_1.default.verifyOtp(), middleware_1.default.handleValidationError, user_controller_1.default.verifyOtp);
adminRouter.get('/admin/get-Auth-secret', admin_auth_1.adminAuthMiddleware, user_controller_1.default.getAuthSecret);
adminRouter.get('/admin/get-two-factor-authentication-status', admin_auth_1.adminAuthMiddleware, user_controller_1.default.getTwoFactorAuthenticationMethod);
//enable 2FA method
adminRouter.post('/admin/two-factor-authentication', admin_auth_1.adminAuthMiddleware, user_validator_1.default.setTwoFactorAuthenticationMethod(), middleware_1.default.handleValidationError, user_controller_1.default.setTwoFactorAuthenticationMethod);
//disable 2FA method
adminRouter.post('/admin/disable-two-factor-authentication', admin_auth_1.adminAuthMiddleware, user_validator_1.default.disableTwoFactorAuthenticationMethod(), middleware_1.default.handleValidationError, user_controller_1.default.disableTwoFactorAuthenticationMethod);
//user save notification setting
adminRouter.post('/admin/notification-setting', admin_auth_1.adminAuthMiddleware, user_validator_1.default.setNotificationMethod(), middleware_1.default.handleValidationError, user_controller_1.default.setNotificationMethod);
//user get notification setting
adminRouter.get('/admin/notification-setting', admin_auth_1.adminAuthMiddleware, user_controller_1.default.getNotificationMethod);
// adminRouter.post(
//   '/admin/change-password',
//   adminAuthMiddleware,
//   userValidator.changeAdminPassword(),
//   middleware.handleValidationError,
//   adminUserController.changePassword,
// );
adminRouter.get('/admin/profile', admin_auth_1.adminAuthMiddleware, user_controller_1.default.getProfile);
