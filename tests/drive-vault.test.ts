import { generateKeyPairSync } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createClient as createSupabase, type SupabaseClient } from '@supabase/supabase-js';
import {
  archiveInvoiceById,
  buildDeliveryProofFileName,
  buildDeterministicPdfName,
  clearDriveCache,
  createZipArchive,
  getDriveAccessToken,
  getDriveCredentials,
  getVaultPeriodFolders,
  isDriveConfigured,
  MAX_DELIVERY_PROOF_BYTES,
  retryPendingDriveArchives,
  rowsToCsv,
  uploadDeliveryProofToDrive,
  type OAuthCredentials,
  type ServiceAccountCredentials,
} from '@/lib/drive-backup';
import { getInvoice } from '@/lib/data';
import { billSheets } from '@/lib/bill-sheets';
import { buildDocuments } from '@/lib/print-documents';
import { sheetsToPdf } from '@/lib/sheet-pdf';
import { ACTORS, createTestDb, intraStatePayload, seedMasterData, syncInvoice, type MasterData } from './db/harness';
import { pgliteFetch } from './support/postgrest';
import { consentUrl, readEnv, upsertEnv } from '../scripts/drive-connect';

let db: PGlite;
let md: MasterData;
let supabaseService: SupabaseClient;

const { privateKey: TEST_PEM_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const ROOT_VAULT_ID = '1VaultRootFolderId_CompanyBilling';
const TEST_CREDS: ServiceAccountCredentials = {
  clientEmail: 'studflow-vault@test-project.iam.gserviceaccount.com',
  privateKey: TEST_PEM_KEY,
  rootFolderId: ROOT_VAULT_ID,
};

interface FakeDriveNode {
  id: string;
  name: string;
  mimeType: string;
  parentId: string;
  bytes?: Buffer;
  webViewLink: string;
}

class FakeGoogleDrive {
  readonly nodes = new Map<string, FakeDriveNode>();
  readonly telegramMessages: Array<{ chat_id: string; text: string }> = [];
  failNextDriveCall = false;
  uploadCalls = 0;
  private seq = 100;

  reset(): void {
    this.nodes.clear();
    this.telegramMessages.length = 0;
    this.failNextDriveCall = false;
    this.uploadCalls = 0;
    this.seq = 100;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

    // 1. Telegram Bot API
    if (url.hostname === 'api.telegram.org') {
      const payload = JSON.parse(String(init?.body ?? '{}')) as { chat_id: string; text: string };
      this.telegramMessages.push(payload);
      return Response.json({ ok: true, result: { message_id: 1 } });
    }

    if (this.failNextDriveCall) {
      this.failNextDriveCall = false;
      return new Response('Drive temporarily unavailable', { status: 503 });
    }

    // 2. Google OAuth2 Token endpoint
    if (url.href.startsWith('https://oauth2.googleapis.com/token')) {
      return Response.json({ access_token: 'fake-drive-oauth-token', expires_in: 3600 });
    }

    // 3. Google Drive Multipart Upload
    if (url.href.startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
      this.uploadCalls += 1;
      const contentType = new Headers(init?.headers).get('content-type') ?? '';
      const boundaryMatch = /boundary=([^\s;]+)/.exec(contentType);
      const boundary = boundaryMatch?.[1] ?? '';
      const rawBuf = Buffer.isBuffer(init?.body)
        ? init.body
        : Buffer.from(init?.body as Uint8Array);
      const text = rawBuf.toString('latin1');
      const parts = text.split(`--${boundary}`);
      const metaPart = parts[1] ?? '';
      const jsonStart = metaPart.indexOf('{');
      const jsonEnd = metaPart.lastIndexOf('}');
      const meta = JSON.parse(metaPart.slice(jsonStart, jsonEnd + 1)) as {
        name: string;
        parents?: string[];
      };

      const filePart = parts[2] ?? '';
      const headerEnd = filePart.indexOf('\r\n\r\n');
      const bodyLatin1 = filePart.slice(headerEnd + 4, filePart.endsWith('\r\n') ? -2 : undefined);
      const fileBytes = Buffer.from(bodyLatin1, 'latin1');

      const patchId = /\/files\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
      if (init?.method === 'PATCH' && patchId) {
        const existing = this.nodes.get(patchId);
        if (!existing) return new Response('Not found', { status: 404 });
        existing.bytes = fileBytes;
        if (meta.name) existing.name = meta.name;
        return Response.json({
          id: existing.id,
          name: existing.name,
          parents: [existing.parentId],
          webViewLink: existing.webViewLink,
        });
      }

      const id = `driveFile_${++this.seq}`;
      const parentId = meta.parents?.[0] ?? '';
      const webViewLink = `https://drive.google.com/file/d/${id}/view`;
      const node: FakeDriveNode = {
        id,
        name: meta.name,
        mimeType: 'application/octet-stream',
        parentId,
        bytes: fileBytes,
        webViewLink,
      };
      this.nodes.set(id, node);
      return Response.json({ id, name: meta.name, parents: [parentId], webViewLink });
    }

    // 4. Google Drive Metadata List / Folder Creation
    if (url.href.startsWith('https://www.googleapis.com/drive/v3/files')) {
      if ((init?.method ?? 'GET') === 'GET') {
        const q = url.searchParams.get('q') ?? '';
        const nameMatch = /name = '([^']+)'/.exec(q);
        const parentMatch = /'([^']+)' in parents/.exec(q);
        const folderOnly = q.includes("mimeType = 'application/vnd.google-apps.folder'");
        const wantedName = nameMatch?.[1] ?? '';
        const wantedParent = parentMatch?.[1] ?? '';

        const matches = [...this.nodes.values()].filter(
          (n) =>
            n.name === wantedName &&
            n.parentId === wantedParent &&
            (!folderOnly || n.mimeType === 'application/vnd.google-apps.folder'),
        );
        return Response.json({
          files: matches.map((m) => ({
            id: m.id,
            name: m.name,
            parents: [m.parentId],
            webViewLink: m.webViewLink,
          })),
        });
      }

      if (init?.method === 'POST') {
        const meta = JSON.parse(String(init.body)) as {
          name: string;
          mimeType: string;
          parents: string[];
        };
        const id = `driveFolder_${++this.seq}`;
        const parentId = meta.parents[0] ?? '';
        const webViewLink = `https://drive.google.com/drive/folders/${id}`;
        this.nodes.set(id, {
          id,
          name: meta.name,
          mimeType: meta.mimeType,
          parentId,
          webViewLink,
        });
        return Response.json({ id, name: meta.name, parents: [parentId], webViewLink });
      }
    }

    throw new Error(`Unexpected fetch URL in Drive test: ${url.href}`);
  };

  pathOf(nodeId: string): string {
    const chain: string[] = [];
    let current = this.nodes.get(nodeId);
    while (current) {
      chain.unshift(current.name);
      if (current.parentId === ROOT_VAULT_ID) {
        chain.unshift('Company_Billing_Vault');
        break;
      }
      current = this.nodes.get(current.parentId);
    }
    return chain.join('/');
  }
}

