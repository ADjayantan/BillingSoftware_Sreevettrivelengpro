# The new look, part 1 (approved by the owner, 25 Nov 2026)

Owner: "not professional, like the software a bigger company uses", "hard to use", then "like Zoho billing, free", then "OK, start, but no Tanglish in the software, easy English". On 26 Nov 2026, after seeing it built: "take the AJIO website as the reference, clean". The look below is that one, approved by the owner the same day ("Nalla irukku"); what the pages do did not change.

Models: `specs/ui-model/` (first) and the pictures of the second one. All figures in them are made up. Zoho is the measure for how complete and easy it is; its name, logo and screens are not copied.

## Goals

- It looks like one finished product on a PC (1366 px) and on a phone (390 px).
- The four things done every day are one click away: make a bill, write down money, send goods, find and print a bill.
- Every word on the screen, in Telegram and in WhatsApp drafts is easy English. The AI box still understands Tamil and Tanglish when somebody speaks.

Not in this part: quotations, credit notes, statement, price lists, reports, GST file, expenses, stock. A part that does not exist is not in the menu.

## What must not change

The printed bill and challan, all arithmetic, numbering, the offline rules, the Enter flow on New bill, "GST % is typed by a person". `/billing` stays static with no data in it and at most 170 KB of script.

## Approaches

1. **Restyle in place** with the app's own classes and a few shared parts (chosen): nothing new to download, the offline shell stays small, every old screen gets the look at once.
2. A UI kit: ready-made, but 60–100 KB on a page that has 9 KB left.
3. A second front end beside the old one: twice the work, two places to keep right.

## The look

AJIO's calm, not AJIO: its name, logo, pictures and screens are not copied. White page, thin lines (`#e4e6e8`), square corners (3 px), no shadows, no coloured boxes. Ink `#27333f`, second ink `#434e59`, muted `#646e78`. One gold, `#84631f` (white on it 5.5 : 1): the main button of a page, links like *All*, the signs on Home. Slate `#2b3e50` for what is chosen (a tick, the kind of bill, the way money came). The bill's crimson `#b3243b` only as the thin line on top and under the open menu entry. A state is a sign and words, without a box: late red, due grey, part paid blue, paid green, cancelled grey. Titles in a serif the device already has (Palatino Linotype, Palatino, Noto Serif), everything else in Segoe UI or the phone's own letters; numbers never in the serif. The menu and the main buttons in capitals with air between the letters. Base 16 px, boxes to type in 16.5 px, the total of a bill 36 px. Every text at least 4.5 : 1.

## The frame

PC, from 832 px: a white head with the gear and the company name, the find box (Ctrl K), the connection, a round **+** with everything that can be made, and the gold **New bill** (Alt N). Under it one line with every page, in groups: Home | Bills, Customers, Money received | Products, Send goods, Job work, Metal rates | Excel books, Company, and Sign out at the right. That line stays on top while the page scrolls. Below 1024 px the office pages and Sign out wait behind **More**. Phone: a white bar on top with the name and the connection; at the bottom Home, Bills, **+**, Customers, More.

The frame has no data of its own: it is also around the static `/billing`. The company name comes from this device (kept after `/api/company` answered once, taken off at sign-out). What waits on this PC comes from the offline engine.

## Pages

| Page | What it shows |
|---|---|
| `/home` | four big buttons; today, this month, to collect, overdue; collect first (with WhatsApp); to send; sales of six months; safe and in order |
| `/invoices` | *Refine by* at the left (state with counts, month), from 1280 px; tabs on top below that; find by number, customer or P.O.; balance and state of each |
| `/invoices/[id]` | the bill as printed at the left; at the right, like a shop's product page: customer, number and state, what is left to collect, Record money, Print, WhatsApp, goods, what happened, Cancel bill |
| `/money` | write down money: customer → unpaid bills → amount filled in → way → Save; below, what came in |
| `/dispatch` | goods not delivered yet: Packed, Send, Delivered |
| `/customers` | what each customer owes (asked for and approved by the owner, 26 Nov 2026: "Aamaa, sari"): bills to collect, the late part with the oldest, and the balance with the dues typed in from before; on top how many owe and how much; A–Z or *Owes most* |
| `/find` | bills, customers, products for what was typed |
| `/billing` | steps 1 Customer 2 Items 3 Packing and delivery; HSN and GST small; total, words, old balance, received now and Save at the side |
| `/more` | phone: everything |
| `/login` | the company on the left, the boxes on the right |

Signed in, `/` opens Home; with the cloud down it opens `/billing`, as before.

## Widths

The menu stands on top, so a page has the window less 56 px, at most 1300 px. Lists stand in two lines per row below 1024 px. Bills has all its columns from 1024 px and *Refine by* from 1280 px. New bill: the total at the side from 1024 px, below that a bar at the bottom with the total and Save. Home: two columns from 1280 px. Measured at 320 to 1920 px, 1093 px (a 1366 laptop at 125%) and 1536 px (a 1920 screen at 125%, the owner's PC) among them: nothing wider than the window, nothing cut, no word broken in two. The menu line fits from 832 px.

The sales bars are boxes, not a drawing: a drawing shrinks its words with it.

## Figures

Only from issued rows, in the database (`008_home.sql`): `home_figures`, `find_bills`, `receipts_found`, `goods_to_send`, `customer_balances`. Read-only, run as the caller, refused unless `private.is_staff()`; amounts travel as text. Cancelled bills count nowhere. A customer's balance is the opening balance typed in by hand (dues from before this software; minus is what we owe them) plus what is left on its bills; money for the old dues is written by changing that opening balance, as no bill stands for it. *To collect* is what is left on bills that are not settled; *overdue* the part of it whose due date is past. "Today" is the Indian date, passed in.

## Words

Short, common words: *Money received*, *Send goods*, *Who owes*, *Waiting to go*. No codes and no jargon in sentences a person reads. WhatsApp drafts in English only. Telegram in English.
