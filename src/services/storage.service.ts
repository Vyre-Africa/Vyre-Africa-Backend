import { Storage } from '@google-cloud/storage';
import config from '../config/env.config';
import logger from '../config/logger';
import fs from 'fs';

// ── Credential strategy ──────────────────────────────────────────────────
//
// LOCAL DEV: if GOOGLE_APPLICATION_CREDENTIALS points at a real downloaded
// key file, use it explicitly. getSignedUrl needs direct access to
// client_email/private_key for LOCAL signing, and ADC auto-detection
// doesn't reliably surface those fields to that specific method (confirmed
// live during testing — regular calls like upload() worked fine via plain
// ADC, but getSignedUrl failed with "Cannot sign data without client_email"
// until the key file's fields were read and passed in explicitly).
//
// PRODUCTION (GCE): deliberately does NOT use a key file. The deployed
// server authenticates via its attached service account through the
// metadata server, which never exposes a raw private key (a real GCP
// security boundary, not a workaround to route around). Signed URLs in
// this mode are generated via Google's IAM signBlob API instead of local
// signing — the @google-cloud/storage library does this automatically
// once the service account has been granted
// roles/iam.serviceAccountTokenCreator ON ITSELF. No key file, no
// long-lived secret sitting on the instance.
//
// This means: DO NOT set GOOGLE_APPLICATION_CREDENTIALS in production.
// Its presence is what triggers the local-key-file path below — leaving
// it unset is what makes IAM-based signing kick in instead.

const keyFilePath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

const storageOptions: ConstructorParameters<typeof Storage>[0] = {
    projectId: config.GCP_PROJECT_ID,
};

if (keyFilePath && fs.existsSync(keyFilePath)) {
    logger.info('Storage: using explicit local key file credentials (dev mode)');
    const keyFile = JSON.parse(fs.readFileSync(keyFilePath, 'utf8'));
    storageOptions.credentials = {
        client_email: keyFile.client_email,
        private_key: keyFile.private_key,
    };
    storageOptions.projectId = keyFile.project_id ?? config.GCP_PROJECT_ID;
} else {
    logger.info('Storage: using default application credentials (production/GCE mode — IAM-based signing)');
}

const storage = new Storage(storageOptions);

const KYC_BUCKET_NAME = config.KYC_DOCUMENTS_BUCKET ?? 'vyre-kyc-documents';
const bucket = storage.bucket(KYC_BUCKET_NAME);

export interface UploadResult {
    url: string;
    objectPath: string;
}

// ─── Upload ──────────────────────────────────────────────────────────────

export async function uploadToStorage(
    buffer: Buffer,
    objectPath: string
): Promise<UploadResult> {
    try {
        const file = bucket.file(objectPath);

        await file.save(buffer, {
            resumable: false,
            metadata: {
                contentType: inferContentType(objectPath),
            },
        });

        logger.info('Uploaded to GCS', { bucket: KYC_BUCKET_NAME, objectPath });

        return {
            url: `gs://${KYC_BUCKET_NAME}/${objectPath}`,
            objectPath,
        };
    } catch (error: any) {
        logger.error('GCS upload failed', { objectPath, error: error.message });
        throw new Error(`Failed to upload ${objectPath}: ${error.message}`);
    }
}

// ─── Generate a short-lived signed URL for viewing ─────────────────────────
//
// LOCAL: signs using the explicit client_email/private_key from the key
// file above.
//
// PRODUCTION: signs via IAM's signBlob API using the service account's own
// identity — requires roles/iam.serviceAccountTokenCreator granted to the
// service account on itself. If that grant is missing, this will fail
// with a permissions error (not "Cannot sign data without client_email" —
// a different, more specific IAM permission error) — if you see that in
// production logs, the IAM binding step wasn't applied or didn't
// propagate yet (IAM changes can take a minute or two to take effect).

export async function getSignedDownloadUrl(
    objectPath: string,
    expiresInMinutes: number = 15
): Promise<string> {
    try {
        const file = bucket.file(objectPath);

        const [url] = await file.getSignedUrl({
            action: 'read',
            expires: Date.now() + expiresInMinutes * 60 * 1000,
            version: 'v4',
        });

        return url;
    } catch (error: any) {
        logger.error('Failed to generate signed URL', { objectPath, error: error.message });
        throw new Error(`Failed to generate signed URL for ${objectPath}: ${error.message}`);
    }
}

// ─── Delete ──────────────────────────────────────────────────────────────

export async function deleteFromStorage(objectPath: string): Promise<void> {
    try {
        await bucket.file(objectPath).delete();
        logger.info('Deleted from GCS', { bucket: KYC_BUCKET_NAME, objectPath });
    } catch (error: any) {
        logger.error('GCS delete failed', { objectPath, error: error.message });
        throw new Error(`Failed to delete ${objectPath}: ${error.message}`);
    }
}

function inferContentType(objectPath: string): string {
    if (objectPath.endsWith('.png')) return 'image/png';
    if (objectPath.endsWith('.jpg') || objectPath.endsWith('.jpeg')) return 'image/jpeg';
    if (objectPath.endsWith('.pdf')) return 'application/pdf';
    return 'application/octet-stream';
}