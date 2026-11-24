import { z } from 'zod';
import { ApiError, body, parse, route } from '@/lib/api/http';
import { MAX_DELIVERY_PROOF_BYTES, uploadDeliveryProofToDrive } from '@/lib/drive-backup';
import { id } from '@/lib/schemas/common';

const proofUploadInput = z.object({
  mime_type: z.enum(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf']),
  /** Base64-encoded compressed delivery proof photo (<200 KB decoded). */
  base64_data: z.string().trim().min(4).max(300_000),
});

export const POST = route<{ id: string }>(async ({ request, supabase, params }) => {
  const deliveryId = parse(id, params.id);
  const input = await body(request, proofUploadInput);
  const stripped = input.base64_data.replace(/^data:[^;]+;base64,/, '');
  const bytes = new Uint8Array(Buffer.from(stripped, 'base64'));

  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DELIVERY_PROOF_BYTES) {
    throw new ApiError(
      400,
      'INVALID',
      `Delivery proof photo must be under 200 KB (received ${bytes.byteLength} bytes)`,
    );
  }

  return uploadDeliveryProofToDrive({
    db: supabase,
    deliveryId,
    mimeType: input.mime_type,
    bytes,
  });
});
