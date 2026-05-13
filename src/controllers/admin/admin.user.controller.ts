import { Request, Response } from 'express';
import prisma from '../../config/prisma.client';
import {
    OTP_CODE_EXP,
    compareHashedData,
    generateAccessToken,
    generateOtp,
    generateRefCode,
    hashData,
} from '../../utils';
import mailService from '../../services/mail.service';
import { endOfDay, startOfDay } from 'date-fns';

class AdminUserController {
    // async loginUser(req: Request, res: Response){
    //     const { email, password } = req.body;

    //     try {
    //         const user = await prisma.user.findUnique({
    //             where: { email: email },
    //             include: {
    //                 role: {
    //                     include: {
    //                         permissions: {
    //                             include: {
    //                                 permission: true,
    //                             },
    //                         },
    //                     },
    //                 },
    //             },
    //         });

    //         if (!user || !user.password)
    //             return res.status(400).json({
    //                 msg: 'Wrong email or password',
    //                 success: false,
    //             });

    //         const pwdCorrect = await compareHashedData(password, user.password);

    //         if (!pwdCorrect) {
    //             return res.status(400).json({
    //                 msg: 'Wrong email or password',
    //                 success: false,
    //             });
    //         }

    //         //check user is an admin
    //         if(user.type !== 'SUPERADMIN'){
    //             return res.status(401).json({
    //                 msg: 'Access Denied!',
    //                 success: false,
    //             });
    //         }

    //         if (user.twoFactorEnabled) {

    //             if (user.twoFactorAuthenticationMethod == 'EMAIL_OTP') {

    //                 const otpCode:string = generateOtp();

    //                 await prisma.user.update({
    //                     where: { id: user.id },
    //                     data: {
    //                         otpCode: otpCode,
    //                         otpCodeUsed: false,
    //                         otpCodeExpiryTime: OTP_CODE_EXP,
    //                     },
    //                 });

    //                 await mailService.sendOtp(user?.email, user.firstName, otpCode);

    //                 return res.status(200).send({
    //                     success: true,
    //                     msg: 'Otp was sent to user email',
    //                     twoFactorEnabled: user.twoFactorEnabled,
    //                     userId: user.id
    //                 });

    //             }

    //             if (user.twoFactorAuthenticationMethod == 'THIRD_PARTY_AUTHENTICATOR') {

    //                 return res.status(200).send({
    //                     success: true,
    //                     msg: 'Enter Code from Authenticator',
    //                     twoFactorEnabled: user.twoFactorEnabled,
    //                     userId: user.id
    //                 });

    //             }

    //             // if(user.twoFactorAuthenticationMethod == 'SMS_OTP'){

    //             // }


    //         }

    //         const token = generateAccessToken({
    //             id: user.id,
    //             firstName: user.firstName,
    //             lastName: user.lastName,
    //             role: user.role,
    //             email: user.email,
    //             phoneNumber: user.phoneNumber ?? '',
    //             createdAt: user.createdAt,
    //             type: user.type,
    //             organisationId: user.organisationId,
    //             photoUrl: user.photoUrl,
    //             userStatus: user.userStatus,
    //         });

    //         return res.status(200).send({
    //             success: true,
    //             msg: 'Authentication was successful',
    //             token: token,
    //             user
    //         });
    //     } catch (error) {
    //         console.log(error)
    //         return res
    //             .status(500)
    //             .json({ msg: 'something went wrong, please try again', success: false, error });
    //     }
    // }

    // async fetchAll(req: Request | any, res: Response) {
    //     const { limit, page } = req.query;
    
    //     try {
    
    //       const totalCount = await prisma.user.count({
    //         where: {type: 'USER', isDeactivated: false},
    //       });
    
    //       const itemLimit = (limit ? parseInt(limit as string) : 20) || 20;
    //       console.log(limit)
    //       const totalPages = Math.ceil(totalCount / itemLimit);
      
    //       const currentPage = page ? Math.max(parseInt(page as string), 1) : 1;
    //       const skip = (currentPage - 1) * itemLimit;
    
    //       const users = await prisma.user.findMany({
    //         where: {type: 'USER', isDeactivated: false},
    //         include: {
    //           store:{ include:{ store: true}}
    //         },
    //         skip: skip,
    //         take: itemLimit || 20
    //       });
    
    //       return res
    //         .status(200)
    //         .json({
    //           msg: 'Successful',
    //           success: true,
    //           totalCount: totalCount,
    //           totalPages: totalPages,
    //           limit: itemLimit,
    //           currentPage: currentPage,
    //           users: users,
    //         });
    
    //     } catch (error) {
    //       console.log(error);
    //       return res.status(500).json({ msg: 'Something went wrong', error });
    //     }
    // }

    // async search(req: Request | any, res: Response){
    //     const { limit, page, keyword} = req.query;

    //     try {

    //         if(!keyword){
    //             return res.status(400).json({ msg: 'Search keyword is required', success: false})
    //         }
    
    //         const totalCount = await prisma.user.count({
    //             where: {
    //                 type: 'USER',
    //                 isDeactivated: false,
    //                 OR: [
    //                     {
    //                         firstName: {
    //                             contains: keyword,
    //                             mode: 'insensitive'
    //                         }
    //                     },
    //                     {
    //                         lastName: {
    //                             contains: keyword,
    //                             mode: 'insensitive'
    //                         }
    //                     },
    //                     {
    //                         email: {
    //                             contains: keyword,
    //                             mode: 'insensitive'
    //                         }
    //                     }
    //                 ]
    //             }
    //         });
      
