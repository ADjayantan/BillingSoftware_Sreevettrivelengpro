# Company Products Implementation Plan

> **How it is carried out:** by one person/agent in this session, task by task, test first. The owner has ruled out reviewer sub-agents and mutation testing. Nothing is committed, migrated or deployed until the owner says so.

**Goal:** one product list in which every product gets an ID from the database, can be called by that ID in a bill, and every GST % was typed by a person.

**Architecture:** `stud_items` becomes the product list (migration 005: identity column, name, optional size). Everything about names, IDs and finding lives in one pure module used by the server, the screen and the PC's copy. The bill form keeps its shape and learns where each GST % came from.

**Tech Stack:** Next.js 16, TypeScript strict, Zod 4, Supabase Postgres (PGlite in tests), Dexie 4, Vitest 5.

**Spec:** `specs/company-products.md` (approved 24 Nov 2026).

## Global Constraints

- `tests/billing-math.test.ts` and migrations `001`–`004` are not touched.
- Product ID: `P` + at least 4 digits (`P0001`, `P12345`). Never typed, changed or reused.
- A product needs a name, HSN and GST %. A stud (all of diameter, length, thread, grade, weight) may go without a name.
- GST % starts empty on a new product and on a hand-typed line; without it the bill cannot be saved.
- Searching: the ID is an exact match and comes first; then own code; then part of name, code or size. Same online and offline.
- A product without a size: pieces ↔ kg only with a typed kg per piece; left out of margin check and AI fill.
- Issued bills, RLS, edit log and links from bills stay as they are. The running version must keep working after 005.
- Dexie stays at version 1 (no new index).

## Review Focus

1. **A number that is no product's ID** (`45` when there is no P0045, but a name contains 45): Enter must not take another product, and the bill must not go out with "45" as its item.
2. **Typing another item over a picked product's text**: the old product's GST %, rate and HSN must not stay on the hand-typed item.
3. **A product with one rate only, unit switched** (₹/piece known, kg chosen): the piece rate must not stay as the kg rate.
4. **A PC that still holds last version's copy or draft** (rows without ID or name): opens, finds by code, refetches once.
5. **An own code that looks like an ID** (`P0007` typed for product 3): refused, so product 7 can never be blocked or confused.

---

### Task 1: Database — migration 005

**Files:** Create `supabase/migrations/005_products.sql`, `tests/db/products.test.ts`. Modify `tests/db/schema.test.ts` (helper list, inserts now give HSN/GST), `tests/db/billing-math-alignment.test.ts` (insert), `scripts/seed.ts` (GST written out).

**Produces:** columns `product_no integer generated always as identity` (unique), `name text`, `search_text` (generated, upper case: name, code, `M8X45 MS`); nullable `diameter_mm, length_mm, thread_type, material_grade, unit_weight_kg`; no defaults on `hsn_sac`, `gst_rate_percent`; `private.product_code(integer) → text`; constraints `stud_items_product_no_key`, `stud_items_kind`, `stud_items_own_code`; trigger `stud_items_identify`.

- [x] Tests: IDs run on 1, 2, 3 for studs and others alike; a deleted ID is not given again; insert with `product_no` → 428C9; update of it → 428C9; `set product_no = default` keeps the old; empty code → `P000n` on insert and on edit; code `P0099` refused (23514); no name and no size refused; part of a size refused; weight without size only when manual; no GST or HSN → 23502; `search_text` follows edits; rows that existed before 005 keep everything and get IDs; the sequence grants nothing on either platform default; edit log has the name.
- [x] See them fail → write 005 → see them pass → `npm run db:verify`.

### Task 2: Names, IDs and finding — pure module, schemas, weights

**Files:** Create `src/lib/products.ts`, `tests/products.test.ts`. Modify `src/lib/schemas/masters.ts`, `src/lib/billing-math.ts` (`WeightSpec` sizes may be null with a measured weight).

**Produces:**
- `productCode(no: number): string`, `typedProductNo(q: string): number | null` (`'7'`, `'p7'`, `'P0007'`)
- `ownCode(p: StudItem): string | null`, `isStud(p): boolean`, `isService(p): boolean` (HSN/SAC starts with 99)
- `productName(p): string` (the name, else `Stud <code> · M8 × 45 mm · MS · <thread>`), `lineText(p, type): string`, `productLabel(p): string` (`P0002 · …`), `productDetail(p): string`
- `findRank(p, q): 0 | 1 | 2 | 3` (ID, own code, part, not found), `revivedProduct(kept): StudItem`
- `StudItem` gains `product_no: number`, `name: string | null`, `search_text: string`; sizes and weight become `string | null`
- `studItemInput`: code optional, GST `Type the GST %`, code like an ID refused, size all or none, name or size

