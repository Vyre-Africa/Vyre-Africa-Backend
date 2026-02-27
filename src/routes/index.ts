import 'dotenv/config';
import { Request, Response, Router } from 'express';
import { adminRouter } from './admin';
import config from '../config/env.config';
import roleValidator from '../validators/role.validator';
import tripValidator from '../validators/wallet.validator';
import middleware from '../middleware';
import { Actions, RESOURCES } from '../globals';
import { authMiddleware } from '../services/auth';
import { registerMiddleware } from '../services/register';
import userController from '../controllers/user.controller';
import tripController from '../controllers/wallet.controller';
import orderController from '../controllers/order.controller';
import userValidator from '../validators/user.validator';
import walletValidator from '../validators/wallet.validator';
import storeValidator from '../validators/store.validator';
import productValidator from '../validators/product.validator';
import orderValidator from '../validators/order.validator';
import mobileProductController from '../controllers/mobile/mobile.product.controller';
import mobileUserController from '../controllers/mobile/mobile.user.controller';
import mobileAdvertController from '../controllers/mobile/mobile.advert.controller';
import walletController from '../controllers/wallet.controller';
import swapController from '../controllers/swap.controller';
import swapValidator from '../validators/swap.validator';
import eventController from '../controllers/event.controller';
// import {  requireAuth } from '@clerk/express';
import PinValidators from '../validators/pin.validator';
import pinController from '../controllers/pin.controller';
import { requireTransactionPin } from '../middleware/transactionPin';
import { requireAuthWithCORS } from '../middleware/cors-helper';
import otcValidator from '../validators/otc.validator';
import otcController from '../controllers/otc.controller';

const router = Router();

//use the admin routes
router.use(adminRouter)

router.get('/', (req: Request, res: Response) => {
  res.send(`Welcome to the vyre Africa Backend API! ${config.nodeEnv}`);
});

// roles

//User
router.post(
  '/register',
  registerMiddleware,
  userController.register
);

router.post(
  '/webhook/clerk',
  eventController.clerk_WebHook
);

router.post(
  '/webhook/qorepay',
  eventController.qorepay_WebHook
);

router.post(
  '/webhook/fern',
  eventController.fern_WebHook
);

router.post(
  '/webhook/tatum',
  eventController.tatum_WebHook
);

router.post(
  '/user/upload_kyc',
   requireAuthWithCORS(),
  authMiddleware,
  userValidator.uploadKyc(),
  middleware.handleValidationError,
  userController.register_Kyc
);

router.post(
  '/user/login',
  userValidator.login(),
  middleware.handleValidationError,
  userController.loginUser,
);

router.post(
  '/authenticate-Otp',
  userValidator.authenticateOtp(),
  middleware.handleValidationError,
  userController.authenticateViaOtp,
);

router.post(
  '/verify-email',
  userValidator.verifyEmail(),
  middleware.handleValidationError,
  userController.verifyEmail,
);
router.post(
  '/resent-otp',
  userValidator.resendOtpCode(),
  middleware.handleValidationError,
  userController.resendOtpCode,
);

router.post(
  '/setup-password',
  // userValidator.setPassword(),
  // middleware.handleValidationError,
  userController.setPassword,
);

router.post(
  '/forgot-password',
  userValidator.resendOtpCode(),
  middleware.handleValidationError,
  userController.forgotPassword,
);

router.post(
  '/verify-Otp',
  userValidator.verifyOtp(),
  middleware.handleValidationError,
  userController.verifyOtp,
);

router.post(
  '/update-password',
  userValidator.updatePassword(),
  middleware.handleValidationError,
  userController.updatePasswordRecovery,
);

router.post(
  '/user-Address',
  userValidator.submitAddress(),
  middleware.handleValidationError,
  userController.submitAddress
);

// swap
router.post(
  '/paymentAccount/fiat',
   requireAuthWithCORS(),
  authMiddleware,
  swapValidator.addFiatAccount(),
  middleware.handleValidationError,
  swapController.addFiatAccount
);

