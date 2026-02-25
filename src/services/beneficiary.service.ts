import { Prisma } from '@prisma/client';
import prisma from '../config/prisma.config';
import { beneficiaryType } from '@prisma/client';

// Types
enum BeneficiaryType {
  BANK = 'BANK',
  CRYPTO = 'CRYPTO',
  USER = 'USER'
}

interface BankDetails {
  accountNumber: string;
  accountName: string;
  bankName: string;
  bankCode?: string; // Optional - not all countries use bank codes
  swiftCode?: string; // For international transfers
  iban?: string; // For European banks
  routingNumber?: string; // For US banks
  sortCode?: string; // For UK banks
}

interface CryptoDetails {
  address: string;
  chain: string;
}

interface UserDetails {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  imgUrl?: string;
}

interface CreateBeneficiaryInput {
  userId: string;
  ISO: string;
  type: BeneficiaryType;
  bank?: BankDetails;
  crypto?: CryptoDetails;
  user?: UserDetails;
}

interface FetchBeneficiariesInput {
  userId: string;
  ISO?: string;
  type?: beneficiaryType;
  chain?: string;
}

// Validation Functions
const validateISO = (ISO: string): boolean => {
  // ISO currency codes are 3 uppercase letters
  const isoRegex = /^[A-Z]{3}$/;
  return isoRegex.test(ISO);
};

const validateBankDetails = (bank: BankDetails): { valid: boolean; error?: string } => {
  if (!bank.accountNumber || bank.accountNumber.trim().length < 5) {
    return { valid: false, error: 'Account number must be at least 5 characters' };
  }
  if (!bank.accountName || bank.accountName.trim().length < 2) {
    return { valid: false, error: 'Account name is required' };
  }
  if (!bank.bankName || bank.bankName.trim().length < 2) {
    return { valid: false, error: 'Bank name is required' };
  }
  return { valid: true };
};

const validateCryptoDetails = (crypto: CryptoDetails): { valid: boolean; error?: string } => {
  if (!crypto.address || crypto.address.trim().length < 10) {
    return { valid: false, error: 'Valid wallet address is required' };
  }
  if (!crypto.chain || crypto.chain.trim().length < 2) {
    return { valid: false, error: 'Chain is required' };
  }
  return { valid: true };
};

const validateCreateBeneficiaryInput = (input: CreateBeneficiaryInput): { valid: boolean; error?: string } => {
  // Validate required fields
  if (!input.userId || input.userId.trim().length < 1) {
    return { valid: false, error: 'User ID is required' };
  }

  if (!input.ISO || !validateISO(input.ISO)) {
    return { valid: false, error: 'Valid ISO currency code is required' };
  }

  if (!input.type || !Object.values(BeneficiaryType).includes(input.type)) {
    return { valid: false, error: 'Valid beneficiary type is required' };
  }

  // Validate type-specific details
  switch (input.type) {
    case BeneficiaryType.BANK:
      if (!input.bank) {
        return { valid: false, error: 'Bank details are required for BANK type' };
      }
      return validateBankDetails(input.bank);

    case BeneficiaryType.CRYPTO:
      if (!input.crypto) {
        return { valid: false, error: 'Crypto details are required for CRYPTO type' };
      }
      return validateCryptoDetails(input.crypto);

    case BeneficiaryType.USER:
      if (!input.user) {
        return { valid: false, error: 'User details are required for USER type' };
      }
      // No validation for user details - comes from database
      return { valid: true };

    default:
      return { valid: false, error: 'Invalid beneficiary type' };
  }
};

// Create Beneficiary (Idempotent)
export const createBeneficiary = async (input: CreateBeneficiaryInput) => {
  try {
    // Validate input
    const validation = validateCreateBeneficiaryInput(input);
    if (!validation.valid) {
      return {
        success: false,
        msg: validation.error,
        beneficiary: null
      };
    }

    // Check if user exists
    const userExists = await prisma.user.findUnique({
      where: { id: input.userId }
    });

    if (!userExists) {
      return {
        success: false,
        msg: 'User not found',
        beneficiary: null
      };
    }

    // Build unique identifier for idempotency check
    let uniqueIdentifier: any = {
      userId: input.userId,
      ISO: input.ISO,
      type: input.type
    };

    // Add type-specific identifier
    if (input.type === BeneficiaryType.BANK && input.bank) {
      uniqueIdentifier.bank = {
        path: ['accountNumber'],
        equals: input.bank.accountNumber
      };
    } else if (input.type === BeneficiaryType.CRYPTO && input.crypto) {
      uniqueIdentifier.crypto = {
        path: ['address'],
        equals: input.crypto.address
      };
    } else if (input.type === BeneficiaryType.USER && input.user) {
      uniqueIdentifier.user = {
        path: ['userId'],
        equals: input.user.userId
      };
    }

    // Check if beneficiary already exists (idempotency)
    const existing = await prisma.beneficiary.findFirst({
      where: uniqueIdentifier
    });

    if (existing) {
      return {
        success: true,
        msg: 'Beneficiary already exists',
        beneficiary: existing,
        isExisting: true
      };
    }

    // Create new beneficiary
    const beneficiary = await prisma.beneficiary.create({
      data: {
        userId: input.userId,
        ISO: input.ISO,
        type: input.type,
        chain: input.crypto?.chain,
        bank: {...input.bank},
        crypto: {...input.crypto},
        user: {...input.user}
      }
    });

    return {
      success: true,
      msg: 'Beneficiary created successfully',
      beneficiary,
      isExisting: false
    };
  } catch (error: any) {
    console.error('Error creating beneficiary:', error);
    return {
      success: false,
      msg: error.message || 'Failed to create beneficiary',
      beneficiary: null
    };
  }
};

