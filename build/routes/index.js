"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const admin_1 = require("./admin");
const env_config_1 = __importDefault(require("../config/env.config"));
const middleware_1 = __importDefault(require("../middleware"));
const auth_1 = require("../services/auth");
const register_1 = require("../services/register");
const user_controller_1 = __importDefault(require("../controllers/user.controller"));
const order_controller_1 = __importDefault(require("../controllers/order.controller"));
const user_validator_1 = __importDefault(require("../validators/user.validator"));
const wallet_validator_1 = __importDefault(require("../validators/wallet.validator"));
const order_validator_1 = __importDefault(require("../validators/order.validator"));
const mobile_user_controller_1 = __importDefault(require("../controllers/mobile/mobile.user.controller"));
const wallet_controller_1 = __importDefault(require("../controllers/wallet.controller"));
const swap_controller_1 = __importDefault(require("../controllers/swap.controller"));
const swap_validator_1 = __importDefault(require("../validators/swap.validator"));
const event_controller_1 = __importDefault(require("../controllers/event.controller"));
const router = (0, express_1.Router)();
exports.router = router;
//use the admin routes
router.use(admin_1.adminRouter);
router.get('/', (req, res) => {
    res.send(`Welcome to the vyre Africa Backend API! ${env_config_1.default.nodeEnv}`);
});
// roles
//User
router.post('/register', register_1.registerMiddleware, user_controller_1.default.register);
router.post('/webhook/clerk', event_controller_1.default.clerk_WebHook);
router.post('/webhook/qorepay', event_controller_1.default.qorepay_WebHook);
router.post('/webhook/fern', event_controller_1.default.fern_WebHook);
router.post('/webhook/tatum', event_controller_1.default.tatum_WebHook);
router.post('/user/upload_kyc', auth_1.authMiddleware, user_validator_1.default.uploadKyc(), middleware_1.default.handleValidationError, user_controller_1.default.register_Kyc);
router.post('/user/login', user_validator_1.default.login(), middleware_1.default.handleValidationError, user_controller_1.default.loginUser);
router.post('/authenticate-Otp', user_validator_1.default.authenticateOtp(), middleware_1.default.handleValidationError, user_controller_1.default.authenticateViaOtp);
router.post('/verify-email', user_validator_1.default.verifyEmail(), middleware_1.default.handleValidationError, user_controller_1.default.verifyEmail);
router.post('/resent-otp', user_validator_1.default.resendOtpCode(), middleware_1.default.handleValidationError, user_controller_1.default.resendOtpCode);
router.post('/setup-password', 
// userValidator.setPassword(),
// middleware.handleValidationError,
user_controller_1.default.setPassword);
router.post('/forgot-password', user_validator_1.default.resendOtpCode(), middleware_1.default.handleValidationError, user_controller_1.default.forgotPassword);
router.post('/verify-Otp', user_validator_1.default.verifyOtp(), middleware_1.default.handleValidationError, user_controller_1.default.verifyOtp);
router.post('/update-password', user_validator_1.default.updatePassword(), middleware_1.default.handleValidationError, user_controller_1.default.updatePasswordRecovery);
router.post('/user-Address', user_validator_1.default.submitAddress(), middleware_1.default.handleValidationError, user_controller_1.default.submitAddress);
// swap
router.post('/paymentAccount/fiat', auth_1.authMiddleware, swap_validator_1.default.addFiatAccount(), middleware_1.default.handleValidationError, swap_controller_1.default.addFiatAccount);
router.post('/paymentAccount/crypto', auth_1.authMiddleware, swap_validator_1.default.addCryptoAccount(), middleware_1.default.handleValidationError, swap_controller_1.default.addCryptoAccount);
router.delete('/paymentAccount/:accountId', auth_1.authMiddleware, swap_controller_1.default.deletePaymentAccount);
router.get('/linkedAccounts', auth_1.authMiddleware, swap_controller_1.default.getLinkedAccounts);
router.post('/swap/quote', auth_1.authMiddleware, swap_validator_1.default.generateQuote(), middleware_1.default.handleValidationError, swap_controller_1.default.generateQuote);
router.post('/swap/initiate', auth_1.authMiddleware, swap_validator_1.default.initiateSwap(), middleware_1.default.handleValidationError, swap_controller_1.default.initiateSwap);
router.get('/swaps', auth_1.authMiddleware, swap_controller_1.default.fetchSwaps);
router.get('/swaps/:id', auth_1.authMiddleware, swap_controller_1.default.fetchSwap);
// router.post('/sendOTP', userController.sendVerification);
// Wallet
router.post('/wallet/create/:currencyId', auth_1.authMiddleware, wallet_controller_1.default.createWallet);
router.post('/wallet/deposit', auth_1.authMiddleware, wallet_validator_1.default.initDeposit(), middleware_1.default.handleValidationError, wallet_controller_1.default.init_BankDeposit);
router.post('/wallet/authorize_fiat_withdrawal', auth_1.authMiddleware, wallet_validator_1.default.initDeposit(), middleware_1.default.handleValidationError, wallet_controller_1.default.authorize_fiat_Withdrawal);
router.post('/wallet/vyre_tranfer', auth_1.authMiddleware, wallet_validator_1.default.initVyreTransfer(), middleware_1.default.handleValidationError, wallet_controller_1.default.init_VyreTransfer);
router.post('/wallet/blockchain_tranfer', auth_1.authMiddleware, wallet_validator_1.default.initBlockchainTransfer(), middleware_1.default.handleValidationError, wallet_controller_1.default.init_BlockchainTransfer);
router.post('/wallet/bank_tranfer', auth_1.authMiddleware, wallet_validator_1.default.initBankTransfer(), middleware_1.default.handleValidationError, wallet_controller_1.default.init_BankTransfer);
router.get('/wallet/all', auth_1.authMiddleware, wallet_controller_1.default.fetchWallets);
router.get('/wallet/:id', auth_1.authMiddleware, wallet_controller_1.default.fetchWallet);
router.get('/wallet_by_name/:name', auth_1.authMiddleware, wallet_controller_1.default.fetchWalletByName);
router.get('/rate', auth_1.authMiddleware, wallet_controller_1.default.getRate);
router.get('/transactions', auth_1.authMiddleware, wallet_controller_1.default.fetchTransactions);
//orders
router.get('/orders', auth_1.authMiddleware, order_controller_1.default.fetchOrders);
router.get('/orders/user', auth_1.authMiddleware, order_controller_1.default.fetch_user_orders);
router.get('/order/:id', 
// authMiddleware,
order_controller_1.default.fetchOrder);
router.post('/orders/create', auth_1.authMiddleware, order_validator_1.default.createOrder(), middleware_1.default.handleValidationError, order_controller_1.default.createOrder);
router.post('/orders/anonymous/initiate', 
// authMiddleware,
order_validator_1.default.initializeAnon(), middleware_1.default.handleValidationError, order_controller_1.default.initiateAnonymous);
router.post('/orders/process', auth_1.authMiddleware, order_validator_1.default.processOrder(), middleware_1.default.handleValidationError, order_controller_1.default.processOrder);
router.post('/order/cancel/:id', auth_1.authMiddleware, order_controller_1.default.cancelOrder);
router.get('/orders/pairs', auth_1.authMiddleware, order_controller_1.default.fetchPairs);
router.get('/orders/pairs/rate', auth_1.authMiddleware, order_controller_1.default.getRatebyPair);
router.get('/orders/getPairWallets', auth_1.authMiddleware, order_controller_1.default.fetchPairWallets);
// //update user profile
router.get('/user/portfolio', auth_1.authMiddleware, wallet_controller_1.default.fetchPortfolio);
router.get('/user/get-profile', auth_1.authMiddleware, user_controller_1.default.getProfile);
router.post('/user/query', auth_1.authMiddleware, user_controller_1.default.queryUser);
router.post('/user/update-profile', auth_1.authMiddleware, user_validator_1.default.updateProfile(), middleware_1.default.handleValidationError, user_controller_1.default.updateProfile);
router.post('/user/change-password', auth_1.authMiddleware, user_validator_1.default.changePassword(), middleware_1.default.handleValidationError, user_controller_1.default.changePassword);
router.post('/user/generate-pin', user_validator_1.default.generatePin(), middleware_1.default.handleValidationError, user_controller_1.default.generatePin);
router.post('/user/verify-pin', user_validator_1.default.verifyPin(), middleware_1.default.handleValidationError, user_controller_1.default.verifyPin);
//get banks
router.get('/banks', user_controller_1.default.getAllBanks);
router.get('/banks/currency', user_controller_1.default.getCurrencyBanks);
router.post('/user/verify-account-detail', auth_1.authMiddleware, user_validator_1.default.verifyAccountDetail(), middleware_1.default.handleValidationError, user_controller_1.default.verifyAccountDetail);
//add user bank
router.post('/user/bank/create', auth_1.authMiddleware, user_validator_1.default.addBank(), middleware_1.default.handleValidationError, user_controller_1.default.addBank);
//get user bank
router.get('/user/bank', auth_1.authMiddleware, user_controller_1.default.getUserBank);
router.get('/user/wallet/balance', auth_1.authMiddleware, user_controller_1.default.getUserWalletBalance);
//delete user bank
router.delete('/user/bank/:userBankId', auth_1.authMiddleware, user_controller_1.default.deleteUserBank);
//user save notification setting
router.post('/user/notification-setting', auth_1.authMiddleware, user_validator_1.default.setNotificationMethod(), middleware_1.default.handleValidationError, user_controller_1.default.setNotificationMethod);
//user get notification setting
router.get('/user/notification-setting', auth_1.authMiddleware, user_controller_1.default.getNotificationMethod);
//user get auth secret for third party authenticator
router.get('/user/get-Auth-secret', auth_1.authMiddleware, user_controller_1.default.getAuthSecret);
router.get('/user/get-two-factor-authentication-status', auth_1.authMiddleware, user_controller_1.default.getTwoFactorAuthenticationMethod);
//save 2FA method
router.post('/user/two-factor-authentication', auth_1.authMiddleware, user_validator_1.default.setTwoFactorAuthenticationMethod(), middleware_1.default.handleValidationError, user_controller_1.default.setTwoFactorAuthenticationMethod);
//save 2FA method
router.post('/user/disable-two-factor-authentication', auth_1.authMiddleware, user_validator_1.default.disableTwoFactorAuthenticationMethod(), middleware_1.default.handleValidationError, user_controller_1.default.disableTwoFactorAuthenticationMethod);
//delete account
router.delete('/user/account/delete', auth_1.authMiddleware, user_validator_1.default.deleteAccount(), middleware_1.default.handleValidationError, mobile_user_controller_1.default.deleteAccount);
//get user notifications
router.get('/user/notification', auth_1.authMiddleware, user_controller_1.default.getNotification);
//filter user notifications
router.get('/user/notification/filter', auth_1.authMiddleware, user_controller_1.default.filterNotification);
//get user transactions
router.get('/user/transactions', auth_1.authMiddleware, user_controller_1.default.getTransactions);
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
router.post('/user/wallet/fund', auth_1.authMiddleware, user_validator_1.default.fundUserWallet(), middleware_1.default.handleValidationError, user_controller_1.default.fundWallet);
//verify carsd
router.post('/user/card/verify', auth_1.authMiddleware, user_validator_1.default.verifyCard(), middleware_1.default.handleValidationError, mobile_user_controller_1.default.verifyCard);
//add atm card
router.post('/user/card/add', auth_1.authMiddleware, user_validator_1.default.addCard(), middleware_1.default.handleValidationError, mobile_user_controller_1.default.addCard);
//get cards
router.get('/user/card/fetch', auth_1.authMiddleware, mobile_user_controller_1.default.getCards);
//set card as preferred
router.post('/user/card/set-as-preferred/:card_id', auth_1.authMiddleware, mobile_user_controller_1.default.setCardAsPreferred);
//unset card as preferred
router.post('/user/card/unset-as-preferred/:card_id', auth_1.authMiddleware, mobile_user_controller_1.default.unSetCardAsPreferred);
//delete card
router.post('/user/card/delete/:card_id', auth_1.authMiddleware, mobile_user_controller_1.default.deleteCard);
