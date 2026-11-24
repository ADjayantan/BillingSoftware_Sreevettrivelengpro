# StudFlow AI · Payment reminders

Use one message per invoice. The first version in each pair is spoken Tamil written in English letters (Tanglish). The second is for a customer who prefers English.

### Gentle due · On the due date

**Tanglish**

```text
Vanakkam {{recipient_name}}, {{company_name}}-ilirundhu oru chinna reminder. Invoice {{invoice_no}} ({{invoice_date}}) ku {{balance}} baaki irukku. Innaikku ({{due_date}}) due. Payment anuppiyirundhaa, reference number share pannunga. Nandri!
```

**English**

```text
Hello {{recipient_name}}, a friendly reminder from {{company_name}}. The balance of {{balance}} on invoice {{invoice_no}} ({{invoice_date}}) is due today, {{due_date}}. If you’ve already paid, please share the payment reference so we can update our records. Thank you.
```

### 7-day overdue · Ask for a payment date

**Tanglish**

```text
Vanakkam {{recipient_name}}, {{company_name}} invoice {{invoice_no}}-oda due date {{due_date}}. Oru vaaram aagudhu. Enga kanakkula innum {{balance}} baaki irukku. Endha thedhi payment anuppa mudiyumnu solla mudiyumaa? Anuppiyirundhaa reference number mattum podhum. Nandri.
```

**English**

```text
Hello {{recipient_name}}, invoice {{invoice_no}} from {{company_name}} was due on {{due_date}}, a week ago. Our records show {{balance}} outstanding. Could you confirm the date we can expect payment? If you’ve already transferred it, the payment reference is enough. Thank you.
```

### 15-day overdue · Firm follow-up

**Tanglish**

```text
Vanakkam {{recipient_name}}, {{company_name}} invoice {{invoice_no}} ku {{balance}} baaki irukku. Due date ({{due_date}}) mudinju 15 naal aagudhu. Innaikku payment anuppunga. Innaikku mudiyalainaa, endha thedhi anuppuveengannu innaikke confirm pannunga. Thogaiyil vithiyaasam irundhaa sollunga, kanakkai sari paarppom. Nandri.
```

**English**

```text
Hello {{recipient_name}}, the {{balance}} outstanding on {{company_name}} invoice {{invoice_no}} is now 15 days overdue (due {{due_date}}). Please arrange payment today, or reply today with a definite payment date. If the amount differs from your records, please tell us so we can reconcile it. Thank you.
```

### Preparing the WhatsApp draft

| Field | Value to insert |
|---|---|
| `recipient_name`, `company_name` | Customer’s accounts contact or business name and the issuing factory’s name |
| `invoice_no`, `invoice_date` | Final synced invoice number and issue date |
| `due_date` | Invoice’s agreed due date. Format both dates as `23 Nov 2026`. |
| `balance` | Current unpaid amount on this invoice after posted receipts and credits, including partial payments. Format once, e.g. `₹1,24,580.50`. |

Select by calendar days in `Asia/Kolkata` (0, 7 or 15 days after due date). The wording assumes the message goes out on that exact day. Refresh the balance before opening the draft. Suppress a settled invoice, an unresolved dispute, or a stage already recorded as sent. If the app knows only “partial” and has no receipt amount, have accounts confirm the rupee balance first. Customer opening balances and buyer-direct freight belong outside this figure.

Substitute all fields, then URL-encode the complete message once. Open `https://wa.me/<country-code-and-number>?text=<encoded-message>` with digits only in the number. Let the owner review the recipient, amount and text in WhatsApp and tap **Send**. Opening the link alone does not confirm sending.

For the factory copy, print the Tamil section below on A4 portrait at 14 pt with 14 mm margins and a Tamil font such as Nirmala UI.

<div style="break-before: page; page-break-before: always"></div>

# StudFlow பயன்படுத்துவது எப்படி?

**உரிமையாளருக்கான ஒரு பக்கக் கையேடு**

1. **பில் தொடங்க.** வாடிக்கையாளர் பெயர், GSTIN, சரக்கு போகும் முகவரி, பணம் வர வேண்டிய தேதி ஆகியவற்றைப் பாருங்கள். குரலில் சொன்னால் திரையில் வந்த அளவையும் விலையையும் சரிபாருங்கள்.

2. **நம்முடைய கம்பி → Supply.** ஸ்டட் அளவு, நீளம், உலோக வகையைத் தேர்வு செய்யுங்கள். பீஸுக்கா, கிலோவுக்கா என்று பார்த்து விலையை இடுங்கள். எடையை மாற்ற, ஒரு பீஸின் எடையை இடுங்கள். 10 பீஸ் சேர்த்து 2.400 கிலோ என்றால் ஒரு பீஸ் 0.240 கிலோ.

3. **வாடிக்கையாளரின் கம்பி → Job Work.** அவர் கொடுத்த சலான் எண், வந்த எடை, திருப்பி அனுப்பிய எடை, கழிவு, கையிருப்பு ஆகியவற்றைப் பதியுங்கள். பில்லில் திரெடிங் கூலி மட்டும் போடுங்கள்.

4. **கட்டணமும் GST-யும்.** நாம் வசூலிக்கும் பேக்கிங், வண்டிக் கட்டணத்தை GST உடன் சேருங்கள். வாடிக்கையாளர் லாரிக்காரருக்கு நேரடியாகத் தரும் தொகை “To-Pay”. அது சலானில் மட்டும் வரும். வழக்கமான தமிழ்நாடு விற்பனைக்கு CGST + SGST, மற்ற மாநில விற்பனைக்கு IGST.

5. **இணையம் போனால்.** வரைவு சாதனத்தில் சேமிக்கப்பட்டதா என்று பாருங்கள். இணையம் வந்ததும் அதே சாதனத்தில் அதே வரைவைத் திறக்கவும். “Synced” என்று காட்டி நிரந்தர பில் எண் வந்ததும் அச்சிடுங்கள்.

6. **சரக்கு அனுப்ப.** இணைந்த சலானில் வண்டி எண், ஓட்டுநர் பெயர், கைபேசி எண்ணைப் பதியுங்கள். லாரி ரசீது இருந்தால் அதன் LR எண்ணையும் சேருங்கள். வண்டி கிளம்பியதும் “Dispatched”, போய்ச் சேர்ந்ததும் “Delivered” தேர்வு செய்யுங்கள்.

7. **பணம் வந்தால்.** வங்கியில் வந்த தொகையை அந்த பில்லுக்கு வரவு வையுங்கள். முழுத் தொகை வந்தால் “Paid”, ஒரு பகுதி வந்தால் “Partial”. நினைவூட்டல் அனுப்பும் முன் பாக்கியையும் WhatsApp எண்ணையும் பாருங்கள்.
