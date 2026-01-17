"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getISOByCountry = exports.calculateFee = exports.checkUserPaymentMethods = exports.decryptData = exports.encryptData = exports.calculateDistance = exports.generateOtp = exports.generateRefCode = exports.compareHashedData = exports.hashData = exports.OTP_CODE_EXP = exports.verifyAccessToken = exports.generateAccessToken = exports.generateSku = exports.amountSufficient = exports.hasSufficientBalance = exports.isValidSignature = exports.generateSignature = void 0;
exports.getPaymentMethodByCurrency = getPaymentMethodByCurrency;
exports.getPaymentSystems = getPaymentSystems;
exports.generateOrderId = generateOrderId;
exports.generateAccessPin = generateAccessPin;
exports.hashPin = hashPin;
exports.verifyPin = verifyPin;
exports.maskEmail = maskEmail;
const bcrypt = __importStar(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const jwks_rsa_1 = __importDefault(require("jwks-rsa"));
const prisma_config_1 = __importDefault(require("./config/prisma.config"));
const moment_1 = __importDefault(require("moment"));
const env_config_1 = __importDefault(require("./config/env.config"));
const decimal_js_1 = __importDefault(require("decimal.js"));
const crypto_1 = __importDefault(require("crypto"));
const ulid_1 = require("ulid");
const logger_1 = __importDefault(require("./config/logger"));
const algorithm = 'aes-256-cbc';
const key = crypto_1.default.randomBytes(32);
const iv = crypto_1.default.randomBytes(16);
const generateSignature = (body, // raw JSON string of the request body
timestamp, // timestamp string from header
secret // your webhook secret
) => {
    const payloadToSign = `${timestamp}.${body}`;
    return crypto_1.default
        .createHmac("sha256", secret)
        .update(payloadToSign)
        .digest("hex");
};
exports.generateSignature = generateSignature;
const isValidSignature = (body, // raw JSON string of the request body
timestamp, // timestamp string from X-Api-Timestamp header
signature, // hex string from X-Api-Signature header
secret // your webhook secret
) => {
    const expectedSignature = (0, exports.generateSignature)(body, timestamp, secret);
    // Use timing-safe comparison to avoid timing attack vulnerability
    const sigBuffer = Buffer.from(signature, "hex");
    const expectedSigBuffer = Buffer.from(expectedSignature, "hex");
    return (sigBuffer.length === expectedSigBuffer.length &&
        crypto_1.default.timingSafeEqual(sigBuffer, expectedSigBuffer));
};
exports.isValidSignature = isValidSignature;
const hasSufficientBalance = (availableBalance, // Store balance as string
amount) => {
    const balanceDecimal = new decimal_js_1.default(availableBalance);
    const amountDecimal = new decimal_js_1.default(amount);
    return amountDecimal.lte(balanceDecimal); // Use lte (less than or equal)
};
exports.hasSufficientBalance = hasSufficientBalance;
const amountSufficient = (amount1, amount2) => {
    const amount1Decimal = new decimal_js_1.default(amount1);
    const amount2Decimal = new decimal_js_1.default(amount2);
    return amount1Decimal.greaterThanOrEqualTo(amount2Decimal); // Use greater than or equal to
};
exports.amountSufficient = amountSufficient;
const generateSku = () => {
    const randomPart = Math.floor(Math.random() * 1000000)
        .toString()
        .padStart(6, '0'); // Generate a random 6-digit number
    const timestampPart = Date.now().toString(); // Get current timestamp
    return `Q-${randomPart}-${timestampPart}`;
};
exports.generateSku = generateSku;
const generateAccessToken = (user) => {
    const options = { expiresIn: env_config_1.default.jwt.expiry };
    return jsonwebtoken_1.default.sign(user, env_config_1.default.jwt.secret, options);
};
exports.generateAccessToken = generateAccessToken;
// 1. Initialize JWKS client
const client = (0, jwks_rsa_1.default)({
    jwksUri: `https://auth.vyre.africa/.well-known/jwks.json`
});
// 2. Key provider callback
const getKey = (header, callback) => {
    client.getSigningKey(header.kid, (err, key) => {
        console.log('the key', key);
        callback(err, key?.getPublicKey());
    });
};
const verifyAccessToken = (token) => {
    // console.log('jwtPublicKey',jwtPublicKey)
    console.log('token', token);
    const options = {
        algorithms: ['RS256'],
        // Add other verification options as needed:
        // issuer: 'https://your-auth0-domain.auth0.com/',
        // audience: 'your-api-identifier',
    };
    console.log('key used here', env_config_1.default.clerk.PEM_PUBLICKEY);
    try {
        const decoded = jsonwebtoken_1.default.verify(token, env_config_1.default.clerk.PEM_PUBLICKEY, options);
        //  console.log('decoded',decoded)
        // Additional manual validation
        const currentTime = Math.floor(Date.now() / 1000);
        if (decoded.exp && decoded.exp < currentTime) {
            throw new Error('Token has expired');
        }
        if (decoded.nbf && decoded.nbf > currentTime) {
            throw new Error('Token is not yet valid');
        }
        return {
            success: true,
            data: decoded
        };
    }
    catch (error) {
        let errorMessage = 'Token verification failed';
        let errorCode = 'TOKEN_VERIFICATION_ERROR';
        if (error instanceof jsonwebtoken_1.default.TokenExpiredError) {
            errorMessage = 'Token has expired';
            errorCode = 'TOKEN_EXPIRED';
        }
        else if (error instanceof jsonwebtoken_1.default.NotBeforeError) {
            errorMessage = 'Token is not yet valid';
            errorCode = 'TOKEN_EARLY';
        }
        else if (error instanceof jsonwebtoken_1.default.JsonWebTokenError) {
            errorMessage = error.message;
            errorCode = 'JWT_ERROR';
        }
        return {
            success: false,
            error: {
                message: errorMessage,
                code: errorCode,
                details: error
            }
        };
    }
};
exports.verifyAccessToken = verifyAccessToken;
exports.OTP_CODE_EXP = (0, moment_1.default)().add(45, 'minutes').toString();
const hashData = async (data) => {
    const hash = await bcrypt.hash(data, 10);
    return hash;
};
exports.hashData = hashData;
const compareHashedData = async (data, encrypted) => {
    const match = await bcrypt.compare(data, encrypted);
    return match;
};
exports.compareHashedData = compareHashedData;
const generateRefCode = (key, length = 6) => {
    const characters = key + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < length; i++) {
        const randomIndex = Math.floor(Math.random() * characters.length);
        code += characters.charAt(randomIndex);
    }
    return code;
};
exports.generateRefCode = generateRefCode;
const generateOtp = (key, length = 6) => {
    // const characters = key + '0123456789';
    const characters = '0123456789';
    let code = '';
    for (let i = 0; i < length; i++) {
        const randomIndex = Math.floor(Math.random() * characters.length);
        code += characters.charAt(randomIndex);
    }
    return code;
};
exports.generateOtp = generateOtp;
const calculateDistance = (latitude1, longitude1, latitude2, longitude2) => {
    // Radius of the Earth in kilometers
    const radius = 6371;
    const toRadians = (degree) => {
        return degree * (Math.PI / 180);
    };
    const differenceInLatitude = toRadians(latitude2 - latitude1);
    const differenceInLongitude = toRadians(longitude2 - longitude1);
    const a = Math.sin(differenceInLatitude / 2) * Math.sin(differenceInLatitude / 2) +
        Math.cos(toRadians(latitude1)) * Math.cos(toRadians(latitude2)) *
            Math.sin(differenceInLongitude / 2) * Math.sin(differenceInLongitude / 2);
    const distanceInRadians = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    // Distance in kilometers
    const distance = radius * distanceInRadians;
    return distance;
};
exports.calculateDistance = calculateDistance;
const encryptData = async (data) => {
    const cipher = crypto_1.default.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted;
};
exports.encryptData = encryptData;
const decryptData = async (data) => {
    const cipher = crypto_1.default.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted;
};
exports.decryptData = decryptData;
const checkUserPaymentMethods = async (userId) => {
    const [fiatAccounts, cryptoAccounts] = await Promise.all([
        prisma_config_1.default.fiatAccount.findMany({
            where: { userId },
            select: { id: true, name: true, currency: true }
        }),
        prisma_config_1.default.cryptoAccount.findMany({
            where: { userId },
            select: { id: true, name: true, cryptoWalletType: true }
        })
    ]);
    return {
        hasAnyPaymentMethod: fiatAccounts.length > 0 || cryptoAccounts.length > 0,
        hasFiatAccount: fiatAccounts.length > 0,
        hasCryptoAccount: cryptoAccounts.length > 0,
        //   fiatAccounts,
        //   cryptoAccounts
    };
};
exports.checkUserPaymentMethods = checkUserPaymentMethods;
const calculateFee = (sourceAmount) => {
    // Base fee is 4.5%, but decreases with higher amounts
    let feePercentage;
    if (sourceAmount <= 10) {
        feePercentage = 0.15; // 15.0% for small amounts (<$10)
    }
    else if (sourceAmount <= 20) {
        feePercentage = 0.095; // 9.5% for $20–50
    }
    else if (sourceAmount <= 50) {
        feePercentage = 0.045; // 4.5% for $10–50
    }
    else {
        feePercentage = 0.025; // 2.5% for $50–100
    }
    // Calculate fee in USD
    let fee = sourceAmount * feePercentage;
    // Ensure minimum fee of $0.40
    return Number(Math.max(fee, 0.40).toFixed(2));
};
exports.calculateFee = calculateFee;
function getPaymentMethodByCurrency(currencyCode) {
    const currencyToMethod = {
        USD: 'ACH', // USA (ACH) or 'WIRE' for international USD
        EUR: 'SEPA', // Eurozone
        AED: 'AE_UAEFTS', // UAE
        ARS: 'AR_TRANSFERS_3', // Argentina
        AUD: 'AU_BECS', // Australia
        BDT: 'BD_BEFTN', // Bangladesh
        BOB: 'BO_RTGS', // Bolivia
        BRL: 'BR_TED_DOC_PIX', // Brazil
        CAD: 'CA_INTERAC', // Canada
        CLP: 'CL_TEF', // Chile
        CNY: 'CN_CNAPS', // China
        COP: 'CO_ACH', // Colombia
        CRC: 'CR_SINPE', // Costa Rica
        CZK: 'CZ_CERTIS', // Czech Republic
        DKK: 'DK_NEMKONTO_FI', // Denmark
        DOP: 'DO_ACH', // Dominican Republic
        EGP: 'EG_RTGS_IPN', // Egypt
        GBP: 'GB_BACS_CHAPS_FPS', // UK
        GHS: 'GH_GHIPSS', // Ghana
        GTQ: 'GT_ACH', // Guatemala
        HKD: 'HK_HKICL_CHATS_ECG', // Hong Kong
        HUF: 'HU_GIRO', // Hungary
        IDR: 'ID_SKN_RTGS', // Indonesia
        ILS: 'IL_ZAHAV', // Israel
        INR: 'IN_NEFT_RTGS_IMPS', // India
        JMD: 'JM_LOCAL', // Jamaica
        JOD: 'JO_ACH', // Jordan
        JPY: 'JP_ZENGIN', // Japan
        KES: 'KE_KIBBS_PESALINK', // Kenya
        KRW: 'KR_LOCAL', // South Korea
        LKR: 'LK_LOCAL', // Sri Lanka
        MXN: 'MX_SPEI', // Mexico
        MYR: 'MY_IBG_RENTAS', // Malaysia
        NGN: 'NG_NIBSS_NEFT', // Nigeria
        NOK: 'NO_NICS', // Norway
        NPR: 'NP_LOCAL', // Nepal
        NZD: 'NZ_LOCAL', // New Zealand
        PEN: 'PE_CCE', // Peru
        PHP: 'PH_INSTAPAY_PESONET', // Philippines
        PKR: 'PK_RAAST_IBFT', // Pakistan
        PLN: 'PL_ELIXIR_BLUE_CASH', // Poland
        QAR: 'QA_QPS', // Qatar
        RON: 'RO_RTGS', // Romania
        SAR: 'SA_MADA', // Saudi Arabia
        SEK: 'SE_BANKGIROT', // Sweden
        SGD: 'SG_FAST_MEPS', // Singapore
        THB: 'TH_BAHTNET_PROMPTPAY', // Thailand
        TRY: 'TR_FAST_EFT', // Turkey
        TZS: 'TZ_RTGS', // Tanzania
        VND: 'VN_IBPS', // Vietnam
        ZAR: 'ZA_RTGS_EFT', // South Africa
    };
    return currencyToMethod[currencyCode.toUpperCase()];
}
const countryToISOMap = {
    'Algeria': 'DZ',
    'Angola': 'AO',
    'Benin': 'BJ',
    'Botswana': 'BW',
    'Burkina Faso': 'BF',
    'Burundi': 'BI',
    'Cameroon': 'CM',
    'Cape Verde': 'CV',
    'Central African Republic': 'CF',
    'Chad': 'TD',
    'Comoros': 'KM',
    'Congo-Brazzaville': 'CG',
    'Congo-Kinshasa': 'CD',
    "Côte d'Ivoire": 'CI',
    'Djibouti': 'DJ',
    'Egypt': 'EG',
    'Equatorial Guinea': 'GQ',
    'Eritrea': 'ER',
    'Eswatini': 'SZ',
    'Ethiopia': 'ET',
    'Gabon': 'GA',
    'Gambia': 'GM',
    'Ghana': 'GH',
    'Guinea': 'GN',
    'Guinea-Bissau': 'GW',
    'Kenya': 'KE',
    'Lesotho': 'LS',
    'Liberia': 'LR',
    'Libya': 'LY',
    'Madagascar': 'MG',
    'Malawi': 'MW',
    'Mali': 'ML',
    'Mauritania': 'MR',
    'Mauritius': 'MU',
    'Morocco': 'MA',
    'Mozambique': 'MZ',
    'Namibia': 'NA',
    'Niger': 'NE',
    'Nigeria': 'NG',
    'Rwanda': 'RW',
    'São Tomé and Príncipe': 'ST',
    'Senegal': 'SN',
    'Seychelles': 'SC',
    'Sierra Leone': 'SL',
    'Somalia': 'SO',
    'South Africa': 'ZA',
    'South Sudan': 'SS',
    'Sudan': 'SD',
    'Tanzania': 'TZ',
    'Togo': 'TG',
    'Tunisia': 'TN',
    'Uganda': 'UG',
    'Zambia': 'ZM',
    'Zimbabwe': 'ZW',
    'Belgium': 'BE',
    'United States': 'US'
};
const getISOByCountry = (countryName) => {
    return countryToISOMap[countryName];
};
exports.getISOByCountry = getISOByCountry;
// Basic version: Returns array of payment method codes
function getPaymentSystems(currencyISO) {
    const currency = currencyISO.toUpperCase();
    const PaymentSystemsMap = {
        'NGN': ['BANK_TRANSFER', 'MOMO', 'CARD'],
        'GHS': ['BANK_TRANSFER', 'MOMO', 'MOBILE_MONEY'],
        'KSH': ['BANK_TRANSFER', 'MOMO', 'MPESA'],
        'KES': ['BANK_TRANSFER', 'MOMO', 'MPESA'],
        'USD': ['CARD', 'PAYPAL', 'BANK_TRANSFER'],
        'EUR': ['CARD', 'BANK_TRANSFER', 'SEPA'],
        'GBP': ['CARD', 'BANK_TRANSFER', 'FASTER_PAYMENTS'],
        'ZAR': ['BANK_TRANSFER', 'CARD', 'EWALLET'],
    };
    return PaymentSystemsMap[currency] || [];
}
function generateOrderId() {
    return `ORD-${(0, ulid_1.ulid)()}`; // e.g., "ORD-01HN8X9ZYQR8XJKM9T5WN3QVBP"
}
function generateAccessPin() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}
async function hashPin(pin) {
    const bcrypt = require('bcryptjs');
    return await bcrypt.hash(pin, 10);
}
/**
 * Verify PIN against hashed version
 */
async function verifyPin(inputPin, hashedPin) {
    const bcrypt = require('bcryptjs');
    try {
        return await bcrypt.compare(inputPin, hashedPin);
    }
    catch (error) {
        logger_1.default.error('PIN verification error', { error });
        return false;
    }
}
function maskEmail(email) {
    const [username, domain] = email.split('@');
    const masked = username.slice(0, 2) + '***' + username.slice(-1);
    return `${masked}@${domain}`;
}
