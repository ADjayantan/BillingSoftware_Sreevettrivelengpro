# Company products: add by hand, automatic product ID

**Status:** approved by the owner 24 Nov 2026 ("Sari, aarambi") and built. Not live until migration 005 is run and the new version deployed.

## What was asked, and why

In the owner's words: add items to the company's products by hand; type the GST percentage by hand too; every product gets a product ID by itself when it is added; a product can be called by that ID.

Today the only product list is *Studs*. It needs diameter, length, thread and grade for every row, and an SKU somebody has to invent. Nuts, washers or anything else the company sells cannot go in, and a bill line cannot be filled by a short number.

## Goals

1. One **Products** page for everything the company sells. A stud is a product that also has a size.
2. A product needs a **name, HSN, GST %** and, if wanted, a rate. Nothing else is compulsory.
3. The database gives each product the next **product ID** (`P0001`, `P0002`, …). Nobody types it, nobody can change it, and it is never used again for another product.
4. In a bill, `7`, `P7` or `P0007` and Enter fills the line: name, HSN, GST %, unit, rate. Parts of the name or the SKU still find it. Same with no internet.
5. **GST % is always typed by a person.** It starts empty on a new product and on a hand-typed bill line; a bill without it cannot be saved. A product's own GST % fills its line and can be changed there. A new line starts with the GST % typed by hand on the line above, so a ten-line labour bill needs it once (our proposal).
6. Every box in a bill line has a name on it (Product or ID, Qty, Unit, Rate ₹, HSN/SAC, GST %, Amount).

## Not in this change

Stock, purchase rates, product photos, bar codes, the ID on printed bills, adding a customer from the bill screen. A one-off item can still be typed straight into a bill and is not saved as a product.

Must not happen: an issued bill changing because a product changed; a GST % nobody typed; a stud losing its weight calculation.

## What people see

```
Products                                  [ New product (Alt+N) ]
ID      Product                          HSN      GST %   ₹/piece   ₹/kg
P0001   Stud MS-M8-45-FT · 8 × 45 · MS   731815   18      3.10      165.00
P0002   Hex nut M12 GI                   731816   18      4.50      —

New product            ID: given when you save
Product name [ Hex nut M12 GI        ]  HSN [ 731816 ]  GST % [      ]
₹ per piece [ 4.50 ]  ₹ per kg [      ]  kg per piece [        ]
[ ] It is a stud: Diameter, Length, Thread, Grade → weight by formula
Own code (optional) [            ]

Bill line:   Product or ID   Qty   Unit   Rate ₹   HSN/SAC   GST %   Amount
             [ 2 ⏎ ]   →   Hex nut M12 GI · 4.50 · 731816 · 18
```

After saving: "Saved as **P0002**".

## Approaches

| | What | Trade-off |
|---|---|---|
| **A. One list (chosen)** | `stud_items` becomes the product list; size becomes optional | One ID series for everything, one search, one page. The code that reads sizes must cope with a product that has none |
| B. A second table beside studs | New `products` table | Studs untouched, but two lists, two searches, and studs would not share the ID series: "every product" would not be true |
| C. Only generate the SKU | Keep the stud form | Smallest, but a nut still needs a diameter and a length |

## How it is built (our calls)

- **Migration `005_products.sql`**; 001–004 stay as they are. `product_no integer generated always as identity` (unique), `name`, and the size columns become optional. A check keeps the two kinds honest: either all of diameter, length, thread, grade and weight are there, or a name is. An empty own code is filled with the product ID, so `sku_code` stays unique and never empty.
- The table, its row security, audit log and links from bills stay. Bills copy name, HSN, GST % and rate at the time, as today.
- **Search**: an ID is an exact match and comes first; otherwise name or own code. Same rule online and in the PC's copy.
- **Weights**: a product without a size converts pieces ↔ kg only if somebody gave its kg per piece.
- **Margin check and AI fill** look at studs only, as today; a product without a size is left out, never guessed.
- **Backup** gets the new columns. The page address stays `/stud-master`; the menu says *Products*.
- Order on the live system: migration first (the running version keeps working with it), then the new version. The migration is run only after the owner's yes.

## Proof

Tests first, for each rule above: IDs run on and cannot be typed, changed or reused; a product without GST % is refused in plain words; `7`, `p7`, `P0007` and a name all find the right product, online and offline; a hand-typed line without GST % cannot be saved; a draft typed before this change still opens; a product without a size breaks neither margin check nor AI fill nor the backup. The frozen billing-math tests stay untouched and green.
