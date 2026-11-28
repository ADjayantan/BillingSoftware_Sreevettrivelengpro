import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import {
  createZipArchive,
  retryPendingDriveArchives,
  rowsToCsv,
  sendTelegramBackupConfirmation,
  uploadFileToVaultFolder,
  type DriveCredentials,
  type ZipEntryInput,
} from '@/lib/drive-backup';
import { istDate } from '@/lib/india';
import { PAGE_ROWS, readAllRows } from '@/lib/read-all';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendTelegramAlert } from '@/lib/telegram';

const NO_STORE = { 'cache-control': 'no-store' };

const BACKUP_TABLES: ReadonlyArray<{
  name: string;
  columns: readonly string[];
}> = [
  {
    name: 'customers',
    columns: ['id', 'name', 'gstin', 'phone', 'state_code', 'is_sez', 'credit_days', 'address', 'opening_balance', 'is_active', 'created_at', 'updated_at'],
  },
  {
    name: 'stud_items',
    columns: ['id', 'product_no', 'name', 'sku_code', 'diameter_mm', 'length_mm', 'thread_type', 'material_grade', 'hsn_sac', 'gst_rate_percent', 'unit_weight_kg', 'unit_weight_is_manual', 'default_rate_per_piece', 'default_rate_per_kg', 'is_active', 'created_at', 'updated_at'],
  },
  {
    name: 'metal_rates',
    columns: ['id', 'material_grade', 'rate_per_kg', 'previous_rate_per_kg', 'change_delta', 'source', 'recorded_at'],
  },
  {
    name: 'invoices',
    columns: [
      'id', 'invoice_no', 'fiscal_year', 'invoice_seq', 'client_temp_id', 'sync_fingerprint', 'bill_type', 'customer_id',
      'invoice_date', 'place_of_supply', 'is_sez', 'customer_snapshot', 'supplier_snapshot', 'subtotal', 'packing_charge',
      'delivery_charge', 'delivery_taxable', 'cgst', 'sgst', 'igst', 'charges_cgst', 'charges_sgst', 'charges_igst',
      'round_off', 'grand_total', 'amount_paid', 'payment_status', 'due_date', 'pdf_drive_url', 'drive_sync_pending',
      'drive_file_id', 'dc_drive_url', 'dc_drive_file_id', 'notes', 'po_no', 'po_date', 'cancelled_at', 'cancellation_reason', 'created_by',
      'created_at', 'updated_at',
    ],
  },
  {
    name: 'invoice_items',
    columns: ['id', 'invoice_id', 'line_no', 'stud_item_id', 'description', 'hsn_sac', 'qty_pieces', 'total_weight_kg', 'billing_unit', 'unit_rate', 'tax_rate_percent', 'line_total', 'cgst_amount', 'sgst_amount', 'igst_amount', 'material_grade', 'size_text', 'created_at'],
  },
  {
    name: 'deliveries',
    columns: ['id', 'invoice_id', 'dc_no', 'fiscal_year', 'dc_seq', 'dc_date', 'transport_mode', 'vehicle_no', 'driver_name', 'driver_phone', 'lr_number', 'freight_paid_by', 'freight_amount', 'delivery_address', 'status', 'proof_drive_url', 'proof_drive_file_id', 'dispatched_at', 'delivered_at', 'created_at', 'updated_at'],
  },
  {
    name: 'job_work_ledger',
    columns: ['id', 'customer_id', 'party_dc_no', 'party_dc_date', 'material_grade', 'description', 'inward_weight_kg', 'outward_weight_kg', 'scrap_weight_kg', 'balance_weight_kg', 'status', 'close_reason', 'closed_at', 'notes', 'created_by', 'created_at', 'updated_at'],
  },
  {
    name: 'alert_rules',
    columns: ['id', 'material_grade', 'threshold_rs_per_kg', 'telegram_chat_id', 'is_active', 'created_at', 'updated_at'],
  },
  {
    name: 'company_profile',
    columns: ['id', 'singleton', 'legal_name', 'tagline', 'gstin', 'address', 'factory_address', 'state_code', 'phone', 'office_phone', 'email', 'bank_name', 'bank_branch', 'bank_account_no', 'bank_ifsc', 'created_at', 'updated_at'],
  },
  {
    name: 'job_work_returns',
    columns: ['id', 'ledger_id', 'invoice_id', 'delivery_id', 'line_no', 'party_dc_no', 'party_dc_date', 'material_grade', 'goods_description', 'goods_hsn', 'pieces', 'returned_weight_kg', 'scrap_weight_kg', 'inward_weight_kg', 'balance_after_kg', 'declared_value', 'reversed_at', 'created_at'],
  },
  {
    name: 'payments',
    columns: ['id', 'invoice_id', 'client_receipt_id', 'amount', 'received_on', 'mode', 'reference', 'settles_invoice', 'voided_at', 'void_reason', 'created_by', 'created_at', 'updated_at'],
  },
  {
    name: 'quotes',
    columns: [
      'id', 'quote_no', 'bill_type', 'customer_id', 'quote_date', 'valid_until', 'place_of_supply', 'is_sez',
      'customer_snapshot', 'lines', 'packing_charge', 'delivery_charge', 'freight_paid_by', 'delivery_taxable',
      'charges_gst_rate', 'subtotal', 'cgst', 'sgst', 'igst', 'round_off', 'grand_total', 'notes', 'status',
      'converted_invoice_id', 'converted_invoice_no', 'created_by', 'created_at', 'updated_at',
    ],
  },
  {
    name: 'suppliers',
    columns: ['id', 'name', 'gstin', 'phone', 'category', 'notes', 'is_active', 'created_at', 'updated_at'],
  },
  {
    name: 'expenses',
    columns: [
      'id', 'expense_date', 'category', 'supplier_id', 'supplier_name', 'bill_no', 'description',
      'material_grade', 'weight_kg', 'taxable_amount', 'gst_amount', 'total_amount', 'payment_mode',
      'payment_status', 'created_by', 'created_at', 'updated_at',
    ],
  },
];

