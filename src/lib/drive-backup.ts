import 'server-only';
import { createHash, createSign } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { billSheets } from '@/lib/bill-sheets';
import { getInvoice } from '@/lib/data';
import { buildDocuments } from '@/lib/print-documents';
import type { InvoiceDocument } from '@/lib/schemas/invoices';
import { sheetsToPdf } from '@/lib/sheet-pdf';

export { createZipArchive, type ZipEntryInput } from '@/lib/zip';

export type VaultCategory =
  | 'Tax_Invoices'
  | 'Delivery_Challans'
  | 'Job_Work_Bills'
  | 'Delivery_Proofs';

interface VaultLocation {
  rootFolderId: string;
  sharedDriveId?: string;
}

/** A Google Workspace robot. It owns no storage, so the vault must be in a Shared Drive. */
export interface ServiceAccountCredentials extends VaultLocation {
  clientEmail: string;
  privateKey: string;
}

/** A person's own Google account (plain Gmail works): files count against their storage. */
export interface OAuthCredentials extends VaultLocation {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export type DriveCredentials = ServiceAccountCredentials | OAuthCredentials;

export interface DriveUploadResult {
  fileId: string;
  fileName: string;
  folderId: string;
  folderPath: string;
  webViewLink: string;
  alreadyExisted: boolean;
}

export interface InvoiceArchiveResult {
  invoiceId: string;
  invoiceNo: string;
  synced: boolean;
  driveSyncPending: boolean;
  invoicePdf: DriveUploadResult | null;
  dcPdf: DriveUploadResult | null;
  error?: string;
}

export const MAX_DELIVERY_PROOF_BYTES = 200 * 1024; // 200 KB strict limit
const ALLOWED_PROOF_MIMES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

const folderIdPattern = /^[A-Za-z0-9_-]{8,128}$/;

const serviceAccountJsonSchema = z.object({
  client_email: z.email(),
  private_key: z.string().min(32),
});

const driveFileListSchema = z.object({
  files: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      webViewLink: z.string().optional(),
      parents: z.array(z.string()).optional(),
    }),
  ),
});

const driveFileSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  webViewLink: z.string().optional(),
  parents: z.array(z.string()).optional(),
});

// In-memory cache of resolved vault subfolder IDs and OAuth access token
const folderCache = new Map<string, string>();
const knownVaultFolderIds = new Set<string>();
let cachedToken: { token: string; expiresAt: number; identity: string } | null = null;

export function clearDriveCache(): void {
  folderCache.clear();
  knownVaultFolderIds.clear();
  cachedToken = null;
}

const OAUTH_VARS = ['GOOGLE_DRIVE_OAUTH_CLIENT_ID', 'GOOGLE_DRIVE_OAUTH_CLIENT_SECRET', 'GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN'] as const;

/** Is Drive set up at all? Billing works without it; archives then wait. */
export function isDriveConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim()) return false;
  return (
    OAUTH_VARS.every((name) => env[name]?.trim()) ||
    Boolean(env.GOOGLE_DRIVE_CLIENT_EMAIL?.trim() && env.GOOGLE_DRIVE_PRIVATE_KEY?.trim()) ||
    Boolean(env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON?.trim())
  );
}

/**
 * Loads and validates server-only Google Drive credentials scoped strictly to
 * GOOGLE_DRIVE_ROOT_FOLDER_ID (Company_Billing_Vault).
 * GOOGLE_DRIVE_OAUTH_* (a person's account, from scripts/drive-connect.ts) wins when set.
 * Otherwise supports both GOOGLE_DRIVE_CLIENT_EMAIL + GOOGLE_DRIVE_PRIVATE_KEY and
 * GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON from specs/golive-runbook.md.
 */