// Fetch Beneficiaries
export const fetchBeneficiaries = async (input: FetchBeneficiariesInput) => {
  try {
    // Validate userId
    if (!input.userId || input.userId.trim().length < 1) {
      return {
        success: false,
        msg: 'User ID is required',
        beneficiaries: []
      };
    }

    // Validate ISO if provided
    if (!input.ISO) {
      return {
        success: false,
        msg: 'Invalid ISO currency code',
        beneficiaries: []
      };
    }

    // Validate type if provided
    if (input.type && !Object.values(beneficiaryType).includes(input.type)) {
      return {
        success: false,
        msg: 'Invalid beneficiary type (must be BANK, CRYPTO, or USER)',
        beneficiaries: []
      };
    }

    // Build query
    const where: any = {
      userId: input.userId
    };

    if (input.ISO) {
      where.ISO = input.ISO;
    }

    if (input.type) {
      where.type = input.type;
    }

    if (input.chain) {
      where.chain = input.chain;
    }

    // Fetch beneficiaries
    const beneficiaries = await prisma.beneficiary.findMany({
      where,
      orderBy: {
        createdAt: 'desc'
      },
      include: {
        userData: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            photoUrl: true
          }
        }
      }
    });

    return {
      success: true,
      msg: 'Beneficiaries fetched successfully',
      beneficiaries,
      count: beneficiaries.length
    };
  } catch (error: any) {
    console.error('Error fetching beneficiaries:', error);
    return {
      success: false,
      msg: error.message || 'Failed to fetch beneficiaries',
      beneficiaries: []
    };
  }
};

// Fetch Single Beneficiary by ID
export const fetchBeneficiaryById = async (id: string, userId: string) => {
  try {
    if (!id || !userId) {
      return {
        success: false,
        msg: 'Beneficiary ID and User ID are required',
        beneficiary: null
      };
    }

    const beneficiary = await prisma.beneficiary.findFirst({
      where: {
        id,
        userId // Ensure the beneficiary belongs to the requesting user
      },
      include: {
        userData: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            photoUrl: true
          }
        }
      }
    });

    if (!beneficiary) {
      return {
        success: false,
        msg: 'Beneficiary not found',
        beneficiary: null
      };
    }

    return {
      success: true,
      msg: 'Beneficiary fetched successfully',
      beneficiary
    };
  } catch (error: any) {
    console.error('Error fetching beneficiary:', error);
    return {
      success: false,
      msg: error.message || 'Failed to fetch beneficiary',
      beneficiary: null
    };
  }
};

// Delete Beneficiary
export const deleteBeneficiary = async (id: string, userId: string) => {
  try {
    if (!id || !userId) {
      return {
        success: false,
        msg: 'Beneficiary ID and User ID are required'
      };
    }

    // Check if beneficiary exists and belongs to user
    const beneficiary = await prisma.beneficiary.findFirst({
      where: {
        id,
        userId
      }
    });

    if (!beneficiary) {
      return {
        success: false,
        msg: 'Beneficiary not found or does not belong to user'
      };
    }

    await prisma.beneficiary.delete({
      where: { id }
    });

    return {
      success: true,
      msg: 'Beneficiary deleted successfully'
    };
  } catch (error: any) {
    console.error('Error deleting beneficiary:', error);
    return {
      success: false,
      msg: error.message || 'Failed to delete beneficiary'
    };
  }
};

// Export types
export type {
  CreateBeneficiaryInput,
  FetchBeneficiariesInput,
  BankDetails,
  CryptoDetails,
  UserDetails
};

export { BeneficiaryType };