# First bill for a new customer, and the monthly Excel book

**Status:** asked for by the owner on 25 Nov 2026 with a written brief ("give a short before/after flow, then implement it"). Built on top of the product list (migration 005).

## What was asked, and why

In the owner's words: billing a new customer is difficult; check that everything is where an owner with little software knowledge expects it; make it all automatic: every bill, with all its details, saved in an Excel sheet, one per month, by the Indian financial year; it must work offline. A wider redesign comes later.

The example used throughout: *a new customer phones, wants 50 EN8 M12 × 80 mm studs, wants packing on the bill, and pays the auto driver ₹300 directly.*

## The counter today (walked on 25 Nov, 1366 px and a 375 px phone)

| Step | What happens |
|---|---|
| Types "Sri Balaji Fabricators" | "No match". Enter moves on to the items as if nothing were wrong |
| Types the items, packing, freight | Works. `Us, billed` / `Buyer, To-Pay` has to be guessed |
| Ctrl+Enter | "Pick the customer", in the bar at the bottom; the cursor stays in Packing |
| | **Leaves the bill:** Customers → New customer → **types the name again**, with 9 boxes, most of them not needed → back to New bill → **types the name a third time** to pick it |
| No internet | A new customer cannot be billed at all |
| Phone | 3.7 screens; Packing is on the second, Received and the totals on the fourth; 20 boxes on the way |
| After Save | "Bill saved", with no word on what happens next |

## The counter after this change

1. **Customer.** Type a name, phone or GSTIN. The list ends with `+ Add 'Sri Balaji Fabricators' as new customer`; the same button stays under the box when nothing was picked. Enter on an unknown name opens the form.
2. **New customer, inside the bill.** Name is already there. *No GSTIN* (default): state, phone. *Has GSTIN*: GSTIN, from which the state is read, and address. Credit days 30, opening balance 0, SEZ and the rest behind **More details**. `Save & use in this bill` → cursor on the first unfinished box of the items. Nothing typed in the bill is lost.
3. **Items and quantities.** As before.
4. **Packing / delivery.** Packing ₹, Freight ₹, *Who pays the freight*: `We pay, add to bill` / `Customer pays the driver`, Received now ₹. Vehicle, driver, LR, dispatch, note: behind **More details** (open by itself when something is in there).
5. **Review total → Save bill.** When something is missing the cursor goes to it. Afterwards three steps are ticked one by one: **Saved on this device → Invoice issued → Excel updated**.

In the example: packing is on the invoice, ₹300 is on the challan only, and nothing is typed twice.

## Rules

**New customer.** GSTIN already in the books → "This GSTIN is *X*: use X". A like-sounding name or the same phone → the owner chooses *Use this one* or *Different customer*; the program never merges by itself. One exception, which it reports: the same GSTIN **and** the same name, created on two devices, is one business. A buyer without an address cannot be billed ₹50,000 or more (Rule 46): said before saving, and the address can be typed right there.

**Offline.** The customer gets its permanent id (uuid) on the device, so the waiting bill never has to change: customer first, then the bill under its own `client_temp_id`. A signed-out device keeps it too, and asks the books at the next sign-in. Sending twice is harmless (same id → same customer). When the books know a match, the whole bill stays on the device until the owner chooses. Dexie goes to version 2 (new table only); queues and drafts are kept.

**Monthly Excel.** `Company_Billing_Vault/FY_2026-27/2026-11/Billing_2026-11.xlsx`, by invoice date (IST). Sheets *Bills*, *Items*, *Dispatch & Job Work*, *Receipts*. Made only from issued bills and posted receipts; cancelled and voided rows stay, labelled, and are not in the totals.

## How (our calls)

- **Outbox in the database (migration 006).** Triggers on invoices, deliveries, receipts and job-work returns write "this month changed" in the same transaction as the sale. A worker takes a month under a lease, reads, writes one Drive file and deletes exactly the changes it had seen; anything later makes the next round. Several marks, no row locks between bills: billing cannot wait for Excel.
- **One file per month.** The file id is made before the file (Drive `generateIds`) and kept in the database, so a lost reply cannot make a second file. A file that was trashed is taken out of the bin; one that was deleted for good is made again.
- **A stale worker cannot overwrite.** It must still hold the lease just before it uploads; the upload is cut off long before the lease ends; when the outcome is unknown the lease is left to run out, so a late write cannot land after a newer one. The revision is stored in the file and checked.
- **Retries.** After every issue, receipt, void, cancellation and dispatch change; every 10 minutes while any device has the app open; a daily job; and *Retry now*.
- **Transport** is *Transporter* by itself when the customer pays the driver, and *Own vehicle* otherwise, until somebody chooses.
- **Open monthly Excel** (owner only) builds the book from the database at that moment, so it opens even when Drive is down; the Drive copy has its own link, its last update and its retry time.
- **No new library.** `.xlsx` is a ZIP of XML, and the ZIP writer exists. Checked with Microsoft Excel itself.
- Grade and size are copied onto the invoice line when it is issued (trigger), because the product list may change later.

## Not in this change

Wider redesign, editing existing customers offline, a book per customer, writing the Excel on the device.

## Proof

New and existing customers, registered and not, duplicate GSTIN, similar name and phone, half-typed bill, offline create → close → reopen → sync, lost reply, double click, two devices (same GSTIN; billing together), 31 March / 1 April, receipt in a later month, cancellation, void, more than 1000 rows, Drive failure then retry, stale worker, old device database. The `.xlsx` is opened in Excel and reconciled with the database. Existing PDF archive and weekly backup stay green; `tests/billing-math.test.ts` and migrations 001–005 are not touched.