export function getDriveCredentials(env: NodeJS.ProcessEnv = process.env): DriveCredentials {
  const rootFolderId = env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim() ?? '';
  if (!folderIdPattern.test(rootFolderId)) {
    throw new Error('GOOGLE_DRIVE_ROOT_FOLDER_ID is missing or malformed.');
  }

  const sharedDriveId = env.GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim() || undefined;
  const location: VaultLocation = { rootFolderId, ...(sharedDriveId ? { sharedDriveId } : {}) };

  const [clientId, clientSecret, refreshToken] = OAUTH_VARS.map((name) => env[name]?.trim() ?? '');
  if (clientId || clientSecret || refreshToken) {
    // Half a setup must not quietly fall back to another account's Drive.
    const missing = OAUTH_VARS.filter((name) => !env[name]?.trim());
    if (!clientId || !clientSecret || !refreshToken) throw new Error(`Google Drive sign-in is incomplete: ${missing.join(', ')} missing.`);
    knownVaultFolderIds.add(rootFolderId);
    return { ...location, clientId, clientSecret, refreshToken };
  }

  let clientEmail = env.GOOGLE_DRIVE_CLIENT_EMAIL?.trim() ?? '';
  let privateKey = env.GOOGLE_DRIVE_PRIVATE_KEY?.trim() ?? '';

  if ((!clientEmail || !privateKey) && env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON?.trim()) {
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON);
    } catch {
      throw new Error('GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON is not valid JSON.');
    }
    const parsed = serviceAccountJsonSchema.safeParse(rawJson);
    if (!parsed.success) {
      throw new Error('GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON is missing client_email or private_key.');
    }
    clientEmail = parsed.data.client_email.trim();
    privateKey = parsed.data.private_key.trim();
  }

  if (!clientEmail || !z.email().safeParse(clientEmail).success) {
    throw new Error('GOOGLE_DRIVE_CLIENT_EMAIL is missing or invalid.');
  }
  const normalizedKey = privateKey.replace(/\\n/g, '\n');
  if (!normalizedKey.includes('PRIVATE KEY-----')) {
    throw new Error('GOOGLE_DRIVE_PRIVATE_KEY must be a valid PEM private key.');
  }

  knownVaultFolderIds.add(rootFolderId);

  return { ...location, clientEmail, privateKey: normalizedKey };
}

/**
 * Ensures any target parent folder is either GOOGLE_DRIVE_ROOT_FOLDER_ID or a subfolder
 * resolved/created underneath it. Prevents writing anywhere outside Company_Billing_Vault.
 */
function assertInsideVault(folderId: string, rootFolderId: string): void {
  if (folderId !== rootFolderId && !knownVaultFolderIds.has(folderId)) {
    throw new Error(`Refusing Google Drive access outside Company_Billing_Vault (${rootFolderId}).`);
  }
}

/**
 * Computes the Indian Financial Year folder name (`FY_YYYY-YY`) and Year-Month folder (`YYYY-MM`)
 * from an IST calendar date (`YYYY-MM-DD`).
 * Example: '2026-11-24' -> { fyFolder: 'FY_2026-27', monthFolder: '2026-11' }
 * Example: '2027-03-15' -> { fyFolder: 'FY_2026-27', monthFolder: '2027-03' }
 */
