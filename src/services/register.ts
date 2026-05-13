import dotenv from 'dotenv';
import { UserInfoClient } from 'auth0';
import { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../utils';
import prisma from '../config/prisma.client';
dotenv.config();

const userInfoClient = new UserInfoClient({
    domain: 'auth.vyre.africa', // Your Auth0 domain
});
  

export const registerMiddleware = async(
    req: Request & Record<string, any>,
    res: Response,
    next: NextFunction,
) => {

    console.log(req.headers)

    const { authorization } = req.headers;
    if (!authorization) {
        return res
            .status(401)
            .json({ msg: 'Authentication token required', success: false });
    }
    const token = authorization.split(' ')[1];

    console.log(token)

    // const result = verifyAccessToken(token as string);
    const { success, data, error } = await verifyAccessToken(token);
    console.log(success)
    let newUser;
    if (success) {
        console.log(data?.sub);      // "auth0|123456"
        // console.log(data?.email);    // "user@example.com"
        try{
            const userDetails = await userInfoClient.getUserInfo(token);
            newUser = userDetails.data
            console.log('userDetails',userDetails.data)
            
        } catch (error) {
            console.error('user retrieval error:', error)
            return res.status(401).json({ msg: 'User not found', success: false });
        }

    }else{
       return res.status(403).json({ error });
    }


    req.user = newUser;
    next();
};
