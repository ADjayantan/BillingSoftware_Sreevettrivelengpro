import { z } from 'zod';
import { body, route } from '@/lib/api/http';
import { archiveInvoiceById, retryPendingDriveArchives } from '@/lib/drive-backup';
import { id } from '@/lib/schemas/common';

const retryInput = z
  .object({
    invoice_id: id.optional(),
    limit: z.number().int().min(1).max(50).default(25),
  })
  .default({ limit: 25 });

/**
 * Retries pending Google Drive invoice/DC PDF uploads (`drive_sync_pending = true`),
 * or archives a single specified `invoice_id`.
 */
export const POST = route(async ({ request, supabase }) => {
  const input = await body(request, retryInput);
  if (input.invoice_id) {
    return archiveInvoiceById(supabase, input.invoice_id);
  }
  return retryPendingDriveArchives(supabase, { limit: input.limit });
});
