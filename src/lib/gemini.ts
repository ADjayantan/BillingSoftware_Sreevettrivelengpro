import 'server-only';
import { z } from 'zod';

// =============================================================================
// 1. Strict Zod Contracts (Zero GST / Total Math Allowed in AI Outputs)
// =============================================================================

export const ParseBillRequestSchema = z
  .object({
    text: z.string().trim().min(1, 'Transcript text is required').max(4000),
  })
  .strict();

export const MaterialGradeDraftSchema = z.enum(['MS', 'EN8', 'EN19', 'SS 304', 'SS 316', 'Brass']);
export const ThreadTypeDraftSchema = z.enum(['full_thread', 'double_end', 'UNC', 'BSW', 'Metric']);
export const BillingUnitDraftSchema = z.enum(['pcs', 'kg']);

export const ParseBillItemSchema = z
  .object({
    item_query: z.string().min(1),
    stud_item_id: z.string().uuid().nullable(),
    diameter: z.string().min(1).nullable(),
    length_mm: z.string().regex(/^\d+$/).nullable(),
    material_grade: MaterialGradeDraftSchema.nullable(),
    thread_type: ThreadTypeDraftSchema.nullable(),
    quantity: z.string().regex(/^\d+(\.\d+)?$/).nullable(),
    billing_unit: BillingUnitDraftSchema.nullable(),
    rate_mention: z.string().min(1).nullable(),
  })
  .strict();

export const ChargeMentionSchema = z
  .object({
    mention: z.string().min(1),
    amount_inr: z.string().regex(/^\d+\.\d{2}$/),
  })
  .strict();

export const ParseBillDeliverySchema = z
  .object({
    transport_mention: z.string().min(1).nullable(),
    vehicle_no: z.string().min(1).nullable(),
    freight_paid_by: z.enum(['seller', 'buyer_to_pay']).nullable(),
    delivery_charge: ChargeMentionSchema.nullable(),
    packing_charge: ChargeMentionSchema.nullable(),
  })
  .strict();

export const ParseBillWarningCodeSchema = z.enum([
  'CUSTOMER_NOT_FOUND',
  'CUSTOMER_MISSING',
  'ITEM_NOT_FOUND',
  'ITEM_AMBIGUOUS',
  'QUANTITY_MISSING',
  'QUANTITY_AMBIGUOUS',
  'PACKAGE_COUNT_UNRESOLVED',
  'RATE_MISSING',
  'RATE_AMBIGUOUS',
  'RATE_UNIT_MISMATCH',
  'FREIGHT_PAYER_MISSING',
  'BILL_TOTAL_IGNORED',
]);

export const ParseBillWarningSchema = z
  .object({
    code: ParseBillWarningCodeSchema,
    path: z.string().min(1),
  })
  .strict();

export const ParseBillResponseSchema = z
  .object({
    bill_type: z.enum(['supply', 'job_work']),
    customer_query: z.string().min(1).nullable(),
    customer_id: z.string().uuid().nullable(),
    items: z.array(ParseBillItemSchema).min(1),
    party_dc_no: z.string().min(1).nullable(),
    delivery: ParseBillDeliverySchema,
    warnings: z.array(ParseBillWarningSchema),
  })
  .strict();

export type ParseBillResponse = z.infer<typeof ParseBillResponseSchema>;
export type ParseBillItem = z.infer<typeof ParseBillItemSchema>;
export type ParseBillWarning = z.infer<typeof ParseBillWarningSchema>;

export const ConfirmedRateSchema = z
  .object({
    amount_inr: z.string().regex(/^\d+(\.\d{1,4})?$/),
    per_unit: BillingUnitDraftSchema,
    per_quantity: z.string().regex(/^[1-9]\d*$/),
  })
  .strict();

export const MarginCheckItemInputSchema = z
  .object({
    stud_item_id: z.string().uuid().nullable(),
    billing_unit: BillingUnitDraftSchema.nullable(),
    confirmed_rate: ConfirmedRateSchema.nullable(),
  })
  .strict();

export const MarginCheckRequestSchema = z
  .object({
    bill_type: z.enum(['supply', 'job_work']),
    items: z.array(MarginCheckItemInputSchema).min(1),
  })
  .strict();

export const MarginWarningCodeSchema = z.enum([
  'LABOUR_COST_UNAVAILABLE',
  'ITEM_UNRESOLVED',
  'BILLING_UNIT_MISSING',
  'RATE_UNCONFIRMED',
  'RATE_UNIT_MISMATCH',
]);

export const MarginAlertSchema = z
  .object({
    code: z.literal('LOW_MARGIN'),
    line: z.number().int().nonnegative(),
    warning_tanglish: z.string().min(1),
  })
  .strict();

export const MarginWarningSchema = z
  .object({
    code: MarginWarningCodeSchema,
    line: z.number().int().nonnegative(),
  })
  .strict();

export const MarginCheckResponseSchema = z
  .object({
    margin_alerts: z.array(MarginAlertSchema),
    warnings: z.array(MarginWarningSchema),
  })
  .strict();

export type MarginCheckRequest = z.infer<typeof MarginCheckRequestSchema>;
export type MarginCheckResponse = z.infer<typeof MarginCheckResponseSchema>;

export const MetalGradeCanonicalSchema = z.enum(['MS', 'EN8', 'EN19', 'SS 304', 'SS 316', 'BRASS']);
export type MetalGradeCanonical = z.infer<typeof MetalGradeCanonicalSchema>;

export const DealerRateQuoteSchema = z
  .object({
    material_grade: MetalGradeCanonicalSchema,
    kind: z.enum(['absolute', 'delta_from_yesterday', 'unchanged']),
    quoted_amount: z.string().regex(/^-?\d+\.\d{2}$/).nullable(),
    quoted_unit: z.enum(['INR/kg', 'INR/metric_tonne']).nullable(),
  })
  .strict();

export const UnpricedMentionReasonSchema = z.enum([
  'out_of_stock',
  'quote_pending',
  'illegible_amount',
  'ambiguous_grade',
  'missing_kg_per_rod',
  'order_tier_unspecified',
]);

export const UnpricedMentionSchema = z
  .object({
    raw_fragment: z.string().min(1),
    reason: UnpricedMentionReasonSchema,
  })
  .strict();

export const DealerRateParsedSchema = z
  .object({
    quotes: z.array(DealerRateQuoteSchema),
    unpriced_mentions: z.array(UnpricedMentionSchema),
  })
  .strict();

export type DealerRateParsed = z.infer<typeof DealerRateParsedSchema>;

// =============================================================================
// 2. Production System Prompts
// =============================================================================