const fakeDrive = new FakeGoogleDrive();

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => supabaseService,
}));

beforeAll(async () => {
  db = await createTestDb();
  md = await seedMasterData(db);
  supabaseService = createSupabase('http://localhost', 'sb_secret_test', {
    global: { fetch: pgliteFetch(db, () => ACTORS.service) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  clearDriveCache();
  fakeDrive.reset();
});

describe('Task B — Isolated Google Drive Vault & Weekly Disaster Backup', () => {
  it('computes Indian FY folders, sanitizes customer names, and parses service account env vars', () => {
    expect(getVaultPeriodFolders('2026-11-24')).toEqual({
      fyFolder: 'FY_2026-27',
      monthFolder: '2026-11',
    });
    expect(getVaultPeriodFolders('2027-03-31')).toEqual({
      fyFolder: 'FY_2026-27',
      monthFolder: '2027-03',
    });
    expect(getVaultPeriodFolders('2027-04-01')).toEqual({
      fyFolder: 'FY_2027-28',
      monthFolder: '2027-04',
    });

    expect(buildDeterministicPdfName('INV/26-27/0001', 'Sri Murugan Engineering & Co. (P) Ltd.')).toBe(
      'INV_26-27_0001_Sri_Murugan_Engineering_Co_P_Ltd.pdf',
    );
    expect(buildDeliveryProofFileName('DC/26-27/0001', 'Vel Tools', 'image/jpeg')).toBe(
      'DC_26-27_0001_Vel_Tools_PROOF.jpg',
    );

    const fromPair = getDriveCredentials({
      NODE_ENV: 'test',
      GOOGLE_DRIVE_ROOT_FOLDER_ID: ROOT_VAULT_ID,
      GOOGLE_DRIVE_CLIENT_EMAIL: TEST_CREDS.clientEmail,
      GOOGLE_DRIVE_PRIVATE_KEY: TEST_CREDS.privateKey.replace(/\n/g, '\\n'),
    });
    expect(fromPair.rootFolderId).toBe(ROOT_VAULT_ID);
    expect(fromPair).toMatchObject({ clientEmail: TEST_CREDS.clientEmail });

    const fromJson = getDriveCredentials({
      NODE_ENV: 'test',
      GOOGLE_DRIVE_ROOT_FOLDER_ID: ROOT_VAULT_ID,
      GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: TEST_CREDS.clientEmail,
        private_key: TEST_CREDS.privateKey,
      }),
    });
    expect(fromJson).toMatchObject({ clientEmail: TEST_CREDS.clientEmail });

    expect(() => getDriveCredentials({ NODE_ENV: 'test' })).toThrow(/GOOGLE_DRIVE_ROOT_FOLDER_ID/);
  });

  it('renders valid PDF 1.4 bytes and archives Supply + Job-Work bills without overwriting finalized PDFs', async () => {
    const supplyIssued = await syncInvoice(db, ACTORS.staff, intraStatePayload(md));
    const supplyDoc = await getInvoice(supabaseService, supplyIssued.invoice_id);
    const pdfBytes = sheetsToPdf(billSheets(buildDocuments(supplyDoc, { documents: 'invoice', copies: 'original' })), supplyIssued.invoice_no);
    const pdfText = Buffer.from(pdfBytes).toString('utf8');
    expect(pdfText.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdfText.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdfText).toContain(supplyIssued.invoice_no);
    expect(pdfText).toContain('Murugan Engineering Works');

    // 1. Archive supply invoice + linked DC
    const archived = await archiveInvoiceById(supabaseService, supplyIssued.invoice_id, {
      creds: TEST_CREDS,
      fetchImpl: fakeDrive.fetch,
    });
    expect(archived.synced).toBe(true);
    expect(archived.driveSyncPending).toBe(false);
    expect(archived.invoicePdf?.alreadyExisted).toBe(false);
    expect(archived.dcPdf?.alreadyExisted).toBe(false);

    expect(fakeDrive.pathOf(archived.invoicePdf!.fileId)).toBe(
      `Company_Billing_Vault/FY_2026-27/2026-11/Tax_Invoices/INV_26-27_0001_Murugan_Engineering_Works.pdf`,
    );
    expect(fakeDrive.pathOf(archived.dcPdf!.fileId)).toBe(
      `Company_Billing_Vault/FY_2026-27/2026-11/Delivery_Challans/DC_26-27_0001_Murugan_Engineering_Works.pdf`,
    );

    const [dbRow] = (
      await db.query<{
        pdf_drive_url: string;
        drive_sync_pending: boolean;
        drive_file_id: string;
        dc_drive_url: string;
      }>(
        'select pdf_drive_url, drive_sync_pending, drive_file_id, dc_drive_url from public.invoices where id = $1',
        [supplyIssued.invoice_id],
      )
    ).rows;
    expect(dbRow).toEqual({
      pdf_drive_url: archived.invoicePdf?.webViewLink,
      drive_sync_pending: false,
      drive_file_id: archived.invoicePdf?.fileId,
      dc_drive_url: archived.dcPdf?.webViewLink,
    });

    // 2. Re-archiving the same invoice never overwrites or re-uploads the finalized PDFs
    const uploadsBefore = fakeDrive.uploadCalls;
    const secondRun = await archiveInvoiceById(supabaseService, supplyIssued.invoice_id, {
      creds: TEST_CREDS,
      fetchImpl: fakeDrive.fetch,
    });
    expect(secondRun.invoicePdf?.alreadyExisted).toBe(true);
    expect(secondRun.dcPdf?.alreadyExisted).toBe(true);
    expect(secondRun.invoicePdf?.fileId).toBe(archived.invoicePdf?.fileId);
    expect(fakeDrive.uploadCalls).toBe(uploadsBefore);

    // 2b. When an invoice is edited in place (replaceExisting: true), the existing Drive PDF is updated in place (same fileId, new bytes)
    await syncInvoice(db, ACTORS.staff, {
      ...intraStatePayload(md, {
        subtotal: '3000.00',
        cgst: '270.00',
        sgst: '270.00',
        grand_total: '3540.00',
        items: [
          {
            line_no: 1,
            stud_item_id: md.studItemId,
            description: 'EN8 M16x125 Studs',
            hsn_sac: '731815',
            qty_pieces: 200,
            total_weight_kg: '39.457460',
            billing_unit: 'pcs',
            unit_rate: '15.00',
            tax_rate_percent: '18.00',
            line_total: '3000.00',
            cgst_amount: '270.00',
            sgst_amount: '270.00',
            igst_amount: '0.00',
          },
        ],
      }),
      edit_invoice_id: supplyIssued.invoice_id,
    });
    const replaced = await archiveInvoiceById(supabaseService, supplyIssued.invoice_id, {
      creds: TEST_CREDS,
      fetchImpl: fakeDrive.fetch,
      replaceExisting: true,
    });
    expect(replaced.synced).toBe(true);
    expect(replaced.invoicePdf?.fileId).toBe(archived.invoicePdf?.fileId);
    const updatedPdfText = fakeDrive.nodes.get(archived.invoicePdf!.fileId)?.bytes?.toString('utf8') ?? '';
    expect(updatedPdfText).toContain('(3,540)');
    expect(updatedPdfText).toContain('(200 PCS)');

    // 3. Job-work bill routes to Job_Work_Bills/
    const jobWorkIssued = await syncInvoice(
      db,
      ACTORS.staff,
      intraStatePayload(md, { bill_type: 'job_work' }),
    );
    const jobWorkArchived = await archiveInvoiceById(supabaseService, jobWorkIssued.invoice_id, {
      creds: TEST_CREDS,
      fetchImpl: fakeDrive.fetch,
    });
    expect(fakeDrive.pathOf(jobWorkArchived.invoicePdf!.fileId)).toContain(
      'Company_Billing_Vault/FY_2026-27/2026-11/Job_Work_Bills/',
    );
  });

  it('keeps drive_sync_pending = true on transient Drive failure without blocking billing, then clears on retry', async () => {
    const issued = await syncInvoice(db, ACTORS.staff, intraStatePayload(md));
    fakeDrive.failNextDriveCall = true;

    const failedAttempt = await archiveInvoiceById(supabaseService, issued.invoice_id, {
      creds: TEST_CREDS,
      fetchImpl: fakeDrive.fetch,
    });
    expect(failedAttempt.synced).toBe(false);
    expect(failedAttempt.driveSyncPending).toBe(true);

    const [beforeRetry] = (
      await db.query<{ drive_sync_pending: boolean; pdf_drive_url: string | null }>(
        'select drive_sync_pending, pdf_drive_url from public.invoices where id = $1',
        [issued.invoice_id],
      )
    ).rows;
    expect(beforeRetry).toEqual({ drive_sync_pending: true, pdf_drive_url: null });

    const retrySummary = await retryPendingDriveArchives(supabaseService, {
      creds: TEST_CREDS,
      fetchImpl: fakeDrive.fetch,
    });
    expect(retrySummary.attempted).toBeGreaterThanOrEqual(1);
    expect(retrySummary.succeeded).toBe(retrySummary.attempted);
    expect(retrySummary.pending).toBe(0);

    const [afterRetry] = (
      await db.query<{ drive_sync_pending: boolean; pdf_drive_url: string | null }>(
        'select drive_sync_pending, pdf_drive_url from public.invoices where id = $1',
        [issued.invoice_id],
      )
    ).rows;
    expect(afterRetry?.drive_sync_pending).toBe(false);
    expect(afterRetry?.pdf_drive_url).toMatch(/^https:\/\/drive\.google\.com\/file\/d\//);
  });

  it('enforces the < 200 KB delivery proof limit and archives valid photos into Delivery_Proofs/', async () => {
    const issued = await syncInvoice(db, ACTORS.staff, intraStatePayload(md));
    const [delivery] = (
      await db.query<{ id: string }>('select id from public.deliveries where invoice_id = $1', [
        issued.invoice_id,
      ])
    ).rows;
    const deliveryId = delivery!.id;

    // 1. Rejects > 200 KB proof photo
    const oversized = new Uint8Array(MAX_DELIVERY_PROOF_BYTES + 1);
    await expect(
      uploadDeliveryProofToDrive({
        db: supabaseService,
        deliveryId,
        mimeType: 'image/jpeg',
        bytes: oversized,
        creds: TEST_CREDS,
        fetchImpl: fakeDrive.fetch,
      }),
    ).rejects.toThrow(/200 KB/);

    // 2. Accepts compressed photo <= 200 KB
    const compressedPhoto = new Uint8Array(24 * 1024).fill(0xff);
    const uploadedProof = await uploadDeliveryProofToDrive({
      db: supabaseService,
      deliveryId,
      mimeType: 'image/jpeg',
      bytes: compressedPhoto,
      creds: TEST_CREDS,
      fetchImpl: fakeDrive.fetch,
    });

    expect(fakeDrive.pathOf(uploadedProof.fileId)).toMatch(
      /^Company_Billing_Vault\/FY_2026-27\/2026-11\/Delivery_Proofs\/DC_26-27_\d+_Murugan_Engineering_Works_PROOF\.jpg$/,
    );

    const [storedDelivery] = (
      await db.query<{ proof_drive_url: string; proof_drive_file_id: string }>(
        'select proof_drive_url, proof_drive_file_id from public.deliveries where id = $1',
        [deliveryId],
      )
    ).rows;
    expect(storedDelivery).toEqual({
      proof_drive_url: uploadedProof.webViewLink,
      proof_drive_file_id: uploadedProof.fileId,
    });
  });

  it('protects /api/cron/weekly-backup with CRON_SECRET and uploads a valid JSON+CSV ZIP backup with Telegram confirmation', async () => {
    const { proxy } = await import('@/proxy');
    const { GET, runWeeklyDisasterBackup } = await import('@/app/api/cron/weekly-backup/route');

    // 1. Proxy lets /api/cron/weekly-backup pass through without browser session cookies
    const proxied = await proxy(new NextRequest('http://localhost:3000/api/cron/weekly-backup'));
    expect(proxied.status).toBe(200);

    // 2. Missing CRON_SECRET on server -> 503 NOT_READY
    vi.stubEnv('CRON_SECRET', '');
    const unconfigured = await GET(new Request('http://localhost:3000/api/cron/weekly-backup'));
    expect(unconfigured.status).toBe(503);

    // 3. Missing or wrong Bearer token -> 401 UNAUTHENTICATED
    const secret = 'studflow_test_cron_secret_32_bytes_long_ok';
    vi.stubEnv('CRON_SECRET', secret);
    const noHeader = await GET(new Request('http://localhost:3000/api/cron/weekly-backup'));
    expect(noHeader.status).toBe(401);
    const wrongToken = await GET(
      new Request('http://localhost:3000/api/cron/weekly-backup', {
        headers: { authorization: 'Bearer wrong_token_value_here_1234567890' },
      }),
    );
    expect(wrongToken.status).toBe(401);
    vi.unstubAllEnvs();

    // 4. Run full weekly backup with Telegram configured
    const backupResult = await runWeeklyDisasterBackup({
      db: supabaseService,
      creds: TEST_CREDS,
      fetchImpl: fakeDrive.fetch,
      backupDate: '2026-11-24',
      env: {
        NODE_ENV: 'test',
        TELEGRAM_BOT_TOKEN: '123456:ABC-DEF',
        TELEGRAM_OWNER_CHAT_ID: '987654321',
      },
    });

    expect(backupResult.backup_file).toBe('backup_2026-11-24.zip');
    expect(backupResult.folder_path).toBe('DB_Backups');
    expect(fakeDrive.pathOf(backupResult.drive_file_id)).toBe(
      'Company_Billing_Vault/DB_Backups/backup_2026-11-24.zip',
    );
    expect(backupResult.telegram_sent).toBe(true);
    expect(fakeDrive.telegramMessages).toHaveLength(1);
    expect(fakeDrive.telegramMessages[0]?.text).toContain('backup_2026-11-24.zip');

    // 5. Verify the uploaded ZIP binary header and decompress the first entry
    const uploadedZipNode = fakeDrive.nodes.get(backupResult.drive_file_id);
    const zipBuf = uploadedZipNode?.bytes;
    expect(zipBuf).toBeDefined();
    expect(zipBuf!.readUInt32LE(0)).toBe(0x04034b50); // PK\x03\x04 local header signature
    const nameLen = zipBuf!.readUInt16LE(26);
    const compressedSize = zipBuf!.readUInt32LE(18);
    const entryName = zipBuf!.subarray(30, 30 + nameLen).toString('utf8');
    const compressedData = zipBuf!.subarray(30 + nameLen, 30 + nameLen + compressedSize);
    const decompressedJson = JSON.parse(inflateRawSync(compressedData).toString('utf8')) as unknown[];
    expect(entryName).toBe('json/customers.json');
    expect(Array.isArray(decompressedJson)).toBe(true);
    expect(decompressedJson.length).toBeGreaterThanOrEqual(2);

    // 6. Graceful skip when Telegram env vars are omitted
    const noTelegramResult = await runWeeklyDisasterBackup({
      db: supabaseService,
      creds: TEST_CREDS,
      fetchImpl: fakeDrive.fetch,
      backupDate: '2026-11-24',
      env: { NODE_ENV: 'test' },
    });
    expect(noTelegramResult.telegram_sent).toBe(false);

    // 7. Verify CSV serializer and standalone ZIP helper
    const csv = rowsToCsv([{ id: '1', name: 'Vel, "Tools"', amount: '100.00' }]);
    expect(csv).toContain('id,name,amount\r\n1,"Vel, ""Tools""",100.00\r\n');
    const miniZip = createZipArchive([{ name: 'hello.txt', content: 'studflow' }]);
    expect(miniZip.byteLength).toBeGreaterThan(30);
  });

  it('rejects any invalid folder segment or attempt to operate outside Company_Billing_Vault', async () => {
    const { ensureVaultFolderPath } = await import('@/lib/drive-backup');
    await expect(
      ensureVaultFolderPath(['../Escape_Vault'], TEST_CREDS, 'fake-token', fakeDrive.fetch),
    ).rejects.toThrow(/Invalid Drive vault folder segment/);
  });
});

describe('Drive with a personal Google account (OAuth)', () => {
  const OAUTH: OAuthCredentials = { clientId: 'client-1.apps.googleusercontent.com', clientSecret: 's3cret', refreshToken: 'refresh-1', rootFolderId: ROOT_VAULT_ID };
  const env = {
    NODE_ENV: 'test' as const,
    GOOGLE_DRIVE_ROOT_FOLDER_ID: ROOT_VAULT_ID,
    GOOGLE_DRIVE_OAUTH_CLIENT_ID: OAUTH.clientId,
    GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: OAUTH.clientSecret,
    GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN: OAUTH.refreshToken,
  };

  it('reads the sign-in, prefers it, and refuses half a setup', () => {
    expect(getDriveCredentials(env)).toEqual(OAUTH);
    expect(getDriveCredentials({ ...env, GOOGLE_DRIVE_CLIENT_EMAIL: TEST_CREDS.clientEmail, GOOGLE_DRIVE_PRIVATE_KEY: TEST_CREDS.privateKey })).toEqual(OAUTH);
    const half = { ...env, GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN: ' ', GOOGLE_DRIVE_CLIENT_EMAIL: TEST_CREDS.clientEmail, GOOGLE_DRIVE_PRIVATE_KEY: TEST_CREDS.privateKey };
    expect(() => getDriveCredentials(half)).toThrow('GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN missing');
    expect(() => getDriveCredentials(half)).not.toThrow(OAUTH.clientSecret);
    expect(isDriveConfigured(env)).toBe(true);
    expect(isDriveConfigured({ ...env, GOOGLE_DRIVE_ROOT_FOLDER_ID: '' })).toBe(false);
    expect(isDriveConfigured({ ...env, GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: '' })).toBe(false);
    expect(isDriveConfigured({ NODE_ENV: 'test' })).toBe(false);
  });

  it('renews with the stored permission, caches per account, and explains a removed permission', async () => {
    const bodies: URLSearchParams[] = [];
    const google: typeof fetch = async (_input, init) => {
      bodies.push(new URLSearchParams(String(init?.body)));
      return Response.json({ access_token: `token-${bodies.length}`, expires_in: 3600 });
    };
    expect(await getDriveAccessToken(OAUTH, google)).toBe('token-1');
    expect(await getDriveAccessToken(OAUTH, google)).toBe('token-1');
    expect(Object.fromEntries(bodies[0] ?? [])).toEqual({ grant_type: 'refresh_token', client_id: OAUTH.clientId, client_secret: 's3cret', refresh_token: 'refresh-1' });
    // Reconnected, or another account: never the first one's token.
    expect(await getDriveAccessToken({ ...OAUTH, refreshToken: 'refresh-2' }, google)).toBe('token-2');
    expect(await getDriveAccessToken(TEST_CREDS, google)).toBe('token-3');
    expect(bodies[2]?.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    clearDriveCache();
    const gone: typeof fetch = async () => Response.json({ error: 'invalid_grant' }, { status: 400 });
    await expect(getDriveAccessToken(OAUTH, gone)).rejects.toThrow(/drive-connect/);
  });

  it('archives an invoice and its challan into the vault', async () => {
    const issued = await syncInvoice(db, ACTORS.staff, intraStatePayload(md));
    const result = await archiveInvoiceById(supabaseService, issued.invoice_id, { creds: OAUTH, fetchImpl: fakeDrive.fetch });
    expect(result).toMatchObject({ synced: true, driveSyncPending: false });
    expect(fakeDrive.pathOf(result.invoicePdf?.fileId ?? '')).toMatch(/^Company_Billing_Vault\/FY_2026-27\/2026-11\/Tax_Invoices\//);
  });
});

describe('scripts/drive-connect.ts', () => {
  it('asks only for files the app itself creates, with PKCE and a state', () => {
    const url = new URL(consentUrl({ clientId: 'c', redirectUri: 'http://127.0.0.1:53682/callback', state: 'st', challenge: 'ch' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      scope: 'https://www.googleapis.com/auth/drive.file', access_type: 'offline', prompt: 'consent', response_type: 'code', state: 'st', code_challenge: 'ch', code_challenge_method: 'S256',
    });
    expect(url.href).not.toMatch(/secret/i);
  });

  it('changes only its own lines of the env file', () => {
    const file = '# note\r\nA=1\r\nGOOGLE_DRIVE_ROOT_FOLDER_ID=\r\nCRON_SECRET=keep\r\n';
    const next = upsertEnv(file, { GOOGLE_DRIVE_ROOT_FOLDER_ID: 'folder_12345', GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN: '1//0a$&b' });
    expect(next).toBe('# note\r\nA=1\r\nGOOGLE_DRIVE_ROOT_FOLDER_ID=folder_12345\r\nCRON_SECRET=keep\r\nGOOGLE_DRIVE_OAUTH_REFRESH_TOKEN=1//0a$&b\r\n');
    expect(readEnv(next)).toMatchObject({ A: '1', CRON_SECRET: 'keep', GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN: '1//0a$&b' });
    expect(() => upsertEnv(file, { A: 'x\ny' })).toThrow();
  });
});

/** Reads a ZIP through its central directory, as any unzip tool does. */
function unzip(zip: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    const nameLength = zip.readUInt16LE(at + 28);
    const header = zip.readUInt32LE(at + 42);
    const start = header + 30 + zip.readUInt16LE(header + 26) + zip.readUInt16LE(header + 28);
    const raw = zip.subarray(start, start + zip.readUInt32LE(at + 20));
    files.set(zip.toString('utf8', at + 46, at + 46 + nameLength), (zip.readUInt16LE(at + 10) === 8 ? inflateRawSync(raw) : raw).toString('utf8'));
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return files;
}

describe('Weekly backup: nothing left out, and never "OK" when something is', () => {
  const NIGHT = {
    creds: TEST_CREDS,
    backupDate: '2026-11-29',
    env: { NODE_ENV: 'test' as const, TELEGRAM_BOT_TOKEN: '123456:ABC-DEF', TELEGRAM_OWNER_CHAT_ID: '987654321' },
  };

  /** The same database behind a server with its own row limit, or a wire that misbehaves. */
  function client(options: { maxRows?: number; wire?: (real: typeof fetch) => typeof fetch } = {}): SupabaseClient {
    const real = pgliteFetch(db, () => ACTORS.service, options.maxRows);
    return createSupabase('http://localhost', 'sb_secret_test', {
      global: { fetch: options.wire ? options.wire(real) : real },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  const reads = (table: string, input: RequestInfo | URL, init?: RequestInit): boolean =>
    (init?.method ?? 'GET') === 'GET' && new URL(String(input)).pathname.endsWith(`/${table}`);

  const rowsOf = async (table: string): Promise<number> =>
    (await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0]?.n ?? -1;
  const everyTable = async (): Promise<string[]> =>
    (await db.query<{ t: string }>(`select relname as t from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1`)).rows.map((row) => row.t);

  async function backUp(source: SupabaseClient): Promise<{ counts: Record<string, number>; files: Map<string, string> }> {
    const { runWeeklyDisasterBackup } = await import('@/app/api/cron/weekly-backup/route');
    const result = await runWeeklyDisasterBackup({ ...NIGHT, db: source, fetchImpl: fakeDrive.fetch });
    const zip = fakeDrive.nodes.get(result.drive_file_id)?.bytes;
    if (!zip) throw new Error('no file was uploaded');
    return { counts: result.table_counts, files: unzip(zip) };
  }
  const rowsIn = (files: Map<string, string>, table: string): { id: string }[] => JSON.parse(files.get(`json/${table}.json`) ?? 'null') as { id: string }[];

  it('holds every row of a table longer than one answer', async () => {
    await db.exec(`insert into public.customers (name, state_code, credit_days) select 'Bulk ' || i, '33', 0 from generate_series(1, 2300) as i`);
    const total = await rowsOf('customers');
    expect(total).toBeGreaterThan(2300);
    const { counts, files } = await backUp(client());
    expect(new Set(rowsIn(files, 'customers').map((row) => row.id)).size).toBe(total);
    expect(files.get('csv/customers.csv')?.trimEnd().split('\r\n')).toHaveLength(total + 1);
    expect(counts.customers).toBe(total);
  });

  it('holds every row of every table when the server cuts answers shorter than asked', async () => {
    await syncInvoice(db, ACTORS.staff, intraStatePayload(md));
    const { files } = await backUp(client({ maxRows: 7 }));
    for (const table of await everyTable()) expect([table, rowsIn(files, table).length]).toEqual([table, await rowsOf(table)]);
  });

  it('holds the ID and name of a product without a size, in both formats', async () => {
    const { rows } = await db.query<{ id: string; no: number }>(
      `insert into public.stud_items (name, hsn_sac, gst_rate_percent) values ('Backed-up "nut", M12', '731816', 18) returning id, product_no as no`,
    );
    const { files } = await backUp(client());
    expect(rowsIn(files, 'stud_items').find((row) => row.id === rows[0]?.id)).toMatchObject({ product_no: rows[0]?.no, name: 'Backed-up "nut", M12', diameter_mm: null });
    const csv = (files.get('csv/stud_items.csv') ?? '').split('\r\n');
    expect(csv[0]).toMatch(/^\uFEFF?id,product_no,name,sku_code,/);
    expect(csv.find((line) => line.startsWith(rows[0]?.id ?? '?'))).toContain(`,${rows[0]?.no},"Backed-up ""nut"", M12",`);
  });

  it('fails and uploads nothing when rows are missing from what it read', async () => {
    await syncInvoice(db, ACTORS.staff, intraStatePayload(md));
    const blind = client({ wire: (real) => async (input, init) => (reads('invoices', input, init) ? Response.json([]) : real(input, init)) });
    await expect(backUp(blind)).rejects.toThrow(/invoices/);
    expect(fakeDrive.uploadCalls).toBe(0);
    expect(fakeDrive.telegramMessages).toEqual([]);
  });

  it('holds a customer added while it was reading', async () => {
    const late = '00000000-0000-4000-8000-000000000001'; // sorts before everything already read
    let added = false;
    const busy = client({
      wire: (real) => async (input, init) => {
        const answer = await real(input, init);
        if (!added && reads('customers', input, init)) {
          added = true;
          await db.query(`insert into public.customers (id, name, state_code, credit_days) values ($1, 'Late', '33', 0)`, [late]);
        }
        return answer;
      },
    });
    const { files } = await backUp(busy);
    expect(rowsIn(files, 'customers').some((row) => row.id === late)).toBe(true);
  });

  it('stays a good backup when only the Telegram note fails', async () => {
    const { runWeeklyDisasterBackup } = await import('@/app/api/cron/weekly-backup/route');
    const noTelegram: typeof fetch = async (input, init) =>
      new URL(String(input)).hostname === 'api.telegram.org' ? new Response('', { status: 502 }) : fakeDrive.fetch(input, init);
    const result = await runWeeklyDisasterBackup({ ...NIGHT, db: client(), fetchImpl: noTelegram });
    expect(result.telegram_sent).toBe(false);
    expect(fakeDrive.uploadCalls).toBe(1);
  });

  /** One scheduled run with this wire to the outside; what the owner was told. */
  async function failedRun(outside: typeof fetch): Promise<string> {
    const { GET } = await import('@/app/api/cron/weekly-backup/route');
    const env = {
      CRON_SECRET: 'studflow_test_cron_secret_32_bytes_long_ok', TELEGRAM_BOT_TOKEN: NIGHT.env.TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_CHAT_ID: NIGHT.env.TELEGRAM_OWNER_CHAT_ID,
      GOOGLE_DRIVE_ROOT_FOLDER_ID: ROOT_VAULT_ID, GOOGLE_DRIVE_OAUTH_CLIENT_ID: 'c.apps.googleusercontent.com', GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: 'drive-secret', GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN: 'expired-permission',
    };
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.stubGlobal('fetch', outside);
    try {
      const response = await GET(new Request('http://localhost/api/cron/weekly-backup', { headers: { authorization: `Bearer ${env.CRON_SECRET}` } }));
      expect(response.status).toBe(500);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
    expect(fakeDrive.uploadCalls).toBe(0);
    expect(fakeDrive.telegramMessages).toHaveLength(1);
    const note = fakeDrive.telegramMessages[0]?.text ?? '';
    expect(note).toContain('FAILED');
    for (const secret of [env.CRON_SECRET, env.TELEGRAM_BOT_TOKEN, env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET, env.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN]) expect(note).not.toContain(secret);
    return note;
  }
  const google = (answer: () => Response): typeof fetch => async (input, init) =>
    new URL(String(input)).hostname === 'oauth2.googleapis.com' ? answer() : fakeDrive.fetch(input, init);

  it('tells the owner when no backup was saved, and why', async () => {
    expect(await failedRun(google(() => Response.json({ error: 'invalid_grant' }, { status: 400 })))).toContain('permission has expired');
  });

  it('tells the owner without the details of an error nobody foresaw', async () => {
    const note = await failedRun(google(() => {
      throw new TypeError('connect failed for refresh_token=expired-permission at 10.0.0.7');
    }));
    expect(note).not.toContain('10.0.0.7');
  });
});