router.post(
  '/paymentAccount/crypto',
   requireAuthWithCORS(),
  authMiddleware,
  swapValidator.addCryptoAccount(),
  middleware.handleValidationError,
  swapController.addCryptoAccount
);

router.delete(
  '/paymentAccount/:accountId',
   requireAuthWithCORS(),
  authMiddleware,
  swapController.deletePaymentAccount
);

router.get(
  '/linkedAccounts',
   requireAuthWithCORS(),
  authMiddleware,
  swapController.getLinkedAccounts
);

router.post(
  '/swap/quote',
   requireAuthWithCORS(),
  authMiddleware,
  swapValidator.generateQuote(),
  middleware.handleValidationError,
  swapController.generateQuote
);

router.post(
  '/swap/initiate',
   requireAuthWithCORS(),
  authMiddleware,
  swapValidator.initiateSwap(),
  middleware.handleValidationError,
  swapController.initiateSwap
);

router.get(
  '/swaps',
   requireAuthWithCORS(),
  authMiddleware,
  swapController.fetchSwaps
);

router.get(
  '/swaps/:id',
   requireAuthWithCORS(),
  authMiddleware,
  swapController.fetchSwap
)

// Pin Routes
router.post('/pin/transaction/create',
     requireAuthWithCORS(),
    authMiddleware,
    PinValidators.createTransactionPin(),
    middleware.handleValidationError,
    pinController.createTransactionPin
);

router.post('/pin/transaction/verify',
     requireAuthWithCORS(),
    authMiddleware,
    PinValidators.verifyTransactionPin(),
    middleware.handleValidationError,
    pinController.verifyTransactionPin
);

router.post('/pin/transaction/change',
     requireAuthWithCORS(),
    authMiddleware,
    PinValidators.changeTransactionPin(),
    middleware.handleValidationError,
    pinController.changeTransactionPin
);

router.get('/pin/transaction/check',
     requireAuthWithCORS(),
    authMiddleware,
    pinController.checkTransactionPin
);


// router.post('/sendOTP', userController.sendVerification);

// Wallet
router.post(
  '/wallet/create/:currencyId',
   requireAuthWithCORS(),
  authMiddleware,
  walletController.createWallet
)

router.post(
  '/wallet/deposit',
   requireAuthWithCORS(),
  authMiddleware,
  walletValidator.initDeposit(),
  middleware.handleValidationError,
  walletController.init_BankDeposit
)

router.post(
  '/wallet/authorize_fiat_withdrawal',
   requireAuthWithCORS(),
  authMiddleware,
  walletValidator.initDeposit(),
  middleware.handleValidationError,
  walletController.authorize_fiat_Withdrawal
)

router.post(
  '/wallet/vyre_tranfer',
   requireAuthWithCORS(),
  authMiddleware,
  walletValidator.initVyreTransfer(),
  middleware.handleValidationError,
  requireTransactionPin,
  walletController.init_VyreTransfer
)

router.post(
  '/wallet/blockchain_tranfer',
   requireAuthWithCORS(),
  authMiddleware,
  walletValidator.initBlockchainTransfer(),
  middleware.handleValidationError,
  requireTransactionPin,
  walletController.init_BlockchainTransfer
)

router.post(
  '/wallet/bank_tranfer',
   requireAuthWithCORS(),
  authMiddleware,
  walletValidator.initBankTransfer(),
  middleware.handleValidationError,
  requireTransactionPin,
  walletController.init_BankTransfer
)

router.get(
  '/wallet/all',
   requireAuthWithCORS(),
  authMiddleware,
  walletController.fetchWallets
)

router.get(
  '/wallet/:id',
   requireAuthWithCORS(),
  authMiddleware,
  walletController.fetchWallet
)

