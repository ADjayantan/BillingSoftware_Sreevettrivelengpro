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
| Parties | **Bill to** with name, address, GSTIN/UIN and state/code. **Ship to** with actual consignee and full delivery address. Print place-of-supply state and code, and reverse charge Yes/No. | **Consignor / Dispatch from** and **Consignee / Deliver to** with names, physical addresses and GSTIN/UIN as applicable. Include place of supply for inter-state movement. |
| Transport | DC reference and the same compact transport strip as the linked DC when dispatch details are available. | Mode, Vehicle No, driver name, Driver Phone, transporter, LR No (lorry receipt), dispatch status/date and e-way bill number when applicable. If self-collected, print “Self-collection”. Print “Pending” for an outstanding LR or “N/A” when none will be issued. |
| Merchandise or service | Item description with grade, size, thread and HSN/SAC. Quantity and UQC (e.g. PCS or KGS), unit price and taxable line value. Show pieces/weight as supporting measurements when relevant, with the actual billing unit unmistakable. Show any recorded discount and pre-discount value if applicable. | Goods description, goods HSN, pieces, net kg and UQC. For a statutory DC include the declared taxable value of transported goods, and applicable rate/head amounts when transportation is for supply. For an ordinary dispatch copy, reference the invoice for value. |
| Closing | Item subtotal, applicable supplier packing and delivery, taxable value, tax by head, signed round-off, **Invoice total**, amount in words. **For [legal supplier] · Authorised signatory** and optional recipient acknowledgement. | For job work show inward kg, returned kg **this DC**, recorded scrap/wastage kg and balance held after posting. Identify actual scrap sent back as a separate goods row if carried. Print declared movement value and its words when applicable. **Dispatched by** and **Received by** with name/signature/date. |

