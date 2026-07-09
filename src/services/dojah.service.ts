import { Dojah } from 'dojah-typescript-sdk';

// ─── Client ────────────────────────────────────────────────────────────────────

const dojah = new Dojah({
  authorization: process.env.DOJAH_SECRET_KEY!,
  appId: process.env.DOJAH_SECRET_KEY!,
//   appId: process.env.DOJAH_APP_ID!,
});

// ─── Types ─────────────────────────────────────────────────────────────────────

export type KycCountry = 'NG' | 'GH' | 'KE' | 'TZ' | 'UG' | 'ZA';

export type Tier1IdType =
  | 'BVN'
  | 'NIN'
  | 'VNIN'
  | 'PASSPORT'
  | 'DRIVERS_LICENSE'
  | 'NATIONAL_ID'
  | 'VOTER'
  | 'SSNIT'
  | 'TZ_NIN';

// Tanzania lookup requires personal details instead of an ID number
export interface TanzaniaLookupParams {
  firstName: string;
  lastName: string;
  dateOfBirth: string;          // YYYY-MM-DD
  mothersFirstName?: string;
  mothersLastName?: string;
}

export interface Tier1Input {
  country: KycCountry;
  idType: Tier1IdType;
  idNumber?: number | string;   // all countries except TZ
  tzParams?: TanzaniaLookupParams; // TZ only
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
  referenceId?: string;
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

// ID types available per country — exported for frontend dropdown population
export const COUNTRY_ID_TYPES: Record<KycCountry, { value: Tier1IdType; label: string }[]> = {
  NG: [
    { value: 'BVN',             label: 'BVN (Bank Verification Number)' },
    { value: 'NIN',             label: 'NIN (National Identity Number)' },
    { value: 'VNIN',            label: 'Virtual NIN (vNIN)' },
    { value: 'PASSPORT',        label: 'International Passport' },
    { value: 'DRIVERS_LICENSE', label: "Driver's Licence" },
  ],
  GH: [
    { value: 'PASSPORT',        label: 'Passport' },
    { value: 'VOTER',           label: 'Voter ID' },
    { value: 'SSNIT',           label: 'SSNIT Number' },
    { value: 'DRIVERS_LICENSE', label: "Driver's Licence" },
  ],
  KE: [
    { value: 'NATIONAL_ID',     label: 'National ID' },
    // KE Passport excluded — Dojah SDK does not support passing a passport number
    // for the Kenya passport endpoint. Re-enable once SDK is updated.
  ],
  TZ: [{ value: 'TZ_NIN',      label: 'National ID (NIN)' }],
  UG: [{ value: 'VOTER',       label: 'Voter ID' }],
  ZA: [{ value: 'NATIONAL_ID', label: 'National ID' }],
};

// ─── Tier 1 — Identity Lookup ──────────────────────────────────────────────────

export async function verifyTier1({
  country,
  idType,
  idNumber,
  tzParams,
}: Tier1Input): Promise<Tier1Result> {
  try {
    // ── Nigeria ───────────────────────────────────────────────────────────────
    if (country === 'NG') {

      if (idType === 'BVN') {
        // entity: NigeriaKycGetBvn1ResponseEntity
        const res = await dojah.nigeriaKyc.getBasicBvn1({ bvn: idNumber as number });
        console.log('response',res.data);
        const entity = (res.data as any)?.entity;
        console.log('entity',entity);
        return {
          success: !!entity,
          firstName: entity?.first_name,
          lastName: entity?.last_name,
          dob: entity?.date_of_birth,
          phone: entity?.phone_number1,
          rawData: res.data,
        };
      }

      if (idType === 'NIN') {
        // entity: NigeriaKycGetNinResponseEntity
        // note: uses 'surname' not 'last_name', 'birth_date' not 'date_of_birth',
        //       'telephone' not 'phone_number', 'picture' not 'photo'
        const res = await dojah.nigeriaKyc.getNin({ nin: idNumber as number });
        const entity = (res.data as any)?.entity;
        return {
          success: !!entity,
          firstName: entity?.first_name,
          lastName: entity?.surname,
          dob: entity?.birth_date,
          phone: entity?.telephone,
          photo: entity?.picture,
          rawData: res.data,
        };
      }

      if (idType === 'VNIN') {
        // entity: GetVninResponseEntity
        // note: uses 'firstname'/'surname' not 'first_name'/'last_name',
        //       'dateOfBirth' (camelCase) not 'date_of_birth',
        //       'mobile' not 'phone_number'
        const res = await dojah.nigeriaKyc.getVnin({ vnin: idNumber as string });
        const entity = (res.data as any)?.entity;
        return {
          success: !!entity,
          firstName: entity?.firstname,
          lastName: entity?.surname,
          dob: entity?.dateOfBirth,
          phone: entity?.mobile,
          photo: entity?.photo,
          rawData: res.data,
        };
      }

      if (idType === 'PASSPORT') {
        // entity: GetKycPassportResponseEntity
        // note: uses 'surname' not 'last_name'
        const res = await dojah.nigeriaKyc.getPassport({ passportNumber: idNumber as string });
        const entity = (res.data as any)?.entity;
        return {
          success: !!entity,
          firstName: entity?.first_name,
          lastName: entity?.surname,
          dob: entity?.date_of_birth,
          photo: entity?.photo,
          rawData: res.data,
        };
      }

      if (idType === 'DRIVERS_LICENSE') {
        // entity: GetKycDriversLicenseResponseEntity
        // note: personal details are nested under entity.personal_details
        //       uses 'firstname'/'surname', 'birth_date' not 'date_of_birth'
        const res = await dojah.nigeriaKyc.getDriversLicense({ licenseNumber: idNumber as string });
        const entity = (res.data as any)?.entity;
        const pd = entity?.personal_details;
        return {
          success: !!pd,
          firstName: pd?.firstname,
          lastName: pd?.surname,
          dob: pd?.birth_date,
          rawData: res.data,
        };
      }
    }

    // ── Ghana ─────────────────────────────────────────────────────────────────
    if (country === 'GH') {

      if (idType === 'PASSPORT') {
        // entity: GetPassportResponseEntity
        // note: uses 'last_name' not 'surname', 'picture' not 'photo'
        const res = await dojah.ghKyc.getPassport({ id: idNumber as string });
        const entity = (res.data as any)?.entity;
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
        // SDK returns untyped `data: object` — log raw in dev to confirm field names
        const res = await dojah.ghKyc.getVoter({ id: idNumber as number });
        const raw = res.data as any;
        if (process.env.NODE_ENV !== 'production') console.log('[dojah GH VOTER raw]', JSON.stringify(raw, null, 2));
        const entity = raw?.entity ?? raw;
        return {
          success: !!entity,
          firstName: entity?.first_name,
          lastName: entity?.last_name,
          dob: entity?.date_of_birth,
          rawData: raw,
        };
      }

      if (idType === 'SSNIT') {
        // entity: GetSsnitResponseEntity
        // note: has 'full_name' only (no separate first/last), 'picture' not 'photo'
        const res = await dojah.ghKyc.getSsnit({ id: idNumber as string });
        const entity = (res.data as any)?.entity;
        const nameParts = (entity?.full_name ?? '').split(' ');
        return {
          success: !!entity,
          firstName: nameParts[0],
          lastName: nameParts.slice(1).join(' ') || undefined,
          dob: entity?.date_of_birth,
          photo: entity?.picture,
          rawData: res.data,
        };
      }

      if (idType === 'DRIVERS_LICENSE') {
        // entity: GetDriversLicenseResponseEntity
        // note: has 'full_name' only, 'picture' not 'photo'
        const res = await dojah.ghKyc.getDriversLicense({ id: idNumber as string });
        const entity = (res.data as any)?.entity;
        const nameParts = (entity?.full_name ?? '').split(' ');
        return {
          success: !!entity,
          firstName: nameParts[0],
          lastName: nameParts.slice(1).join(' ') || undefined,
          dob: entity?.date_of_birth,
          photo: entity?.picture,
          rawData: res.data,
        };
      }
    }

    // ── Kenya ──────────────────────────────────────────────────────────────────
    if (country === 'KE') {

      if (idType === 'NATIONAL_ID') {
        // entity: GetNationalIdResponseEntity
        // note: uses 'last_name'/'middle_name', no photo field
        const res = await dojah.keKyc.getNationalId({ id: Number(idNumber) });
        const entity = (res.data as any)?.entity;
        return {
          success: !!entity,
          firstName: entity?.first_name,
          lastName: entity?.last_name,
          dob: entity?.date_of_birth,
          rawData: res.data,
        };
      }

      if (idType === 'PASSPORT') {
        // The Dojah SDK's keKyc.getPassport() accepts no parameters — the passport
        // number cannot be passed through it. This endpoint is not usable until
        // Dojah updates the SDK or documents an alternative approach (e.g. direct
        // HTTP call with the passport number as a query param).
        // TODO: check Dojah dashboard for KE passport endpoint requirements and
        //       implement via direct axios call if needed.
        return {
          success: false,
          error: 'Kenya Passport lookup is not currently supported. Please use National ID instead.',
        };
      }
    }

    // ── Tanzania ───────────────────────────────────────────────────────────────
    // Does NOT take an ID number — requires personal details for lookup.
    // Frontend must collect firstName, lastName, dateOfBirth (+ optional mother's names).
    if (country === 'TZ' && idType === 'TZ_NIN') {
      if (!tzParams) {
        return {
          success: false,
          error: 'Tanzania NIN lookup requires personal details (firstName, lastName, dateOfBirth). Provide tzParams.',
        };
      }
      const res = await dojah.tzKyc.getNin({
        firstName: tzParams.firstName,
        lastName: tzParams.lastName,
        dateOfBirth: tzParams.dateOfBirth,
        mothersFirstName: tzParams.mothersFirstName,
        mothersLastName: tzParams.mothersLastName,
      });
      // SDK returns untyped `data: object` — log raw in dev to confirm field names
      const raw = res.data as any;
      if (process.env.NODE_ENV !== 'production') console.log('[dojah TZ NIN raw]', JSON.stringify(raw, null, 2));
      const entity = raw?.entity ?? raw;
      return {
        success: !!entity,
        firstName: entity?.first_name,
        lastName: entity?.last_name,
        dob: entity?.date_of_birth,
        rawData: raw,
      };
    }

    // ── Uganda ─────────────────────────────────────────────────────────────────
    if (country === 'UG' && idType === 'VOTER') {
      // SDK returns untyped `data: object` — log raw in dev to confirm field names
      const res = await dojah.ugKyc.getVoter({ id: idNumber as number });
      const raw = res.data as any;
      if (process.env.NODE_ENV !== 'production') console.log('[dojah UG VOTER raw]', JSON.stringify(raw, null, 2));
      const entity = raw?.entity ?? raw;
      return {
        success: !!entity,
        firstName: entity?.first_name,
        lastName: entity?.last_name,
        rawData: raw,
      };
    }

    // ── South Africa ───────────────────────────────────────────────────────────
    if (country === 'ZA' && idType === 'NATIONAL_ID') {
      // entity: ZafKycGetIdResponseEntity
      // note: has 'full_name' + separate 'last_name', 'date_of_birth', 'photo'
      const res = await dojah.zafKyc.getId({ idNumber: idNumber as number });
      const entity = (res.data as any)?.entity;
      // full_name includes first + last — extract first name by removing last_name from it
      const fullName: string = entity?.full_name ?? '';
      const lastName: string = entity?.last_name ?? '';
      const firstName = fullName.replace(lastName, '').trim() || fullName;
      return {
        success: !!entity,
        firstName,
        lastName,
        dob: entity?.date_of_birth,
        photo: entity?.photo,
        rawData: res.data,
      };
    }

    return { success: false, error: `Unsupported country/idType: ${country}/${idType}` };

  } catch (error: any) {
    console.error('Dojah BVN call failed:', {
        url: error?.config?.url,
        baseURL: error?.config?.baseURL,
        method: error?.config?.method,
        responseData: error?.response?.data,
        status: error?.response?.status,
    });

    return { success: false, error: error?.response?.data?.error ?? error.message, rawData: error?.response?.data };

  }
}

// ─── Tier 2 — Photo ID + Selfie ────────────────────────────────────────────────
// Country-agnostic: Dojah compares the face on the ID document against the
// selfie using computer vision only — it does not care what country issued
// the ID or what type it is. Works identically for NG, GH, KE, TZ, UG, ZA
// and any other country. The user simply provides their ID photo and a selfie.

export async function verifyTier2({
  selfieImageBase64,
  idImageBase64,
}: {
  selfieImageBase64: string;
  idImageBase64: string;
}): Promise<Tier2Result> {
  try {
    const res = await dojah.ml.verifyPhotoIdWithSelfie({
      selfie_image: selfieImageBase64,
      photoid_image: idImageBase64,
    });

    // SDK returns untyped `data: object` — log raw in dev to confirm match field names
    const raw = res.data as any;
    if (process.env.NODE_ENV !== 'production') console.log('[dojah TIER2 SELFIE raw]', JSON.stringify(raw, null, 2));
    const data = raw?.entity ?? raw;
    const match: boolean =
      data?.match === true ||
      data?.face_match === true ||
      (typeof data?.confidence === 'number' && data.confidence >= 0.8);

    return {
      success: true,
      match,
      confidence: data?.confidence ?? data?.similarity,
      rawData: raw,
    };
  } catch (err: any) {
    console.error('[dojah.verifyTier2]', err?.message ?? err);
    return { success: false, match: false, error: err?.message ?? 'Verification failed' };
  }
}

// ─── AML Screening ─────────────────────────────────────────────────────────────
// entity: AmlScreenAmlResponseEntity
// note: response is async — returns { reference_id, status } only.
// Dojah sends actual hit results to your webhook, not inline.
// Store the reference_id and handle hits via webhook for production use.
// For now, we treat a successful call as a clean screen and log the reference.

export async function screenAml({
  firstName,
  lastName,
}: {
  firstName: string;
  lastName: string;
}): Promise<AmlResult> {
  try {
    const res = await dojah.aml.screenAml({ first_name: firstName, last_name: lastName });
    const entity = (res.data as any)?.entity;

    // AML response is { reference_id, status } — hits arrive via webhook asynchronously
    return {
      success: true,
      isPep: false,       // will be updated by webhook handler when Dojah delivers results
      isSanctioned: false,
      referenceId: entity?.reference_id,
      hits: [],
      rawData: res.data,
    };
  } catch (err: any) {
    console.error('[dojah.screenAml]', err?.message ?? err);
    return { success: false, isPep: false, isSanctioned: false, hits: [], error: err?.message };
  }
}

// ─── Phone Fraud Screening ─────────────────────────────────────────────────────
// entity: FraudScreenPhoneResponseEntity
// note: uses 'valid' not 'is_valid', 'disposable' not 'is_disposable',
//       'score' not 'risk_score', 'type' includes 'voip'

export async function screenPhone(phoneNumber: number): Promise<FraudResult> {
  try {
    const res = await dojah.fraud.screenPhone({ phoneNumber });
    const entity = (res.data as any)?.entity;

    const flags: string[] = [];
    if (entity?.valid === false) flags.push('INVALID_PHONE');
    if (entity?.type?.toLowerCase() === 'voip') flags.push('VOIP_NUMBER');
    if (entity?.disposable === true) flags.push('DISPOSABLE_NUMBER');
    if (typeof entity?.score === 'number' && entity.score >= 70) flags.push('HIGH_RISK_SCORE');

    return { success: true, riskScore: entity?.score, flags, rawData: res.data };
  } catch (err: any) {
    console.error('[dojah.screenPhone]', err?.message ?? err);
    return { success: false, flags: [], error: err?.message };
  }
}

// ─── Email Fraud Screening ─────────────────────────────────────────────────────
// entity: FraudGetEmailReputationResponseEntity
// note: uses 'suspicious' not 'is_disposable', 'score' not 'fraud_score',
//       'reputation' is a string ('low'/'medium'/'high'), 'deliverable' is bool

export async function screenEmail(email: string): Promise<FraudResult> {
  try {
    const res = await dojah.fraud.getEmailReputation({ email });
    const entity = (res.data as any)?.entity;

    const flags: string[] = [];
    if (entity?.suspicious === true) flags.push('SUSPICIOUS_EMAIL');
    if (entity?.deliverable === false) flags.push('UNDELIVERABLE_EMAIL');
    if (entity?.reputation?.toLowerCase() === 'low') flags.push('LOW_REPUTATION');
    if (typeof entity?.score === 'number' && entity.score >= 70) flags.push('HIGH_FRAUD_SCORE');

    return { success: true, riskScore: entity?.score, flags, rawData: res.data };
  } catch (err: any) {
    console.error('[dojah.screenEmail]', err?.message ?? err);
    return { success: false, flags: [], error: err?.message };
  }
}