/**
 * Constant-time verification of `Authorization: Bearer ${CRON_SECRET}`.
 * Fails closed if `CRON_SECRET` is missing on the server.
 */
export function verifyCronAuth(request: Request, env: NodeJS.ProcessEnv = process.env): 'ok' | 'unconfigured' | 'unauthorized' {
  const configured = env.CRON_SECRET?.trim() ?? '';
  if (configured.length < 16) {
    return 'unconfigured';
  }
  const header = request.headers.get('authorization') ?? '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) {
    return 'unauthorized';
  }
  const provided = header.slice(prefix.length);
  const expectedBuf = Buffer.from(configured, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (expectedBuf.length !== providedBuf.length) {
    return 'unauthorized';
  }
  return timingSafeEqual(expectedBuf, providedBuf) ? 'ok' : 'unauthorized';
}

type BackupRow = Record<string, unknown> & { id: string };

/** The whole table, proven: what was read is counted against the table itself. */
async function readWholeTable(db: SupabaseClient, table: string): Promise<BackupRow[]> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const rows = await readAllRows<BackupRow>((after) => {
      const page = db.from(table).select('*').order('id').limit(PAGE_ROWS);
      return after === null ? page : page.gt('id', after);
    }).catch(() => {
      throw new Error(`Weekly backup failed reading table ${table}`);
    });
    const { count } = await db.from(table).select('id', { count: 'exact', head: true });
    if (count === rows.length) return rows;
    // Someone saved something meanwhile: read it again.
  }
  throw new Error(`Weekly backup could not read every row of table ${table}`);
}

