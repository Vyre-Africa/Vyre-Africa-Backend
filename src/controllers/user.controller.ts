import { Request, Response } from 'express';
import { AccountType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import slugify from 'slugify';
import config from '../config/env.config';
import prisma from '../config/prisma.config';
import mailService from '../services/mail.service';
import paystackService from '../services/paystack.service';
import flutterwaveService from '../services/flutterwave.service';
import { authenticator, totp } from 'otplib';
import * as speakeasy from 'speakeasy';
import * as qrcode from 'qrcode';
import notificationService from '../services/notification.service';
import { currency } from '../globals';
import {
    OTP_CODE_EXP,
    compareHashedData,
    generateAccessToken,
    generateOtp,
    generateRefCode,
    hashData,
    checkUserPaymentMethods,
    generateAccessPin,
    hashPin,
    maskEmail,
    verifyPin
} from '../utils';
import moment from 'moment';
import transactionService from '../services/transaction.service';
import fernService from '../services/fern.service';
import logger from '../config/logger';

interface KycDetails {
    legalFirstName: string;
    legalLastName: string;
    phoneNumber: string;
    dateOfBirth: string;
    employmentStatus: string;
    mostRecentOccupation?: string;
    sourceOfFunds: string;
    accountPurpose: string;
    expectedMonthlyPaymentsUsd: string;
    // isIntermediary?: boolean;

    nationalIdType: string;
    nationalIdNumber: string;
    address: {
      streetLine1: string;
      city: string;
      stateRegionProvince: string;
      postalCode: string;
      countryCode: string;
    };
    documents: {
      governmentId: {
        type: string;
        // countryCode: string;
        documentIdNumber: string;
        issuanceDate: string;
        expirationDate: string;
        frontIdImage: string;
      };
      proof_of_Address: {
        type: string;
        // description?: string;
        proofOfAddressImage: string;
      };
    };
  }

class UserController {

    async generatePin(req: Request, res: Response) {
        const { email, phoneNumber } = req.body;

        try {
            if (!email || !phoneNumber) {
                return res.status(400).json({
                    msg: 'Email and phone number are required',
                    success: false
                });
            }

            logger.info('🔵 PIN generation requested', { email, phoneNumber });

            // ============================================
            // CHECK IF USER EXISTS
            // ============================================
            const existingUser = await prisma.user.findFirst({
                where: {
                    email
                },
                select: {
                    id: true,
                    email: true,
                    phoneNumber: true,
                    firstName: true,
                    accessPin: true,
                    pinGeneratedAt: true,
                    pinGenerationCount: true
                }
            });

            // ✅ Rate limiting: Prevent PIN spam
            if (existingUser?.pinGeneratedAt) {
                const timeSinceLastPin = Date.now() - existingUser.pinGeneratedAt.getTime();
                const oneMinute = 60 * 1000;

                if (timeSinceLastPin < oneMinute) {
                    const secondsLeft = Math.ceil((oneMinute - timeSinceLastPin) / 1000);
                    return res.status(429).json({
                    msg: `Please wait ${secondsLeft} seconds before requesting a new PIN`,
                    success: false
                    });
                }

                // Check daily limit (10 PINs per day)
                const isNewDay = new Date().toDateString() !== new Date(existingUser.pinGeneratedAt).toDateString();
                const currentCount = isNewDay ? 0 : existingUser.pinGenerationCount;

                if (currentCount >= 10) {
                    return res.status(429).json({
                    msg: 'PIN generation limit reached. Please try again tomorrow or contact support.',
                    success: false
                    });
                }
            }

            // ============================================
            // GENERATE NEW PIN
            // ============================================
            const newPin = generateAccessPin();
            const hashedPin = await hashPin(newPin);
            
            // ✅ ONLY TEMP USERS GET EXPIRY
            // Existing users regenerating PIN = no expiry
            const expiresAt:any = existingUser 
                ? null  // ✅ No expiry for existing users
                : new Date(Date.now() + 15 * 60 * 1000); // 15 min expiry for temp users

            let user;

            if (existingUser) {
                // ============================================
                // EXISTING USER: Regenerate reusable PIN
                // ============================================
                if (existingUser.email !== email || existingUser.phoneNumber !== phoneNumber) {
                    return res.status(400).json({
                    msg: 'Email and phone number do not match',
                    success: false
                    });
                }

                const isNewDay = new Date().toDateString() !== new Date(existingUser.pinGeneratedAt || 0).toDateString();

                user = await prisma.user.update({
                    where: { id: existingUser.id },
                    data: {
                        accessPin: hashedPin,
                        pinExpiresAt: null, // ✅ No expiry for existing users
                        pinGeneratedAt: new Date(),
                        pinGenerationCount: isNewDay ? 1 : (existingUser.pinGenerationCount || 0) + 1,
                        pinAttempts: 0,
                        pinLockedUntil: null
                    },
                    select: {
                        id: true,
                        email: true,
                        firstName: true
                    }
                });

                logger.info('✅ Reusable PIN regenerated for existing user', { userId: user.id });
            } else {
                // ============================================
                // NEW USER: Create temp record with expiring PIN
                // ============================================
                user = await prisma.tempUser.create({
                    data: {
                        email,
                        phoneNumber,
                        accessPin: hashedPin,
                        pinExpiresAt: expiresAt, // ✅ Expires in 15 min
                        pinGeneratedAt: new Date(),
                        pinGenerationCount: 1
                        },
                        select: {
                        id: true,
                        email: true
                        }
                });

                logger.info('✅ Temporary PIN generated for new user', { tempUserId: user.id });
            }

            // ============================================
            // SEND PIN TO EMAIL
            // ============================================
            await this.sendAccessPinEmail({
                email,
                firstName: existingUser?.firstName || 'there',
                pin: newPin,
                isReusable: !!existingUser, // ✅ Tell user if PIN is reusable
                expiresInMinutes: existingUser ? null : 15
            });

            return res.status(200).json({
                msg: existingUser 
                    ? 'New reusable PIN sent to your email. Save it for future orders!'
                    : 'PIN sent to your email. Valid for 15 minutes.',
                success: true,
                data: {
                    email: maskEmail(email),
                    isReusable: !!existingUser,
                    expiresIn: existingUser ? null : 15
                }
            });

        } catch (error: any) {
            logger.error('🔴 PIN generation failed', {
                email,
                error: error.message
            });

            return res.status(500).json({
              msg: 'Failed to generate PIN. Please try again.',
              success: false
            });
        }

    }

    async verifyPin(req: Request, res: Response) {
    try {
        const { email, phoneNumber, pin } = req.body;

        // ============================================
        // STEP 1: VALIDATE INPUT
        // ============================================
        if (!email || !phoneNumber || !pin) {
        return res.status(400).json({
            success: false,
            valid: false,
            msg: 'Email, phone number, and PIN are required'
        });
        }

        if (!/^\d{6}$/.test(pin as string)) {
        return res.status(400).json({
            success: false,
            valid: false,
            msg: 'PIN must be 6 digits'
        });
        }

        logger.info('🔍 PIN verification attempt', { 
        email, 
        phoneNumber
        });

        // ============================================
        // STEP 2: FIND USER RECORD
        // ============================================
        const [existingUser, tempUser] = await Promise.all([
            prisma.user.findFirst({
                where: {
                    email: email as string,
                    phoneNumber 
                },
                select: {
                id: true,
                email: true,
                accessPin: true,
                pinExpiresAt: true,
                pinAttempts: true,
                pinLockedUntil: true,
                firstName: true
                }
            }),
            prisma.tempUser.findFirst({
                where: {
                 email: email as string,
                 phoneNumber 
                },
                select: {
                    id: true,
                    email: true,
                    accessPin: true,
                    pinExpiresAt: true
                }
            })
        ]);

        const userRecord = existingUser || tempUser;

        // ============================================
        // STEP 3: CHECK IF USER EXISTS
        // ============================================
        if (!userRecord) {
            return res.status(404).json({
                success: false,
                valid: false,
                msg: 'No PIN found for this email and phone number. Please generate a PIN first.',
                needsGeneration: true
            });
        }

        // ============================================
        // STEP 4: CHECK IF LOCKED (EXISTING USERS ONLY)
        // ============================================
        if (existingUser?.pinLockedUntil && new Date() < existingUser.pinLockedUntil) {
            const minutesLeft = Math.ceil((existingUser.pinLockedUntil.getTime() - Date.now()) / 60000);
            return res.status(429).json({
                success: false,
                valid: false,
                msg: `Too many failed attempts. Please try again in ${minutesLeft} minutes.`,
                locked: true,
                lockedUntil: existingUser.pinLockedUntil,
                minutesRemaining: minutesLeft
            });
        }

        // ============================================
        // STEP 5: CHECK IF EXPIRED (TEMP USERS ONLY)
        // ============================================
        if (tempUser && tempUser.pinExpiresAt && new Date() > tempUser.pinExpiresAt) {
        // Delete expired temp user
            await prisma.tempUser.delete({ 
                where: { id: tempUser.id } 
            }).catch(() => {});

            return res.status(410).json({
                success: false,
                valid: false,
                msg: 'Your PIN has expired. Please generate a new one.',
                expired: true,
                needsGeneration: true
            });
        }

        // ============================================
        // STEP 6: VERIFY PIN
        // ============================================
        const isValid = await verifyPin(pin as string, userRecord.accessPin as string);

        if (isValid) {
        // ✅ PIN IS CORRECT
        
        // Reset attempts for existing users
        if (existingUser) {
            await prisma.user.update({
            where: { id: existingUser.id },
            data: {
                pinAttempts: 0,
                pinLockedUntil: null
            }
            }).catch(err => logger.error('Failed to reset PIN attempts', err));
        }

        logger.info('✅ PIN verification successful', { 
            email,
            isExistingUser: !!existingUser 
        });

        return res.status(200).json({
            success: true,
            valid: true,
            msg: 'PIN is correct! You can proceed with your order.',
            isReusable: !!existingUser, // Tell user if this PIN can be reused
            userName: existingUser?.firstName || null
        });
        } else {
        // ❌ PIN IS INCORRECT
        
        if (existingUser) {
            // Track failed attempts for existing users
            const attempts = (existingUser.pinAttempts || 0) + 1;
            const shouldLock = attempts >= 5;

            await prisma.user.update({
            where: { id: existingUser.id },
            data: {
                pinAttempts: attempts,
                pinLockedUntil: shouldLock 
                ? new Date(Date.now() + 30 * 60 * 1000)
                : null
            }
            }).catch(err => logger.error('Failed to update PIN attempts', err));

            const attemptsRemaining = 5 - attempts;

            logger.warn('❌ PIN verification failed', { 
            email,
            attempts,
            shouldLock 
            });

            if (shouldLock) {
            return res.status(429).json({
                success: false,
                valid: false,
                msg: 'Too many failed attempts. Your PIN is locked for 30 minutes.',
                locked: true,
                attemptsRemaining: 0
            });
            }

            return res.status(400).json({
            success: false,
            valid: false,
            msg: `Incorrect PIN. ${attemptsRemaining} ${attemptsRemaining === 1 ? 'attempt' : 'attempts'} remaining.`,
            attemptsRemaining
            });
        } else {
            // Temp user - no attempt tracking
            logger.warn('❌ PIN verification failed for temp user', { email });

            return res.status(400).json({
            success: false,
            valid: false,
            msg: 'Incorrect PIN. Please check your email and try again.'
            });
        }
        }

    } catch (error: any) {
        logger.error('🔴 PIN verification error', {
        error: error.message,
        stack: error.stack
        });

        return res.status(500).json({
        success: false,
        valid: false,
        msg: 'Failed to verify PIN. Please try again.'
        });
    }
    }

    private async sendAccessPinEmail(params: {
        email: string;
        firstName: string;
        pin: string;
        isReusable: boolean;
        expiresInMinutes: number | null;
        }): Promise<void> {
        const { email, firstName, pin, isReusable, expiresInMinutes } = params;

        const subject = isReusable ? 'Your New Access PIN' : 'Your Access PIN';
  
        const expiryText = isReusable
            ? 'This PIN can be reused for all your future orders. Save it somewhere safe!'
            : `This PIN is valid for ${expiresInMinutes} minutes. Once you complete your first order, you can reuse this PIN for future orders.`;

        await mailService.general(
            email,
            firstName,
            subject,
            `Hi ${firstName},

            Your access PIN is: ${pin}

            ${expiryText}

            Please enter this PIN along with your details to continue with your order.

            If you forget your PIN, you can always generate a new one.

            Keep this PIN secure and do not share it with anyone.`
            
        )

        logger.info('📧 PIN email sent', { email: maskEmail(email) });

    }
    
    async register(req: Request & Record<string, any>, res: Response) {
        // const { DETAILS} = req.body;
        const {
            sub, 
            given_name, 
            family_name, 
            picture, 
            email, 
            email_verified 
        } = req.user;


        // console.log(req.body)

        try {

            // let referree:any;

            const userExist = await prisma.user.findUnique({
              where: { 
                authId: sub,
                email
               },
            });

            // if(DETAILS.referreeId){
            //     referree = await prisma.user.findFirst({
            //         where:{referralId: DETAILS.referreeId}
            //     })
            // }

            
            if (userExist) {
                return res.status(400).json({
                    msg: 'User already exist',
                    success: false,
                    user: userExist,
                });
            }
            
            console.log('entered individual')
            // console.log('PERSONAL', DETAILS)

            // const otpCode = generateOtp();

            const result = await prisma.$transaction(async (prisma) => {

                // const customer = await fernService.customer({
                //     customerType:'INDIVIDUAL',
                //     firstName:DETAILS.firstName,
                //     lastName: DETAILS.lastName,
                //     email: DETAILS.email
                // })

                // console.log('customer',customer)

                const newUser = await prisma.user.create({
                    data: {
                        firstName: given_name,
                        lastName: family_name,
                        authId: sub,
                        email,
                        emailVerified: email_verified,
                        photoUrl: picture,

                        // fernUserId: customer.customerId,
                        // fernKycLink: customer.kycLink,
                        // userStatus: customer.customerStatus
                    }
                });

                console.log('newUser',newUser)

                return {
                  user: newUser
                };

            });

            // await walletService.createWallet(newUser.id, 'NGN')

            // await mailService.sendOtp(DETAILS.email, DETAILS.firstName, otpCode);

            return res.status(201).json({
                msg: 'Registration Sucessful',
                success: true,
                user: result.user
            });


        } catch (error) {
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }

    async register_Kyc(req: Request & Record<string, any>, res: Response) {
        const user = req.user
        const {
            legalFirstName,
            legalLastName,
            phoneNumber,
            dateOfBirth,

            nationalIdType,
            nationalIdNumber,
            employmentStatus,
            mostRecentOccupation,
            sourceOfFunds,
            accountPurpose,
            expectedMonthlyPaymentsUsd,
            address,
            documents

        } = req.body as KycDetails;

        

        // console.log(req.body)

        try {

            console.log('in block')

            // Basic validation
            // if (!legalFirstName || !legalLastName || !phoneNumber || !dateOfBirth) {
            //     return res.status(400).json({ msg: 'Missing required fields',success: false });
            // }

            // const userData = await prisma.user.findUnique({
            //     where: { id: user.id },
            // });

            // if (userData) {
            //     return res.status(400).json({
            //         msg: 'User not found',
            //         success: false,
            //     });
            // }

            // Process the KYC submission in a transaction
            const result = await prisma.$transaction(async (prisma) => {

                const customer = await fernService.customer({
                        legalFirstName,
                        legalLastName,
                        phoneNumber,
                        nationalIdType,
                        nationalIdNumber,
                        email: user?.email,
                        dateOfBirth,
                        employmentStatus,
                        mostRecentOccupation,
                        sourceOfFunds,
                        accountPurpose,
                        expectedMonthlyPaymentsUsd,
                        address,
                        documents
                })

                // 1. Create Address
                const addressRecord = await prisma.address.create({
                    data: {
                        streetLine1: address.streetLine1,
                        city: address.city,
                        stateRegionProvince: address.stateRegionProvince,
                        postalCode: address.postalCode,
                        countryCode: address.countryCode
                    }
                });
        
                // 2. Create Government ID
                const governmentId = await prisma.identity.create({
                    data: {
                        type: documents.governmentId.type,
                        countryCode: address.countryCode,
                        documentIdNumber: documents.governmentId.documentIdNumber,
                        issuanceDate: new Date(documents.governmentId.issuanceDate),
                        expirationDate: new Date(documents.governmentId.expirationDate),
                        frontIdImage: documents.governmentId.frontIdImage
                    }
                });
        
                // 3. Create Proof of Address
                // const proofOfAddress = await prisma.proofOfAddress.create({
                //     data: {
                //         type: documents.proof_of_Address.type,
                //         description: `${documents.proof_of_Address.type} means of verification`,
                //         proofOfAddressImage: documents.proof_of_Address.proofOfAddressImage
                //     }
                // });
        
                // 4. Create Documents (linking both)
                const documentsRecord = await prisma.documents.create({
                    data: {
                        identityId: governmentId.id
                    }
                });
        
                // 5. Create UserKyc record
                await prisma.userKyc.create({
                    data: {
                        firstName: legalFirstName,
                        lastName: legalLastName,
                        phoneNumber,
                        dateOfBirth: new Date(dateOfBirth),
                        employmentStatus,
                        mostRecentOccupation,
                        sourceOfFunds,
                        accountPurpose,
                        expectedMonthlyPayments: expectedMonthlyPaymentsUsd,
                        // isIntermediary,
                        addressId: addressRecord.id,
                        documentsId: documentsRecord.id,
                        userId: user.id
                    }
                });

               return await prisma.user.update({
                    where:{id: user.id},
                    data:{
                        fernUserId: customer.customerId,
                        fernKycLink: customer.kycLink,
                        userStatus: 'PENDING'
                    }
                })

            });





            
            // console.log('entered individual')
            // console.log('PERSONAL', DETAILS)

    

            // await walletService.createWallet(newUser.id, 'NGN')

            // await mailService.sendOtp(DETAILS.email, DETAILS.firstName, otpCode);

            return res.status(201).json({
                msg: 'KYC initiated Successfully',
                success: true,
            });


        } catch (error) {
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }

    async verifyEmail(req: Request, res: Response) {
        const { code, email } = req.body;
        try {
            const user = await prisma.user.findUnique({
                where: { email: email },
            });
            if (
                !user ||
                // moment().isAfter(user.otpCodeExpiryTime) ||
                user.otpCodeUsed
            ) {
                return res
                    .status(400)
                    .json({ msg: 'Invalid otp code or otp code is expired' });
            }
            if (code !== user.otpCode) {
                return res.status(400).json({ msg: 'Otp Code is incorrect',success: false, });
            }
            await prisma.user.update({
                where: { email },
                data: { otpCodeUsed: true, emailVerified: true },
            });


            return res
                .status(200)
                .json({ msg: 'validation successful', success: true, userId: user?.id });

        } catch (error) {
            console.log(error)
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }

    async verifyOtp(req: Request, res: Response) {
        const { code, email } = req.body;

        console.log(code, email)
        try {
            const user = await prisma.user.findUnique({
                where: { email: email },
            });
            console.log(user)
            // console.log('expired:',moment().isAfter(user?.otpCodeExpiryTime))
            //email otp verification
            // if (user?.twoFactorAuthenticationMethod == 'EMAIL_OTP' || user?.twoFactorAuthenticationMethod == 'SMS_OTP') {
                if (
                    !user ||
                    // moment().isAfter(user.otpCodeExpiryTime) ||
                    user.otpCodeUsed
                ) {
                    
                    return res
                        .status(400)
                        .json({ msg: 'Invalid otp code or otp code is expired' });
                }
                if (code !== parseInt(user.otpCode as string)) {
                    return res.status(400).json({ success: false, msg: 'Otp Code is incorrect' });
                }
                await prisma.user.update({
                    where: { email },
                    data: { otpCodeUsed: true, emailVerified: true },
                });
            // }

            return res
                .status(200)
                .json({ msg: 'validation successful', success: true, userId: user?.id });

        } catch (error) {
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }

    async setPassword(req: Request & Record<string, any>, res: Response) {
        const { userId, password } = req.body

        console.log('body',req.body)
        try {
            //get user
            const user = await prisma.user.findUnique({
                where: { id: userId }
            })

            if (!user) {
                return res.status(400).json({
                    msg: 'user not found',
                    success: false,
                });
            }

            const encryptedPassword = await hashData(password);

            await prisma.user.update({
                where: { id: user.id },
                data: {
                    password: encryptedPassword
                },
            });

            return res.status(201).json({
                msg: 'Password Set successfully',
                success: true,
                user
            });

        } catch (error) {
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }

    async resendOtpCode(req: Request, res: Response) {
        const { email } = req.body;
        const user = await prisma.user.findUnique({ where: { email: email } });
        if (!user) {
            return res.status(400).json({
                msg: 'user was not found',
                success: false,
            });
        }

        if (
            !user.otpCode ||
            user?.otpCodeUsed === true
            // moment().isAfter(user?.otpCodeExpiryTime)
        ) {
            const otpCode = generateOtp();

            await prisma.user.update({
                where: { email: email },
                data: {
                    otpCode: otpCode,
                    otpCodeUsed: false,
                    otpCodeExpiryTime: OTP_CODE_EXP,
                },
            });

            await mailService.sendOtp(user?.email, user.firstName, otpCode);
            // await mailService.sendMail(user?.email,otpCode)
        } else {
            await mailService.sendOtp(user?.email, user.firstName, user.otpCode);
            // await mailService.sendMail(user?.email, user.otpCode)
        }
        return res.status(200).json({
            msg: 'Otp successfully sent to your email',
            success: true,
        });
    }

    async sendVerification(req: Request, res: Response) {
        const { email, OTP } = req.body;

        if (!email || !OTP) {
            return res
                .status(400)
                .json({ msg: 'Missing required fields', success: false });
        }

        try {
            const EmailSent = await mailService.sendMail(email, OTP);

            console.log(EmailSent);

            return res.status(200).send(EmailSent);
        } catch (error) {
            console.log(error);
            res.status(500).send('Internal Server Error');
        }
    }

    async loginUser(req: Request, res: Response) {
        const { email, password } = req.body;

        try {
            const user = await prisma.user.findUnique({
                where: { email, isDeactivated: false },
                // include: {
                //     wallet: true,
                // },
            });

            console.log(user)

            if (!user || !user.password)
                return res.status(400).json({
                    msg: 'user does not exist',
                    success: false,
                });

            const pwdCorrect = await compareHashedData(password, user.password);

            console.log(pwdCorrect);
            if (!pwdCorrect) {
                return res.status(400).json({
                    msg: 'Wrong email or password',
                    success: false,
                });
            }

            if (!user.emailVerified) {
                return res.status(400).json({
                    msg: 'Email address is not verified',
                    success: false,
                });
            }

            //create wallet for user if user does not have a wallet
            // if(!user.wallet){
            //     await walletService.createUserWallet(user.id)
            // }

            if (user.twoFactorEnabled) {

                if (user.twoFactorAuthenticationMethod == 'THIRD_PARTY_AUTHENTICATOR') {

                    return res.status(200).send({
                        success: true,
                        msg: 'Enter Code from Authenticator',
                        twoFactorEnabled: user.twoFactorEnabled,
                        userId: user.id
                    });

                }

                const otpCode = generateOtp();

                await prisma.user.update({
                    where: { id: user.id },
                    data: {
                        otpCode: otpCode,
                        otpCodeUsed: false,
                        otpCodeExpiryTime: OTP_CODE_EXP,
                    },
                });

                if (user.twoFactorAuthenticationMethod == 'EMAIL_OTP') {

                    await mailService.sendOtp(user?.email, user.firstName, otpCode);

                    return res.status(200).send({
                        success: true,
                        msg: 'Otp was sent to user email',
                        twoFactorEnabled: user.twoFactorEnabled,
                        userId: user.id
                    });

                }

                // if(user.twoFactorAuthenticationMethod == 'SMS_OTP'){
                //     const message = `Your Qaya verification code is: ${otpCode}`
                    
                //     if(user.phoneNumber){
                //         await smsService.send({
                //             api_key: config.termiiLiveKey,
                //             to: user.phoneNumber.replace(/^\+/, ''),
                //             from: 'Qaya',
                //             sms: message,
                //             type: "plain",
                //             channel: "generic",
                //         });
                //     }

                //     return res.status(200).send({
                //         success: true,
                //         msg: 'Otp was sent to user phone',
                //         twoFactorEnabled: user.twoFactorEnabled,
                //         userId: user.id
                //     });
                // }


            }

            const token = generateAccessToken({
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                phoneNumber: user.phoneNumber ?? '',
                createdAt: user.createdAt,
                type: user.type,
                photoUrl: user.photoUrl,
                userStatus: user.userStatus,
            });

            return res.status(200).send({
                success: true,
                msg: 'Authentication was successful',
                token: token,
                user
            });
            
        } catch (error) {
            console.log(error)
            return res
                .status(500)
                .json({ msg: 'something went wrong, please try again', success: false, error });
        }
    }

    async authenticateViaOtp(req: Request, res: Response) {
        const { code, userId } = req.body;

        try {
            const user = await prisma.user.findUnique({
                where: { id: userId },
            });

            if (!user)
                return res.status(400).json({
                    msg: 'user not found',
                    success: false,
                });


            if (user.twoFactorAuthenticationMethod == 'EMAIL_OTP' || user.twoFactorAuthenticationMethod == 'SMS_OTP') {

                if (
                    !user || user.otpCodeUsed === true
                    // moment().isAfter(user.otpCodeExpiryTime) ||
                    
                ) {
                    return res
                        .status(400)
                        .json({ msg: 'Invalid otp code or otp code is expired', success: false });
                }
                if (code !== user.otpCode) {
                    return res.status(400).json({ msg: 'Otp Code is incorrect', success: false });
                }
                await prisma.user.update({
                    where: { id: user.id },
                    data: { otpCodeUsed: true, emailVerified: true },
                });

            }

            // if(user.twoFactorAuthenticationMethod == 'SMS_OTP'){
            // todo: sms otp 
            // }

            if (user.twoFactorAuthenticationMethod == 'THIRD_PARTY_AUTHENTICATOR') {

                // const isValid = authenticator.check(code, user.twoFactorAuthenticationSecret as string)

                const isValid = speakeasy.totp.verify({
                    secret: user.twoFactorAuthenticationSecret as string, 
                    encoding: 'base32',
                    token: code,
                });

                console.log('isvalid', isValid)

                if (!isValid) {
                    return res
                        .status(400)
                        .json({ msg: 'Invalid otp code or otp code is expired', success: false });
                }

            }

            const token = generateAccessToken({
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                phoneNumber: user.phoneNumber ?? '',
                createdAt: user.createdAt,
                type: user.type,
                photoUrl: user.photoUrl,
                userStatus: user.userStatus
            });

            return res.status(200).send({
                success: true,
                msg: 'Authentication was successful',
                token: token,
                user
            });
        } catch (error) {
            console.log(error);
            res.status(500).send('Internal Server Error');
        }
    }

    async forgotPassword(req: Request, res: Response) {
        const { email } = req.body;
        console.log(email)
        try {
            const user = await prisma.user.findFirst({
                where: { email: email }
            });

            console.log('user',user)
            if (!user) {
                return res.status(400).json({
                    msg: 'User Account with email not found',
                    success: false,
                });
            }
            if (
                !user.otpCode ||
                user?.otpCodeUsed === true
                // moment().isAfter(user?.otpCodeExpiryTime)
            ) {
                const otpCode = generateOtp();

                await prisma.user.update({
                    where: { email: email },
                    data: {
                        otpCode: otpCode,
                        otpCodeUsed: false,
                        otpCodeExpiryTime: OTP_CODE_EXP
                    },
                });

                await mailService.sendOtp(user?.email, user.firstName, otpCode);
            } else {
                await mailService.sendOtp(user?.email, user.firstName, user.otpCode);
            }
            return res.status(200).json({
                msg: 'An otp as been sent to your email',
                success: true,
                user: user
            });
        } catch (error) {
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }

    async getProfile(req: Request & Record<string, any>, res: Response) {
        const user = req.user
        const isNewUser = req.isNewUser

        try {

            const userData = await prisma.user.findUnique({
                where: { id: user.id }
            });

            console.log('started', userData)

            if (!userData) {
                return res.status(400).json({
                    msg: 'User not found',
                    success: false
                });
            }

            const {hasAnyPaymentMethod,hasFiatAccount,hasCryptoAccount} = await checkUserPaymentMethods(userData.id)

            return res.status(201).json({
                msg: 'Profile fetched successfully',
                success: true,
                user: userData,
                isNewUser,
                hasAnyPaymentMethod
            });

        } catch (error) {
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }

    async updateProfile(req: Request & Record<string, any>, res: Response) {
        const { firstName, lastName, email, phoneNumber, photoUrl } = req.body
        const user = req.user

        try {
            const updatedUser = await prisma.user.update({
                where: { email: user.email },
                data: {
                    firstName,
                    lastName,
                    email,
                    phoneNumber,
                    photoUrl
                },
            });

            return res.status(201).json({
                msg: 'Profile updated successfully',
                success: true,
                user: updatedUser,
            });

        } catch (error) {
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }

    async submitAddress(req: Request & Record<string, any>, res: Response) {
        const { country, address, state, city, postalCode, userId } = req.body
        // const user = req.user

        try {
            const updatedUser = await prisma.user.update({
                where: { id: userId },
                data: {
                    country,
                    address,
                    state,
                    city,
                    postalCode
                },
            });

            return res.status(201).json({
                msg: 'Details updated successfully',
                success: true,
                user: updatedUser,
            });

        } catch (error) {
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }

    async changePassword(req: Request & Record<string, any>, res: Response) {
        const { currentPassword, newPassword } = req.body
        const userData = req.user

        try {
            //get user
            const user = await prisma.user.findUnique({
                where: { id: userData.id }
            })

            if (!user) {
                return res.status(400).json({
                    msg: 'user not found',
                    success: false,
                });
            }


            if (!user.password || !await compareHashedData(currentPassword, user.password)) {
                return res.status(400).json({
                    msg: 'current password is incorrect',
                    success: false,
                });
            }

            const encryptedPassword = await hashData(newPassword);

            await prisma.user.update({
                where: { email: user.email },
                data: {
                    password: encryptedPassword
                },
            });

            return res.status(201).json({
                msg: 'Password changed successfully',
                success: true,
                user,
            });

        } catch (error) {
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }

    async updatePasswordRecovery(req: Request & Record<string, any>, res: Response) {
        const { userId, password } = req.body
        try {
            //get user
            const user = await prisma.user.findUnique({
                where: { id: userId }
            })

            if (!user) {
                return res.status(400).json({
                    msg: 'user not found',
                    success: false,
                });
            }

            const encryptedPassword = await hashData(password);

            await prisma.user.update({
                where: { email: user.email },
                data: {
                    password: encryptedPassword
                },
            });

            return res.status(201).json({
                msg: 'Password changed successfully',
                success: true,
                user,
            });

        } catch (error) {
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }

    async getAllBanks(req: Request, res: Response) {
        // const banks = await paystackService.getBanks();
        const { search, limit = 20 } = req.query;

        let banks:any;

        const where = search ? { name: { contains: search as string, mode: 'insensitive' as Prisma.QueryMode } }: {};

        console.log('got in ')

        banks = await prisma.bank.findMany({
          where,
          take: Number(limit),
          select: {
            id: true,
            name: true,
            code: true,
           },
        });

        return res.status(201).json({
            msg: 'Banks fetched successfully',
            success: true,
            banks,
        });
        
    }

    async getCurrencyBanks(req: Request & Record<string, any>, res: Response) {
        // const banks = await paystackService.getBanks();
        const { currency } = req.query;

        if (!currency) {
            return res.status(400).json({
                msg: 'currency required',
                success: false,
            });
        }

        let banks:any;
        

        console.log('got in ')

        banks = await prisma.bank.findMany({
          where:{currency: currency as string},
        //   take: Number(limit),
          select: {
            id: true,
            name: true,
            code: true,
           },
        });

        return res.status(201).json({
            msg: 'Banks fetched successfully',
            success: true,
            banks,
        });
        
    }

    async queryUser(req: Request, res: Response) {
        // const banks = await paystackService.getBanks();
        const { email } = req.body;

        let users;

        if (!email) {
            return res.status(400).json({
                msg: 'email required to find user',
                success: false,
            });
        }

        console.log('got in ')
        users = await prisma.user.findMany({
          where: { email: { startsWith: email as string } },
        });

        return res.status(201).json({
            msg: 'users fetched successfully',
            success: true,
            users,
        });



       
    }

    async verifyAccountDetail(req: Request & Record<string, any>, res: Response) {
        const { bankId, accountNumber } = req.body
        const user = req.user

        console.log(req.body)

        const bank = await prisma.bank.findUnique({
            where: { id: bankId }
        });

        console.log(bank)

        if (!bank) {
            return res.status(400).json({
                msg: 'bank not found',
                success: false,
            });
        }

        const verifyDetails = await flutterwaveService.resolveAccount(bank.code, accountNumber)

        console.log(verifyDetails)

        if (verifyDetails?.status !== 'success') {
            return res.status(400).json({
                msg: 'wrong account details',
                success: false,
            });
        }

        return res.status(201).json({
            msg: 'Bank Account verified successfully',
            success: true,
            data: {
                accountNumber: verifyDetails.data?.account_number,
                accountName: verifyDetails.data?.account_name
            },
        });
    }

    async addBank(req: Request & Record<string, any>, res: Response) {
        const { bankId, accountNumber, accountName } = req.body
        const user = req.user

        try {
            const bank = await prisma.bank.findUnique({
                where: { id: bankId }
            });

            if (!bank) {
                return res.status(400).json({
                    msg: 'bank not found',
                    success: false,
                });
            }

            let userBank = await prisma.userBank.findFirst({
                where: {
                    userId: user.id,
                    accountNumber
                }
            })

            if (userBank) {
                return res.status(400).json({
                    msg: 'account already exists',
                    success: false,
                });
            }

            userBank = await prisma.userBank.create({
                data: {
                    accountName,
                    accountNumber,
                    userId: user.id,
                    bankId: bank.id
                }
            })

            return res.status(201).json({
                msg: 'user bank added successfully',
                success: true,
                userBank
            });

        } catch (error) {
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }

    async getUserBank(req: Request & Record<string, any>, res: Response) {
        const user = req.user
        const userBanks = await prisma.userBank.findMany({
            where: {
                userId: user.id,
            },
            include: {
                bank: true,
            },
        });

        return res.status(201).json({
            msg: 'User banks fetched successfully',
            success: true,
            userBanks,
        });
    }

    async getUserWalletBalance(req: Request & Record<string, any>, res: Response) {
        // const user = req.user
       

        // try {

        //     const wallet = await prisma.wallet.findUnique({
        //         where:{userId: user?.id}
        //     })
        //     return res.status(201).json({
        //         msg: 'User Wallet balance',
        //         success: true,
        //         wallet: wallet
        //     });
            
        // } catch (error) {

        //     return res.status(500).json({
        //         msg: 'failed to fetch balance',
        //         success: false,
        //     });
        // }
        
    }

    async deleteUserBank(req: Request & Record<string, any>, res: Response) {
        const user = req.user
        const userBankId = req.params.userBankId

        try {
            let userBank = await prisma.userBank.findUnique({
                where: { id: userBankId }
            })

            if (!userBank) {
                return res.status(400).json({
                    msg: 'user bank not found',
                    success: false,
                });
            }

            await prisma.userBank.delete({
                where: { id: userBankId }
            })

            const userBanks = await prisma.userBank.findMany({
                where: {
                    userId: user.id,
                },
                include: {
                    bank: true,
                },
            });

            return res.status(201).json({
                msg: 'Bank deleted successfully',
                success: true,
                userBanks
            });
        } catch (error) {
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }

    async setNotificationMethod(req: Request & Record<string, any>, res: Response) {
        const user = req.user
        const { emailNotification, pushNotification, smsNotification } = req.body

        try {
            let notificationSetting = await prisma.notificationSetting.findUnique({
                where: { userId: user.id }
            })

            if (notificationSetting) {
                notificationSetting = await prisma.notificationSetting.update({
                    where: { userId: user.id },
                    data: {
                        emailNotification,
                        pushNotification,
                        smsNotification
                    },
                });
            } else {
                notificationSetting = await prisma.notificationSetting.create({
                    data: {
                        userId: user.id,
                        emailNotification,
                        pushNotification,
                        smsNotification
                    },
                });
            }

            return res.status(201).json({
                msg: 'Notification method set successfully',
                success: true,
                notificationSetting,
            });

        } catch (error) {
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }

    async getNotificationMethod(req: Request & Record<string, any>, res: Response) {
        const user = req.user;

        const notificationSetting = await prisma.notificationSetting.findUnique({
            where: { userId: user.id }
        })

        if (!notificationSetting) {
            const newSetting = await prisma.notificationSetting.create({
                data: {
                    userId: user.id,
                    emailNotification: true,
                    pushNotification: false,
                    smsNotification: false
                },
            });

            return res.status(201).json({
                msg: 'Notification method fetched successfully',
                success: true,
                notificationSetting: newSetting
            });
        }

        return res.status(201).json({
            msg: 'Notification method fetched successfully',
            success: true,
            notificationSetting: notificationSetting
        });
    }

    async getAuthSecret(req: Request & Record<string, any>, res: Response) {
        const user = req.user;
        let qrCodeUrl;
        let secret;

        // const secret = authenticator.generateSecret()
        //generate secret 
        secret = speakeasy.generateSecret({ length: 15 });

        //generate qrcode url
        qrCodeUrl = await qrcode.toDataURL(secret?.otpauth_url as string);
        console.log('secret', secret)

        return res.status(201).json({
            msg: 'Secret Created Successfully',
            success: true,
            secret,
            qrCodeUrl: qrCodeUrl,
        });
    }


    async setTwoFactorAuthenticationMethod(req: Request & Record<string, any>, res: Response) {
        const user = req.user
        const { method, userSecret, token } = req.body;

        try {
            if (method == 'THIRD_PARTY_AUTHENTICATOR') {
                //verify code
                const isValid = speakeasy.totp.verify({
                    secret: userSecret, 
                    encoding: 'base32',
                    token,
                });

                if (!isValid) {
                    return res
                        .status(400)
                        .json({ msg: 'Invalid token please try again', success: false });
                }
            }

            const updatedUser = await prisma.user.update({
                where: { id: user.id },
                data: {
                    ...(userSecret !== '' && { twoFactorAuthenticationSecret: userSecret }),
                    twoFactorEnabled: true,
                    twoFactorAuthenticationMethod: method,
                }
            })

            return res.status(201).json({
                msg: '2FA method set successfully',
                success: true,
                user: updatedUser,
            });

        } catch (error) {
            console.log(error)
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }

    async disableTwoFactorAuthenticationMethod(req: Request & Record<string, any>, res: Response) {
        const user = req.user
        const { token } = req.body;


        try {

            const userData = await prisma.user.findUnique({
                where: { id: user.id }
            })

            if (!userData) {
                return res.status(400).json({
                    msg: 'user not found',
                    success: false
                });
            }


            if (userData.twoFactorAuthenticationMethod == 'THIRD_PARTY_AUTHENTICATOR') {

                if (!token) {
                    return res.status(400).json({
                        msg: 'Token required to disable authenticator',
                        success: false
                    });
                }

                // const isValid = authenticator.check(token, userData.twoFactorAuthenticationSecret as string)
                const isValid = speakeasy.totp.verify({
                    secret: userData.twoFactorAuthenticationSecret as string, 
                    encoding: 'base32',
                    token,
                });

                console.log('isvalid', isValid)

                if (!isValid) {
                    return res
                        .status(400)
                        .json({ msg: 'Token not valid please try again', success: false });
                }

            }

            const updatedUser = await prisma.user.update({
                where: { id: user.id },
                data: {
                    twoFactorEnabled: false
                }
            })

            return res.status(201).json({
                msg: '2Factor disabled successfully',
                success: true,
                user: updatedUser
            });

        } catch (error) {
            console.log(error)
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }


    async getTwoFactorAuthenticationMethod(req: Request & Record<string, any>, res: Response) {
        const user = req.user;

        const userData = await prisma.user.findUnique({
            where: { id: user.id }
        })

        if (!userData) {
            return res.status(400).json({
                msg: 'user not found',
                success: false
            });
        }

        return res.status(201).json({
            msg: 'Two Factor Authentication method fetched successfully',
            success: true,
            enabled: userData.twoFactorEnabled,
            method: userData.twoFactorAuthenticationMethod
        });
    }


    async getNotification(req: Request & Record<string, any>, res: Response) {
        const user = req.user
        const {limit} = req.query

        try {
            const notifications = await notificationService.getUserNotification(user.id, limit as string)

            return res.status(201).json({
                msg: 'Notifications fetched successfully',
                success: true,
                notifications,
            });

        } catch (error) {
            console.log(error)
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }

    async filterNotification(req: Request & Record<string, any>, res: Response) {
        const user = req.user
        const { type, limit, date_from, date_to } = req.query

        try {
            
            let dateFrom: Date | null = null;
            let dateTo: Date | null = null;

            if (date_from && date_to) {
                dateFrom = new Date(date_from as string);
                dateTo = new Date(date_to as string);
            }

            const notifications = await notificationService.filterUserNotification(user.id, limit as string, dateFrom, dateTo, type as string)
            
            return res.status(201).json({
                msg: 'Notifications fetched successfully',
                success: true,
                notifications
            });

        } catch (error) {
            console.log(error)
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }

    async getTransactions(req: Request & Record<string, any>, res: Response) {
        const user = req.user
        const { limit } = req.query;

        // try {
            
        //     const transactions = await transactionService.get(user.id, limit as string);

        //     return res.status(201).json({
        //         msg: 'Transactions fetched successfully',
        //         success: true,
        //         transactions
        //     });

        // } catch (error) {
        //     console.log(error)
        //     return res
        //         .status(500)
        //         .json({ msg: 'Internal Server Error', success: false, error });
        // }

    }

    // async filterTransactions(req: Request & Record<string, any>, res: Response) {
    //     const user = req.user
    //     const { limit, date_from, date_to, type, status } = req.query;

    //     try {

    //         let dateFrom: Date | null = null;
    //         let dateTo: Date | null = null;

    //         if (date_from && date_to) {
    //             dateFrom = new Date(date_from as string);
    //             dateTo = new Date(date_to as string);
    //         }
            
    //         const transactions = await transactionService.filterByStatusDateType(user.id, limit as string, dateFrom, dateTo, type as string, status as string);

    //         return res.status(201).json({
    //             msg: 'Transactions fetched successfully',
    //             success: true,
    //             transactions
    //         });

    //     } catch (error) {
    //         console.log(error)
    //         return res
    //             .status(500)
    //             .json({ msg: 'Internal Server Error', success: false, error });
    //     }
    // }
    
    async getTransactionsByStatus(req: Request & Record<string, any>, res: Response) {
        const user = req.user
        const { limit } = req.query;
        const status = req.query.status as string;

        try {

            if(!status){
                return res.status(400).json({ msg: 'State is required', success: false})
            }
            
            const transactions = await transactionService.filterByStatus(user.id, limit as string, status);

            return res.status(201).json({
                msg: 'Transactions fetched successfully',
                success: true,
                transactions
            });

        } catch (error) {
            console.log(error)
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }

    async getTransactionsByType(req: Request & Record<string, any>, res: Response) {
        const user = req.user
        const { limit } = req.query;
        const payment = req.query.payment as string;

        try {

            if(!payment){
                return res.status(400).json({ msg: 'Payment Type is required', success: false})
            }
            
            const transactions = await transactionService.filterByType(user.id, limit as string, payment);

            return res.status(201).json({
                msg: 'Transactions fetched successfully',
                success: true,
                transactions
            });

        } catch (error) {
            console.log(error)
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }

    async fundWallet(req: Request & Record<string, any>, res: Response)
    {
        const user = req.user
        const {amount, transactionId } = req.body

        const userData = await prisma.user.findUnique({
            where:{id: user.id}
        })

        try {

            //verify transaction
            const verify = await paystackService.verifyTransaction(transactionId);

            if (!verify?.status) {
                return res.status(400).json({
                    msg: 'Error verifying transaction',
                    success: false,
                });
            }

            //fund wallet
            // const fundWallet = await walletService.fundUserWallet(amount, user.id)
            // if(!fundWallet){
            //     return res.status(400).json({
            //         msg: 'Error funding wallet',
            //         success: false,
            //     });
            // }

            //save transaction
            // const transaction = await transactionService.create(
            //     user.id,
            //     null, 
            //     amount, 
            //     'SUCCESSFUL', 
            //     'WALLET',
            //     'CREDIT',
            //     'Wallet Topup',
            //     []
            // )

            //save notification
            await notificationService.create(
                user.id,
                null,
                'Wallet Funding',
                'You funded your wallet with ' + amount,
                'TOPUP'
            )

            //send push notification
            // await mobilePushService.singlePush('Wallet Funding', 'You funded your wallet with ' + amount, (userData?.pushToken as string))

            // console.log(fundWallet)
            // const updatedUser = await prisma.user.findUnique({
            //     where:{id: user.id},
            //     include:{wallet: true}
            // })

            // return res.status(201).json({
            //     msg: 'Wallet funded successfully',
            //     success: true,
            //     user: updatedUser,
            //     wallet: fundWallet,
            //     transaction
            // });
            
        } catch (error) {
            console.log(error)
            return res
                .status(500)
                .json({ msg: 'Internal Server Error', success: false, error });
        }
    }


}

export default new UserController();
