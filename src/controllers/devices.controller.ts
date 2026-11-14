// src/controllers/devices.controller.ts
//
// Device registration. Two routes, and the whole correctness of the thing
// is in one line of the upsert — see below.

import type { Request, Response } from 'express';
import { Expo } from 'expo-server-sdk';
import prisma from '../config/prisma.client';

export async function registerDevice(req: Request | any, res: Response) {
  const user = req.user;
  if (!user?.id) {
    return res.status(401).json({ msg: 'Unauthorised', success: false });
  }

  const { token, platform, deviceName, osVersion, appVersion } = req.body ?? {};

  // Reject anything that is not an Expo token before it reaches the table.
  // Otherwise junk sits there until the first send fails, and every send in
  // between pays for a wasted message slot.
  if (typeof token !== 'string' || !Expo.isExpoPushToken(token)) {
    return res.status(400).json({ msg: 'Not an Expo push token', success: false });
  }
  if (platform !== 'ios' && platform !== 'android') {
    return res.status(400).json({ msg: 'platform must be ios or android', success: false });
  }

  try {
    // THE line.
    //
    // Upsert on the token, with userId in the UPDATE half. When a second
    // person signs in on the same handset, Expo returns the same token and
    // this REASSIGNS the row to them, atomically.
    //
    // If userId were only in `create`, the upsert would find the existing row
    // and leave it pointing at the previous user — which is exactly Spondle's
    // bug, just with more tables. The previous user would keep receiving the
    // new user's transaction notifications.
    await prisma.deviceToken.upsert({
      where: { token },
      create: { token, userId: user.id, platform, deviceName, osVersion, appVersion },
      update: { userId: user.id, platform, deviceName, osVersion, appVersion },
    });

    return res.status(200).json({ msg: 'Device registered', success: true });
  } catch (error) {
    console.error('[devices] register failed', error);
    return res.status(500).json({ msg: 'Internal Server Error', success: false });
  }
}

export async function unregisterDevice(req: Request | any, res: Response) {
  const user = req.user;
  if (!user?.id) {
    return res.status(401).json({ msg: 'Unauthorised', success: false });
  }

  const { token } = req.body ?? {};
  if (typeof token !== 'string') {
    return res.status(400).json({ msg: 'token required', success: false });
  }

  try {
    // Scoped to the caller. A token you do not own is not yours to delete —
    // an unscoped delete here would let anyone holding a token string silence
    // that person's notifications.
    //
    // deleteMany, not delete: deleting a row that is already gone must not
    // throw. The client calls this on sign-out as best-effort, and a 500 on
    // the way out of the app is worse than useless.
    await prisma.deviceToken.deleteMany({ where: { token, userId: user.id } });

    return res.status(200).json({ msg: 'Device unregistered', success: true });
  } catch (error) {
    console.error('[devices] unregister failed', error);
    return res.status(500).json({ msg: 'Internal Server Error', success: false });
  }
}