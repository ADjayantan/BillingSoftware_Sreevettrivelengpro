# StudFlow AI · Invoice and delivery challan

Use the same print view for the office printer and the Google Drive PDF. A4 is **210 × 297 mm portrait**. Half-A4 is **A5, 148 × 210 mm portrait**. Each invoice, challan and labelled copy starts on its own logical page. For two A5 pages on one physical A4 landscape sheet, use the printer’s two-pages-per-sheet setting.

## Which form to issue

| Transaction | Tax invoice | Linked delivery challan (DC) |
| --- | --- | --- |
| Sale of finished studs | **GST Tax Invoice**. Bill the goods and supplier-charged incidentals. Print the DC number and date. | **Delivery Challan · Sale Dispatch**. Quote the invoice number and date. This is a dispatch and receipt record. For an ordinary sale involving movement, issue the tax invoice by removal and carry the applicable transport documents. |
| Threading customer-owned material | **GST Tax Invoice · Job Work**. Bill threading labour at the agreed unit and service SAC. Quote the principal’s inward challan and the return DC. | **Delivery Challan · Job-Work Return**. Show the principal, job worker, actual goods returned, goods HSN and original party DC number/date. For a full return, send the principal’s challan copy with the goods, endorsed with the return details. For piecemeal returns, the job worker issues a fresh challan for each movement referencing the principal’s challan. The labour invoice can be linked when issued. |