    //         const itemLimit = (limit ? parseInt(limit as string) : 20) || 20;
    //         console.log(limit)
    //         const totalPages = Math.ceil(totalCount / itemLimit);
        
    //         const currentPage = page ? Math.max(parseInt(page as string), 1) : 1;
    //         const skip = (currentPage - 1) * itemLimit;

    //         const users = await prisma.user.findMany({
    //             where: {
    //                 type: 'USER',
    //                 isDeactivated: false,
    //                 OR: [
    //                     {
    //                         firstName: {
    //                             contains: keyword,
    //                             mode: 'insensitive'
    //                         }
    //                     },
    //                     {
    //                         lastName: {
    //                             contains: keyword,
    //                             mode: 'insensitive'
    //                         }
    //                     },
    //                     {
    //                         email: {
    //                             contains: keyword,
    //                             mode: 'insensitive'
    //                         }
    //                     }
    //                 ]
    //             },
    //             include: {
    //                 store:{ include:{ store: true}}
    //             },
    //             skip: skip,
    //             take: itemLimit || 20
    //         });
      
    //         return res
    //           .status(200)
    //           .json({
    //             msg: 'Successful',
    //             success: true,
    //             totalCount: totalCount,
    //             totalPages: totalPages,
    //             limit: itemLimit,
    //             currentPage: currentPage,
    //             users: users,
    //           });
      
    //       } catch (error) {
    //         console.log(error);
    //         return res.status(500).json({ msg: 'Something went wrong', error });
    //     }
    // }

    // async filterByDate(req: Request, res: Response){
    //     const { limit, page, date_from, date_to } = req.query;

    //     try {

    //         if(!date_from || !date_to){
    //             return res.status(400).json({ msg: 'Date from and Date to are required', success: false})
    //         }

    //         const dateFrom = new Date(date_from as string);
    //         const dateTo = new Date(date_to as string);
    
    //         const totalCount = await prisma.user.count({
    //             where: {
    //                 type: 'USER',
    //                 isDeactivated: false,
    //                 createdAt: {
    //                     gte: startOfDay(dateFrom),
    //                     lte: endOfDay(dateTo),
    //                 },
    //             }
    //         });
      
    //         const itemLimit = (limit ? parseInt(limit as string) : 20) || 20;
    //         console.log(limit)
    //         const totalPages = Math.ceil(totalCount / itemLimit);
        
    //         const currentPage = page ? Math.max(parseInt(page as string), 1) : 1;
    //         const skip = (currentPage - 1) * itemLimit;

    //         const users = await prisma.user.findMany({
    //             where: {
    //                 type: 'USER',
    //                 isDeactivated: false,
    //                 createdAt: {
    //                     gte: startOfDay(dateFrom),
    //                     lte: endOfDay(dateTo),
    //                 },
    //             },
    //             include: {
    //                 store:{ include:{ store: true}}
    //             },
    //             skip: skip,
    //             take: itemLimit || 20
    //         });
      
    //         return res
    //           .status(200)
    //           .json({
    //             msg: 'Successful',
    //             success: true,
    //             totalCount: totalCount,
    //             totalPages: totalPages,
    //             limit: itemLimit,
    //             currentPage: currentPage,
    //             users: users,
    //           });
      
    //       } catch (error) {
    //         console.log(error);
    //         return res.status(500).json({ msg: 'Something went wrong', error });
    //     }
    // }

    // async deleteUser(req: Request, res: Response){
    //     const user_id = req.params.user_id;

    //     try {

    //         await prisma.user.update({
    //             where: {id: user_id},
    //             data: {isDeactivated: true}
    //         })

    //         //TODO: send email to user
      
    //         return res
    //           .status(200)
    //           .json({
    //             msg: 'User deleted successfully',
    //             success: true,
    //           });
      
    //       } catch (error) {
    //         console.log(error);
    //         return res.status(500).json({ msg: 'Something went wrong', error });
    //     }
    // }

    // async changePassword(req: Request & Record<string, any>, res: Response) {
    //     const { newPassword } = req.body
    //     const user = req.user

    //     try {

    //         const encryptedPassword = await hashData(newPassword);

    //         await prisma.user.update({
    //             where: { email: user.email },
    //             data: {
    //                 password: encryptedPassword
    //             },
    //         });

    //         return res.status(201).json({
    //             msg: 'Password changed successfully',
    //             success: true,
    //             user,
    //         });

    //     } catch (error) {
    //         return res
    //             .status(500)
    //             .json({ msg: 'Internal Server Error', success: false, error });
    //     }
    // }

    // async updateProfile(req: Request & Record<string, any>, res: Response) {
    //     const { firstName, lastName, email, photoUrl } = req.body
    //     const user = req.user

    //     try {
    //         const updatedUser = await prisma.user.update({
    //             where: { email: user.email },
    //             data: {
    //                 firstName,
    //                 lastName,
    //                 email,
    //                 photoUrl
    //             },
    //         });

    //         return res.status(201).json({
    //             msg: 'Profile updated successfully',
    //             success: true,
    //             user: updatedUser,
    //         });

    //     } catch (error) {
    //         return res
    //             .status(500)
    //             .json({ msg: 'Internal Server Error', success: false, error });
    //     }
    // }
}

export default new AdminUserController()