export const BILL_EXTRACTOR_SYSTEM_PROMPT = `You are the real-time billing draft extractor for a Tamil Nadu stud threading and fastener company.
Users speak or type in Tanglish (Tamil + English), Tamil, or English.

STRICT RULES:
1. Extract ONLY structured draft fields into valid JSON matching the requested schema.
2. NEVER calculate GST, CGST, SGST, IGST, line totals, or grand totals. Output raw extracted quantities, specs, and stated unit rates only.
3. Recognize fastener terminology accurately:
   - Diameters: M6, M8, M10, M12, M16, M20, M24, 1/2", 5/8", 3/4" (convert inches to mm only if explicitly requested, else preserve label).
   - Materials: MS (Mild Steel), EN8, EN19, SS 304, SS 316, Brass.
   - Thread types: Full Thread (full_thread), Double-End Stud (double_end), BSW, Metric, UNC.
   - Bill types: "job work" / "labour" / "thread mattum" / "rod avanga kuduthadhu" -> "job_work"; otherwise "supply".
   - Units: "pcs" / "piece" / "nos" -> "pcs"; "kg" / "kilo" -> "kg".
   - Freight: "to-pay" / "party pay" / "buyer to-pay" -> "buyer_to_pay"; "namma transport" / "prepaid" / "seller" -> "seller".
4. If quantity, rate, or customer is missing or ambiguous, set the field to null and append a clear warning code in warnings[].`;

export const METAL_RATE_PARSER_SYSTEM_PROMPT = `You are the daily rod metal-rate parser for a Tamil Nadu stud threading factory.
Dealers send morning rate updates in Tanglish, Tamil, or English over WhatsApp or Telegram.

STRICT RULES:
1. Extract ONLY valid JSON matching DealerRateParsedSchema ({ quotes, unpriced_mentions }).
2. Canonical grades are strictly in grade_order: "MS", "EN8", "EN19", "SS 304", "SS 316", "BRASS".
3. Classify each priced grade quote as:
   - "absolute" with quoted_unit "INR/kg" or "INR/metric_tonne"
   - "delta_from_yesterday" with signed quoted_amount (e.g. "4.00" or "-6.50") and quoted_unit "INR/kg"
   - "unchanged" with quoted_amount: null and quoted_unit: null
4. Collapse identical repeated quotes for the same grade within the same message and emit quotes in grade_order.
5. Put non-billable mentions into unpriced_mentions with the exact reason:
   "out_of_stock", "quote_pending", "illegible_amount", "ambiguous_grade", "missing_kg_per_rod", or "order_tier_unspecified".`;

// =============================================================================
// 3. Gemini Flash JSON Client with 3-Attempt Exponential Backoff Retry
// =============================================================================

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly code: 'UNCONFIGURED' | 'UPSTREAM_HTTP' | 'INVALID_JSON' | 'SCHEMA_MISMATCH',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

export function resolveGeminiApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.GEMINI_API_KEY?.trim() ||
    env.GEMINI_API_KEY_PRIMARY?.trim() ||
    env.GEMINI_API_KEY_FALLBACK?.trim() ||
    ''
  );
}

const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls Gemini Flash in strict JSON mode (`responseMimeType: "application/json"`),
 * retries up to 3 attempts with exponential backoff on HTTP 429/503 or network error,
 * and validates the parsed output against the supplied Zod schema.
 */
export async function callGeminiJson<T extends z.ZodType>(options: {
  systemInstruction: string;
  userPrompt: string;
  schema: T;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  baseDelayMs?: number;
  model?: string;
}): Promise<z.output<T>> {
  const apiKey = resolveGeminiApiKey(options.env);
  if (!apiKey) {
    throw new GeminiError('GEMINI_API_KEY is not configured on the server', 'UNCONFIGURED');
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 3, 5));
  const baseDelayMs = options.baseDelayMs ?? 150;
  const model = options.model ?? 'gemini-2.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: options.systemInstruction }],
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: options.userPrompt }],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0,
          },
        }),
      });

      if (!response.ok) {
        if (RETRYABLE_HTTP_STATUS.has(response.status) && attempt < maxAttempts) {
          await sleep(baseDelayMs * 2 ** (attempt - 1));
          continue;
        }
        throw new GeminiError(`Gemini API returned HTTP ${response.status}`, 'UPSTREAM_HTTP', response.status);
      }

      const payload = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const rawText = payload.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      let decoded: unknown;
      try {
        decoded = JSON.parse(rawText);
      } catch {
        throw new GeminiError('Gemini output was not valid JSON', 'INVALID_JSON');
      }

      const parsed = options.schema.safeParse(decoded);
      if (!parsed.success) {
        throw new GeminiError(
          `Gemini JSON violated schema: ${parsed.error.issues[0]?.message ?? 'invalid shape'}`,
          'SCHEMA_MISMATCH',
        );
      }
      return parsed.data;
    } catch (error) {
      lastError = error;
      if (error instanceof GeminiError && (error.code === 'INVALID_JSON' || error.code === 'SCHEMA_MISMATCH' || error.code === 'UPSTREAM_HTTP')) {
        throw error;
      }
      if (attempt < maxAttempts) {
        await sleep(baseDelayMs * 2 ** (attempt - 1));
        continue;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new GeminiError('Gemini request failed', 'UPSTREAM_HTTP');
}

// =============================================================================
// 4. Catalogue Resolution & Deterministic Tanglish Fastener Extractor
// =============================================================================

export interface ActiveCustomerRow {
  id: string;
  name: string;
}

export interface ActiveStudRow {
  id: string;
  sku_code: string;
  diameter_mm: number | string;
  length_mm: number | string;
  thread_type: string;
  material_grade: string;
}

const CORPORATE_SUFFIXES = new Set(['private', 'pvt', 'limited', 'ltd', 'llp', 'inc', 'co', 'company']);

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function customerAcronym(name: string): string {
  return name
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0 && !CORPORATE_SUFFIXES.has(word.toLowerCase()))
    .map((word) => word[0]!.toUpperCase())
    .join('');
}

/**
 * Resolves a spoken `customer_query` against active `public.customers` rows.
 * Matches exact name, leading word/phrase alias (e.g. "Vellaru" -> "Vellaru Pump Castings Private Limited"),
 * or non-suffix acronym (e.g. "BMS" -> "Bharathapuzha Mill Spares LLP").
 */
