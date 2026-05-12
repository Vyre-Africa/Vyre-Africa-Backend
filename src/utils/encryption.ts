// src/utils/encryption.ts
import crypto from 'crypto';

const ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY!;
const ALGORITHM = 'aes-256-gcm';

// AES-256 needs 32 bytes — validate byte length not string length
if (!ENCRYPTION_KEY) {
    throw new Error('WALLET_ENCRYPTION_KEY is required');
}

const KEY_BUFFER = Buffer.from(ENCRYPTION_KEY, 'utf8');

if (KEY_BUFFER.length !== 32) {
    throw new Error(`WALLET_ENCRYPTION_KEY must be exactly 32 bytes, got ${KEY_BUFFER.length}`);
}

export function encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, KEY_BUFFER, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decrypt(encryptedText: string): string {
    const [ivHex, authTagHex, encrypted] = encryptedText.split(':');

    const iv      = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, KEY_BUFFER, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}