router.get(
  '/wallet_by_name/:name',
   requireAuthWithCORS(),
  authMiddleware,
  walletController.fetchWalletByName
)

router.get(
  '/beneficiary/wallet',
   requireAuthWithCORS(),
   authMiddleware,
  walletController.fetchBeneficiaries_Handler
)
 

router.get(
  '/rate',
   requireAuthWithCORS(),
  authMiddleware,
  walletController.getRate
)

router.get(
  '/transactions',
   requireAuthWithCORS(),
  authMiddleware,
  walletController.fetchTransactions
)




//orders
router.get(
  '/orders',
   requireAuthWithCORS(),
  authMiddleware,
  orderController.fetchOrders
);

router.get(
  '/orders/user',
   requireAuthWithCORS(),
  authMiddleware,
  orderController.fetch_user_orders
);

router.get(
  '/order/:id',
  // authMiddleware,
  orderController.fetchOrder
)

router.post(
  '/orders/create',
   requireAuthWithCORS(),
  authMiddleware,
  orderValidator.createOrder(),
  middleware.handleValidationError,
  orderController.createOrder
);

router.post(
  '/orders/anonymous/initiate',
  // authMiddleware,
  orderValidator.initializeAnon(),
  middleware.handleValidationError,
  orderController.initiateAnonymous
);

router.post(
  '/orders/process',
   requireAuthWithCORS(),
  authMiddleware,
  orderValidator.processOrder(),
  middleware.handleValidationError,
  orderController.processOrder
);

router.post(
  '/order/cancel/:id',
   requireAuthWithCORS(),
  authMiddleware,
  orderController.cancelOrder
)

router.get(
  '/orders/pairs',
   requireAuthWithCORS(),
  authMiddleware,
  orderController.fetchPairs
);

router.get(
  '/orders/pairs/rate',
   requireAuthWithCORS(),
  authMiddleware,
  orderController.getRatebyPair
)

router.get(
  '/orders/getPairWallets',
   requireAuthWithCORS(),
  authMiddleware,
  orderController.fetchPairWallets
);

// //update user profile


router.get(
  '/user/portfolio',
   requireAuthWithCORS(),
  authMiddleware,
  walletController.fetchPortfolio,
);

router.get(
  '/user/get-profile',
   requireAuthWithCORS(),
  authMiddleware,
  userController.getProfile,
);

router.post(
  '/user/query',
   requireAuthWithCORS(),
  authMiddleware,
  userController.queryUser
)


router.post(
  '/user/update-profile',
   requireAuthWithCORS(),
  authMiddleware,
  userValidator.updateProfile(),
  middleware.handleValidationError,
  userController.updateProfile,
);

router.post(
  '/user/change-password',
   requireAuthWithCORS(),
  authMiddleware,
  userValidator.changePassword(),
  middleware.handleValidationError,
  userController.changePassword,
);

router.post(
  '/user/generate-pin',
  userValidator.generatePin(),
  middleware.handleValidationError,
  userController.generatePin
);

router.post(
  '/user/verify-pin',
  userValidator.verifyPin(),
  middleware.handleValidationError,
  userController.verifyPin
);



//get banks
router.get(
  '/banks',
  userController.getAllBanks,
);

router.get(
  '/banks/currency',
  userController.getCurrencyBanks,
);

router.post(
  '/user/verify-account-detail',
   requireAuthWithCORS(),
  authMiddleware,
  userValidator.verifyAccountDetail(),
  middleware.handleValidationError,
  userController.verifyAccountDetail,
);

//add user bank
router.post(
  '/user/bank/create',
   requireAuthWithCORS(),
  authMiddleware,
  userValidator.addBank(),
  middleware.handleValidationError,
  userController.addBank,
);

//get user bank
router.get(
  '/user/bank',
   requireAuthWithCORS(),
  authMiddleware,
  userController.getUserBank,
);

router.get(
  '/user/wallet/balance',
   requireAuthWithCORS(),
  authMiddleware,
  userController.getUserWalletBalance,
);