### Task 3: Routes and reads

**Files:** Modify `src/lib/data.ts`, `src/lib/api/http.ts`, `tests/support/postgrest.ts` (`neq`, `not.is.null`), `tests/api/routes.test.ts`.

**Consumes:** Task 2. **Produces:** `STUD_COLUMNS` with the new columns; `listStudItems` (ID first, then by ID; pages stay complete); `studRecord` with a null weight for a product without one.

- [x] Tests: create with only name, HSN, GST → 201, `product_no` from the database even when one was sent, `sku_code` = the ID; `?q=2`, `p2`, `P0002` give product 2 first; name part and code part find; page 2 of an ID search misses and repeats nothing; missing GST → 400 with the words; code `P0099` → 400; duplicate code → 409 `Another product already has this code`.

### Task 4: Search and the PC's copy

**Files:** Modify `src/lib/master-search.ts`, `src/lib/master-cache.ts`, `src/lib/offline-db.ts` (`CacheState.shape?`), `src/components/typeahead.tsx`, `tests/offline.test.ts`.

**Produces:** `Option.loose?: true` (a guess; Enter alone never takes it); `cachedStuds` ranked like the cloud; a copy of an older shape is fetched again in full.

- [x] Tests: `2`, `p2`, `P0002`, name and code give the same options online and offline; a number that is no ID gives loose options only; rows of the old shape are still found by code and then refetched once.

### Task 5: Bill form — GST % by hand

**Files:** Modify `src/lib/bill-form.ts`. Create `tests/bill-form.test.ts`. Modify helpers in `tests/print.test.ts`, `tests/offline.test.ts`.

**Produces:** `FormLine.gstFrom: '' | 'hand' | 'above' | 'product'`; `typeGst(line, text)`, `typeText(line, text, type)`; `blankLine` with empty GST.

- [x] Tests: new line empty; blank line below follows a hand-typed GST and stops following once typed into; a product's GST is not copied down; `18%` is 18; missing / `abc` / `118` refused in words; `45` without product refused; picking fills name, HSN, GST, unit, rate; in job work goods fill only the text, a labour item (SAC 99…) fills all; typing over a product drops what it filled, small edits keep it; one-rate product and unit switch; switching supply ↔ job work drops and brings back a product's GST; a draft of the old version opens with its GST; a product without size gives no weight, with kg per piece it does.

### Task 6: AI, margin check, backup

**Files:** Modify `src/app/api/ai/parse-bill/route.ts`, `src/app/api/ai/margin-check/route.ts`, `src/app/api/cron/weekly-backup/route.ts`, `tests/task-a.test.ts`, `tests/drive-vault.test.ts`.

- [x] Tests: with a sizeless product in the list parse-bill and margin-check answer 200, the catalogue sent out holds studs only, the margin line is `ITEM_UNRESOLVED`; the backup CSV of products has `product_no` and `name`.

### Task 7: Screens

**Files:** Create `src/lib/product-form.ts` (pure), `tests/product-form.test.ts`. Modify `src/app/(app)/stud-master/{page,view}.tsx`, `src/app/(app)/billing/screen.tsx`, `src/app/(app)/layout.tsx`.

**Produces:** `blankProduct`, `editProduct(p)`, `setStud(form, on)`, `productInput(form)`.

- [x] Tests (pure): a new product has empty HSN and GST; ticking stud offers 731815 only into an empty HSN; unticking sends no size; kg per piece of a non-stud is a measured weight.
- [x] Screens: Products page (ID, product, HSN, GST %, kg/piece, ₹/piece, ₹/kg), form, "Saved as P0002"; bill line with named boxes, ID and kg under the item, Enter stops at an empty GST %.

### Task 8: Prove it

- [x] Browser: local app against an in-memory copy of the database — add a nut and a stud, bill both by ID, hand-typed line with typed GST, offline search, phone width.
- [x] Gate: `npm test`, `npm run db:verify`, lint, typecheck, build (≤ 170 KB first load), frozen hashes, no env value in any changed file.
- [x] Update `CLAUDE.md`. Report; ask before commit, live migration and deploy.