The invoice particulars follow Rule 46. For ordinary paper goods invoices, label the copies “Original for Recipient”, “Duplicate for Transporter” and “Triplicate for Supplier”. For paper service invoices use “Original for Recipient” and “Duplicate for Supplier”. Rule 48(6) exempts invoices prepared under Rule 48(4) from those copy rules. When e-invoicing applies, obtain the IRN and signed QR from the IRP before final issue and print the actual QR and IRN. Include the prescribed Rule 46(s) declaration when applicable. For Rule 55 triplicate challans use the consignee, transporter and consigner designations respectively. [CBIC Rule 46](https://taxinformation.cbic.gov.in/content-page/explore-rules/1000136/1000001) · [CGST Rules 48 and 55](https://cbic-gst.gov.in/pdf/01012022-CGST-Rules-2017-amended_Part-A.pdf)

### Amounts, codes and freight

- Render money from the deterministic calculation snapshot in INR with Indian grouping and two decimals. Preserve the billing quantity’s significant decimals. List each applicable GST rate bucket with its taxable base and the rate and amount for each tax head. For an ordinary domestic TN supply with place of supply 33, print CGST and SGST. For Kerala 32 or Karnataka 29, print IGST. The brief assumes the customer state equals place of supply. Resolve exceptions before issuing. Use each item’s configured goods HSN or service SAC at the required digit length.
- Show each seller charge exactly once in the calculation of taxable value. A separately invoiced packing line is already in the item subtotal. In the brief’s grouped To-Pay mode, the buyer contracts and pays the third party directly. Show the buyer-direct amounts only on the DC under **Payable directly by buyer**, separately from the goods value. If freight alone is buyer-direct and the factory bills packing, post packing as its own taxable item line, set the grouped packing charge to zero and put only freight in the DC block. A carrier payment that discharges the seller’s obligation requires supplier valuation review. [CGST Act §15(2)(b)–(c)](https://taxinformation.cbic.gov.in/content-page/explore-act/1000284/1000001)
- Job-work declared goods value belongs on the movement document. Only the agreed service and any applicable supplier charges enter the labour bill. Spell the **rounded invoice total** using lakh/crore grouping. For ₹1,23,456.00 print “Rupees One Lakh Twenty-Three Thousand Four Hundred Fifty-Six Only”. A DC showing ₹5,000.50 of material reads “Declared goods value in words · Rupees Five Thousand and Fifty Paise Only”. An ordinary dispatch copy may omit values and the corresponding words.

## Shared print layout

The following Mustache-style HTML defines the field slots and row order for both forms. Use escaped text interpolation, including for addresses. Supply `linked`, `taxBand`, `closingRows` and the other collections as ordered display rows. A label/value pair represents one entry in its current section. Each `article` is a complete document copy. Keep the document in normal flow.

```html
<main class="packet" data-paper="{{paper}}">
  {{#documents}}
  <article class="sheet">
    <header class="pair">
      <div><h1>{{title}}</h1><strong>{{issuerName}}</strong>
        <div>{{issuerAddress}}</div><div>GSTIN {{issuerGstin}}</div></div>
      <div><strong>{{number}}</strong><div>{{issueDate}}</div><div>{{copyLabel}}</div>
        {{#linked}}<div>{{label}} · {{value}}</div>{{/linked}}</div>
    </header>
    <section class="pair ruled">
      {{#parties}}<div><b>{{role}}</b><div>{{name}}</div><div>{{address}}</div>
        <div>{{stateAndCode}}</div><div>{{registration}}</div></div>{{/parties}}
    </section>
    <section class="strip">{{#facts}}<span><b>{{label}}</b> {{value}}</span>{{/facts}}</section>
    {{#irp}}<section class="irp keep"><img alt="Signed e-invoice QR" src="{{signedQrImage}}">
      <div><b>IRN</b><div>{{irn}}</div></div></section>{{/irp}}
    {{#declarationText}}<p>{{.}}</p>{{/declarationText}}
    <table class="lines">
      <colgroup><col class="item"><col class="qty"><col class="rate"><col class="amount"></colgroup>
      <thead><tr><th class="ref" colspan="4">{{title}} · {{number}} · {{copyLabel}}</th></tr>
        <tr>{{#columns}}<th scope="col" class="{{align}}">{{label}}</th>{{/columns}}</tr></thead>
      <tbody>{{#items}}<tr><td>{{description}}<small>{{codeLabel}} {{code}}</small></td>
        <td class="num">{{quantity}}<small>{{quantityDetail}}</small></td>
        <td class="num">{{third}}<small>{{thirdDetail}}</small></td>
        <td class="num">{{fourth}}</td></tr>{{/items}}</tbody>
    </table>
    {{#taxBand}}
    <table class="tax"><thead><tr><th class="ref" colspan="{{count}}">GST summary · {{number}}</th></tr>
      <tr>{{#columns}}<th scope="col" class="{{align}}">{{label}}</th>{{/columns}}</tr></thead>
      <tbody>{{#rows}}<tr>{{#cells}}<td class="{{align}}">{{text}}</td>{{/cells}}</tr>{{/rows}}</tbody>
    </table>{{/taxBand}}
    <footer class="keep closing">
      <b>{{closingTitle}} · {{number}}</b>
      {{#closingRows}}<div class="sum"><span>{{label}}</span><strong>{{value}}</strong></div>{{/closingRows}}
      {{#total}}<div class="sum total"><b>{{label}}</b><b>{{value}}</b></div>{{/total}}
      {{#words}}<p><b>{{label}}</b> {{value}}</p>{{/words}}
    <div class="pair signs">
      {{#signatures}}<div><div>{{organisation}}</div><div class="signline">{{role}}</div>
        <small>{{nameDateLabel}}</small></div>{{/signatures}}
    </div>
    </footer>
  </article>
  {{/documents}}
</main>
```

**Invoice binding.** Use the four column labels **Description / HSN or SAC**, **Billed qty**, **Rate ₹/unit**, **Taxable ₹**. In the rate cell show the denominator (e.g. “per kg”). Add the tax table after the last item. Use **GST rate | Taxable ₹ | CGST % / ₹ | SGST % / ₹** or **GST rate | Taxable ₹ | IGST % / ₹**. Each head cell shows e.g. “9% · 90.00”. The closing rows reconcile the posted subtotal, charges, taxable value, tax and signed round-off to the invoice total. For a tax bucket shared by multiple HSNs show its posted tax once. Use the service description and service SAC on labour rows.

**DC binding.** Use **Goods / HSN**, **Pieces**, **Net kg**, **Declared value ₹** for a valued DC. For an unvalued internal dispatch copy use **Packages / remarks** in the fourth column. Use the tax table only when the movement document requires tax details. Include `Vehicle No`, `Driver Phone` and `LR No` as separate facts. In the closing block identify weights and buyer-direct charges by name and unit. Label any value in the total slot **Declared goods value**. A DC has no invoice balance or demand for payment.

### CSS for both formats

Load the shared CSS after Tailwind’s base styles. Equivalent utilities for screen controls are `print:hidden`, `text-right` and `tabular-nums`. The print root has `data-paper="a4"` or `data-paper="a5"`. Include exactly one matching page-size rule after the shared CSS for each print job.

```css
* { box-sizing: border-box; }
.packet { color: #161616; font: 10pt/1.28 Inter, Arial, "Nirmala UI", sans-serif; }
.sheet { width: 100%; overflow-wrap: anywhere; }
.sheet h1 { margin: 0 0 1.5mm; font-size: 16pt; line-height: 1.1; }
.sheet p { margin: 1.5mm 0; }
.sheet small { display: block; font-size: 0.92em; }
.pair { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 5mm; }
.ruled, .strip, .closing { border-top: 0.25mm solid #666; margin-top: 2mm; padding-top: 2mm; }
.strip { display: flex; flex-wrap: wrap; gap: 1mm 4mm; }
.lines, .tax { width: 100%; border-collapse: collapse; table-layout: fixed; margin-top: 2.5mm; }
.lines .item { width: 43%; } .lines .qty { width: 16%; }
.lines .rate { width: 18%; } .lines .amount { width: 23%; }
.sheet th, .sheet td { padding: 1.3mm; text-align: left; vertical-align: top; border-bottom: 0.2mm solid #999; }
.sheet .num, .sum strong, .total b:last-child { text-align: right; font-variant-numeric: tabular-nums; }
.sheet .ref { font-size: 0.92em; font-weight: normal; }
.sum { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 3mm; }
.total { margin-top: 1mm; padding-top: 1mm; border-top: 0.35mm solid; font-size: 1.16em; }
.signs { margin-top: 3mm; }
.signline { margin-top: 9mm; border-top: 0.2mm solid; padding-top: 1mm; }
.irp { display: flex; align-items: center; gap: 3mm; margin-top: 2mm; }
.irp img { width: 36mm; height: 36mm; object-fit: contain; flex: none; }
.packet[data-paper="a5"] { font-size: 9pt; }
.packet[data-paper="a5"] h1 { font-size: 13pt; }
.packet[data-paper="a5"] :is(th, td) { padding: 0.9mm; }

@media print {
  html, body { margin: 0; padding: 0; background: white; }
  .screen-only { display: none !important; }
  .packet, .sheet { display: block; width: auto; height: auto; overflow: visible; box-shadow: none; }
  .sheet + .sheet { page-break-before: always; break-before: page; }
  thead { display: table-header-group; }
  tr, .keep, .pair { page-break-inside: avoid; break-inside: avoid; }
  h1, h2 { break-after: avoid; }
}
```

```css
/* A4 job */
@page { size: A4 portrait; margin: 10mm; }
```

```css
/* Half-A4 job */
@page { size: A5 portrait; margin: 7mm; }
```

Allow long tables to flow across pages. The item and GST headers repeat the document number. Keep the compact totals, words and signatures together. This block carries its own document reference if it starts a new page. Long descriptions wrap. If one description exceeds the available height of a page, split it into a labelled continuation row with blank quantity and amount cells. Use 100% scale with browser headers/footers off. In headless PDF output, prefer the CSS page size and wait for fonts and the signed QR image to load.

## Print acceptance cases

| Fixture | Expected on paper and archived PDF |
| --- | --- |
| One TN supply at illustrative 18%. Goods ₹1,000, seller packing ₹20, seller freight ₹30. | Taxable ₹1,050.00, CGST ₹94.50, SGST ₹94.50, invoice and words ₹1,239.00. Both references match. |
| Same goods to Kerala. Packing ₹20 on its own taxable line, buyer-direct freight ₹30. | Taxable ₹1,020.00, IGST ₹183.60, round-off +₹0.40, total ₹1,204.00. The DC identifies the ₹30.00 buyer payment. |
| One job-work return with its labour invoice | Labour bill lists the service SAC and labour consideration. DC lists physical goods and HSN, references the principal’s challan, and reconciles weights. |
| Both sizes, one line and 60 lines, long address, long description and ₹1,23,45,678.90 | Confirm PDF dimensions, no clipped glyphs, every line once, reference on continuation pages, tax and words once per copy, intact signatures, and a new page at the change of document. Scan the signed QR from a physical print when applicable. |