export function resolveCustomerFromCatalogue(
  customerQuery: string | null,
  customers: readonly ActiveCustomerRow[],
): string | null {
  if (!customerQuery) return null;
  const needle = normalizeText(customerQuery);
  if (!needle) return null;

  const exact = customers.filter((c) => normalizeText(c.name) === needle);
  if (exact.length === 1) return exact[0]!.id;

  const prefixMatches = customers.filter((c) => {
    const norm = normalizeText(c.name);
    return norm === needle || norm.startsWith(`${needle} `);
  });
  if (prefixMatches.length === 1) return prefixMatches[0]!.id;

  const acronymMatches = customers.filter(
    (c) => customerAcronym(c.name).toLowerCase() === needle,
  );
  if (acronymMatches.length === 1) return acronymMatches[0]!.id;

  return null;
}

function canonicalStudThread(stud: ActiveStudRow): z.infer<typeof ThreadTypeDraftSchema> | null {
  const t = stud.thread_type.toLowerCase();
  const sku = stud.sku_code.toUpperCase();
  if (t.includes('fully threaded') || t.includes('full_thread') || t.includes('full thread') || sku.endsWith('-FT')) {
    return 'full_thread';
  }
  if (t.includes('double-ended') || t.includes('double_end') || t.includes('double end') || sku.endsWith('-DE')) {
    return 'double_end';
  }
  if (t.includes('unc')) return 'UNC';
  if (t.includes('bsw')) return 'BSW';
  if (t.includes('metric')) return 'Metric';
  return null;
}

function canonicalMaterialDisplay(raw: string): z.infer<typeof MaterialGradeDraftSchema> | null {
  const upper = raw.trim().toUpperCase().replace(/\s+/g, ' ');
  if (upper === 'MS') return 'MS';
  if (upper === 'EN8' || upper === 'EN-8') return 'EN8';
  if (upper === 'EN19' || upper === 'EN-19') return 'EN19';
  if (upper === 'SS 304' || upper === 'SS304') return 'SS 304';
  if (upper === 'SS 316' || upper === 'SS316') return 'SS 316';
  if (upper === 'BRASS') return 'Brass';
  return null;
}

/**
 * Resolves an extracted line item against active `public.stud_items`.
 * Returns `{ studItemId, warningCode }`.
 */
export function resolveStudFromCatalogue(
  item: Omit<ParseBillItem, 'stud_item_id'>,
  studItems: readonly ActiveStudRow[],
): { studItemId: string | null; warningCode: 'ITEM_NOT_FOUND' | 'ITEM_AMBIGUOUS' | null } {
  const queryNorm = item.item_query.trim().toUpperCase();

  const matchesAllStatedSpecs = (stud: ActiveStudRow): boolean => {
    if (item.diameter !== null) {
      const mMatch = /^M(\d+(?:\.\d+)?)$/i.exec(item.diameter.trim());
      if (!mMatch) return false;
      if (Number(mMatch[1]) !== Number(stud.diameter_mm)) return false;
    }
    if (item.length_mm !== null) {
      if (Number(item.length_mm) !== Number(stud.length_mm)) return false;
    }
    if (item.material_grade !== null) {
      if (item.material_grade.toUpperCase() !== stud.material_grade.trim().toUpperCase()) return false;
    }
    if (item.thread_type !== null) {
      const studThread = canonicalStudThread(stud);
      if (studThread !== item.thread_type) return false;
    }
    return true;
  };

  // 1. Direct SKU match (must also agree with any stated specs)
  const skuMatches = studItems.filter(
    (s) => s.sku_code.trim().toUpperCase() === queryNorm && matchesAllStatedSpecs(s),
  );
  if (skuMatches.length === 1) {
    return { studItemId: skuMatches[0]!.id, warningCode: null };
  }

  // 2. Spec-based match
  const candidates = studItems.filter(matchesAllStatedSpecs);
  if (candidates.length === 0) {
    return { studItemId: null, warningCode: 'ITEM_NOT_FOUND' };
  }
  if (candidates.length > 1) {
    return { studItemId: null, warningCode: 'ITEM_AMBIGUOUS' };
  }

  // Unique candidate: require at least diameter, length_mm, and material_grade so
  // partial queries (like "M12 stud") never guess when a test DB has only 1 row.
  const hasCoreSpecs =
    item.diameter !== null &&
    item.length_mm !== null &&
    item.material_grade !== null;
  if (!hasCoreSpecs) {
    return { studItemId: null, warningCode: 'ITEM_AMBIGUOUS' };
  }
  return { studItemId: candidates[0]!.id, warningCode: null };
}

const TAMIL_NUMBER_WORDS: ReadonlyArray<[RegExp, string]> = [
  [/\birunooru\b/i, '200'],
  [/\birupathainju\b/i, '25'],
  [/\bpaththu\b/i, '10'],
  [/\baaru\b/i, '6'],
];

interface RawDraftItem {
  item_query: string;
  diameter: string | null;
  length_mm: string | null;
  material_grade: z.infer<typeof MaterialGradeDraftSchema> | null;
  thread_type: z.infer<typeof ThreadTypeDraftSchema> | null;
  quantity: string | null;
  billing_unit: 'pcs' | 'kg' | null;
  rate_mention: string | null;
  qtyWarning?: 'QUANTITY_MISSING' | 'QUANTITY_AMBIGUOUS' | 'PACKAGE_COUNT_UNRESOLVED';
  rateWarning?: 'RATE_MISSING' | 'RATE_AMBIGUOUS' | 'RATE_UNIT_MISMATCH';
}

interface RawDraftExtraction {
  bill_type: 'supply' | 'job_work';
  customer_query: string | null;
  items: RawDraftItem[];
  party_dc_no: string | null;
  delivery: z.infer<typeof ParseBillDeliverySchema>;
  extraWarnings: ParseBillWarning[];
}

function extractCustomerQuery(clean: string): string | null {
  // 1. "New party <Name>, supply..."
  const newParty = /\bNew\s+party\s+([A-Za-z][A-Za-z0-9\s]*?)(?=[,.;]|\s+supply\b|\s+job\s*work\b)/i.exec(clean);
  if (newParty?.[1]) return newParty[1].trim();

  // 2. Unnamed party ("Supply draft please. ... Party name call mudichuttu solren.")
  if (/^Supply\s+draft\b/i.test(clean) || /\bParty\s+name\b/i.test(clean)) {
    return null;
  }

  // 3. "<Customer> supply-ku" or "<Customer>-ku"
  const suffixKu = /^([A-Za-z][A-Za-z0-9\s]*?)(?:\s+supply)?-(?:ku|kku)\b/i.exec(clean);
  if (suffixKu?.[1]) {
    return suffixKu[1].trim();
  }

  // 4. Leading customer name before action/order keywords
  const leading = /^([A-Za-z][A-Za-z0-9\s]*?)(?=\s*(?:[,–-]|\b(?:order\s+supply|supply|sale\s+order|adhe\s+supply|wants\s+supply|job\s*work|party\s+DC)\b))/i.exec(clean);
  if (leading?.[1]) {
    const candidate = leading[1].trim();
    if (!/^(?:Supply|Job\s*work|MS|EN8|EN19|SS\s*304|SS\s*316|Brass)$/i.test(candidate)) {
      return candidate;
    }
  }

  return null;
}

