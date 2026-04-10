import { Request, Response, Router } from 'express';
import config from '../config/env.config';
import userValidator from '../validators/user.validator';
import middleware from '../middleware';
import userController from '../controllers/user.controller';
import adminUserController from '../controllers/admin/admin.user.controller';
import { adminAuthMiddleware } from '../services/admin.auth';
import adminProductController from '../controllers/admin/admin.product.controller';
import adminOrderController from '../controllers/admin/admin.order.controller';
import adminTransactionController from '../controllers/admin/admin.transaction.controller';
import adminBroadcastController from '../controllers/admin/admin.broadcast.controller';
import broadcastValidator from '../validators/broadcast.validator';
import advertValidator from '../validators/advert.validator';
import adminAdvertController from '../controllers/admin/admin.advert.controller';
import adminNotificationController from '../controllers/admin/admin.notification.controller';
import adminDashboardController from '../controllers/admin/admin.dashboard.controller';
import roleValidator from '../validators/role.validator';
// import rolesController from '../controllers/roles.controller';
// import adminRoleController from '../controllers/admin/admin.role.controller';

const adminRouter = Router();

// adminRouter.post(
//     '/admin/login',
//     userValidator.login(),
//     middleware.handleValidationError,
//     adminUserController.loginUser,

// );

adminRouter.post(
    '/admin/forgot-password',
    userValidator.resendOtpCode(),
    middleware.handleValidationError,
    userController.forgotPassword,
);

adminRouter.post(
    '/admin/resend-otp',
    userValidator.resendOtpCode(),
    middleware.handleValidationError,
    userController.resendOtpCode,
);

adminRouter.post(
    '/admin/verify-otp',
    userValidator.verifyOtp(),
    middleware.handleValidationError,
    userController.verifyOtp,
);

adminRouter.get(
    '/admin/get-Auth-secret',
    adminAuthMiddleware,
    userController.getAuthSecret,
  );
  
  adminRouter.get(
    '/admin/get-two-factor-authentication-status',
    adminAuthMiddleware,
    userController.getTwoFactorAuthenticationMethod,
  );
  
  //enable 2FA method
  adminRouter.post(
    '/admin/two-factor-authentication',
    adminAuthMiddleware,
    userValidator.setTwoFactorAuthenticationMethod(),
    middleware.handleValidationError,
    userController.setTwoFactorAuthenticationMethod,
  );
  
  //disable 2FA method
  adminRouter.post(
    '/admin/disable-two-factor-authentication',
    adminAuthMiddleware,
    userValidator.disableTwoFactorAuthenticationMethod(),
    middleware.handleValidationError,
    userController.disableTwoFactorAuthenticationMethod,
  )

  //user save notification setting
adminRouter.post(
  '/admin/notification-setting',
  adminAuthMiddleware,
  userValidator.setNotificationMethod(),
  middleware.handleValidationError,
  userController.setNotificationMethod,
);

//user get notification setting
adminRouter.get(
  '/admin/notification-setting',
  adminAuthMiddleware,
  userController.getNotificationMethod,
);

// adminRouter.post(
//   '/admin/change-password',
//   adminAuthMiddleware,
//   userValidator.changeAdminPassword(),
//   middleware.handleValidationError,
//   adminUserController.changePassword,
// );

adminRouter.get(
  '/admin/profile',
  adminAuthMiddleware,
  userController.getProfile,
);

// adminRouter.post(
//   '/admin/update-profile',
//   adminAuthMiddleware,
//   userValidator.updateAdminProfile(),
//   middleware.handleValidationError,
//   adminUserController.updateProfile,
// );

//   adminRouter.get('/admin/users', adminAuthMiddleware, adminUserController.fetchAll)
//   adminRouter.get('/admin/users/search', adminAuthMiddleware, adminUserController.search)
//   adminRouter.get('/admin/users/filter-by-date', adminAuthMiddleware, adminUserController.filterByDate)
//   adminRouter.delete('/admin/user/delete/:user_id', adminAuthMiddleware, adminUserController.deleteUser)

//   adminRouter.get('/admin/products', adminAuthMiddleware, adminProductController.fetchAll)
//   adminRouter.get('/admin/products/search', adminAuthMiddleware, adminProductController.search)
//   adminRouter.get('/admin/products/filter-by-date', adminAuthMiddleware, adminProductController.filterByDate)

//   adminRouter.get('/admin/orders', adminAuthMiddleware, adminOrderController.fetchAll)
//   adminRouter.get('/admin/orders/search', adminAuthMiddleware, adminOrderController.search)
//   adminRouter.get('/admin/orders/filter-by-date', adminAuthMiddleware, adminOrderController.filterByDate)
//   adminRouter.get('/admin/orders/filter-by-status', adminAuthMiddleware, adminOrderController.filterByStatus)

//   adminRouter.get('/admin/orders/:user_id', adminAuthMiddleware, adminOrderController.fetchUserOrder)
//   adminRouter.get('/admin/orders/:user_id/search', adminAuthMiddleware, adminOrderController.searchUserOrder)
//   adminRouter.get('/admin/orders/:user_id/filter-by-date', adminAuthMiddleware, adminOrderController.filterUserOrderByDate)
//   adminRouter.get('/admin/orders/:user_id/filter-by-status', adminAuthMiddleware, adminOrderController.filterUserOrderByStatus)


//   adminRouter.get('/admin/transactions', adminAuthMiddleware, adminTransactionController.fetchAll)
//   adminRouter.get('/admin/transactions/search', adminAuthMiddleware, adminTransactionController.search)
//   adminRouter.get('/admin/transactions/filter-by-date', adminAuthMiddleware, adminTransactionController.filterByDate)
//   adminRouter.get('/admin/transactions/filter-by-status', adminAuthMiddleware, adminTransactionController.filterByStatus)

//   adminRouter.get('/admin/broadcasts', adminAuthMiddleware, adminBroadcastController.fetchAll)
//   adminRouter.post('/admin/broadcast/create', adminAuthMiddleware,broadcastValidator.createBroadCast(), adminBroadcastController.publishBroadcast)
//   adminRouter.post('/admin/broadcast/draft', adminAuthMiddleware,broadcastValidator.createBroadCast(), adminBroadcastController.draftBroadcast)

//   adminRouter.post('/admin/advert/create', adminAuthMiddleware,advertValidator.createAdvert(), adminAdvertController.createAdvert)
//   adminRouter.post('/admin/advert/createDraft', adminAuthMiddleware,advertValidator.createAdvert(), adminAdvertController.createDraft)
//   adminRouter.get('/admin/adverts/published', adminAuthMiddleware, adminAdvertController.fetchpublished)
//   adminRouter.get('/admin/adverts/drafts', adminAuthMiddleware, adminAdvertController.fetchDrafts)
// adminRouter.post(
//     '/admin/advert/update/:id',
//     adminAuthMiddleware,
//     advertValidator.updateAdvert(),
//     middleware.handleValidationError,
//     adminAdvertController.update,
//   )

//   adminRouter.delete(
//     '/admin/advert/delete/:id',
//     adminAuthMiddleware,
//     advertValidator.deleteAdvert(),
//     middleware.handleValidationError,
//     adminAdvertController.delete,
//   )

//   adminRouter.get('/admin/user/notifications', adminAuthMiddleware, adminNotificationController.fetchAll)
//   adminRouter.get('/admin/user/notifications/filter-by-date', adminAuthMiddleware, adminNotificationController.filterByDate)

//   adminRouter.get('/admin/dashboard', adminAuthMiddleware, adminDashboardController.get)

  //roles and permission



export { adminRouter };