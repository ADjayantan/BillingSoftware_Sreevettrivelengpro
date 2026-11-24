import 'server-only';
import { createHash, createSign } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getInvoice } from '@/lib/data';
import { buildDocuments, type PrintDocument } from '@/lib/print-documents';
import type { InvoiceDocument } from '@/lib/schemas/invoices';

export type VaultCategory =
  | 'Tax_Invoices'
  | 'Delivery_Challans'
  | 'Job_Work_Bills'
  | 'Delivery_Proofs';

export interface DriveCredentials {
  clientEmail: string;
  privateKey: string;
  rootFolderId: string;
  sharedDriveId?: string;
}

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
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
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
let cachedToken: { token: string; expiresAt: number; clientEmail: string } | null = null;

export function clearDriveCache(): void {
  folderCache.clear();
  knownVaultFolderIds.clear();
  cachedToken = null;
}

/**
 * Loads and validates server-only Google Drive credentials scoped strictly to
 * GOOGLE_DRIVE_ROOT_FOLDER_ID (Company_Billing_Vault).
 * Supports both GOOGLE_DRIVE_CLIENT_EMAIL + GOOGLE_DRIVE_PRIVATE_KEY and
 * GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON from specs/golive-runbook.md.
 */
export function getDriveCredentials(env: NodeJS.ProcessEnv = process.env): DriveCredentials {
  const rootFolderId = env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim() ?? '';
  if (!folderIdPattern.test(rootFolderId)) {
    throw new Error('GOOGLE_DRIVE_ROOT_FOLDER_ID is missing or malformed.');
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
  const sharedDriveId = env.GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim() || undefined;

  return {
    clientEmail,
    privateKey: normalizedKey,
    rootFolderId,
    ...(sharedDriveId ? { sharedDriveId } : {}),
  };
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

/**
 * Signs a service-account JWT and exchanges it for a short-lived Google Drive OAuth2 access token.
 */
export async function getDriveAccessToken(
  creds: DriveCredentials,
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<string> {
  if (
    cachedToken &&
    cachedToken.clientEmail === creds.clientEmail &&
    cachedToken.expiresAt - 60_000 > nowMs
  ) {
    return cachedToken.token;
  }

  const iat = Math.floor(nowMs / 1000);
  const exp = iat + 3600;
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claimSet = base64Url(
    JSON.stringify({
      iss: creds.clientEmail,
      scope: DRIVE_SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat,
      exp,
    }),
  );

  const unsignedJwt = `${header}.${claimSet}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsignedJwt);
  signer.end();
  const signature = signer.sign(creds.privateKey, 'base64url');
  const assertion = `${unsignedJwt}.${signature}`;

  const response = await fetchImpl(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Google OAuth token exchange failed with HTTP ${response.status}`);
  }

  const parsed = z
    .object({ access_token: z.string().min(1), expires_in: z.number().positive().default(3600) })
    .parse(await response.json());

  cachedToken = {
    token: parsed.access_token,
    expiresAt: nowMs + parsed.expires_in * 1000,
    clientEmail: creds.clientEmail,
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
// Lightweight Zero-Dependency Server-Side PDF 1.4 Generator
// =============================================================================

function pdfEscape(text: string): string {
  // Replace ₹ with Rs. and strip non-WinAnsi characters so standard PDF Type1 Helvetica renders cleanly
  const ascii = text
    .replace(/₹/g, 'Rs.')
    .replace(/·/g, '|')
    .replace(/×/g, 'x')
    .replace(/—/g, '-')
    .replace(/[^\x20-\x7E]/g, ' ');
  return ascii.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function formatDocumentLines(doc: PrintDocument): Array<{ text: string; bold?: boolean; size?: number }> {
  const lines: Array<{ text: string; bold?: boolean; size?: number }> = [];
  lines.push({ text: `${doc.title}   [${doc.copyLabel}]`, bold: true, size: 13 });
  lines.push({ text: `${doc.issuerName} | GSTIN: ${doc.issuerGstin}`, bold: true, size: 10 });
  lines.push({ text: doc.issuerAddress, size: 9 });
  lines.push({
    text: `Document No: ${doc.number}   |   Date: ${doc.issueDate}   |   ${doc.linked.map((l) => `${l.label}: ${l.value}`).join('   |   ')}`,
    bold: true,
    size: 9,
  });
  lines.push({ text: '-'.repeat(98), size: 8 });

  for (const party of doc.parties) {
    lines.push({
      text: `${party.role}: ${party.name} (${party.registration}) — ${party.stateAndCode}`,
      bold: true,
      size: 9,
    });
    if (party.address) {
      lines.push({ text: `   ${party.address}`, size: 9 });
    }
  }

  if (doc.facts.length > 0) {
    lines.push({
      text: doc.facts.map((f) => `${f.label}: ${f.value}`).join('  |  '),
      size: 9,
    });
  }
  for (const decl of doc.declarationText) {
    lines.push({ text: `NOTE: ${decl}`, bold: true, size: 9 });
  }

  lines.push({ text: '-'.repeat(98), size: 8 });
  lines.push({
    text: doc.columns.map((c) => c.label).join('   |   '),
    bold: true,
    size: 9,
  });
  lines.push({ text: '-'.repeat(98), size: 8 });

  for (const [idx, item] of doc.items.entries()) {
    const qtyText = item.quantityDetail ? `${item.quantity} (${item.quantityDetail})` : item.quantity;
    const rateText = item.thirdDetail ? `${item.third} ${item.thirdDetail}` : item.third;
    lines.push({
      text: `${idx + 1}. ${item.description} [${item.codeLabel} ${item.code}]`,
      bold: true,
      size: 9,
    });
    lines.push({
      text: `     Qty: ${qtyText}   |   Rate/Wt: ${rateText}   |   Amount: ${item.fourth || '-'}`,
      size: 9,
    });
  }

  if (doc.taxBand && doc.taxBand.rows.length > 0) {
    lines.push({ text: '-'.repeat(98), size: 8 });
    lines.push({
      text: `GST Summary: ${doc.taxBand.columns.map((c) => c.label).join(' | ')}`,
      bold: true,
      size: 9,
    });
    for (const row of doc.taxBand.rows) {
      lines.push({
        text: `   ${row.map((cell) => cell.text).join('   |   ')}`,
        size: 9,
      });
    }
  }

  lines.push({ text: '-'.repeat(98), size: 8 });
  lines.push({ text: `${doc.closingTitle} (${doc.number})`, bold: true, size: 10 });
  for (const row of doc.closingRows) {
    lines.push({ text: `   ${row.label}: ${row.value}`, size: 9 });
  }
  if (doc.total) {
    lines.push({ text: `${doc.total.label}: ${doc.total.value}`, bold: true, size: 11 });
  }
  if (doc.words) {
    lines.push({ text: `${doc.words.label} ${doc.words.value}`, bold: true, size: 9 });
  }
  lines.push({ text: '-'.repeat(98), size: 8 });
  lines.push({
    text: doc.signatures.map((s) => `${s.organisation} (${s.role})`).join('          |          '),
    size: 9,
  });

  return lines;
}

/**
 * Generates a valid, deterministic multi-page PDF 1.4 binary from one or more `PrintDocument` objects.
 * Zero external dependencies, zero headless browser RAM overhead on Vercel serverless.
 */
export function renderPrintDocumentsToPdf(documents: readonly PrintDocument[]): Uint8Array {
  if (documents.length === 0) {
    throw new Error('Cannot generate PDF with zero documents.');
  }

  const LINES_PER_PAGE = 46;
  const pageStreams: string[] = [];

  for (const doc of documents) {
    const allLines = formatDocumentLines(doc);
    for (let offset = 0; offset < allLines.length; offset += LINES_PER_PAGE) {
      const slice = allLines.slice(offset, offset + LINES_PER_PAGE);
      const cmds: string[] = ['BT'];
      let y = 800;
      for (const line of slice) {
        const font = line.bold ? '/F2' : '/F1';
        const size = line.size ?? 9;
        cmds.push(`${font} ${size} Tf`);
        cmds.push(`1 0 0 1 36 ${y} Tm (${pdfEscape(line.text)}) Tj`);
        y -= size + 7;
      }
      cmds.push('ET');
      pageStreams.push(cmds.join('\n'));
    }
  }

  // Object layout:
  // 1: Catalog, 2: Pages, 3: Font Helvetica (/F1), 4: Font Helvetica-Bold (/F2)
  // For each page i (0..N-1): pageObj = 5 + i*2, contentObj = 6 + i*2
  const objects: string[] = [];
  const pageObjIds: number[] = [];

  for (let i = 0; i < pageStreams.length; i++) {
    pageObjIds.push(5 + i * 2);
  }

  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjIds.length} >>\nendobj\n`,
  );
  objects.push('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n');
  objects.push(
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n',
  );

  for (let i = 0; i < pageStreams.length; i++) {
    const pageId = 5 + i * 2;
    const contentId = 6 + i * 2;
    const stream = pageStreams[i] ?? '';
    const streamBytes = Buffer.byteLength(stream, 'utf8');
    objects.push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`,
    );
    objects.push(
      `${contentId} 0 obj\n<< /Length ${streamBytes} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  }

  const header = '%PDF-1.4\n';
  const offsets: number[] = [0];
  let cursor = Buffer.byteLength(header, 'utf8');
  for (const obj of objects) {
    offsets.push(cursor);
    cursor += Buffer.byteLength(obj, 'utf8');
  }

  const xrefLines = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`];
  for (let i = 1; i <= objects.length; i++) {
    xrefLines.push(`${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`);
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(header + objects.join('') + xrefLines.join('') + trailer, 'utf8'));
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
    const invoicePdfBytes = renderPrintDocumentsToPdf(invoicePrintDocs);
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
        const dcPdfBytes = renderPrintDocumentsToPdf(dcPrintDocs);
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
  const hasEnv =
    Boolean(options.creds) ||
    Boolean(
      process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim() &&
        ((process.env.GOOGLE_DRIVE_CLIENT_EMAIL?.trim() && process.env.GOOGLE_DRIVE_PRIVATE_KEY?.trim()) ||
          process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON?.trim()),
    );

  if (!hasEnv) {
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

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] ?? 0;
    crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInput {
  name: string;
  content: string | Uint8Array;
}

/**
 * Builds a standards-compliant PKZIP archive (DEFLATE method 8) in pure Node.js (`node:zlib`)
 * with zero third-party ZIP packages.
 */
export function createZipArchive(entries: readonly ZipEntryInput[]): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const rawBuf =
      typeof entry.content === 'string'
        ? Buffer.from(entry.content, 'utf8')
        : Buffer.from(entry.content);
    const compressed = deflateRawSync(rawBuf, { level: 6 });
    const checksum = crc32(rawBuf);

    // Local file header (30 bytes + name)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(8, 8); // compression method: DEFLATE
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x5778, 12); // mod date
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compressed);

    // Central directory file header (46 bytes + name)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(8, 10); // DEFLATE
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x5778, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDirSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return new Uint8Array(Buffer.concat([...localParts, ...centralParts, eocd]));
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
