// Create a helper function
// middleware/cors-helper.ts
import 'dotenv/config';

import { requireAuth } from '@clerk/express';
import { Request, Response, NextFunction } from 'express';

export const requireAuthWithCORS = () => {
  return (req: Request, res: Response, next: NextFunction) => {
    // Skip OPTIONS
    // if (req.method === 'OPTIONS') {
    //   return next();
    // }
    
    // // Apply Clerk auth
    // return requireAuth()(req, res, next);
    return next();
  };
};