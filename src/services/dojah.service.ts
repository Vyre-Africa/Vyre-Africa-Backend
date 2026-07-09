import axios, { type AxiosInstance } from 'axios';

// ─── Client ────────────────────────────────────────────────────────────────
//
// SECURITY: the previous client hardcoded a secret key literal alongside
// three other guessed auth field names ('authorization', 'accessToken',
// 'apiKey'). That key must be treated as compromised — rotate it in the
// Dojah dashboard regardless of anything else in this file.
//
// This client sets headers in exactly one place, using exactly the two
// headers Dojah's docs specify: AppId + Authorization (no "Bearer" prefix).

const DOJAH_ENV = process.env.DOJAH_ENV === 'live' ? 'live' : 'sandbox';

const DOJAH_BASE_URL =
  DOJAH_ENV === 'live' ? 'https://api.dojah.io' : 'https://sandbox.dojah.io';

if (!process.env.DOJAH_APP_ID || !process.env.DOJAH_SECRET_KEY) {
  throw new Error('DOJAH_APP_ID and DOJAH_SECRET_KEY must both be set');
}

const dojahClient: AxiosInstance = axios.create({
  baseURL: DOJAH_BASE_URL,
  headers: {
    AppId: process.env.DOJAH_APP_ID,
    Authorization: process.env.DOJAH_SECRET_KEY, // NOT "Bearer <key>"
  },
  timeout: 15000,
});

