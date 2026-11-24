# MASTER PROJECT BRIEF: StudFlow AI — Crash-Proof Cloud Billing & Dispatch System

## 1. Business Context & Industry
- **Industry:** Stud Threading & Fastener Manufacturing / Job-Work Unit (Tamil Nadu, India — State Code: 33).
- **Core Operations:**
  1. **Direct Supply (GST Tax Invoice):** Procuring raw metal rods (MS, EN8, EN19, SS 304, SS 316, Brass), cutting/threading studs, and selling to industrial buyers (standard fasteners HSN: 7318; configurable per item).
  2. **Job Work (Labour Billing + Material Tracking):** Customers supply raw rods/studs; the company performs threading and returns finished studs while tracking Inward Weight, Outward Weight, and Process Scrap/Wastage.
- **Primary User:** Factory owner (needs clean, large-font, fast keyboard/voice UI, zero clutter, works on both office desktop PC and mobile phone).

## 2. Critical Problems Solved
1. **Zero Data Loss on PC Crash:** The current office PC crashes frequently and loses local files. Therefore, NO heavy desktop database or local-only files are allowed. All data must live in Cloud PostgreSQL with instant sync and automatic Google Drive PDF archiving.
2. **Ultra-Low Local RAM & Storage:** Must run as a lightweight Next.js PWA (~100–150 MB RAM, near 0 MB local DB storage). **NO Local LLM** is permitted. All AI runs server-side via Gemini Flash API (0 MB local RAM).
3. **Offline Resilience:** If internet/power drops mid-bill, drafts save instantly in browser IndexedDB (Dexie.js) and auto-sync when online.
4. **Delivery & Freight Visibility:** Every bill links to a Delivery Challan (DC) with vehicle number, driver details, transport mode, live delivery status, and flexible delivery/packing charge tax handling.
5. **Proactive Metal Rate Alerts & Autonomous AI:** Daily raw metal rate tracking with spike alerts, margin-drop warnings during billing, Tanglish voice/text-to-bill drafting, and automated credit payment reminders.

## 3. Approved Tech Stack
- **Frontend & PWA:** Next.js (App Router), React, TypeScript (strict), Tailwind CSS, Dexie.js (IndexedDB offline queue), Service Worker (`manifest.json`).
- **Backend & Cloud DB:** Supabase (PostgreSQL + Auth + Row Level Security + Edge/API support) deployed on Vercel.
- **Cloud AI (0 MB Local RAM):** Google Gemini Flash API (Server-side routes only, JSON output mode + Zod validation).
- **Notifications:** Telegram Bot API (100% free instant alerts) + Web Push + 1-click WhatsApp deep links (`wa.me`).
- **Cloud Vault (2 TB):** Google Drive API (Dedicated Company Account) for auto-organized monthly Invoice/DC PDFs and weekly full DB backups.

## 4. Database Schema (8 Core Tables in Supabase PostgreSQL)
1. `customers`: id, name, gstin, phone, state_code, credit_days, address, opening_balance, created_at
2. `stud_items`: id, sku_code, diameter_mm, length_mm, thread_type, material_grade, hsn_sac, unit_weight_kg, default_rate_per_piece, default_rate_per_kg
3. `metal_rates`: id, material_grade, rate_per_kg, previous_rate_per_kg, change_delta, source, recorded_at
4. `invoices`: id, invoice_no (assigned server-side on sync), client_temp_id (for idempotent offline sync), bill_type ('supply'|'job_work'), customer_id, subtotal, packing_charge, delivery_charge, delivery_taxable (boolean), cgst, sgst, igst, round_off, grand_total, payment_status ('unpaid'|'partial'|'paid'), due_date, pdf_drive_url, created_at
5. `invoice_items`: id, invoice_id, stud_item_id, description, qty_pieces, total_weight_kg, billing_unit ('pcs'|'kg'), unit_rate, tax_rate_percent, line_total
6. `deliveries`: id, invoice_id, dc_no, transport_mode, vehicle_no, driver_name, driver_phone, lr_number, freight_paid_by ('seller'|'buyer_to_pay'), delivery_address, status ('pending'|'packed'|'dispatched'|'delivered'), proof_drive_url, dispatched_at, delivered_at
7. `job_work_ledger`: id, customer_id, party_dc_no, material_grade, inward_weight_kg, outward_weight_kg, scrap_weight_kg, balance_weight_kg, status ('open'|'closed'), created_at
8. `alert_rules`: id, material_grade, threshold_rs_per_kg, telegram_chat_id, is_active

## 5. Non-Negotiable Engineering & Accounting Rules
- **100% Deterministic Billing Math:** AI MUST NEVER calculate GST, weights, or totals. All arithmetic lives in pure, unit-tested `src/lib/billing-math.ts`.
- **Standard Steel Stud Weight Formula (with manual override):**
  `unit_weight_kg = ((diameter_mm * diameter_mm) / 162.2) * (length_mm / 1000)`
- **GST State Rule:** If customer `state_code === '33'` (Tamil Nadu), split tax equally into CGST + SGST. Otherwise apply IGST.
- **Delivery Charge Rule:** If `delivery_taxable === true`, add packing + delivery charge to taxable value before GST. If `freight_paid_by === 'buyer_to_pay'`, show on Delivery Challan only and exclude from invoice grand total.
- **Crash-Safe Invoice Numbering:** Offline bills receive a temporary local ID (`OFFLINE-<uuid>`). Official sequential GST numbers (`INV/26-27/0001`) are assigned atomically in PostgreSQL upon cloud sync using `client_temp_id` idempotency to prevent duplicates after crashes.
- **Strict Security:** Zero API keys or service credentials in client code or `NEXT_PUBLIC_*` vars. Validate every API request/response with Zod. Enforce Supabase RLS on all 8 tables. Respect Next.js Server/Client component boundaries.
