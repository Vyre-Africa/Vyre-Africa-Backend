import { body } from 'express-validator';

class UserValidator {

    register() {
        return [
            body('DETAILS').isObject(),
            body('DETAILS.firstName')
                .notEmpty()
                .withMessage('user first name is required'),
            body('DETAILS.lastName')
                .notEmpty()
                .withMessage('user last name is required'),
            body('DETAILS.email')
                .notEmpty()
                .withMessage('user email address is required'),
            body('DETAILS.phoneNumber')
                .notEmpty()
                .withMessage('user phone number is required')
            // body('DETAILS.referreeId')
            //     .optional()
            //     .withMessage('referral id is optional'),
        ];
    }

    generatePin(){
        return [
            body('email').notEmpty().withMessage('email is required'),
            body('phoneNumber').notEmpty().withMessage('phoneNumber is required')
        ];
    }

    uploadKyc() {
        return [
            // body('DETAILS').isObject().withMessage('DETAILS must be an object'),
            // Personal Information
                body('legalFirstName').notEmpty().withMessage('Legal first name is required').isString().withMessage('Legal first name must be a string').trim().isLength({ max: 100 }).withMessage('Legal first name cannot exceed 100 characters'),
                body('legalLastName').notEmpty().withMessage('Legal last name is required').isString().withMessage('Legal last name must be a string').trim().isLength({ max: 100 }).withMessage('Legal last name cannot exceed 100 characters'),
                body('phoneNumber').notEmpty().withMessage('Phone number is required').isString().withMessage('Phone number must be a string').trim().isMobilePhone('any').withMessage('Invalid phone number format'),
                body('dateOfBirth').notEmpty().withMessage('Date of birth is required'),
                body('nationalIdType').notEmpty().withMessage('National Id Type is required'),
                body('nationalIdNumber').notEmpty().withMessage('National Id Number is required'),


                // Address Validation
                body('address').isObject().withMessage('Address must be an object'),
                    body('address.streetLine1').notEmpty().withMessage('Street address is required').isString().withMessage('Street address must be a string').trim().isLength({ max: 200 }).withMessage('Street address cannot exceed 200 characters'),
                    body('address.city').notEmpty().withMessage('City is required').isString().withMessage('City must be a string').trim().isLength({ max: 100 }).withMessage('City cannot exceed 100 characters'),
                    body('address.stateRegionProvince').notEmpty().withMessage('State/Region/Province is required').isString().withMessage('State/Region/Province must be a string').trim().isLength({ max: 100 }).withMessage('State/Region/Province cannot exceed 100 characters'),
                    body('address.postalCode').notEmpty().withMessage('Postal code is required').isString().withMessage('Postal code must be a string').trim().isLength({ max: 20 }).withMessage('Postal code cannot exceed 20 characters'),
                    body('address.countryCode').notEmpty().withMessage('Country code is required').isString().withMessage('Country code must be a string').trim().isLength({ min: 2, max: 3 }).withMessage('Country code must be 2-3 characters').isAlpha().withMessage('Country code must contain only letters'),

                
                body('documents').isObject().withMessage('Documents must be an object'),
    
                    // Government ID Validation
                    body('documents.governmentId').isObject().withMessage('Government ID must be an object'),
                        body('documents.governmentId.type').notEmpty().withMessage('Government ID type is required').isString().withMessage('Government ID type must be a string')
                            .isIn([
                                "NATIONAL_ID",
                                "DRIVERS_LICENSE", 
                                "PASSPORT"
                            ]).withMessage('Invalid government ID type'),
                        // body('documents.governmentId.countryCode').notEmpty().withMessage('Government ID country code is required').isString().withMessage('Country code must be a string').trim().isLength({ min: 2, max: 3 }).withMessage('Country code must be 2-3 characters').isAlpha().withMessage('Country code must contain only letters'),
                        body('documents.governmentId.documentIdNumber').notEmpty().withMessage('Document ID number is required').isString().withMessage('Document ID number must be a string').trim().isLength({ max: 50 }).withMessage('Document ID number cannot exceed 50 characters'),
                      
                        body('documents.governmentId.issuanceDate').notEmpty().withMessage('Issuance date is required'),
                        // body('documents.governmentId.expirationDate').notEmpty().withMessage('Expiration date is required').isISO8601().withMessage('Expiration date must be in ISO8601 format (YYYY-MM-DD)').toDate()
                        // .custom((value, { req }) => {
                        //     if (new Date(value) <= new Date()) {
                        //     throw new Error('Expiration date must be in the future');
                        //     }
                        //     return true;
                        // }),
                      
                        body('documents.governmentId.frontIdImage')
                        .notEmpty().withMessage('Front ID image is required')
                        .custom((value) => {
                            if (!value || !(typeof value === 'string' || value instanceof Buffer)) {
                            throw new Error('Front ID image must be a base64 string or buffer');
                            }
                            return true;
                        }),
                      
                    // Proof of Address Validation
                    // body('documents.proof_of_Address').isObject().withMessage('Proof of Address must be an object'),
                    //     body('documents.proof_of_Address.type').notEmpty().withMessage('Proof of Address type is required').isString().withMessage('Proof of Address type must be a string'),
                    //     body('documents.proof_of_Address.proofOfAddressImage').notEmpty().withMessage('Proof of Address image is required')
                    //     .custom((value) => {
                    //         if (!value || !(typeof value === 'string' || value instanceof Buffer)) {
                    //         throw new Error('Proof of Address must be a PDF or image file');
                    //         }
                    //         return true;
                    //     }),

                // Employment Information
                body('employmentStatus').notEmpty().withMessage('Employment status is required').isString().withMessage('Employment status must be a string')
                .isIn([
                    "EMPLOYED",
                    "SELF_EMPLOYED",
                    "UNEMPLOYED",
                    "RETIRED",
                    "STUDENT",
                    "HOMEMAKER"
                  ]).withMessage('Invalid employment status'),
                            
                body('mostRecentOccupation').optional().isString().withMessage('Most recent occupation must be a string').trim().isLength({ max: 100 }).withMessage('Most recent occupation cannot exceed 100 characters'),
                // Financial Information
                body('sourceOfFunds').notEmpty().withMessage('Source of funds is required').isString().withMessage('Source of funds must be a string')
                    .isIn([
                        "COMPANY_FUNDS",
                        "E_COMMERCE_RESELLER",
                        "GAMBLING_PROCEEDS",
                        "GIFTS",
                        "GOVERNMENT_BENEFITS",
                        "INHERITANCE",
                        "INVESTMENTS_OR_LOANS",
                        "PENSION_RETIREMENT_FUNDS",
                        "PROCEEDS_FROM_REAL_ESTATE_SALES",
                        "SALARY",
                        "SAVINGS",
                        "SOMEONE_ELSES_FUNDS",
                        "BUSINESS_LOANS",
                        "GRANTS",
                        "INTER_COMPANY_FUNDS",
                        "INVESTMENT_PROCEEDS",
                        "LEGAL_SETTLEMENT",
                        "OWNERS_CAPITAL",
                        "PENSION_OR_RETIREMENT",
                        "SALE_OF_ASSETS",
                        "SALE_OF_GOODS_AND_SERVICES",
                        "TAX_REFUND",
                        "THIRD_PARTY_FUNDS",
                        "TREASURY_RESERVES"
                    ]).withMessage('Invalid source of funds'),
                            
                body('accountPurpose').notEmpty().withMessage('Account purpose is required').isString().withMessage('Account purpose must be a string')
                    .isIn([
                        "CHARITABLE_DONATIONS",
                        "COMPANY_OPERATIONS",
                        "E_COMMERCE_PAYMENTS",
                        "FREELANCE_PAYMENTS",
                        "INVESTMENT",
                        "PAYMENTS_TO_FRIENDS_FAMILY_ABROAD",
                        "PERSONAL_EXPENSES",
                        "PURCHASING_GOODS_OR_SERVICES",
                        "SALARY_PAYMENTS",
                        "WEALTH_PROTECTION",
                        "OTHER",
                        "PAYROLL",
                        "RECEIVING_GOODS_OR_SERVICES",
                        "TAX_OPTIMIZATION",
                        "THIRD_PARTY_PAYMENTS",
                        "TREASURY_MANAGEMENT"
                    ]).withMessage('Invalid account purpose'),
                            
                body('expectedMonthlyPaymentsUsd').notEmpty().withMessage('Expected monthly payments is required').isString().withMessage('Expected monthly payments must be a string')
                    .isIn([
                        "LESS_THAN_5000",
                        "BETWEEN_5000_9999",
                        "LESS_THAN_10000",
                        "BETWEEN_10000_49999",
                        "BETWEEN_10000_99999",
                        "OVER_50000",
                        "BETWEEN_100000_999999",
                        "BETWEEN_1000000_9999999",
                        "OVER_10000000"
                    ]).withMessage('Invalid Expected monthly payments'),
                            
        ];
    }
    