// Shared error handler — every call routes through here so we always get
// the real status/response, instead of the SDK's stripped-down error.
function handleDojahError(context: string, error: any) {
  console.error(`Dojah call failed [${context}]:`, {
    url: error?.config?.url,
    baseURL: error?.config?.baseURL,
    status: error?.response?.status,
    responseData: error?.response?.data,
  });
  return {
    error: error?.response?.data?.error ?? error?.response?.data?.message ?? error.message,
    rawData: error?.response?.data,
  };
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type KycCountry = 'NG' | 'GH' | 'KE' | 'TZ' | 'UG' | 'ZA';

export type Tier1IdType =
  | 'BVN'
  | 'NIN'
  | 'VNIN'
  | 'VIN'
  | 'PASSPORT'
  | 'DRIVERS_LICENSE'
  | 'NATIONAL_ID'
  | 'VOTER'
  | 'SSNIT'
  | 'TZ_NIN';

export interface TanzaniaLookupParams {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  mothersFirstName?: string;
  mothersLastName?: string;
}

export interface Tier1Input {
  country: KycCountry;
  idType: Tier1IdType;
  idNumber?: number | string;
  surname?: string;       // NG PASSPORT (endpoint currently disabled)
  fullName?: string;      // required for GH DRIVERS_LICENSE / SSNIT
  dateOfBirth?: string;   // required for GH DRIVERS_LICENSE / SSNIT (yyyy-MM-dd)
  tzParams?: TanzaniaLookupParams;
}

export interface Tier1Result {
  success: boolean;
  firstName?: string;
  lastName?: string;
  dob?: string;
  phone?: string;
  photo?: string;
  rawData?: any;
  error?: string;
}

export interface Tier2Result {
  success: boolean;
  match: boolean;
  confidence?: number;
  rawData?: any;
  error?: string;
}

export interface AmlResult {
  success: boolean;
  isPep: boolean;
  isSanctioned: boolean;
  riskLevel?: string;
  matchStatus?: string;
  hits: any[];
  rawData?: any;
  error?: string;
}

export interface FraudResult {
  success: boolean;
  riskScore?: number;
  flags: string[];
  rawData?: any;
  error?: string;
}

// ID types available per country — exported for frontend dropdown population.
// NG PASSPORT / DRIVERS_LICENSE / VNIN (plain lookup) are intentionally
// excluded — endpoints unconfirmed against current Dojah docs. Do not
// re-add without verifying exact path/params in sandbox first.
export const COUNTRY_ID_TYPES: Record<KycCountry, { value: Tier1IdType; label: string }[]> = {
  NG: [
    { value: 'BVN', label: 'BVN (Bank Verification Number)' },
    { value: 'NIN', label: 'NIN (National Identity Number)' },
    { value: 'VIN', label: "Voter's Card (VIN)" },
  ],
  GH: [
    { value: 'PASSPORT',        label: 'Passport' },
    { value: 'VOTER',           label: 'Voter ID' },
    { value: 'SSNIT',           label: 'SSNIT Number' },
    { value: 'DRIVERS_LICENSE', label: "Driver's Licence" },
  ],
  KE: [
    { value: 'NATIONAL_ID', label: 'National ID' },
    { value: 'PASSPORT',    label: 'Passport' },
  ],
  TZ: [{ value: 'TZ_NIN', label: 'National ID (NIN)' }], // UNCONFIRMED — see verifyTier1
  UG: [{ value: 'NATIONAL_ID', label: 'National ID (NIN)' }],
  ZA: [{ value: 'NATIONAL_ID', label: 'National ID' }],
};

// ─── Tier 1 — Identity Lookup ──────────────────────────────────────────────

export async function verifyTier1({
  country,
  idType,
  idNumber,
  surname,
  fullName,
  dateOfBirth,
  tzParams,
}: Tier1Input): Promise<Tier1Result> {
  try {
    // ── Nigeria ───────────────────────────────────────────────────────────
    if (country === 'NG') {

      if (idType === 'BVN') {
        // CONFIRMED against current Dojah docs
        const res = await dojahClient.get('/api/v1/kyc/bvn/full', {
          params: { bvn: idNumber },
        });
        const entity = res.data?.entity;
        return {
          success: !!entity,
          firstName: entity?.first_name,
          lastName: entity?.last_name,
          dob: entity?.date_of_birth,
          phone: entity?.phone_number1,
          photo: entity?.image,
          rawData: res.data,
        };
      }

      if (idType === 'NIN') {
        // CONFIRMED against current Dojah docs
        const res = await dojahClient.get('/api/v1/kyc/nin', {
          params: { nin: idNumber },
        });
        const entity = res.data?.entity;
        return {
          success: !!entity,
          firstName: entity?.first_name,
          lastName: entity?.last_name,
          dob: entity?.date_of_birth,
          phone: entity?.phone_number,
          photo: entity?.photo,
          rawData: res.data,
        };
      }

      if (idType === 'VIN') {
        // CONFIRMED against current Dojah docs — Nigeria Voter's ID
        const res = await dojahClient.get('/api/v1/kyc/vin', {
          params: { vin: idNumber },
        });
        const entity = res.data?.entity;
        const [firstName, ...rest] = (entity?.full_name ?? '').split(' ');
        return {
          success: !!entity,
          firstName,
          lastName: rest.join(' ') || undefined,
          dob: entity?.date_of_birth,
          phone: entity?.phone,
          rawData: res.data,
        };
      }

      if (idType === 'PASSPORT' || idType === 'DRIVERS_LICENSE' || idType === 'VNIN') {
        // Disabled — endpoint not confirmed against current Dojah docs.
        // Do not re-enable without verifying exact path/params in sandbox
        // first. This block is defense in depth: even if a stale frontend
        // dropdown or cached client still sends one of these idTypes, the
        // backend refuses rather than hitting an unverified endpoint.
        return {
          success: false,
          error: `${idType} verification is temporarily unavailable for Nigeria. Please use BVN, NIN, or Voter's Card instead.`,
        };
      }
    }

    // ── Ghana — all four CONFIRMED against current Dojah docs ──────────────
    if (country === 'GH') {

      if (idType === 'PASSPORT') {
        const res = await dojahClient.get('/api/v1/gh/kyc/passport', {
          params: { id: idNumber },
        });
        const entity = res.data?.entity;
        return {
          success: !!entity,
          firstName: entity?.first_name,
          lastName: entity?.last_name,
          dob: entity?.date_of_birth,
          photo: entity?.picture,
          rawData: res.data,
        };
      }

      if (idType === 'VOTER') {
        const res = await dojahClient.get('/api/v1/gh/kyc/voter', {
          params: { id: idNumber },
        });
        const entity = res.data?.entity;
        const [firstName, ...rest] = (entity?.full_name ?? '').split(' ');
        return {
          success: !!entity,
          firstName,
          lastName: rest.join(' ') || undefined,
          photo: entity?.picture,
          rawData: res.data,
        };
      }

      if (idType === 'SSNIT') {
        // full_name and date_of_birth are REQUIRED by Dojah for this endpoint
        if (!fullName || !dateOfBirth) {
          return { success: false, error: 'fullName and dateOfBirth are required for Ghana SSNIT lookup' };
        }
        const res = await dojahClient.get('/api/v1/gh/kyc/ssnit', {
          params: { id: idNumber, full_name: fullName, date_of_birth: dateOfBirth },
        });
        const entity = res.data?.entity;
        const [firstName, ...rest] = (entity?.full_name ?? '').split(' ');
        return {
          success: !!entity,
          firstName,
          lastName: rest.join(' ') || undefined,
          dob: entity?.date_of_birth,
          photo: entity?.picture,
          rawData: res.data,
        };
      }

      if (idType === 'DRIVERS_LICENSE') {
        // full_name and date_of_birth are REQUIRED by Dojah for this endpoint
        if (!fullName || !dateOfBirth) {
          return { success: false, error: 'fullName and dateOfBirth are required for Ghana Drivers Licence lookup' };
        }
        const res = await dojahClient.get('/api/v1/gh/kyc/dl', {
          params: { id: idNumber, full_name: fullName, date_of_birth: dateOfBirth },
        });
        const entity = res.data?.entity;
        const [firstName, ...rest] = (entity?.full_name ?? '').split(' ');
        return {
          success: !!entity,
          firstName,
          lastName: rest.join(' ') || undefined,
          dob: entity?.date_of_birth,
          photo: entity?.picture,
          rawData: res.data,
        };
      }
    }

    // ── Kenya — both CONFIRMED against current Dojah docs ──────────────────
    if (country === 'KE') {

      if (idType === 'NATIONAL_ID') {
        const res = await dojahClient.get('/api/v1/ke/kyc/id', {
          params: { id: idNumber },
        });
        const entity = res.data?.entity;
        return {
          success: !!entity,
          firstName: entity?.first_name,
          lastName: entity?.last_name,
          dob: entity?.date_of_birth,
          rawData: res.data,
        };
      }

      if (idType === 'PASSPORT') {
        const res = await dojahClient.get('/api/v1/ke/kyc/passport', {
          params: { id_number: idNumber },
        });
        const entity = res.data?.entity;
        return {
          success: !!entity,
          firstName: entity?.first_name,
          lastName: entity?.last_name,
          dob: entity?.date_of_birth,
          phone: entity?.phone_number,
          photo: entity?.photo,
          rawData: res.data,
        };
      }
    }

    // ── Tanzania — UNCONFIRMED WHETHER THIS COUNTRY IS EVEN SUPPORTED ──────
    // No Tanzania page has turned up across two rounds of research covering
    // NG, GH, KE, UG, ZA, Angola, Zimbabwe, and Zambia. Get explicit
    // confirmation from Dojah support before this ever reaches a real user.
    if (country === 'TZ' && idType === 'TZ_NIN') {
      return {
        success: false,
        error: 'Tanzania NIN lookup is not confirmed as a supported Dojah endpoint.',
      };
    }

    // ── Uganda — CONFIRMED: this is a NIN lookup ────────────────────────────
    if (country === 'UG' && idType === 'NATIONAL_ID') {
      const res = await dojahClient.get('/api/v1/ug/kyc/nin', {
        params: { nin: idNumber },
      });
      const entity = res.data?.entity;
      return {
        success: !!entity,
        firstName: entity?.first_name,
        lastName: entity?.last_name,
        dob: entity?.date_of_birth,
        rawData: res.data,
      };
    }

    // ── South Africa — CONFIRMED against current Dojah docs ────────────────
    if (country === 'ZA' && idType === 'NATIONAL_ID') {
      const res = await dojahClient.get('/api/v1/za/kyc/id', {
        params: { id_number: idNumber },
      });
      const entity = res.data?.entity;
      return {
        success: !!entity,
        firstName: entity?.first_name,
        lastName: entity?.last_name,
        dob: entity?.date_of_birth,
        rawData: res.data,
      };
    }

    return { success: false, error: `Unsupported country/idType: ${country}/${idType}` };

  } catch (error: any) {
    const { error: msg, rawData } = handleDojahError(`verifyTier1:${country}/${idType}`, error);
    return { success: false, error: msg, rawData };
  }
}

// ─── Selfie-combined lookups (identity + liveness in one call) ────────────
// Separate, higher-assurance endpoints Dojah offers alongside the plain
// lookups above. Wire these in if/when your Tier1 flow starts collecting a
// selfie at the same step as the ID number.

export async function verifyBvnWithSelfie(bvn: string, selfieImageBase64: string) {
  try {
    const res = await dojahClient.post('/api/v1/kyc/bvn/verify', {
      bvn,
      selfie_image: selfieImageBase64,
    });
    return { success: true, rawData: res.data };
  } catch (error: any) {
    return { success: false, ...handleDojahError('verifyBvnWithSelfie', error) };
  }
}

export async function verifyNinWithSelfie(nin: string, selfieImageBase64: string) {
  try {
    const res = await dojahClient.post('/api/v1/kyc/nin/verify', {
      nin,
      selfie_image: selfieImageBase64,
    });
    return { success: true, rawData: res.data };
  } catch (error: any) {
    return { success: false, ...handleDojahError('verifyNinWithSelfie', error) };
  }
}

export async function verifyVninWithSelfie(vnin: string, selfieImageBase64: string) {
  try {
    const res = await dojahClient.post('/api/v1/kyc/vnin/verify', {
      vnin,
      selfie_image: selfieImageBase64,
    });
    return { success: true, rawData: res.data };
  } catch (error: any) {
    return { success: false, ...handleDojahError('verifyVninWithSelfie', error) };
  }
}

// ─── Tier 2 — Photo ID + Selfie — CONFIRMED against current Dojah docs ────

export async function verifyTier2({
  selfieImageBase64,
  idImageBase64,
}: {
  selfieImageBase64: string;
  idImageBase64: string;
}): Promise<Tier2Result> {
  try {
    const res = await dojahClient.post('/api/v1/kyc/photoid/verify', {
      selfie_image: selfieImageBase64,
      photoid_image: idImageBase64,
    });
    const data = res.data?.entity?.selfie;
    return {
      success: true,
      match: data?.match === true, // Dojah: confidence_value >= 90 → match true
      confidence: data?.confidence_value,
      rawData: res.data,
    };
  } catch (error: any) {
    const { error: msg } = handleDojahError('verifyTier2', error);
    return { success: false, match: false, error: msg };
  }
}

// ─── AML Screening (v2) — CONFIRMED, fully synchronous ─────────────────────
// Rewritten from scratch: the previous version assumed an async
// reference_id/webhook pattern that doesn't match this endpoint's real
// behavior. It returns full PEP/sanctions/adverse-media results inline.

export async function screenAml({
  firstName,
  lastName,
  dateOfBirth,
  nationality,
  idNumber,
}: {
  firstName: string;
  lastName: string;
  dateOfBirth?: string;
  nationality?: string;
  idNumber?: string;
}): Promise<AmlResult> {
  try {
    const res = await dojahClient.post('/api/v1/aml/v2/screening', {
      schema: 'individual',
      properties: {
        names: `${firstName} ${lastName}`.trim(),
        date_of_birth: dateOfBirth ?? '',
        nationality: nationality ?? '',
        id_number: idNumber ?? '',
      },
      screening_options: {
        pep_check: true,
        sanction: true,
        adverse_media_check: true,
        match_threshold: 0.85,
      },
    });

    const entity = res.data?.entity;
    const results = entity?.results ?? [];

    const isPep = results.some((r: any) => r?.source_type === 'PEP' && r?.match === true);
    const isSanctioned = results.some((r: any) => r?.source_type === 'SANCTIONS' && r?.match === true);

    return {
      success: true,
      isPep,
      isSanctioned,
      riskLevel: entity?.risk_level,
      matchStatus: entity?.match_status,
      hits: results,
      rawData: res.data,
    };
  } catch (error: any) {
    const { error: msg } = handleDojahError('screenAml', error);
    return { success: false, isPep: false, isSanctioned: false, hits: [], error: msg };
  }
}

// ─── Email Fraud Screening — CONFIRMED against current Dojah docs ─────────

export async function screenEmail(email: string): Promise<FraudResult> {
  try {
    const res = await dojahClient.get('/api/v1/fraud/email', {
      params: { email_address: email },
    });
    const entity = res.data?.entity;
    const d = entity?.details ?? {};

    const flags: string[] = [];
    if (entity?.suspicious === true) flags.push('SUSPICIOUS_EMAIL');
    if (d.disposable === true) flags.push('DISPOSABLE_EMAIL');
    if (d.deliverable === false) flags.push('UNDELIVERABLE_EMAIL');
    if (d.data_breach === true) flags.push('IN_DATA_BREACH');
    if (d.credentials_leaked === true) flags.push('CREDENTIALS_LEAKED');
    if (entity?.reputation?.toLowerCase() === 'low') flags.push('LOW_REPUTATION');
    if (d.new_domain === true) flags.push('NEW_DOMAIN');

    return { success: true, flags, rawData: res.data };
  } catch (error: any) {
    const { error: msg } = handleDojahError('screenEmail', error);
    return { success: false, flags: [], error: msg };
  }
}

// ─── Combined User Screening (phone + email + AML + IP in one call) ───────
// Dojah offers a single endpoint that does everything a standalone
// screenPhone would have tried to do, plus AML and IP risk in the same
// call — GET /api/v1/fraud/user. No standalone phone-only endpoint was
// found in the docs available, so this is the confirmed path for phone
// risk rather than a guessed one.

export async function screenUser({
  firstName,
  lastName,
  middleName,
  dateOfBirth,
  email,
  phone,
  ipAddress,
}: {
  firstName: string;
  lastName: string;
  middleName?: string;
  dateOfBirth: string;
  email?: string;
  phone?: string;
  ipAddress?: string;
}) {
  try {
    const res = await dojahClient.get('/api/v1/fraud/user', {
      params: {
        first_name: firstName,
        last_name: lastName,
        middle_name: middleName,
        date_of_birth: dateOfBirth,
        email,
        phone,
        ip_address: ipAddress,
      },
    });
    return {
      success: true,
      rawData: res.data,
      overallRiskScore: res.data?.entity?.overall_risk_score,
    };
  } catch (error: any) {
    const { error: msg } = handleDojahError('screenUser', error);
    return { success: false, error: msg };
  }
}