//delete user bank
router.delete(
  '/user/bank/:userBankId',
   requireAuthWithCORS(),
  authMiddleware,
  userController.deleteUserBank,
);

//user save notification setting
router.post(
  '/user/notification-setting',
   requireAuthWithCORS(),
  authMiddleware,
  userValidator.setNotificationMethod(),
  middleware.handleValidationError,
  userController.setNotificationMethod,
);

//user get notification setting
router.get(
  '/user/notification-setting',
   requireAuthWithCORS(),
  authMiddleware,
  userController.getNotificationMethod,
);

//user get auth secret for third party authenticator
router.get(
  '/user/get-Auth-secret',
   requireAuthWithCORS(),
  authMiddleware,
  userController.getAuthSecret,
);

router.get(
  '/user/get-two-factor-authentication-status',
   requireAuthWithCORS(),
  authMiddleware,
  userController.getTwoFactorAuthenticationMethod,
);

//save 2FA method
router.post(
  '/user/two-factor-authentication',
   requireAuthWithCORS(),
  authMiddleware,
  userValidator.setTwoFactorAuthenticationMethod(),
  middleware.handleValidationError,
  userController.setTwoFactorAuthenticationMethod,
);

//save 2FA method
router.post(
  '/user/disable-two-factor-authentication',
   requireAuthWithCORS(),
  authMiddleware,
  userValidator.disableTwoFactorAuthenticationMethod(),
  middleware.handleValidationError,
  userController.disableTwoFactorAuthenticationMethod,
)

//delete account
router.delete(
  '/user/account/delete',
   requireAuthWithCORS(),
  authMiddleware,
  userValidator.deleteAccount(),
  middleware.handleValidationError,
  mobileUserController.deleteAccount,
);

//get user notifications
router.get(
  '/user/notification',
   requireAuthWithCORS(),
  authMiddleware,
  userController.getNotification,
);

//filter user notifications
router.get(
  '/user/notification/filter',
   requireAuthWithCORS(),
  authMiddleware,
  userController.filterNotification,
);

//get user transactions
router.get(
  '/user/transactions',
   requireAuthWithCORS(),
  authMiddleware,
  userController.getTransactions,
);

// router.get(
//   '/user/transactions/filter',
//   authMiddleware,
//   userController.filterTransactions,
// );

// router.get(
//   '/user/transactions/filter-by-status',
//   authMiddleware,
//   userController.getTransactionsByStatus,
// );

// router.get(
//   '/user/transactions/filter-by-type',
//   authMiddleware,
//   userController.getTransactionsByType,
// );

//fund user wallet
router.post(
  '/user/wallet/fund',
   requireAuthWithCORS(),
  authMiddleware,
  userValidator.fundUserWallet(),
  middleware.handleValidationError,
  userController.fundWallet,
);

//verify carsd
router.post(
  '/user/card/verify',
   requireAuthWithCORS(),
  authMiddleware,
  userValidator.verifyCard(),
  middleware.handleValidationError,
  mobileUserController.verifyCard,
);


//add atm card
router.post(
  '/user/card/add',
   requireAuthWithCORS(),
  authMiddleware,
  userValidator.addCard(),
  middleware.handleValidationError,
  mobileUserController.addCard,
);

//get cards
router.get(
  '/user/card/fetch',
   requireAuthWithCORS(),
  authMiddleware,
  mobileUserController.getCards,
);

//set card as preferred
router.post(
  '/user/card/set-as-preferred/:card_id',
   requireAuthWithCORS(),
  authMiddleware,
  mobileUserController.setCardAsPreferred,
);

//unset card as preferred
router.post(
  '/user/card/unset-as-preferred/:card_id',
   requireAuthWithCORS(),
  authMiddleware,
  mobileUserController.unSetCardAsPreferred,
);

//delete card
router.post(
  '/user/card/delete/:card_id',
   requireAuthWithCORS(),
  authMiddleware,
  mobileUserController.deleteCard,
);