    login() {
        return [
            body('email')
                .notEmpty()
                .withMessage('Email address is required')
                .isEmail(),
            body('password')
                .notEmpty()
                .withMessage('Password is required')
                // .isStrongPassword(),
        ];
    }

    authenticateOtp(){
        return [
            body('code').notEmpty().withMessage('Otp code is required'),
            body('userId').notEmpty().withMessage('userId is required')
        ];
    }


    Subscribe() {
        return [
            body('token')
                .notEmpty()
                .withMessage('push token  is required')
        ];
    }

    setPassword() {
        return [
            body('userId').notEmpty().withMessage('userId is required'),
            body('password').notEmpty().withMessage('Password is not strong')
        ];
    }

    verifyEmail() {
        return [
            body('email')
                .notEmpty()
                .withMessage('Email address is required')
                .isEmail(),
            body('code').notEmpty().withMessage('Otp code is required'),
        ];
    }

    verifyOtp() {
        return [
            body('email')
                .notEmpty()
                .withMessage('Email address is required')
                .isEmail(),
            body('code').notEmpty().withMessage('Otp code is required'),
        ];
    }

    resendOtpCode() {
        return [
            body('email')
                .notEmpty()
                .withMessage('Email address is required')
                .isEmail(),
        ];
    }
    updatePassword() {
        return [
            body('userId')
            .notEmpty()
            .withMessage('userId is required'),
            body('password')
                .notEmpty()
                // .isStrongPassword()
                .withMessage('Password is required')
        ];
    }
    submitAddress() {
        return [
            body('country').notEmpty().withMessage('country is required'),
            body('address').notEmpty().withMessage('address is required'),
            body('state').notEmpty().withMessage('state is required'),
            body('city').notEmpty().withMessage('city is required'),
            body('postalCode').notEmpty().withMessage('postalCode is required'),
            body('userId').notEmpty().withMessage('userId is required'),
        ];
    }
    updateProfile() {
        return [
            body('firstName').notEmpty().withMessage('first name is required'),
            body('lastName').notEmpty().withMessage('last name is required'),
            // body('phoneNumber').notEmpty().withMessage('phone Number is required'),
            body('email')
                .notEmpty()
                .withMessage('Email address is required')
                .isEmail(),
            body('photoUrl').notEmpty().withMessage('photo url is required'),
        ];
    }