export function getVaultPeriodFolders(isoDate: string): { fyFolder: string; monthFolder: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!match) {
    throw new Error(`Invalid ISO date for Drive vault routing: ${isoDate}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error(`Invalid month in ISO date: ${isoDate}`);
  }
  const startYear = month >= 4 ? year : year - 1;
  const endYy = String((startYear + 1) % 100).padStart(2, '0');
  return {
    fyFolder: `FY_${startYear}-${endYy}`,
    monthFolder: `${year}-${String(month).padStart(2, '0')}`,
  };
}

/**
 * Sanitizes a customer name for deterministic PDF filenames:
 * strips unsafe punctuation, collapses whitespace into single underscores, caps length at 60 chars.
 */
export function sanitizeCustomerName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
    .replace(/_+$/g, '');
  return cleaned || 'Customer';
}

/**
 * Builds the deterministic filename `{INVOICE_OR_DC_NO}_{SANITIZED_CUSTOMER_NAME}.pdf`.
 * E.g. ('INV/26-27/0001', 'Vellaru Pump Castings Pvt Ltd') -> 'INV_26-27_0001_Vellaru_Pump_Castings_Pvt_Ltd.pdf'
 */
export function buildDeterministicPdfName(documentNo: string, customerName: string): string {
  const safeDocNo = documentNo
    .trim()
    .replace(/[\/\\]+/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '');
  if (!safeDocNo) {
    throw new Error('Document number is required for deterministic Drive filename.');
  }
  return `${safeDocNo}_${sanitizeCustomerName(customerName)}.pdf`;
}

/**
 * Builds deterministic filename for a delivery proof upload inside Delivery_Proofs/.
 */
export function buildDeliveryProofFileName(dcNo: string, customerName: string, mimeType: string): string {
  const ext = ALLOWED_PROOF_MIMES[mimeType.toLowerCase()];
  if (!ext) {
    throw new Error(`Unsupported delivery proof MIME type: ${mimeType}`);
  }
  const safeDcNo = dcNo.trim().replace(/[\/\\]+/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
  return `${safeDcNo}_${sanitizeCustomerName(customerName)}_PROOF.${ext}`;
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** The service account's signed request for a token, or the person's stored permission. */
function tokenRequest(creds: DriveCredentials, nowMs: number): Record<string, string> {
  if ('refreshToken' in creds) {
    return {
      grant_type: 'refresh_token',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
    };
  }
  const iat = Math.floor(nowMs / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claimSet = base64Url(
    JSON.stringify({ iss: creds.clientEmail, scope: DRIVE_SCOPE, aud: OAUTH_TOKEN_URL, iat, exp: iat + 3600 }),
  );
  const unsignedJwt = `${header}.${claimSet}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsignedJwt);
  signer.end();
  return {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${unsignedJwt}.${signer.sign(creds.privateKey, 'base64url')}`,
  };
}

/** Whose token is cached. Never the secret itself. */
const identityOf = (creds: DriveCredentials): string =>
  'refreshToken' in creds
    ? `oauth:${creds.clientId}:${createHash('sha256').update(creds.refreshToken).digest('hex')}`
    : `service:${creds.clientEmail}`;

/**
 * Exchanges the credentials for a short-lived Google Drive OAuth2 access token.
 */
export async function getDriveAccessToken(
  creds: DriveCredentials,
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<string> {
  const identity = identityOf(creds);
  if (cachedToken && cachedToken.identity === identity && cachedToken.expiresAt - 60_000 > nowMs) {
    return cachedToken.token;
  }

  const response = await fetchImpl(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(tokenRequest(creds, nowMs)).toString(),
  });

  if (!response.ok) {
    if ('refreshToken' in creds && response.status === 400) {
      throw new Error('Google Drive permission has expired or was removed. Run scripts/drive-connect.ts again.');
    }
    throw new Error(`Google OAuth token exchange failed with HTTP ${response.status}`);
  }

  const parsed = z
    .object({ access_token: z.string().min(1), expires_in: z.number().positive().default(3600) })
    .parse(await response.json());

  cachedToken = {
    token: parsed.access_token,
    expiresAt: nowMs + parsed.expires_in * 1000,
    identity,
  };
  return parsed.access_token;
}

function escapeDriveQueryValue(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Finds or creates a single child folder inside `parentId` (strictly inside Company_Billing_Vault).
 */
async function ensureChildFolder(
  name: string,
  parentId: string,
  creds: DriveCredentials,
  token: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  assertInsideVault(parentId, creds.rootFolderId);
  const cacheKey = `${creds.rootFolderId}:${parentId}/${name}`;
  const hit = folderCache.get(cacheKey);
  if (hit) return hit;

  const q = `mimeType = '${FOLDER_MIME}' and name = '${escapeDriveQueryValue(name)}' and '${escapeDriveQueryValue(parentId)}' in parents and trashed = false`;
  const params = new URLSearchParams({
    q,
    fields: 'files(id,name,parents)',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    pageSize: '1',
  });
  if (creds.sharedDriveId) {
    params.set('corpora', 'drive');
    params.set('driveId', creds.sharedDriveId);
  }

  const listRes = await fetchImpl(`${DRIVE_API}?${params.toString()}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!listRes.ok) {
    throw new Error(`Google Drive folder lookup (${name}) failed with HTTP ${listRes.status}`);
  }
  const existing = driveFileListSchema.parse(await listRes.json()).files[0];
  if (existing) {
    knownVaultFolderIds.add(existing.id);
    folderCache.set(cacheKey, existing.id);
    return existing.id;
  }

  const createRes = await fetchImpl(`${DRIVE_API}?supportsAllDrives=true&fields=id,name,parents`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId],
    }),
  });
  if (!createRes.ok) {
    throw new Error(`Google Drive folder creation (${name}) failed with HTTP ${createRes.status}`);
  }
  const created = driveFileSchema.parse(await createRes.json());
  knownVaultFolderIds.add(created.id);
  folderCache.set(cacheKey, created.id);
  return created.id;
}