// OTC 
router.post(
  '/otc/request',
  //  requireAuthWithCORS(),
  // authMiddleware,
  otcValidator.submitOtc(),
  middleware.handleValidationError,
  otcController.submitOtcRequest
)

// router.get(
//   '/user/two-factor-authentication',
//   authMiddleware,
//   userController.getTwoFactorAuthenticationMethod,
// );

//Orders
// router.post(
//   '/orders/create',
//   authMiddleware,
//   orderValidator.createOrder(),
//   middleware.handleValidationError,
//   orderController.createOrder,
// );

// router.post('/orders/update', authMiddleware, orderController.updateOrder);

// router.get('/orders/fetchOrder', authMiddleware, orderController.fetchOrder);
// router.get('/orders/fetchOrders', authMiddleware, orderController.fetchOrders);

// router.get('/store/orders', authMiddleware, storeController.getOrders);
// router.get('/store/orders/search', authMiddleware, storeController.searchOrders);
// router.get('/store/orders/filter-by-status', authMiddleware, storeController.filterOrdersByStatus);


//Products
// router.post(
//   '/products/create',
//   authMiddleware,
//   middleware.checkAbilities(Actions.Create, RESOURCES.product),
//   middleware.handleValidationError,
//   productValidator.createProduct(),
//   productController.createProduct,
// );

// router.post(
//   '/products/update/:id',
//   authMiddleware,
//   middleware.checkAbilities(Actions.Create, RESOURCES.product),
//   middleware.handleValidationError,
//   productValidator.updateProduct(),
//   productController.updateProduct,
// );

// router.post(
//   '/products/draft',
//   authMiddleware,
//   middleware.checkAbilities(Actions.Create, RESOURCES.product),
//   middleware.handleValidationError,
//   productController.createDraft,
// );

// router.get(
//   '/products/fetchProduct',
//   authMiddleware,
//   productController.fetchProduct,
// );

// router.delete(
//   '/product/delete/:id',
//   authMiddleware,
//   productController.deleteProduct,
// );

// router.get(
//   '/products/fetchDeals',
//   authMiddleware,
//   productController.fetchDeals,
// ); 

// router.get(
//   '/products/store',
//   authMiddleware,
//   productController.fetchProducts,
// );

// router.get(
//   '/drafts/store',
//   authMiddleware,
//   productController.fetchDrafts,
// );


// router.post(
//   '/products/Summary',
//   authMiddleware,
//   productController.calculatePrice,
// );

//category & product endpoints for the mobile app

// search products
// router.get(
//   '/products/search',
//   authMiddleware,
//   mobileProductController.fetchProductsbyKeyword,
// );



//add product to cart

//Organisation
// router.post(
//   '/organisation/user/create',
//   organisationValidator.createNewOrgUser(),
//   middleware.handleValidationError,
//   organisationController.createOrgUser,
// );

// router.post(
//   '/organisation/user/setup-password',
//   organisationValidator.createUserPassword(),
//   middleware.handleValidationError,
//   organisationController.createPassword,
// );

// router.post(
//   '/organisation/user/resend-email',
//   organisationValidator.resendEmail(),
//   middleware.handleValidationError,
//   organisationController.orgResendEmail,
// );

// router.post(
//   '/organisation/profile/update',
//   authMiddleware,
//   organisationValidator.updateOrg(),
//   middleware.handleValidationError,
//   organisationController.updateOrgProfile,
// );

// router.get('/organisation/dashboard', authMiddleware, organisationController.fetchDashboardData);

// router.get('/organisation/administrators', authMiddleware, organisationController.fetchAdministrators);

// router.post(
//   '/organisation/withdraw',
//   authMiddleware,
//   organisationValidator.withdrawRevenue(),
//   middleware.handleValidationError,
//   organisationController.withdrawRevenue,
// );

export { router };
