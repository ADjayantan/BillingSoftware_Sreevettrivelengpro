# The owner's own bill

**Status:** on 25 Nov 2026 the owner sent a photo of the printed bill book ("ithu tha enna oda billu"), saw a model of it filled by the software, and approved it for plain paper ("Sari, aarambi"). Built on top of migrations 005 and 006. The print contents and the drawing are in `print-templates.md`.

## What and why

The bill a customer gets must look like the bill the owner has always given: gear logo, green and red, the same boxes in the same order, the Vel behind the rows. Today's print is a plain list, and the PDF in Google Drive is lines of text. Both become this bill. The delivery challan takes the same look.

## Goals

- A4, A5 and the Drive PDF are one and the same drawing.
- Everything GST needs is on it, small, inside the owner's boxes: copy mark, HSN/SAC, unit, GST rate and amount, state and place of supply, reverse charge, signatory.
- Any bill fits: 1 or 60 lines, two GST rates, Karnataka, job work, a long address, ₹12 crore. Nothing is cut off, nothing overlaps, every line stands once.
- Black-and-white printers and phones work: nothing depends on a colour, on a browser setting or on an installed font.
- P.O. number and date can be typed on a bill, online and offline, and are on the print, the bill page and in the monthly Excel.
- The head of the bill (line under the name, office and factory address, office phone, mobile, e-mail, GSTIN, bank) comes only from the Company page and is frozen on each bill.

## Not part of it

Printing into the pre-printed book (the owner chose plain paper). A picture upload for the logo: gear and Vel are drawn in the program. Tamil letters in the Drive PDF: there they are written in English letters; the printer has them as they are. Changing a P.O. number after issue: like everything on an issued bill it is frozen.

## Approaches

| Way | Trade-off |
|---|---|
| HTML for the printer, another drawing for the PDF | Two designs that drift apart; page breaks left to each browser |
| A browser on the server makes the PDF from the HTML | Same look, but a 50 MB browser in every function, slow and fragile on the free plan |
| **One drawing in our own units, written out as SVG (screen, printer) and as PDF (Drive)** | We measure and break text ourselves. Chosen: same on every device, tested as data, no new library |

## Decisions

1. **Sheet.** The frame is 100 units wide and 145.6 high on both papers (A4: 10 mm margin, 1 unit = 1.9 mm; A5: 7 mm, 1.34 mm), so A5 is the same drawing, smaller. `@page` margin is 0: the browser adds no header or footer of its own.
2. **Text** is measured with the widths of Helvetica (the same as Arial), and every piece is told its width: another font is squeezed into it and cannot overflow.
3. **Pages.** The closing block (sums, words, total, bank, signature) stays together, with at least one item row above it. A following page has a short head with the bill's number and repeats the table head; from two pages on, "Page 1 of 2".
4. **Rows.** Nine rows as in the book; a row that needs more height takes the place of an empty one. A fuller bill goes on to the next page.
5. **Sums.** SUB TOTAL, CGST, SGST, IGST, R. Off always; Packing, Delivery and Taxable value only when there are charges; CGST/SGST or IGST once per GST rate, with the amount it is on when there are two or more. Then each line also says its GST %.
6. **Title** is TAX INVOICE (job work: with JOB WORK under it), DELIVERY CHALLAN (SALE DISPATCH or JOB-WORK RETURN). The HSN heading says SAC when the codes are SACs.
7. **Cancelled** bills say CANCELLED large across the rows, and when and why above them.
8. **Challan.** No prices. Job work: one row per lot with inward, scrap and balance kg under it; declared value and its words when every lot has one. "Received by" and "Dispatched by" to sign.
9. **P.O.** `invoices.po_no` (1–40 characters), `po_date` (only with a number). Not sent when empty, so a bill that waited since before this change keeps its fingerprint.
10. **Company.** `tagline`, `factory_address`, `office_phone` (as written: `0422 - 1234567`). The snapshot takes every column of the company, so new bills carry them and old ones print without.
