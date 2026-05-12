// src/utils/encryption.ts
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
    const key = process.env.WALLET_ENCRYPTION_KEY;
    if (!key) throw new Error('WALLET_ENCRYPTION_KEY is required');
    const buffer = Buffer.from(key, 'utf8');
    if (buffer.length !== 32) {
        throw new Error(`WALLET_ENCRYPTION_KEY must be exactly 32 bytes, got ${buffer.length}`);
    }
    return buffer;
}

export function encrypt(text: string): string {
    const KEY_BUFFER = getKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, KEY_BUFFER, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decrypt(encryptedText: string): string {
    const KEY_BUFFER = getKey();
    const [ivHex, authTagHex, encrypted] = encryptedText.split(':');

    const iv      = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, KEY_BUFFER, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}