/**
 * Resolves a multi-segment folder chain under `GOOGLE_DRIVE_ROOT_FOLDER_ID`.
 * Allowed patterns:
 * - `['FY_YYYY-YY', 'YYYY-MM', 'Tax_Invoices' | 'Delivery_Challans' | 'Job_Work_Bills' | 'Delivery_Proofs']`
 * - `['DB_Backups']`
 */
export async function ensureVaultFolderPath(
  segments: readonly string[],
  creds: DriveCredentials,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ folderId: string; folderPath: string }> {
  knownVaultFolderIds.add(creds.rootFolderId);
  let currentParentId = creds.rootFolderId;

  for (const segment of segments) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(segment)) {
      throw new Error(`Invalid Drive vault folder segment: ${segment}`);
    }
    currentParentId = await ensureChildFolder(segment, currentParentId, creds, token, fetchImpl);
  }

  return {
    folderId: currentParentId,
    folderPath: segments.join('/'),
  };
}

/**
 * Checks whether a finalized file with the exact `fileName` already exists in `folderId`.
 * Prevents silent overwriting or duplicate copies on retry.
 */
async function findExistingFileInFolder(
  fileName: string,
  folderId: string,
  creds: DriveCredentials,
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ id: string; name: string; webViewLink: string } | null> {
  assertInsideVault(folderId, creds.rootFolderId);
  const q = `name = '${escapeDriveQueryValue(fileName)}' and '${escapeDriveQueryValue(folderId)}' in parents and trashed = false`;
  const params = new URLSearchParams({
    q,
    fields: 'files(id,name,webViewLink,parents)',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    pageSize: '1',
  });
  if (creds.sharedDriveId) {
    params.set('corpora', 'drive');
    params.set('driveId', creds.sharedDriveId);
  }

  const res = await fetchImpl(`${DRIVE_API}?${params.toString()}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Google Drive existing-file check failed with HTTP ${res.status}`);
  }
  const found = driveFileListSchema.parse(await res.json()).files[0];
  if (!found) return null;
  return {
    id: found.id,
    name: found.name,
    webViewLink: found.webViewLink ?? `https://drive.google.com/file/d/${found.id}/view`,
  };
}

/**
 * Uploads a file via multipart/related to a resolved folder strictly inside Company_Billing_Vault.
 * When `preventOverwrite = true` (default for finalized invoices/DCs), returns the existing file
 * if one with the same deterministic name is already present.
 */