function extractDeliveryDetails(clean: string): {
  delivery: z.infer<typeof ParseBillDeliverySchema>;
  freightPayerMissing: boolean;
} {
  let transport_mention: string | null = null;
  let vehicle_no: string | null = null;
  let freight_paid_by: 'seller' | 'buyer_to_pay' | null = null;
  let delivery_charge: z.infer<typeof ChargeMentionSchema> | null = null;
  let packing_charge: z.infer<typeof ChargeMentionSchema> | null = null;

  // Vehicle registration number (e.g. "TN 45 AB 2451" or "TN38AB1234")
  const vehMatch = /\b([A-Z]{2}\s+\d{1,2}\s+[A-Z]{1,3}\s+\d{3,4}|[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{3,4})\b/.exec(clean);
  if (vehMatch?.[1]) {
    vehicle_no = vehMatch[1].trim();
  }

  // Packing charge: "No packing charge" -> 0.00, or "Packing 75" / "Packing 45"
  const noPackingMatch = /\b(No\s+packing\s+charge)\b/i.exec(clean);
  const packingAmtMatch = /\b(Packing(?:\s+charge)?\s+(?:Rs\.?\s*)?(\d+(?:\.\d{1,2})?))\b/i.exec(clean);
  if (noPackingMatch?.[1]) {
    packing_charge = { mention: noPackingMatch[1], amount_inr: '0.00' };
  } else if (packingAmtMatch?.[1] && packingAmtMatch[2]) {
    packing_charge = {
      mention: packingAmtMatch[1],
      amount_inr: Number(packingAmtMatch[2]).toFixed(2),
    };
  }

  // Transport + freight charge mentions:
  // Pattern A: "<Vehicle> <amount> to-pay" (e.g., "Auto 300 to-pay", "lorry 250 to-pay")
  const vehicleToPayMatch = /\b((Auto|lorry|tempo)\s+(\d+(?:\.\d{1,2})?)\s+to-?pay)\b/i.exec(clean);
  // Pattern B: "<Vehicle> charge <amount>" (e.g., "Lorry charge 90")
  const vehicleChargeMatch = /\b((Lorry|Tempo|Auto)\s+charge\s+(\d+(?:\.\d{1,2})?))\b/i.exec(clean);
  // Pattern C: "freight <amount>" (e.g., "Tempo TN 45 AB 2451, freight 120 namma bill-la podu")
  const freightMatch = /\b(freight\s+(?:Rs\.?\s*)?(\d+(?:\.\d{1,2})?))\b/i.exec(clean);

  if (vehicleToPayMatch) {
    transport_mention = vehicleToPayMatch[2]!;
    freight_paid_by = 'buyer_to_pay';
    delivery_charge = {
      mention: vehicleToPayMatch[1]!,
      amount_inr: Number(vehicleToPayMatch[3]).toFixed(2),
    };
  } else if (vehicleChargeMatch) {
    transport_mention = vehicleChargeMatch[2]!;
    delivery_charge = {
      mention: vehicleChargeMatch[1]!,
      amount_inr: Number(vehicleChargeMatch[3]).toFixed(2),
    };
  } else if (freightMatch) {
    delivery_charge = {
      mention: freightMatch[1]!,
      amount_inr: Number(freightMatch[2]).toFixed(2),
    };
    const tMatch = /\b(Tempo|Lorry|Auto)\b/i.exec(clean);
    if (tMatch?.[1]) transport_mention = tMatch[1];
  }

  if (freight_paid_by === null) {
    if (/\bto-?pay\b|\bparty-kitta\s+vaanguvaaru\b|\banga\s+kaasu\s+kuduppaanga\b/i.test(clean)) {
      freight_paid_by = 'buyer_to_pay';
    } else if (/\bnamma\s+bill-la\s+podu\b|\bnamma\s+vandi\b|\bseller\s+freight\b/i.test(clean)) {
      freight_paid_by = 'seller';
    }
  }

  const freightPayerMissing =
    delivery_charge !== null &&
    Number(delivery_charge.amount_inr) > 0 &&
    freight_paid_by === null;

  return {
    delivery: {
      transport_mention,
      vehicle_no,
      freight_paid_by,
      delivery_charge,
      packing_charge,
    },
    freightPayerMissing,
  };
}

function parseItemFromClause(clause: string): RawDraftItem | null {
  const seg = clause.trim();
  if (!seg) return null;

  // 1. Check explicit SKU code (e.g. EN8-M16-125-DE)
  const skuMatch = /\b((?:MS|EN8|EN19|SS304|SS316|BRASS)-M\d+-\d+-(?:FT|DE))\b/i.exec(seg);

  // 2. Check descriptive item span:
  //    e.g. "MS M8 x 45 mm full thread", "EN8 M12 x 80 mm", "SS 304 half-inch UNC, 75 mm long", "M12 stud"
  const halfInchMatch = /\b((?:SS\s*304|SS\s*316|EN19|EN8|MS|Brass)\s+half-inch\s+(?:UNC|BSW),\s*\d+\s*mm\s+long)\b/i.exec(seg);
  const stdDescMatch = /\b((?:(?:SS\s*304|SS\s*316|EN19|EN8|MS|Brass)\s+)?M\d+(?:\s*x\s*\d+\s*mm)?(?:\s+(?:full\s+thread|double\s+end(?:ed)?|UNC|BSW))?(?:\s+stud)?)\b/i.exec(
    skuMatch ? seg.replace(skuMatch[1]!, ' ') : seg,
  );

  const item_query = skuMatch?.[1] ?? halfInchMatch?.[1] ?? stdDescMatch?.[1]?.trim() ?? null;
  if (!item_query) return null;

  // Spoken attributes: extract from the descriptive span (even when SKU was also spoken, as in V02!)
  const specSource = halfInchMatch?.[1] ?? stdDescMatch?.[1] ?? '';

  let material_grade: z.infer<typeof MaterialGradeDraftSchema> | null = null;
  const matMatch = /\b(SS\s*304|SS\s*316|EN19|EN8|MS|Brass)\b/i.exec(specSource);
  if (matMatch?.[1]) {
    material_grade = canonicalMaterialDisplay(matMatch[1]);
  }

  let diameter: string | null = null;
  if (/\bhalf-inch\b/i.test(specSource)) {
    diameter = '1/2"';
  } else {
    const inchMatch = /\b(\d+\/\d+)\s*(?:"|inch\b)/i.exec(specSource);
    const metricMatch = /\b(M\d+)\b/i.exec(specSource);
    if (inchMatch?.[1]) diameter = `${inchMatch[1]}"`;
    else if (metricMatch?.[1]) diameter = metricMatch[1].toUpperCase();
  }

  let length_mm: string | null = null;
  const lenMatch = /(?:x\s*(\d+)\s*mm|\b(\d+)\s*mm\s+long\b)/i.exec(specSource);
  if (lenMatch) {
    length_mm = (lenMatch[1] ?? lenMatch[2])!;
  }

  let thread_type: z.infer<typeof ThreadTypeDraftSchema> | null = null;
  if (/\bfull\s+thread\b/i.test(specSource)) thread_type = 'full_thread';
  else if (/\bdouble\s+end(?:ed)?\b/i.test(specSource)) thread_type = 'double_end';
  else if (/\bUNC\b/i.test(specSource)) thread_type = 'UNC';
  else if (/\bBSW\b/i.test(specSource)) thread_type = 'BSW';
  else if (/\bMetric\b/i.test(specSource)) thread_type = 'Metric';

  // Extract quantity & billing_unit from the clause
  let quantity: string | null = null;
  let billing_unit: 'pcs' | 'kg' | null = null;
  let qtyWarning: RawDraftItem['qtyWarning'];

  // 1) Self-correction: "80 pieces… illa illa, 90 pieces final"
  const qtyCorrectionMatch = /\b\d+\s*(?:pieces?|pcs)\s*(?:…|\.\.\.|,|\s)+\s*illa\s+illa,?\s*(\d+)\s*(pieces?|pcs|kilo|kg)\b/i.exec(seg);
  // 2) Competing counts: "50 pieces-aa 60 pieces-aa"
  const qtyAmbiguousMatch = /\b\d+\s*(pieces?|pcs|kilo|kg)-aa\s+\d+\s*(?:pieces?|pcs|kilo|kg)-aa\b/i.exec(seg);
  // 3) Box count: "rendu box" / "2 box"
  const boxMatch = /\b(?:rendu|\d+)\s*box\b/i.exec(seg);
  // 4) Missing pieces: "Pieces evlo-nu"
  const missingPiecesMatch = /\bPieces\s+evlo-nu\b/i.exec(seg);

  if (qtyCorrectionMatch) {
    quantity = qtyCorrectionMatch[1]!;
    billing_unit = /kg|kilo/i.test(qtyCorrectionMatch[2]!) ? 'kg' : 'pcs';
  } else if (qtyAmbiguousMatch) {
    quantity = null;
    billing_unit = /kg|kilo/i.test(qtyAmbiguousMatch[1]!) ? 'kg' : 'pcs';
    qtyWarning = 'QUANTITY_AMBIGUOUS';
  } else if (boxMatch) {
    quantity = null;
    billing_unit = null;
    qtyWarning = 'PACKAGE_COUNT_UNRESOLVED';
  } else if (missingPiecesMatch) {
    quantity = null;
    billing_unit = 'pcs';
    qtyWarning = 'QUANTITY_MISSING';
  } else {
    // Check numeric quantity ("12.75 kilo", "2,000 pieces", "18.125 kilo-ku", "40 pieces", "30 pieces of")
    const numQtyMatch = /\b(\d[\d,]*(?:\.\d+)?)\s*(pieces?|pcs|kilo|kg)(?:-ku|\b)/i.exec(seg);
    if (numQtyMatch) {
      quantity = numQtyMatch[1]!.replace(/,/g, '');
      billing_unit = /kg|kilo/i.test(numQtyMatch[2]!) ? 'kg' : 'pcs';
    } else {
      // Check Tamil number words ("irunooru piece", "irupathainju kilo", "paththu piece", "aaru pieces")
      for (const [wordRe, digits] of TAMIL_NUMBER_WORDS) {
        const tamilMatch = new RegExp(`${wordRe.source}\\s+(pieces?|pcs|kilo|kg)\\b`, 'i').exec(seg);
        if (tamilMatch) {
          quantity = digits;
          billing_unit = /kg|kilo/i.test(tamilMatch[1]!) ? 'kg' : 'pcs';
          break;
        }
      }
      if (!quantity) {
        qtyWarning = 'QUANTITY_MISSING';
      }
    }
  }

  // Extract rate_mention
  let rate_mention: string | null = null;
  let rateWarning: RawDraftItem['rateWarning'];

  const ratePatterns: ReadonlyArray<{
    regex: RegExp;
    group?: number;
    warning?: RawDraftItem['rateWarning'];
  }> = [
    // V13 correction: "cancel that, Rs 5.50 per piece final"
    { regex: /\bcancel\s+that,\s*(Rs\s+\d+(?:\.\d+)?\s+per\s+piece)\s+final\b/i },
    // V21 range: "They said 48 to 55 per piece"
    { regex: /\b(\d+(?:\.\d+)?\s+to\s+\d+(?:\.\d+)?\s+per\s+(?:piece|kg))\b/i, warning: 'RATE_AMBIGUOUS' },
    // V20 per-thousand: "Thousand pieces-ku Rs 1,200"
    { regex: /\b(Thousand\s+pieces-ku\s+Rs\s+[\d,]+(?:\.\d+)?)\b/i },
    // V01 / V04: "piece-ku moonu rooba paththu kaasu", "piece-ku rendu rooba ambadhu kaasu"
    { regex: /\b(piece-ku\s+[a-z\s]+?\s+kaasu)\b/i },
    // V15 / V19: "Piece-ku 3.10 rupees", "Piece-ku 15.06 rupees"
    { regex: /\b(Piece-ku\s+\d+(?:\.\d+)?\s+rupees)\b/ },
    // V02: "kilo-ku 168 rupees 50 paise"
    { regex: /\b(kilo-ku\s+\d+\s+rupees\s+\d+\s+paise)\b/i },
    // V17 / V18: "kilo-ku 77.50", "kilo-ku 77.51"
    { regex: /\b(kilo-ku\s+\d+(?:\.\d+)?)\b/i },
    // V05 / V09: "oru piece 51 rooba", "Oru piece 13 rooba"
    { regex: /\b([Oo]ru\s+piece\s+\d+(?:\.\d+)?\s+rooba)\b/ },
    // V14: "kilo rate 168.50"
    { regex: /\b(kilo\s+rate\s+\d+(?:\.\d+)?)\b/i },
    // V07: "piece rate 13"
    { regex: /\b(piece\s+rate\s+\d+(?:\.\d+)?)\b/i },
    // V08 / V22: "Rs 24.50 per piece", "Rs 14 per kilo"
    { regex: /\b(Rs\s+\d+(?:\.\d+)?\s+per\s+(?:piece|kilo|kg))\b/i },
    // V06 / V11 / V25: "Rs 15.50 each", "Rs 14 each", "Rs 18 each"
    { regex: /\b(Rs\s+\d+(?:\.\d+)?\s+each)\b/i },
    // V16: "77.49 per kg"
    { regex: /\b(\d+(?:\.\d+)?\s+per\s+(?:kg|piece))\b/i },
    // V24: "each 128 rupees", "each 12.97"
    { regex: /\b(each\s+\d+(?:\.\d+)?(?:\s+rupees)?)\b/i },
    // V03 / V10 / V23 / V24 / V25: "13 rupees each", "226 rupees each", "18 each", "15.50 each", "46 each", "76 each", "186 each"
    { regex: /\b(\d+(?:\.\d+)?(?:\s+rupees)?\s+each)\b/i },
  ];

  for (const pat of ratePatterns) {
    const m = pat.regex.exec(seg);
    if (m?.[pat.group ?? 1]) {
      rate_mention = m[pat.group ?? 1]!.trim();
      if (pat.warning) rateWarning = pat.warning;
      break;
    }
  }

  if (rate_mention === null) {
    rateWarning = 'RATE_MISSING';
  } else if (!rateWarning && billing_unit) {
    const ratePerKg = /\b(?:kilo\s+rate|kilo-ku|per\s+(?:kg|kilo))\b/i.test(rate_mention);
    const ratePerPc = /\b(?:piece\s+rate|piece-ku|oru\s+piece|per\s+piece|each)\b/i.test(rate_mention);
    if ((billing_unit === 'pcs' && ratePerKg) || (billing_unit === 'kg' && ratePerPc)) {
      rateWarning = 'RATE_UNIT_MISMATCH';
    }
  }

  return {
    item_query,
    diameter,
    length_mm,
    material_grade,
    thread_type,
    quantity,
    billing_unit,
    rate_mention,
    ...(qtyWarning ? { qtyWarning } : {}),
    ...(rateWarning ? { rateWarning } : {}),
  };
}

function splitTranscriptIntoItemClauses(clean: string): string[] {
  // Multi-line indicators in transcripts:
  // - V03: "... 13 rupees each. Then SS 304 half-inch UNC..."
  // - V24: "... each 128 rupees. Next Brass M8 x 40 mm... Innum oru line, EN8 M18 x 140 mm..."
  // - V25: "... Rs 18 each. SS 304 M16 x 150 mm 2 pieces at 76 each and SS 304 M22 x 200 mm 1 piece at 186 each."
  // Note: Do not split after a bare SKU sentence like "sticker says EN8-M16-125-DE. EN8 M16 x 125 mm..." (V02).
  const rawParts = clean
    .split(
      /(?:\.\s+(?=Then\s+|Next\s+|Innum\s+oru\s+line,\s*)|\b(?:each|rooba|rupees)\.\s+(?=(?:SS\s*304|SS\s*316|EN19|EN8|MS|Brass)\s+M\d+)|\s+and\s+(?=(?:SS\s*304|SS\s*316|EN19|EN8|MS|Brass)\s+M\d+))/i,
    )
    .map((s) => s.trim())
    .filter(Boolean);

  // Restore the trailing rate word ("each" / "rooba" / "rupees") if consumed by the split boundary
  const parts: string[] = [];
  let cursor = 0;
  for (const part of rawParts) {
    const idx = clean.indexOf(part, cursor);
    if (idx > cursor) {
      const gap = clean.slice(cursor, idx);
      const wordMatch = /\b(each|rooba|rupees)\.\s*$/i.exec(gap);
      if (wordMatch?.[1] && parts.length > 0) {
        parts[parts.length - 1] = `${parts[parts.length - 1]} ${wordMatch[1]}`;
      }
    }
    parts.push(part);
    if (idx >= 0) cursor = idx + part.length;
  }

  return parts.length > 0 ? parts : [clean];
}

export function extractRawBillDraft(text: string): RawDraftExtraction {
  const clean = text.trim();

  const isJobWork = /\b(job\s*work|labour|thread(?:ing)?\s+mattum|party\s+DC)\b/i.test(clean);
  const bill_type: 'supply' | 'job_work' = isJobWork ? 'job_work' : 'supply';

  const dcMatch = /\bparty\s+DC\s+([A-Z0-9/-]+?)(?=[.,;\s]|$)/i.exec(clean);
  const party_dc_no = dcMatch ? dcMatch[1]! : null;

  const customer_query = extractCustomerQuery(clean);
  const { delivery, freightPayerMissing } = extractDeliveryDetails(clean);

  const extraWarnings: ParseBillWarning[] = [];
  if (freightPayerMissing) {
    extraWarnings.push({ code: 'FREIGHT_PAYER_MISSING', path: 'delivery.freight_paid_by' });
  }
  if (/\b(?:make\s+grand\s+total|grand\s+total|total\s+bill)\b/i.test(clean)) {
    extraWarnings.push({ code: 'BILL_TOTAL_IGNORED', path: 'transcript' });
  }

  const clauses = splitTranscriptIntoItemClauses(clean);
  const items: RawDraftItem[] = [];
  for (const clause of clauses) {
    const parsed = parseItemFromClause(clause);
    if (parsed) items.push(parsed);
  }
  if (items.length === 0) {
    const fallback = parseItemFromClause(clean);
    if (fallback) items.push(fallback);
  }

  return {
    bill_type,
    customer_query,
    items,
    party_dc_no,
    delivery,
    extraWarnings,
  };
}

/**
 * Full server-side Tanglish/Tamil/English bill draft parser and catalogue resolver.
 * Uses Gemini Flash in JSON mode when configured (or when a custom `fetchImpl` is injected),
 * and deterministically resolves all database foreign keys (`customer_id`, `stud_item_id`)
 * and structured warning paths.
 */
export async function parseBillTranscript(options: {
  text: string;
  customers: readonly ActiveCustomerRow[];
  studItems: readonly ActiveStudRow[];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<ParseBillResponse> {
  const { text, customers, studItems } = options;

  const hasGeminiKey = Boolean(resolveGeminiApiKey(options.env));
  if (options.fetchImpl || hasGeminiKey) {
    const catalogueSummary = JSON.stringify({
      customers: customers.map((c) => ({ id: c.id, name: c.name })),
      stud_items: studItems.map((s) => ({
        id: s.id,
        sku_code: s.sku_code,
        diameter_mm: Number(s.diameter_mm),
        length_mm: Number(s.length_mm),
        material_grade: s.material_grade,
        thread_type: s.thread_type,
      })),
    });

    return callGeminiJson({
      systemInstruction: BILL_EXTRACTOR_SYSTEM_PROMPT,
      userPrompt: `Catalogue:\n${catalogueSummary}\n\nTranscript:\n${text}`,
      schema: ParseBillResponseSchema,
      ...(options.env ? { env: options.env } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  const raw = extractRawBillDraft(text);
  const warnings: ParseBillWarning[] = [];

  const customer_id = resolveCustomerFromCatalogue(raw.customer_query, customers);
  if (raw.customer_query === null) {
    warnings.push({ code: 'CUSTOMER_MISSING', path: 'customer_id' });
  } else if (customer_id === null) {
    warnings.push({ code: 'CUSTOMER_NOT_FOUND', path: 'customer_id' });
  }

  const resolvedItems: ParseBillItem[] = raw.items.map((item, idx) => {
    const { studItemId, warningCode } = resolveStudFromCatalogue(item, studItems);
    if (warningCode) {
      warnings.push({ code: warningCode, path: `items[${idx}].stud_item_id` });
    }
    if (item.qtyWarning) {
      warnings.push({ code: item.qtyWarning, path: `items[${idx}].quantity` });
    }
    if (item.rateWarning) {
      warnings.push({ code: item.rateWarning, path: `items[${idx}].rate_mention` });
    }
    return {
      item_query: item.item_query,
      stud_item_id: studItemId,
      diameter: item.diameter,
      length_mm: item.length_mm,
      material_grade: item.material_grade,
      thread_type: item.thread_type,
      quantity: item.quantity,
      billing_unit: item.billing_unit,
      rate_mention: item.rate_mention,
    };
  });

  warnings.push(...raw.extraWarnings);

  return ParseBillResponseSchema.parse({
    bill_type: raw.bill_type,
    customer_query: raw.customer_query,
    customer_id,
    items: resolvedItems,
    party_dc_no: raw.party_dc_no,
    delivery: raw.delivery,
    warnings,
  });
}

// =============================================================================
// 5. Deterministic + Gemini Dealer Metal-Rate Message Parser
// =============================================================================

export const CANONICAL_METAL_GRADES: readonly MetalGradeCanonical[] = [
  'MS',
  'EN8',
  'EN19',
  'SS 304',
  'SS 316',
  'BRASS',
] as const;

function matchLeadingGrade(text: string): { grade: MetalGradeCanonical; matchedLen: number } | null {
  const patterns: ReadonlyArray<[MetalGradeCanonical, RegExp]> = [
    ['SS 304', /^(?:S\.?\s*S\.?[\s-]*304|304[\s-]*S\.?\s*S\.?)(?:\s+rod|\s+round|\s+rnd)?\b/i],
    ['SS 316', /^(?:S\.?\s*S\.?[\s-]*316|316[\s-]*S\.?\s*S\.?)(?:\s+rod|\s+round|\s+rnd)?\b/i],
    ['EN19', /^EN[\s-]*19(?:\s+rod|\s+round|\s+rnd)?\b/i],
    ['EN8', /^EN[\s-]*8(?:\s+rod|\s+round|\s+rnd)?\b/i],
    ['BRASS', /^(?:Brass|BRS)(?:\s+extrusion\s+rod|\s+round|\s+rnd|\s+rod)?\b/i],
    ['MS', /^M\.?\s*S\.?(?:\s+round|\s+rnd|\s+bright|\s+rod)?\b/i],
  ];
  for (const [grade, regex] of patterns) {
    const m = regex.exec(text);
    if (m) return { grade, matchedLen: m[0].length };
  }
  return null;
}

/**
 * Parses a dealer WhatsApp/Telegram rate message into `DealerRateParsed` (`{ quotes, unpriced_mentions }`).
 * Uses Gemini Flash in JSON mode when `GEMINI_API_KEY` or `fetchImpl` is supplied,
 * or deterministic extraction when running offline/locally.
 */
export async function parseDealerRateMessage(options: {
  rawText: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<DealerRateParsed> {
  const hasGeminiKey = Boolean(resolveGeminiApiKey(options.env));
  if (options.fetchImpl || hasGeminiKey) {
    return callGeminiJson({
      systemInstruction: METAL_RATE_PARSER_SYSTEM_PROMPT,
      userPrompt: options.rawText,
      schema: DealerRateParsedSchema,
      ...(options.env ? { env: options.env } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  const raw = options.rawText.trim();
  const quotes: z.infer<typeof DealerRateQuoteSchema>[] = [];
  const unpriced_mentions: z.infer<typeof UnpricedMentionSchema>[] = [];
  const seenQuotes = new Set<string>();

  const pushQuote = (q: z.infer<typeof DealerRateQuoteSchema>) => {
    const key = `${q.material_grade}|${q.kind}|${q.quoted_amount ?? 'null'}|${q.quoted_unit ?? 'null'}`;
    if (seenQuotes.has(key)) return;
    seenQuotes.add(key);
    quotes.push(q);
  };

  // Split into sentence/line fragments
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    // 1. Check multi-grade unchanged sentence (e.g. "EN 8 / eN19 / ss316 — moonum nethu rate thaan, no chnge. MS round stock illa.")
    const multiUnchangedMatch = /((?:(?:EN\s*8|eN\s*19|ss\s*316|ss\s*304|MS|Brass)\s*\/\s*)+(?:EN\s*8|eN\s*19|ss\s*316|ss\s*304|MS|Brass))\s*[—–-]\s*[^.]*\b(?:nethu\s+rate|no\s+ch(?:a)?nge|unchanged)\b/i.exec(line);
    let remainingLine = line;
    if (multiUnchangedMatch?.[1]) {
      const gradeTokens = multiUnchangedMatch[1].split('/').map((s) => s.trim());
      for (const tok of gradeTokens) {
        const g = matchLeadingGrade(tok);
        if (g) {
          pushQuote({
            material_grade: g.grade,
            kind: 'unchanged',
            quoted_amount: null,
            quoted_unit: null,
          });
        }
      }
      remainingLine = line.replace(multiUnchangedMatch[0], ' ');
    }

    // 2. Check tiered/conditional quote spanning a comma (e.g. "EN8 retail 90/kg, 200kg mela 86/kg boss.")
    const tierMatch = /\b((?:MS|EN[\s-]*8|EN[\s-]*19|SS\s*304|SS\s*316|Brass)\s+retail\s+\d+(?:\.\d+)?\/kg,\s*\d+\s*kg\s+mela\s+\d+(?:\.\d+)?\/kg)\b/i.exec(remainingLine);
    if (tierMatch?.[1]) {
      unpriced_mentions.push({
        raw_fragment: tierMatch[1].trim(),
        reason: 'order_tier_unspecified',
      });
      remainingLine = remainingLine.replace(tierMatch[0], ' ');
    }

    // Split remaining line by pipe "|", slash " / " (between grade segments), semicolon, period, or comma before a grade
    const segments = remainingLine
      .replace(/^Sir\s+mill\s+list\s+\d+\/\d+:\s*/i, '')
      .replace(/^Fwd\s+frm\s+counter:\s*/i, '')
      .replace(/^[🔔👋🙏⬇️🔥]+\s*/u, '')
      .replace(/^Innaiku\s+konjam\s+down\s+sir\s*[⬇️]*\s*/iu, '')
      .split(/\s*(?:\||;|\.\s+|\s+\/\s+(?=(?:316\s*ss|304\s*ss|s\.?s\.?[\s-]*304|s\.?s\.?[\s-]*316|brs|brass|en|ms)\b)|,(?=\s*(?:M\.?\s*S\.?|EN[\s-]*8|EN[\s-]*19|S\.?\s*S\.?(?:[\s-]*304|[\s-]*316)?|304\s*S\.?\s*S\.?|316\s*S\.?\s*S\.?|Brass|BRS)\b))\s*/i)
      .map((s) => s.trim().replace(/[.]+$/, '').trim())
      .filter(Boolean);

    for (const seg of segments) {
      // Check per-rod quote (e.g. "EN8 ₹830/rod, weight apram solren")
      const rodMatch = /\b((?:MS|EN[\s-]*8|EN[\s-]*19|SS\s*304|SS\s*316|Brass)\s+(?:₹|Rs\.?\s*)?\d+(?:\.\d+)?\/rod,\s*weight\s+apram\s+solren)\b/i.exec(seg);
      if (rodMatch?.[1]) {
        unpriced_mentions.push({
          raw_fragment: rodMatch[1].trim(),
          reason: 'missing_kg_per_rod',
        });
        continue;
      }

      // Check ambiguous SS / EN grade without number (e.g. "SS ₹220/kg (grade therila)")
      const ambigMatch = /\b(SS\s+(?:₹|Rs\.?\s*)?\d+(?:\.\d+)?\/kg(?:\s*\(grade\s+therila\))?)/i.exec(seg);
      if (ambigMatch?.[1]) {
        unpriced_mentions.push({
          raw_fragment: ambigMatch[1].trim(),
          reason: 'ambiguous_grade',
        });
        continue;
      }

      const gMatch = matchLeadingGrade(seg);
      if (!gMatch) continue;
      const { grade, matchedLen } = gMatch;
      const tail = seg.slice(matchedLen).trim();

      // Unpriced checks
      if (/\b(?:stock\s+illa|no\s+stock|out\s+of\s+stock)\b/i.test(tail)) {
        unpriced_mentions.push({ raw_fragment: seg, reason: 'out_of_stock' });
        continue;
      }
      if (/\b(?:quote\s+evening|will\s+confirm|rate\s+later|evening\s+solren)\b/i.test(tail)) {
        unpriced_mentions.push({ raw_fragment: seg, reason: 'quote_pending' });
        continue;
      }
      if (/\d*\?\d*(?:\.\d+)?\/kg/i.test(tail)) {
        const fragMatch = /^([A-Za-z0-9.\s]+\d*\?\d*(?:\.\d+)?\/kg)/i.exec(seg);
        unpriced_mentions.push({
          raw_fragment: (fragMatch?.[1] ?? seg).trim(),
          reason: 'illegible_amount',
        });
        continue;
      }

      // Delta from yesterday (e.g. "inniku nethu rate mela +₹4/kg boss...")
      const deltaMatch = /([+-])\s*(?:₹|Rs\.?\s*)?(\d+(?:\.\d{1,2})?)\s*\/(?:kg|kilo)\b/i.exec(tail);
      if (deltaMatch) {
        const sign = deltaMatch[1] === '-' ? '-' : '';
        pushQuote({
          material_grade: grade,
          kind: 'delta_from_yesterday',
          quoted_amount: `${sign}${Number(deltaMatch[2]).toFixed(2)}`,
          quoted_unit: 'INR/kg',
        });
        continue;
      }

      // Metric tonne quote (e.g. "₹1,20,500/MT", "₹2,10,000 per metric tonne")
      const mtMatch = /(?:₹|Rs\.?\s*)?([\d,]+(?:\.\d{1,2})?)\s*(?:\/|\s+per\s+)(?:MT|metric\s+tonne|tonne)\b/i.exec(tail);
      if (mtMatch?.[1]) {
        const amount = Number(mtMatch[1].replace(/,/g, ''));
        if (Number.isFinite(amount) && amount > 0) {
          pushQuote({
            material_grade: grade,
            kind: 'absolute',
            quoted_amount: amount.toFixed(2),
            quoted_unit: 'INR/metric_tonne',
          });
          continue;
        }
      }

      // INR/kg quote (e.g. "58.25", "– 86 exact", "328/- kg", "₹764.25/kilo ready", "Rs 63.25/kg ex yard", "88/kg confirm 👍")
      const kgMatch = /^(?:[–-]\s*)?(?:₹|Rs\.?\s*)?(\d+(?:\.\d{1,2})?)\s*(?:\/-\s*kg|\/kg|\/kilo|per\s+kg|\bexact\b|\bready\b|\bconfirm\b|\bex\s+yard\b|$)/i.exec(tail);
      if (kgMatch?.[1]) {
        const amount = Number(kgMatch[1]);
        if (Number.isFinite(amount) && amount > 0) {
          pushQuote({
            material_grade: grade,
            kind: 'absolute',
            quoted_amount: amount.toFixed(2),
            quoted_unit: 'INR/kg',
          });
        }
      }
    }
  }

  // Emit recognized grades strictly in grade_order: ['MS', 'EN8', 'EN19', 'SS 304', 'SS 316', 'BRASS']
  quotes.sort(
    (a, b) =>
      CANONICAL_METAL_GRADES.indexOf(a.material_grade) -
      CANONICAL_METAL_GRADES.indexOf(b.material_grade),
  );

  return DealerRateParsedSchema.parse({
    quotes,
    unpriced_mentions,
  });
}
