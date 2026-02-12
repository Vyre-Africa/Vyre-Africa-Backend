import dotenv from 'dotenv';
import { UserInfoClient } from 'auth0';
import { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../utils';
import prisma from '../config/prisma.config';
import { clerkClient, requireAuth, getAuth } from '@clerk/express'

dotenv.config();


export const authMiddleware = async (
  req: Request & { user?: any, isNewUser?:boolean },
  res: Response,
  next: NextFunction
) => {

  // Skip OPTIONS requests (CORS preflight)
  if (req.method === 'OPTIONS') {
    return next();
  }
  
  try {

    const { userId } = getAuth(req)
    const data = await clerkClient.users.getUser(userId as string)

    // 3. Find/Create User
    let user = await prisma.user.findUnique({
      where: { id: userId as string },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true
      }
    });

    // 4. Create new user if not exists
    if (!user) {
      user = await prisma.user.create({
        data: {
          id: data.id,
          email: data.primaryEmailAddress?.emailAddress as string,
          firstName: data.firstName || '',
          lastName: data.lastName || '',
          emailVerified: data.primaryEmailAddress?.verification?.status === 'verified' || false,
          photoUrl: data.imageUrl
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true
        }
      });

      // Optionally return 201 for new users
      req.isNewUser = true;
    }

    // 5. Attach user and proceed
    req.user = user;
    next();

  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(500).json({
      success: false,
      error: 'Authentication failed'
    });
  }
};