export async function uploadFileToVaultFolder(params: {
  folderSegments: readonly string[];
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  preventOverwrite?: boolean;
  creds?: DriveCredentials;
  fetchImpl?: typeof fetch;
}): Promise<DriveUploadResult> {
  const {
    folderSegments,
    fileName,
    mimeType,
    bytes,
    preventOverwrite = true,
    creds = getDriveCredentials(),
    fetchImpl = fetch,
  } = params;

  const token = await getDriveAccessToken(creds, fetchImpl);
  const { folderId, folderPath } = await ensureVaultFolderPath(folderSegments, creds, token, fetchImpl);
  assertInsideVault(folderId, creds.rootFolderId);

  if (preventOverwrite) {
    const existing = await findExistingFileInFolder(fileName, folderId, creds, token, fetchImpl);
    if (existing) {
      return {
        fileId: existing.id,
        fileName: existing.name,
        folderId,
        folderPath,
        webViewLink: existing.webViewLink,
        alreadyExisted: true,
      };
    }
  }

  const boundary = `studflow_vault_${createHash('sha256').update(fileName).digest('hex').slice(0, 16)}`;
  const metadataPart = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({
      name: fileName,
      parents: [folderId],
    })}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    'utf8',
  );
  const closingPart = Buffer.from(`\r\n--${boundary}--`, 'utf8');
  const multipartBody = Buffer.concat([metadataPart, Buffer.from(bytes), closingPart]);

  const uploadUrl = `${DRIVE_UPLOAD_API}?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,parents`;
  const res = await fetchImpl(uploadUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });

  if (!res.ok) {
    throw new Error(`Google Drive multipart upload (${fileName}) failed with HTTP ${res.status}`);
  }

  const uploaded = driveFileSchema.parse(await res.json());
  const webViewLink = uploaded.webViewLink ?? `https://drive.google.com/file/d/${uploaded.id}/view`;

  return {
    fileId: uploaded.id,
    fileName: uploaded.name,
    folderId,
    folderPath,
    webViewLink,
    alreadyExisted: false,
  };
}

// =============================================================================
// Invoice & Delivery Challan Non-Blocking Archival + Retry Pass
// =============================================================================

/**
 * Generates and uploads the finalized Invoice PDF (into `Tax_Invoices` or `Job_Work_Bills`)
 * and linked Delivery Challan PDF (into `Delivery_Challans`) under
 * `Company_Billing_Vault/FY_YYYY-YY/YYYY-MM/`.
 *
 * Non-blocking design: if Google Drive fails or is unreachable, marks `drive_sync_pending = true`
 * on `public.invoices` and returns `{ synced: false, driveSyncPending: true }` without throwing.
 */