An internal dispatch number identifies the factory’s movement record. Preserve the original issuer and number on a principal’s challan. For a fresh statutory challan print its own serial, date and issuer. [CGST Act §31](https://taxinformation.cbic.gov.in/content-page/explore-act/1000300/1000001/invoice/ACTS) · [CGST Rules 45 and 55](https://cbic-gst.gov.in/pdf/01012022-CGST-Rules-2017-amended_Part-A.pdf) · [CBIC Circular 38/12/2018, §8.4](https://cbic-gst.gov.in/pdf/circularno-38-cgst.pdf)

## Bind the issued snapshot

Build the view from the posted invoice, its item rows and its linked delivery. Persist the names, addresses, codes, rates, charge ownership, tax amounts and dispatch details used at issue so reprinting after a master edit reproduces the issued copy. Supplement the brief’s core tables with an issue-time snapshot for fields such as supplier registration, place of supply, service SAC, principal challan date, goods movement value and applicable statutory references. Print final numbers from the server and dates in India time (e.g. 23 Nov 2026). An offline preview carries **DRAFT · Pending sync** and its temporary reference. Retrying print or sync reuses the issued numbers.

| Block | GST tax invoice | Delivery challan |
| --- | --- | --- |
| Identity | Legal supplier name/address/GSTIN. Invoice number unique per financial year, up to 16 characters, e.g. `INV/26-27/0001`. Issue date, DC reference, copy designation, due date. | Issuer name/address/GSTIN, DC serial (up to 16 characters for Rule 55), date, movement reason, dispatch date/time, status as of issue, linked invoice when issued, party DC for job work. |
| Parties | **To** with name, address, GSTIN/UIN and state/code. **Delivery at** with the full delivery address when it is another one. Print place-of-supply state and code, and reverse charge Yes/No. | **Consignor / Dispatch from** and **Consignee / Deliver to** with names, physical addresses and GSTIN/UIN as applicable. Include place of supply for inter-state movement. |
| Transport | DC reference and the same compact transport strip as the linked DC when dispatch details are available. | Mode, Vehicle No, driver name, Driver Phone, transporter, LR No (lorry receipt), dispatch status/date and e-way bill number when applicable. If self-collected, print “Self-collection”. Print “Pending” for an outstanding LR or “N/A” when none will be issued. |
| Merchandise or service | Item description with grade, size, thread and HSN/SAC. Quantity and UQC (e.g. PCS or KGS), unit price and taxable line value. Show pieces/weight as supporting measurements when relevant, with the actual billing unit unmistakable. Show any recorded discount and pre-discount value if applicable. | Goods description, goods HSN, pieces, net kg and UQC. For a statutory DC include the declared taxable value of transported goods, and applicable rate/head amounts when transportation is for supply. For an ordinary dispatch copy, reference the invoice for value. |
| Closing | Item subtotal, applicable supplier packing and delivery, taxable value, tax by head, signed round-off, **Invoice total**, amount in words. **For [legal supplier] · Authorised signatory** and optional recipient acknowledgement. | For job work show inward kg, returned kg **this DC**, recorded scrap/wastage kg and balance held after posting. Identify actual scrap sent back as a separate goods row if carried. Print declared movement value and its words when applicable. **Dispatched by** and **Received by** with name/signature/date. |

The invoice particulars follow Rule 46. For ordinary paper goods invoices, label the copies “Original for Recipient”, “Duplicate for Transporter” and “Triplicate for Supplier”. For paper service invoices use “Original for Recipient” and “Duplicate for Supplier”. Rule 48(6) exempts invoices prepared under Rule 48(4) from those copy rules. When e-invoicing applies, obtain the IRN and signed QR from the IRP before final issue and print the actual QR and IRN. Include the prescribed Rule 46(s) declaration when applicable. For Rule 55 triplicate challans use the consignee, transporter and consigner designations respectively. [CBIC Rule 46](https://taxinformation.cbic.gov.in/content-page/explore-rules/1000136/1000001) · [CGST Rules 48 and 55](https://cbic-gst.gov.in/pdf/01012022-CGST-Rules-2017-amended_Part-A.pdf)

### Amounts, codes and freight

- Render money from the deterministic calculation snapshot in INR with Indian grouping and two decimals. Preserve the billing quantity’s significant decimals. List each applicable GST rate bucket with its taxable base and the rate and amount for each tax head. For an ordinary domestic TN supply with place of supply 33, print CGST and SGST. For Kerala 32 or Karnataka 29, print IGST. The brief assumes the customer state equals place of supply. Resolve exceptions before issuing. Use each item’s configured goods HSN or service SAC at the required digit length.
- Show each seller charge exactly once in the calculation of taxable value. A separately invoiced packing line is already in the item subtotal. In the brief’s grouped To-Pay mode, the buyer contracts and pays the third party directly. Show the buyer-direct amounts only on the DC under **Payable directly by buyer**, separately from the goods value. If freight alone is buyer-direct and the factory bills packing, post packing as its own taxable item line, set the grouped packing charge to zero and put only freight in the DC block. A carrier payment that discharges the seller’s obligation requires supplier valuation review. [CGST Act §15(2)(b)–(c)](https://taxinformation.cbic.gov.in/content-page/explore-act/1000284/1000001)
- Job-work declared goods value belongs on the movement document. Only the agreed service and any applicable supplier charges enter the labour bill. Spell the **rounded invoice total** using lakh/crore grouping. For ₹1,23,456.00 print “Rupees One Lakh Twenty-Three Thousand Four Hundred Fifty-Six Only”. A DC showing ₹5,000.50 of material reads “Declared goods value in words · Rupees Five Thousand and Fifty Paise Only”. An ordinary dispatch copy may omit values and the corresponding words.

## Shared print layout

The bill and the challan are drawn as the owner's own printed bill (`own-bill.md`). `src/lib/print-documents.ts` binds the issued snapshot to what must be said; `src/lib/bill-sheets.ts` draws it as pages of text, lines and shapes in units of its own; `src/components/sheets.tsx` writes the pages as SVG for the screen and the office printer, `src/lib/sheet-pdf.ts` as PDF for Google Drive. Both show the same drawing.

From top to bottom:

| Part | Invoice | Challan |
| --- | --- | --- |
| Above the frame | Copy designation; “Page 1 of 2” when there is more than one. | Same. |
| Head | Gear, company name, line under the name, office and factory address, telephone, mobile, e-mail: from the issued snapshot. | Same. |
| Left | **To, M/s.** name, address, phone. **Party GSTIN No.** and **State** with code. | **Deliver to** or **Principal / deliver to**: the delivery address. |
| Right | Company GSTIN, **TAX INVOICE** (and **JOB WORK**), No., Date, **DC No. dt**, **Party DC dt** of a single lot, **P. O. No. dt**. | **DELIVERY CHALLAN**, **SALE DISPATCH** or **JOB-WORK RETURN**, No., Date, **Invoice No. dt**, **Party DC dt**, **P. O. No. dt**. |
| Notes, only when there are any | CANCELLED with date and reason, SEZ declaration, **Delivery at** when it is not the address above, several party DCs, the note on the bill. | CANCELLED. |
| Rows | SL. No., HSN CODE (SAC CODE for services), PARTICULARS, RATE per unit, QTY. with its unit and the other measurement, AMOUNT in Rs. and P. On a bill of several GST rates the rate stands under each code. Nine rows at least. | PIECES, NET KG and VALUE or REMARKS instead of rate, quantity and amount. A job-work row names its party DC; of several lots each has its inward, scrap and balance kg. |
| Below, left | **Rupees** in words. Place of supply, reverse charge, due date, and how the goods go. | Declared value in words; reason, place of supply when inter-state, mode, vehicle, driver, phone, LR, status. |
| Below, right | SUB TOTAL, CGST, SGST, IGST, R. Off; Packing, Delivery and Taxable value only with charges; each GST rate with what it is on when there are several. | Value as per invoice, freight the buyer pays directly, or the weights of the lot. |
| Closing | **TOTAL AMOUNT**; bank details, E & O E; **For [company] · Authorised Signatory**. | **DECLARED GOODS VALUE** when every lot has one; **Received by**, **For [company] · Dispatched by**. |

**Text.** Every piece of text is given its width, measured with the letters of Helvetica (the widths of Arial), so another font cannot run over. A value too long for its place gets smaller letters, then narrower ones; it is never cut. Letters Helvetica does not have stand on the printed page as they are; in the PDF Tamil is written in English letters and ₹ as Rs.

**Pages.** The rows flow over as many pages as they need. The closing part stays in one piece, with at least one row above it. A following page starts with the company, the bill’s number and date, and repeats the heading of the rows.

### CSS and page size

The print root has `data-paper="a4"` or `data-paper="a5"`. The frame is 100 units wide: on A4 a unit is 1.9 mm with a margin of 10 mm, on A5 1.34 mm with 7 mm. The margins are in the drawing: `@page` has none, so the browser has no room for a header or footer of its own. Include exactly one matching page rule for each print job. Print at 100% scale.

```css
.packet { color: #111111; }
.sheet svg { display: block; width: 100%; height: auto; }

@media print {
  html, body { margin: 0; padding: 0; background: white; }
  .screen-only { display: none !important; }
  /* A millimetre less than the paper: rounding must not start an empty page. */
  .sheet { overflow: hidden; break-inside: avoid; }
  .sheet + .sheet { break-before: page; }
  .packet[data-paper="a4"] .sheet { width: 210mm; height: 296mm; }
  .packet[data-paper="a5"] .sheet { width: 148mm; height: 209mm; }
}
```

```css
/* A4 job */
@page { size: A4 portrait; margin: 0; }
```

```css
/* Half-A4 job */
@page { size: A5 portrait; margin: 0; }
```

## Print acceptance cases

| Fixture | Expected on paper and archived PDF |
| --- | --- |
| One TN supply at illustrative 18%. Goods ₹1,000, seller packing ₹20, seller freight ₹30. | Taxable ₹1,050.00, CGST ₹94.50, SGST ₹94.50, invoice and words ₹1,239.00. Both references match. |
| Same goods to Kerala. Packing ₹20 on its own taxable line, buyer-direct freight ₹30. | Taxable ₹1,020.00, IGST ₹183.60, round-off +₹0.40, total ₹1,204.00. The DC identifies the ₹30.00 buyer payment. |
| One job-work return with its labour invoice | Labour bill lists the service SAC and labour consideration. DC lists physical goods and HSN, references the principal’s challan, and reconciles weights. |
| Both sizes, one line and 60 lines, long address, long description and ₹1,23,45,678.90 | Confirm PDF dimensions, no clipped glyphs, every line once, reference on continuation pages, tax and words once per copy, intact signatures, and a new page at the change of document. Scan the signed QR from a physical print when applicable. |