export async function runWeeklyDisasterBackup(options: {
  db?: SupabaseClient;
  creds?: DriveCredentials;
  fetchImpl?: typeof fetch;
  backupDate?: string;
  env?: NodeJS.ProcessEnv;
} = {}) {
  const db = options.db ?? createAdminClient();
  const backupDate = options.backupDate ?? istDate(new Date());
  const zipEntries: ZipEntryInput[] = [];
  const tableCounts: Record<string, number> = {};
  const tableHashes: Record<string, string> = {};

  for (const table of BACKUP_TABLES) {
    const rows = await readWholeTable(db, table.name);
    const jsonContent = JSON.stringify(rows, null, 2);
    const csvContent = rowsToCsv(rows, table.columns);

    tableCounts[table.name] = rows.length;
    tableHashes[table.name] = createHash('sha256').update(jsonContent).digest('hex');

    zipEntries.push({ name: `json/${table.name}.json`, content: jsonContent });
    zipEntries.push({ name: `csv/${table.name}.csv`, content: csvContent });
  }

  const manifest = {
    backup_date: backupDate,
    generated_at: new Date().toISOString(),
    tables: BACKUP_TABLES.map((t) => t.name),
    row_counts: tableCounts,
    sha256_json: tableHashes,
  };
  zipEntries.push({ name: 'manifest.json', content: JSON.stringify(manifest, null, 2) });

  const zipBytes = createZipArchive(zipEntries);
  const zipSha256 = createHash('sha256').update(zipBytes).digest('hex');
  const fileName = `backup_${backupDate}.zip`;

  const upload = await uploadFileToVaultFolder({
    folderSegments: ['DB_Backups'],
    fileName,
    mimeType: 'application/zip',
    bytes: zipBytes,
    preventOverwrite: false,
    ...(options.creds ? { creds: options.creds } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  // Flush any pending invoice/DC PDF archives while the weekly maintenance window runs
  const retried = await retryPendingDriveArchives(db, {
    ...(options.creds ? { creds: options.creds } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  }).catch(() => ({ attempted: 0, succeeded: 0, pending: 0, results: [] }));

  const totalRows = Object.values(tableCounts).reduce((sum, n) => sum + n, 0);
  const oneLineAlert = `StudFlow Vault Backup OK: ${fileName} (${totalRows} rows across ${BACKUP_TABLES.length} tables, ${zipBytes.byteLength} bytes) archived to DB_Backups/ [${upload.fileId}].`;

  // The file is safe by now: a note that does not get through must not make it a failed backup.
  const telegram = await sendTelegramBackupConfirmation({
    text: oneLineAlert,
    ...(options.env ? { env: options.env } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  }).catch(() => ({ sent: false }));

  return {
    backup_file: upload.fileName,
    drive_file_id: upload.fileId,
    folder_path: upload.folderPath,
    web_view_link: upload.webViewLink,
    zip_bytes: zipBytes.byteLength,
    zip_sha256: zipSha256,
    table_counts: tableCounts,
    pending_pdfs_retried: {
      attempted: retried.attempted,
      succeeded: retried.succeeded,
      remaining: retried.pending,
    },
    telegram_sent: telegram.sent,
  };
}

async function handleCron(request: Request): Promise<NextResponse> {
  const auth = verifyCronAuth(request);
  if (auth === 'unconfigured') {
    return NextResponse.json(
      { error: { code: 'NOT_READY', message: 'CRON_SECRET is not configured on the server' } },
      { status: 503, headers: NO_STORE },
    );
  }
  if (auth !== 'ok') {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Valid cron bearer token required' } },
      { status: 401, headers: NO_STORE },
    );
  }

  try {
    const data = await runWeeklyDisasterBackup();
    return NextResponse.json({ data }, { status: 200, headers: NO_STORE });
  } catch (error) {
    console.error('weekly backup cron error', error instanceof Error ? error.name : typeof error);
    // A silent failure looks like a quiet week. Only our own sentences are the reason: what a
    // library says may carry an address or a credential.
    const reason = error instanceof Error && error.name === 'Error' ? error.message.replace(/\.$/, '') : 'an unexpected error; see the server log';
    await sendTelegramAlert({ text: `StudFlow backup FAILED (${istDate(new Date())}). There is no good backup for today. Reason: ${reason}.` });
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Weekly Drive backup failed' } },
      { status: 500, headers: NO_STORE },
    );
  }
}

export const GET = handleCron;
export const POST = handleCron;