export async function archiveInvoiceDocumentToDrive(
  db: SupabaseClient,
  doc: InvoiceDocument,
  options: { creds?: DriveCredentials; fetchImpl?: typeof fetch } = {},
): Promise<InvoiceArchiveResult> {
  const { invoice, delivery } = doc;
  try {
    const creds = options.creds ?? getDriveCredentials();
    const fetchImpl = options.fetchImpl ?? fetch;
    const { fyFolder, monthFolder } = getVaultPeriodFolders(invoice.invoice_date);
    const invoiceCategory: VaultCategory =
      invoice.bill_type === 'job_work' ? 'Job_Work_Bills' : 'Tax_Invoices';

    const invoicePrintDocs = buildDocuments(doc, { documents: 'invoice', copies: 'original' });
    const invoicePdfBytes = sheetsToPdf(billSheets(invoicePrintDocs), invoice.invoice_no);
    const invoiceFileName = buildDeterministicPdfName(invoice.invoice_no, invoice.customer_snapshot.name);

    const invoiceUpload = await uploadFileToVaultFolder({
      folderSegments: [fyFolder, monthFolder, invoiceCategory],
      fileName: invoiceFileName,
      mimeType: 'application/pdf',
      bytes: invoicePdfBytes,
      preventOverwrite: true,
      creds,
      fetchImpl,
    });

    let dcUpload: DriveUploadResult | null = null;
    if (delivery) {
      const dcPrintDocs = buildDocuments(doc, { documents: 'dc', copies: 'original' });
      if (dcPrintDocs.length > 0) {
        const dcPeriod = getVaultPeriodFolders(delivery.dc_date);
        const dcPdfBytes = sheetsToPdf(billSheets(dcPrintDocs), delivery.dc_no);
        const dcFileName = buildDeterministicPdfName(delivery.dc_no, invoice.customer_snapshot.name);
        dcUpload = await uploadFileToVaultFolder({
          folderSegments: [dcPeriod.fyFolder, dcPeriod.monthFolder, 'Delivery_Challans'],
          fileName: dcFileName,
          mimeType: 'application/pdf',
          bytes: dcPdfBytes,
          preventOverwrite: true,
          creds,
          fetchImpl,
        });
      }
    }

    const { error: updateError } = await db
      .from('invoices')
      .update({
        pdf_drive_url: invoiceUpload.webViewLink,
        drive_file_id: invoiceUpload.fileId,
        dc_drive_url: dcUpload?.webViewLink ?? null,
        dc_drive_file_id: dcUpload?.fileId ?? null,
        drive_sync_pending: false,
      })
      .eq('id', invoice.id);

    if (updateError) {
      throw new Error(`Failed to save Drive archive link on invoice ${invoice.invoice_no}`);
    }

    return {
      invoiceId: invoice.id,
      invoiceNo: invoice.invoice_no,
      synced: true,
      driveSyncPending: false,
      invoicePdf: invoiceUpload,
      dcPdf: dcUpload,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Drive archive failed';
    await db
      .from('invoices')
      .update({ drive_sync_pending: true })
      .eq('id', invoice.id)
      .then(
        () => undefined,
        () => undefined,
      );

    return {
      invoiceId: invoice.id,
      invoiceNo: invoice.invoice_no,
      synced: false,
      driveSyncPending: true,
      invoicePdf: null,
      dcPdf: null,
      error: message,
    };
  }
}

/**
 * Loads an invoice by ID and archives its PDF + linked DC PDF to Google Drive.
 */
export async function archiveInvoiceById(
  db: SupabaseClient,
  invoiceId: string,
  options: { creds?: DriveCredentials; fetchImpl?: typeof fetch } = {},
): Promise<InvoiceArchiveResult> {
  const doc = await getInvoice(db, invoiceId);
  return archiveInvoiceDocumentToDrive(db, doc, options);
}

/**
 * Non-blocking fire-and-forget archive hook invoked after `sync_invoice` succeeds.
 * Never throws and never delays invoice issuance. If Drive env vars are absent or
 * Drive is temporarily unreachable, `drive_sync_pending` stays `true` for the retry pass.
 */
export function triggerInvoiceArchiveAsync(
  db: SupabaseClient,
  invoiceId: string,
  options: { creds?: DriveCredentials; fetchImpl?: typeof fetch } = {},
): Promise<InvoiceArchiveResult | null> {
  if (!options.creds && !isDriveConfigured()) {
    return Promise.resolve(null);
  }

  return archiveInvoiceById(db, invoiceId, options).catch(() => null);
}

/**
 * Retries all non-cancelled invoices where `drive_sync_pending = true` (or `pdf_drive_url is null`).
 */
export async function retryPendingDriveArchives(
  db: SupabaseClient,
  options: { limit?: number; creds?: DriveCredentials; fetchImpl?: typeof fetch } = {},
): Promise<{ attempted: number; succeeded: number; pending: number; results: InvoiceArchiveResult[] }> {
  const limit = options.limit ?? 25;
  const { data, error } = await db
    .from('invoices')
    .select('id')
    .eq('drive_sync_pending', true)
    .is('cancelled_at', null)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error('Could not query pending Drive archives.');
  }

  const rows = z.array(z.object({ id: z.uuid() })).parse(data ?? []);
  const results: InvoiceArchiveResult[] = [];
  let succeeded = 0;

  for (const row of rows) {
    const res = await archiveInvoiceById(db, row.id, options);
    results.push(res);
    if (res.synced) succeeded += 1;
  }

  return {
    attempted: rows.length,
    succeeded,
    pending: rows.length - succeeded,
    results,
  };
}

// =============================================================================
// Compressed Delivery Proof Photo Upload (< 200 KB) into Delivery_Proofs/
// =============================================================================

