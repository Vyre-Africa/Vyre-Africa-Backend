import { Request, Response } from 'express';
import prisma from '../config/prisma.client';
import {
  verifyTier1,
  verifyTier2,
  screenAml,
  screenEmail,
  COUNTRY_ID_TYPES,
} from '../services/dojah.service';
import { getUsageSummary, getMonthlyUsage } from '../services/kycLimits.service';
import type { KycCountry, Tier1IdType } from '../services/dojah.service';
import type { KycTier } from '../services/kycLimits.service';

class KycController {

  // GET /kyc/id-types?country=NG
  async getIdTypes(req: Request, res: Response) {
    const country = (req.query.country as string)?.toUpperCase() as KycCountry;
    try {
      if (!country || !COUNTRY_ID_TYPES[country]) {
        return res.status(400).json({
          success: false,
          msg: `Unsupported country: ${country}. Supported: ${Object.keys(COUNTRY_ID_TYPES).join(', ')}`,
        });
      }
      return res.status(200).json({
        success: true,
        msg: 'ID types fetched successfully',
        idTypes: COUNTRY_ID_TYPES[country],
      });
    } catch (error) {
      console.log(error);
      return res.status(500).json({ msg: 'Internal Server Error', success: false });
    }
  }

  // GET /kyc/lookup?email=harvey@vyre.africa
  // Public — no auth required.
  // Returns ONLY kycTier + usage figures. No PII ever returned.
  // Used by the anonymous order flow to silently apply higher limits
  // when the email belongs to a verified registered account.
  async lookupByEmail(req: Request, res: Response) {
    const email = (req.query.email as string)?.toLowerCase().trim();
    try {
      if (!email) {
        return res.status(400).json({ success: false, msg: 'email is required' });
      }

      const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, kycTier: true }, // never select PII
      });

      // No account — return Tier 0 defaults, not an error
      if (!user) {
        return res.status(200).json({
          success: true,
          kycTier: 0,
          monthlyLimitUsd: null,
          usedUsd: 0,
          remainingUsd: null,
        });
      }

      const tier = Number(user.kycTier ?? 0) as KycTier;
      const usedUsd = await getMonthlyUsage(user.id);

      const monthlyLimitUsd =
        tier === 1 ? 10000 :
        tier === 2 ? 50000 :
        tier === 3 ? null :
        null;

      const remainingUsd =
        monthlyLimitUsd !== null ? Math.max(0, monthlyLimitUsd - usedUsd) : null;

      return res.status(200).json({
        success: true,
        kycTier: tier,
        monthlyLimitUsd,
        usedUsd,
        remainingUsd,
      });

    } catch (error) {
      console.log(error);
      return res.status(500).json({ msg: 'Internal Server Error', success: false });
    }
  }

  // GET /kyc/usage
  async getUsage(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    try {
      const summary = await getUsageSummary(user.id, user.kycTier as KycTier);
      return res.status(200).json({
        success: true,
        msg: 'KYC usage fetched successfully',
        data: summary,
      });
    } catch (error) {
      console.log(error);
      return res.status(500).json({ msg: 'Internal Server Error', success: false });
    }
  }

  // POST /kyc/upgrade/tier1
  async upgradeTier1(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    console.log('Upgrade Tier 1 request body:', req.body);
    try {
      if (user.kycTier >= 1) {
        return res.status(200).json({
          success: true,
          msg: 'Already verified at Tier 1 or above',
          kycTier: user.kycTier,
        });
      }

      const { country, idType, idNumber, tzParams, email, fullName, dateOfBirth } = req.body as {
        country: KycCountry;
        idType: Tier1IdType;
        idNumber?: number | string;
        tzParams?: {
          firstName: string;
          lastName: string;
          dateOfBirth: string;
          mothersFirstName?: string;
          mothersLastName?: string;
        };
        email?: string;
        fullName?: string;      // required for GH SSNIT / DRIVERS_LICENSE
        dateOfBirth?: string;   // required for GH SSNIT / DRIVERS_LICENSE (yyyy-MM-dd)
      };

      if (!country || !idType) {
        return res.status(400).json({ success: false, msg: 'country and idType are required' });
      }

      if (!COUNTRY_ID_TYPES[country]) {
        return res.status(400).json({
          success: false,
          msg: `Unsupported country: ${country}. Supported: ${Object.keys(COUNTRY_ID_TYPES).join(', ')}`,
        });
      }

      const validIdTypes = COUNTRY_ID_TYPES[country].map((t) => t.value);
      if (!validIdTypes.includes(idType)) {
        return res.status(400).json({
          success: false,
          msg: `${idType} is not supported for ${country}. Supported: ${validIdTypes.join(', ')}`,
        });
      }

      const isTanzania = country === 'TZ' && idType === 'TZ_NIN';
      const requiresGhNameDob =
        country === 'GH' && (idType === 'SSNIT' || idType === 'DRIVERS_LICENSE');

      if (isTanzania && (!tzParams?.firstName || !tzParams?.lastName || !tzParams?.dateOfBirth)) {
        return res.status(400).json({
          success: false,
          msg: 'Tanzania NIN lookup requires tzParams with firstName, lastName, and dateOfBirth',
        });
      }

      if (requiresGhNameDob && (!fullName || !dateOfBirth)) {
        return res.status(400).json({
          success: false,
          msg: `${idType} verification for Ghana requires fullName and dateOfBirth`,
        });
      }

      if (!isTanzania && !idNumber) {
        return res.status(400).json({ success: false, msg: 'idNumber is required' });
      }

      const verificationRecord = await prisma.kycVerification.create({
        data: { userId: user.id, type: idType, country, status: 'PENDING' },
      });

      const idResult = await verifyTier1({ country, idType, idNumber, tzParams, fullName, dateOfBirth });

      console.log('Dojah Tier 1 result:', idResult);

      if (!idResult.success) {
        await prisma.kycVerification.update({
          where: { id: verificationRecord.id },
          data: { status: 'FAILED', dojahData: idResult.rawData ?? null, resolvedAt: new Date() },
        });
        return res.status(422).json({
          success: false,
          msg: idResult.error ?? 'Identity verification failed. Please check your details and try again.',
        });
      }

      // AML/PEP/sanctions screening — mandatory at Tier 1 upgrade per
      // AML/CFT Policy Section 7. This does NOT hard-block the upgrade on a
      // hit; it flags the verification record for manual compliance review
      // instead, since PEP/adverse-media hits are common false positives on
      // common names and a human should make the final call. If you want
      // hits to hard-block the Tier 1 upgrade instead, say so explicitly —
      // that's a deliberate policy choice, not something to default silently.
      const amlResult = await screenAml({
        firstName: idResult.firstName ?? '',
        lastName: idResult.lastName ?? '',
      });

      console.log('Dojah AML result:', amlResult);

      const amlFlagged = amlResult.isPep || amlResult.isSanctioned;

      await prisma.kycVerification.create({
        data: {
          userId: user.id,
          type: 'AML',
          country,
          status: amlResult.success ? 'APPROVED' : 'FAILED',
          dojahData: amlResult.rawData ?? null,
          flaggedForReview: amlFlagged,
          reviewNote: amlFlagged
            ? `AML screen: riskLevel=${amlResult.riskLevel ?? 'unknown'}, matchStatus=${amlResult.matchStatus ?? 'unknown'}`
            : null,
          resolvedAt: new Date(),
        },
      });

      if (email) {
        const emailResult = await screenEmail(email);
        console.log('Dojah email fraud result:', emailResult);
        await prisma.kycVerification.create({
          data: {
            userId: user.id,
            type: 'EMAIL_FRAUD',
            country,
            status: emailResult.success ? 'APPROVED' : 'FAILED',
            dojahData: emailResult.rawData ?? null,
            flaggedForReview: emailResult.flags.includes('HIGH_FRAUD_SCORE'),
            resolvedAt: new Date(),
          },
        });
      }

      const dojahRefField =
        idType === 'BVN' ? 'dojahBvnRef' :
        idType === 'NIN' || idType === 'VNIN' || idType === 'TZ_NIN' ? 'dojahNinRef' :
        'dojahIdRef';

      await prisma.kycVerification.update({
        where: { id: verificationRecord.id },
        data: {
          status: 'APPROVED',
          dojahData: idResult.rawData ?? null,
          dojahRef: String(idNumber ?? ''),
          resolvedAt: new Date(),
        },
      });

      await prisma.user.update({
        where: { id: user.id },
        data: { 
            kycTier: 1, 
            kycTier1At: new Date(), 
            [dojahRefField]: String(idNumber ?? ''),
            legalFirstName: idResult.firstName,
            legalLastName: idResult.lastName,
            legalNameVerifiedAt: new Date()
        },
      });

      return res.status(200).json({
        success: true,
        msg: 'Identity verified. You now have access to $10,000/month in trading volume.',
        kycTier: 1,
      });

    } catch (error) {
      console.log(error);
      return res.status(500).json({ msg: 'Internal Server Error', success: false });
    }
  }

  // POST /kyc/upgrade/tier2
  async upgradeTier2(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    try {
      if (user.kycTier < 1) {
        return res.status(403).json({
          success: false,
          msg: 'Complete Tier 1 verification before proceeding to Tier 2.',
        });
      }

      if (user.kycTier >= 2) {
        return res.status(200).json({
          success: true,
          msg: 'Already verified at Tier 2 or above',
          kycTier: user.kycTier,
        });
      }

      const { selfieImageBase64, idImageBase64 } = req.body as {
        selfieImageBase64: string;
        idImageBase64: string;
      };

      if (!selfieImageBase64 || !idImageBase64) {
        return res.status(400).json({
          success: false,
          msg: 'selfieImageBase64 and idImageBase64 are required',
        });
      }

      const verificationRecord = await prisma.kycVerification.create({
        data: {
          userId: user.id,
          type: 'PHOTO_ID_SELFIE',
          country: user.country ?? 'GLOBAL',
          status: 'PENDING',
        },
      });

      const result = await verifyTier2({ selfieImageBase64, idImageBase64 });

      if (!result.success || !result.match) {
        await prisma.kycVerification.update({
          where: { id: verificationRecord.id },
          data: { status: 'FAILED', dojahData: result.rawData ?? null, resolvedAt: new Date() },
        });
        // Dojah's confidence_value is already on a 0-100 scale — do not
        // multiply by 100 again (that previously showed e.g. "8500%").
        return res.status(422).json({
          success: false,
          msg: result.error ??
            `Face match failed (confidence: ${(result.confidence ?? 0).toFixed(0)}%). Please ensure your face is clearly visible and matches your ID photo.`,
        });
      }

      await prisma.kycVerification.update({
        where: { id: verificationRecord.id },
        data: { status: 'APPROVED', dojahData: result.rawData ?? null, resolvedAt: new Date() },
      });

      await prisma.user.update({
        where: { id: user.id },
        data: { kycTier: 2, kycTier2At: new Date(), dojahLivenessRef: `tier2_${Date.now()}` },
      });

      return res.status(200).json({
        success: true,
        msg: 'Identity fully verified. You now have access to $50,000/month in trading volume.',
        kycTier: 2,
      });

    } catch (error) {
      console.log(error);
      return res.status(500).json({ msg: 'Internal Server Error', success: false });
    }
  }

}

export default new KycController();