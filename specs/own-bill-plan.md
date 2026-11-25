# Own Bill Implementation Plan

> **How it is carried out:** in this session, task by task, test first, by one agent. The owner has ruled out reviewer sub-agents and mutation testing. Nothing is committed, migrated or deployed until the owner says so.

**Goal:** the bill and the challan print (A4, A5) and go to Drive (PDF) as the owner's own printed bill.

**Architecture:** `print-documents.ts` turns an issued bill into what must be said; `bill-sheets.ts` draws that as pages of three kinds of marks (text, line, path) in frame units; `components/sheets.tsx` writes the pages as SVG and `sheet-pdf.ts` as PDF. All but the component are pure and have no library.

**Tech Stack:** Next.js 16, TypeScript strict, Zod 4, Supabase Postgres (PGlite in tests), Vitest 5.

**Spec:** `specs/own-bill.md`, `specs/print-templates.md`.

## Global Constraints

- `tests/billing-math.test.ts` and migrations `001`–`004` are not touched. 007 is a new file; 005 and 006 stay as they are.
- No real GSTIN, bank, phone or address anywhere in code, tests, specs.
- Arithmetic only in `billing-math.ts`; the print formats issued figures.
- An old bill (no P.O., snapshot without the new company keys) and an old queued bill or draft keep working.
- Print route stays a Server Component; no new client JavaScript on it; `/billing` first load ≤ 170 KB.

## Review Focus

1. **A very long value** (500-character address, 120-character name, 300-character description, ₹12,03,72,319.00, 40-character P.O.): inside its box, nothing overlapping, nothing cut.
2. **A bill queued before the update and answered after it**: same payload, same fingerprint, no "different content".
3. **Closing block at the end of a full page**: moves as a whole, never alone on a page without an item row.
4. **Two or more GST rates, with and without charges**: every rate with its base once; the rows still add up to the total.
5. **Letters Helvetica does not have** (Tamil customer, ₹, ×, “ ”): printed as they are on paper, readable in the PDF, never an empty name, never a broken file.

---

### Task 1: Database — migration 007

**Files:** Create `supabase/migrations/007_own_bill.sql`, `tests/db/own-bill.test.ts`. Modify `src/app/api/cron/weekly-backup/route.ts` (CSV column lists).

**Produces:** `company_profile.tagline text`, `.factory_address text`, `.office_phone text`; `invoices.po_no text`, `.po_date date`, constraint `invoices_po_date_needs_no`; `public.sync_invoice` reading `po_no`, `po_date`.

- [x] Tests: a bill with P.O. stores both; blank → null; date without number → 23514; number over 40 → 23514; `po_date` not `YYYY-MM-DD` → 22023; payload without the keys gives the same row and replays as before; P.O. cannot be changed after issue (23514); the snapshot has the three company keys; staff cannot change the company; text limits of the three columns.
- [x] See them fail → write 007 → see them pass → `npm run db:verify`.

### Task 2: P.O. and company in schemas, reads, drafts

**Files:** Modify `src/lib/schemas/invoices.ts`, `src/lib/schemas/masters.ts`, `src/lib/schemas/books.ts`, `src/lib/data.ts`, `src/lib/bill-draft.ts`, `src/lib/bill-form.ts`, `src/lib/month-data.ts`, `src/lib/month-workbook.ts`. Tests: `tests/bill-form.test.ts`, `tests/api/routes.test.ts`, `tests/month-workbook.test.ts`, `tests/offline.test.ts`.

**Produces:** `BillDraft.po_no: string | null`, `.po_date: string | null`; `BillForm.poNo: string`, `.poDate: string`; `invoiceRow.po_no/po_date`; supplier snapshot `tagline | factory_address | office_phone: string | null` (missing → null); `companyInput`/`companyRow` with the three fields; Excel *Bills* columns `P.O. no`, `P.O. date` after `DC no`.

- [x] Tests: `buildSyncPayload` has no `po_no` key when there is none; a draft stored without the keys parses; a form stored without them revives; a date typed without a number is not sent; a P.O. alone makes the form worth keeping; workbook cells.

### Task 3: Measuring and drawing

**Files:** Create `src/lib/text-width.ts`, `src/lib/sheet.ts`, `src/lib/bill-art.ts`, `tests/sheet.test.ts`.

**Produces:**
- `textWidth(text: string, face: Face, size: number): number`
- `wrap(text: string, face: Face, size: number, width: number): string[]`
- `type Op = TextOp | LineOp | PathOp`, `interface Sheet { key: string; label: string; ops: Op[] }`, `FRAME = { width: 100, height: 145.6 }`
- `class Pen { ops; text(…); line(…); box(…); art(…) }`
- `GEAR: Art`, `VEL: Art`

- [x] Tests: known widths; wrap keeps every character, breaks an over-long word, keeps typed line breaks; a text with `max` is never wider than it; a box path closes.

### Task 4: What the bill says

**Files:** Rewrite `src/lib/print-documents.ts`. Tests: `tests/print.test.ts` (acceptance cases of `print-templates.md`).

**Produces:** `PrintDocument` (kind, title, subtitle, issuer, refs, to, notes, columns, items, sums, rows, facts, total, words, bank, signatures, cancelled), `buildDocuments(doc, options)`.

### Task 5: The drawing of it

**Files:** Create `src/lib/bill-sheets.ts`, `tests/bill-sheets.test.ts`.

**Produces:** `billSheets(documents: readonly PrintDocument[]): Sheet[]`.

- [x] Tests, over a set of hard bills (Review Focus 1, 3, 4): every mark inside the frame; no text over another text; no vertical line through a text; every description, amount and number exactly once per copy; nine rows on a small bill; closing together with a row above it; "Page 1 of 2"; CANCELLED.

### Task 6: SVG, PDF, pages

**Files:** Create `src/components/sheets.tsx`, `src/lib/sheet-pdf.ts`, `src/lib/latin.ts`, `tests/sheet-output.test.ts`. Modify `src/app/invoices/[id]/print/page.tsx`, `print.css`, `src/lib/drive-backup.ts`, `tests/drive-vault.test.ts`, `specs/print-templates.md`. Delete `src/components/print-packet.tsx`.

**Produces:** `Sheets({ sheets, paper })`, `sheetsToPdf(sheets: readonly Sheet[], title: string): Uint8Array`.

- [x] Tests: markup is text; one page per sheet; PDF cross-reference table points at its objects, A4, one page per sheet; brackets and backslashes escaped; Tamil name readable; the same bill gives the same bytes.

### Task 7: Company page, billing screen, bill page

**Files:** Create `src/lib/sample-bill.ts`. Modify `src/app/(app)/company/form.tsx`, `page.tsx`, `src/app/(app)/billing/screen.tsx`, `src/app/(app)/invoices/[id]/page.tsx`.

- [x] P.O. no beside Due, Enter passes it by; its date box appears with a number. Company page shows a sample bill with the saved details.

### Task 8: Papers and proof

**Files:** `CLAUDE.md`, `specs/golive-runbook.md`.

- [x] Full gate (tests, db:verify, typecheck, lint, build, first load), frozen hashes, no private value in any changed file. Practice copy: print every kind of bill with a real browser to PDF, A4 and A5, page counts right; compare with the Drive PDF page by page; black and white; phone width.