export async function uploadDeliveryProofToDrive(params: {
  db: SupabaseClient;
  deliveryId: string;
  mimeType: string;
  bytes: Uint8Array;
  creds?: DriveCredentials;
  fetchImpl?: typeof fetch;
}): Promise<DriveUploadResult> {
  const { db, deliveryId, mimeType, bytes, creds, fetchImpl } = params;

  if (bytes.byteLength === 0) {
    throw new Error('Delivery proof file is empty.');
  }
  if (bytes.byteLength > MAX_DELIVERY_PROOF_BYTES) {
    throw new Error(
      `Delivery proof exceeds 200 KB limit (${bytes.byteLength} bytes > ${MAX_DELIVERY_PROOF_BYTES} bytes). Compress the photo first.`,
    );
  }
  const normalizedMime = mimeType.trim().toLowerCase();
  if (!(normalizedMime in ALLOWED_PROOF_MIMES)) {
    throw new Error('Delivery proof must be a compressed JPEG, PNG, WebP photo or PDF.');
  }

  const { data: deliveryRows, error: delErr } = await db
    .from('deliveries')
    .select('id,invoice_id,dc_no,dc_date')
    .eq('id', deliveryId)
    .limit(1);
  if (delErr) throw delErr;
  const delivery = z
    .array(z.object({ id: z.uuid(), invoice_id: z.uuid(), dc_no: z.string(), dc_date: z.string() }))
    .parse(deliveryRows ?? [])[0];
  if (!delivery) {
    throw new Error('Delivery challan not found.');
  }

  const { data: invRows, error: invErr } = await db
    .from('invoices')
    .select('customer_snapshot')
    .eq('id', delivery.invoice_id)
    .limit(1);
  if (invErr) throw invErr;
  const customerName =
    z
      .array(z.object({ customer_snapshot: z.looseObject({ name: z.string() }) }))
      .parse(invRows ?? [])[0]?.customer_snapshot.name ?? 'Customer';

  const { fyFolder, monthFolder } = getVaultPeriodFolders(delivery.dc_date);
  const fileName = buildDeliveryProofFileName(delivery.dc_no, customerName, normalizedMime);

  const uploaded = await uploadFileToVaultFolder({
    folderSegments: [fyFolder, monthFolder, 'Delivery_Proofs'],
    fileName,
    mimeType: normalizedMime,
    bytes,
    preventOverwrite: false,
    ...(creds ? { creds } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  const { error: updErr } = await db
    .from('deliveries')
    .update({
      proof_drive_url: uploaded.webViewLink,
      proof_drive_file_id: uploaded.fileId,
    })
    .eq('id', deliveryId);
  if (updErr) throw updErr;

  return uploaded;
}

// =============================================================================
// Weekly Full-Database JSON + CSV ZIP Disaster Backup + Telegram Confirmation
// =============================================================================

/**
 * Serializes an array of table rows into RFC-4180 CSV format.
 */
export function rowsToCsv(rows: readonly Record<string, unknown>[], fallbackColumns: readonly string[] = []): string {
  const colSet = new Set<string>(fallbackColumns);
  for (const row of rows) {
    for (const key of Object.keys(row)) colSet.add(key);
  }
  const columns = [...colSet];
  if (columns.length === 0) return '';

  const escapeCell = (val: unknown): string => {
    if (val === null || val === undefined) return '';
    const raw = typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (/[",\r\n]/.test(raw)) {
      return `"${raw.replace(/"/g, '""')}"`;
    }
    return raw;
  };

  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((col) => escapeCell(row[col])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * Sends a 1-line Telegram confirmation after the weekly DB backup completes.
 * Gracefully skips if TELEGRAM_BOT_TOKEN or recipient chat ID is not configured yet.
 */
export async function sendTelegramBackupConfirmation(params: {
  text: string;
  chatIdOverride?: string | null;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<{ sent: boolean; skippedReason?: string }> {
  const env = params.env ?? process.env;
  const fetchImpl = params.fetchImpl ?? fetch;
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId =
    params.chatIdOverride?.trim() ||
    env.TELEGRAM_OWNER_CHAT_ID?.trim() ||
    env.TELEGRAM_DEFAULT_CHAT_ID?.trim() ||
    env.TELEGRAM_CHAT_ID?.trim();

  if (!botToken || !chatId) {
    return { sent: false, skippedReason: 'Telegram credentials not configured' };
  }

  const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: params.text,
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    throw new Error(`Telegram sendMessage failed with HTTP ${res.status}`);
  }
  return { sent: true };
}