    changePassword() {
        return [
            body('currentPassword').notEmpty().withMessage('current password is required'),
            body('newPassword').notEmpty().withMessage('new password is required'),
        ];
    }

    verifyAccountDetail() {
        return [
            body('bankId').notEmpty().withMessage('bank ID is required'),
            body('accountNumber').notEmpty().withMessage('account number is required').isString(),
        ];
    }

    addBank() {
        return [
            body('bankId').notEmpty().withMessage('bank ID is required'),
            body('accountNumber').notEmpty().withMessage('account number is required'),
            body('accountName').notEmpty().withMessage('account name is required'),
        ];
    }

    setNotificationMethod(){
        return [
            body('emailNotification').notEmpty().withMessage('email notification value is required').isBoolean(),
            body('pushNotification').notEmpty().withMessage('push notification value is required').isBoolean(),
            body('smsNotification').notEmpty().withMessage('sms notification value is required').isBoolean(),
        ];
    }

    setTwoFactorAuthenticationMethod(){
        return [
            body('method').notEmpty().withMessage('method is required').isIn(['EMAIL_OTP', 'SMS_OTP', 'THIRD_PARTY_AUTHENTICATOR']).withMessage('invalid 2FA method'),
            body('userSecret').optional(),
            body('token').optional()
        ];
    }

    disableTwoFactorAuthenticationMethod(){
        return [
            body('token').optional()
            // body('token').notEmpty().withMessage('token is required')
        ];
    }

    verifyTwoFactorAuthenticationCode(){
        return [
            body('token').notEmpty().withMessage('token is required'),
        ];
    }

    deleteAccount(){
        return [
            body('password').notEmpty().withMessage('password is required'),
            body('reason').notEmpty().withMessage('reason is required'),
        ];
    }

    fundUserWallet(){
        return [
            body('amount').notEmpty().withMessage('amount is required').isNumeric(),
            body('transactionId').notEmpty().withMessage('transaction id is required')
        ];
    }

    addCard(){
        return [
            body('cardHolderName').notEmpty().withMessage('card holder name is required').isString(),
            body('cardNumber').notEmpty().withMessage('card number is required'),
            body('brand').notEmpty().withMessage('brand is required').isString(),
            body('cardType').notEmpty().withMessage('card type is required').isString(),
            body('expiryDate').notEmpty().withMessage('expiry date is required').isDate().withMessage('expiry date must be a date field'),
            body('cvv').notEmpty().withMessage('cvv is required').isNumeric(),
            body('transactionId').notEmpty().withMessage('transaction id is required')
        ];
    }

    verifyCard(){
        return [
            body('cardNumber').notEmpty().withMessage('card number is required').isLength({max: 6}),
        ]
    }

    changeAdminPassword() {
        return [
            body('newPassword').notEmpty().withMessage('new password is required'),
        ];
    }

    updateAdminProfile() {
        return [
            body('firstName').notEmpty().withMessage('first name is required'),
            body('lastName').notEmpty().withMessage('last name is required'),
            body('email')
                .notEmpty()
                .withMessage('Email address is required')
                .isEmail(),
            body('photoUrl').notEmpty().withMessage('photo url is required'),
        ];
    }

}

export default new UserValidator();
