# JCM HQ — WhatsApp templates to create in WhatsApp Manager

Updated 12 Oct 2026. One section per template. Create each one in **WhatsApp Manager → Message templates → Create template**, copy the body exactly (the `{{1}}` markers included), add the buttons listed, upload the banner for the header, fill the sample values and submit. Meta usually approves Utility templates within a few minutes to a few hours.

The same settings for every template unless the section says otherwise:

| Setting | Value |
|---|---|
| Category | **Utility** |
| Language | **English** (code `en`) — HQ sends with `en`, so do not pick "English (US)" |
| Header | **Image** — upload the banner named in the section (open the link in a browser, save the PNG, upload it as the sample) |
| Footer | leave empty |
| Sample values | use the ones in the section; Meta only uses them to review the template |

Rules worth knowing:
- A variable can never contain a line break. HQ flattens lists to one line ("; " between items).
- Quick-reply buttons work once per message; HQ already handles the replies (QR Code = per-customer UPI QR, Ledger = PDF statement, Invoices = invoice-portal link).
- Already approved and in use — nothing to do: `payment_reminder_20d`, `payment_reminder_40d`, `retail_reminder_20d`, `retail_reminder_40d`, `hello_world`.
- Names must be exactly as written (lowercase, underscores). HQ sends by these names.
- After approval, HQ → Admin → **WhatsApp** → "Send a sample" sends each one to your own number so you can see it with real buttons.

Banners live at `https://hq.jcmretails.com/wa/<name>.png` (1200 × 628).

---

## A. Customers and suppliers (sent by HQ for new Busy vouchers)

Queued by JCM Sync every 5 minutes from Busy. **Invoices go out at 20:30** in the evening; everything else goes at the next run. Each kind can be switched off on the WhatsApp page.

### 1. `txn_invoice` — Invoice generated
Header image: `invoice.png` · Buttons: Quick reply **QR Code**, Quick reply **Ledger**, Quick reply **Invoices**

```
Namaste {{1}},

Your invoice has been generated.

🧾 Invoice No.: {{2}}
📅 Date: {{3}}
💰 Amount: ₹{{4}}
📦 Items: {{5}}

You can view and download the bill any time on our invoice portal: https://invoice.jcmretails.com (log in with your registered mobile number).

For payment, tap QR Code below. For your account statement, tap Ledger.

Thank you for your business.
J.C. Mittal and Sons, Ratlam
```
Samples: {{1}} Badshah Electric · {{2}} JCM/1234 · {{3}} 12 Oct 2026 · {{4}} 45,600 · {{5}} 7

### 2. `txn_receipt` — Payment received
Header image: `receipt.png` · Buttons: Quick reply **Ledger**

```
Namaste {{1}},

Thank you! We have received your payment.

💰 Amount: ₹{{2}}
📅 Date: {{3}}
🧾 Receipt No.: {{4}}

It has been credited to your account with us. Tap Ledger below for your updated statement.

J.C. Mittal and Sons, Ratlam
```
Samples: Badshah Electric · 25,000 · 12 Oct 2026 · R/221

### 3. `txn_purchase` — Your bill is entered (to the supplier)
Header image: `purchase.png` · Buttons: none

```
Namaste {{1}},

Your bill has been received and entered in our books.

🧾 Bill No.: {{2}}
📅 Bill Date: {{3}}
💰 Amount: ₹{{4}}
📦 Items: {{5}}

If any detail on the bill differs from your records, please reply here within 2 days so we can correct it before filing.

J.C. Mittal and Sons, Ratlam
```
Samples: Lapp India Pvt Ltd · INV-5521 · 12 Oct 2026 · 88,000 · 12

### 4. `txn_payment` — Payment sent (to the supplier)
Header image: `payment.png` · Buttons: none

```
Namaste {{1}},

We have made a payment to you.

💰 Amount: ₹{{2}}
📅 Date: {{3}}
🧾 Voucher No.: {{4}}

Kindly confirm once it reflects in your account, and share the receipt / adjustment details against our bills.

J.C. Mittal and Sons, Ratlam
```
Samples: Lapp India Pvt Ltd · 1,20,000 · 12 Oct 2026 · P/310

### 5. `txn_order` — Order booked
Header image: `order.png` · Buttons: Quick reply **Invoices**

```
Namaste {{1}},

Thank you for your order. It has been booked with us.

📋 Order No.: {{2}}
📅 Date: {{3}}
📦 Items: {{4}}
💰 Order Value: ₹{{5}}

We will message you again when the material is dispatched. If anything in the order needs a change, please reply here today so we can correct it before billing.

J.C. Mittal and Sons, Ratlam
```
Samples: Badshah Electric · SO/261/45 · 12 Oct 2026 · 5 · 32,500

### 6a. `txn_credit_note` — Credit note
Header image: `credit-note.png` · Buttons: Quick reply **Ledger**

```
Namaste {{1}},

A credit note has been issued to your account.

🧾 Credit Note No.: {{2}}
📅 Date: {{3}}
💰 Amount: ₹{{4}}

This amount has been credited to your account with us. Tap Ledger below for your updated statement.

J.C. Mittal and Sons, Ratlam
```
Samples: Badshah Electric · CN/18 · 12 Oct 2026 · 1,800

### 6b. `txn_debit_note` — Debit note
Header image: `debit-note.png` · Buttons: Quick reply **Ledger**

```
Namaste {{1}},

A debit note has been issued to your account.

🧾 Debit Note No.: {{2}}
📅 Date: {{3}}
💰 Amount: ₹{{4}}

This amount has been debited to your account with us. Tap Ledger below for your updated statement, or reply here if you have a question about it.

J.C. Mittal and Sons, Ratlam
```
Samples: Badshah Electric · DN/7 · 12 Oct 2026 · 950

### 7. `quotation_sent` — Quotation
Header image: `quotation.png` · Buttons: none
(HQ wiring for this one comes with the Quotations page update; create the template now so it is ready.)

```
Namaste {{1}},

Thank you for your enquiry. Please find our quotation below.

📄 Quotation No.: {{2}}
📅 Date: {{3}}
💰 Total: ₹{{4}}

Prices are valid for 7 days. Reply here for any change in quantity or specification, and we will send a revised quotation.

J.C. Mittal and Sons, Ratlam
```
Samples: Ronak Moonat · Q-2026-118 · 12 Oct 2026 · 1,85,000

---

## B. Customers and suppliers (sent by HQ pages)

### 8. `order_dispatched_photo` — Dispatched, with LR photo
Header image: upload `dispatched.png` as the sample (live messages carry the LR photo instead) · Buttons: Quick reply **Invoices**

```
Namaste {{1}},

Your material has been dispatched.

📦 Boxes: {{2}}
✅ Sent: {{3}}
⏳ Still to come: {{4}} (₹{{5}})
🧾 Invoice: {{7}} for ₹{{6}}

The LR copy is attached above. Download the invoice at {{8}} (log in with your registered mobile number).

J.C. Mittal and Sons, Ratlam
```
Samples: {{1}} Badshah Electric · {{2}} 3 · {{3}} 5 items (18 pcs) · {{4}} Daikin 1.5T split AC × 1 · {{5}} 42,000 · {{6}} 68,500 · {{7}} JCM/1234 · {{8}} https://invoice.jcmretails.com

### 9. `order_dispatched` — Dispatched, no LR (self-pickup / local delivery)
Header image: `dispatched.png` · Buttons: Quick reply **Invoices**
Same body as 8 but the LR line replaced:

```
Namaste {{1}},

Your material has been dispatched.

📦 Boxes: {{2}}
✅ Sent: {{3}}
⏳ Still to come: {{4}} (₹{{5}})
🧾 Invoice: {{7}} for ₹{{6}}

Download the invoice at {{8}} (log in with your registered mobile number).

J.C. Mittal and Sons, Ratlam
```
Samples: as in 8 (with {{4}} none · {{5}} 0)

### 10. `gstr1_filing_reminder` — Supplier has not filed our invoice
Header image: upload any 1200 × 628 PNG as sample (live = the month's GST banner drawn by HQ) · Buttons: none

```
Namaste, {{1}},

This is J.C. Mittal & Sons, Ratlam (GSTIN 23AAPFJ0607D1ZT).
Our GSTR-2A for {{2}} does not show the following invoice(s) of yours:

{{3}}

Please check your GSTR-1 and file or amend it so that we can claim the input tax credit. Thank you.

Awaiting your reply in the next 3 working days on this.
```
Samples: Lapp India Pvt Ltd · August 2026 · 1. INV-5521 dt 11 Aug 2026 (₹88,000); 2. INV-5602 dt 20 Aug 2026 (₹12,400)

### 11. `portal_login_otp` — Invoice-portal login code (only if the portal sends OTPs on WhatsApp)
Category **Authentication** (not Utility). Meta builds the text itself; you only tick the options:
- Code delivery: **Copy code** button, button text "Copy code"
- Tick "Add security recommendation"; expiry 10 minutes
Nothing to type. Skip this one if the portal uses SMS.

---

## C. Staff and admins (numbers from Manage Users → WhatsApp)

Short messages with a button into the HQ app. Staff should act in HQ and tick their Task Board task.

### 12. `staff_followup_morning` — Today's follow-up list (10:00, each person)
Header image: `staff-followup.png` · Buttons: **Visit website** → `https://hq.jcmretails.com/#payment-followup/today`, button text "Open my list"

```
Good morning {{1}} 🙏

You have {{2}} payment follow-ups today, ₹{{3}} due in all.
Biggest: {{4}}

What to do:
1. Open your list in JCM HQ and call each party.
2. Save the outcome after every call (promised / call later / no answer).
3. Your Task Board task ticks itself when the list is empty.

Reminders by WhatsApp are sent by HQ automatically — your job is the calls.
```
Samples: Keshav · 12 · 4,85,000 · Badshah Electric ₹1,20,000, Nexus Enterprises ₹95,000, Shree Traders ₹60,000 and 9 more

### 13. `staff_followup_evening` — Collections summary (19:00, admins)
Header image: `staff-evening.png` · Buttons: **Visit website** → `https://hq.jcmretails.com/#payment-followup/today`, button text "Open Today's follow-ups"

```
Payment follow-up — {{1}}

✅ Done: {{2}} parties followed up
⏳ Still due: {{3}}

By person: {{4}}

Promised for today: {{5}}
```
Samples: 12 Oct 2026 · 18 · 7 · Keshav: 8 done of 12, 4 left · 3 promised ₹1,10,000; Ratan: 10 done of 13, 3 left · 2 parties, ₹85,000 — check they came in

### 14. `staff_red_alert` — Explanation needed (to the person who made the entry)
Header image: `staff-red-alert.png` · Buttons (two URL buttons):
1. **Visit website** → `https://hq.jcmretails.com/#explain`, text "Answer in HQ"
2. **Visit website**, URL type **Dynamic** → `https://wa.me/{{1}}`, text "Reply to admin" — sample for the variable: `919109105999`

```
{{1}}, {{2}} has asked you to explain {{3}} Busy entry/entries.

What: {{4}}

Question: {{5}}

Please answer today in JCM HQ → My Explanations (first button). To talk it over, the second button opens {{2}}'s WhatsApp. The task is also on your Task Board.
```
Samples: Priti · Shishir · 2 · Bill deleted: JCM/1180 Badshah Electric ₹12,400 (11 Oct); ₹0 rate: JCM/1190 line 3 (12 Oct) · Why was this bill deleted after printing?

### 15. `staff_purchase_bill` — Purchase bill entered (one per bill)
Header image: `staff-purchase.png` · Buttons: **Visit website** → `https://hq.jcmretails.com/#purchases`, text "Open Purchase Summary"

```
📦 Material received — purchase bill entered

Party: {{1}}
Bill: {{2}} dated {{3}}
Items ({{4}})
Bill total: ₹{{5}}
Entered by: {{6}}

Check the items and rates against the goods received. Anything wrong → note it on the Task Board today.
```
Samples: Lapp India Pvt Ltd · LAPP/88812 · 11 Oct 2026 · 12: Cable 2.5 sqmm 500 × ₹28; Cable 4 sqmm 300 × ₹44 and 10 more · 88,000 · Ratan at 11:42, 12 Oct 2026

### 16. `staff_purchase_summary` — Purchases entered today (evening)
Header image: `staff-purchase.png` · Buttons: **Visit website** → `https://hq.jcmretails.com/#purchases`, text "Open Purchase Summary"

```
📋 Purchases entered today — {{1}}

{{2}} bills · {{3}} item lines · ₹{{4}}

Parties: {{5}}

Open Purchase Summary to see every bill with its items.
```
Samples: 12 Oct 2026 · 6 · 41 · 3,42,000 · Lapp India ₹88,000; Daikin ₹1,20,000; Atomberg ₹54,000 and 3 more

### 17. `gst_mismatch_summary` — GSTR-2A mismatch report (PDF to staff)
Header: **Document** (upload any small PDF as the sample; live = the report PDF) · Buttons: none

```
{{1}} has sent the GSTR-2A mismatch summary for {{2}} — see the attached PDF. Please go through every item and clear all of them within 2 days, by {{3}}. Reply here if anything is unclear.
```
Samples: Shishir · August 2026 · 14 Oct 2026

### 18. `staff_orders_pending` — Orders & material (17:30, admins)
Header image: `staff-orders.png` · Buttons: **Visit website** → `https://hq.jcmretails.com/#material`, text "Open Material"

```
Orders & material — {{1}}

🛒 Items still to order: {{2}}
⏰ Ordered but late: {{3}}
⏳ Parties waiting for material: {{4}}

Waiting: {{5}}

Open Material in JCM HQ to order what is short and set expected dates.
```
Samples: 12 Oct 2026 · 9 · 4 · 7 · Badshah Electric (not all ordered), Nexus Enterprises, Shree Traders and 4 more

---

## Checklist

| # | Template | Banner | Buttons | Done |
|---|---|---|---|---|
| 1 | txn_invoice | invoice.png | QR Code · Ledger · Invoices | ☐ |
| 2 | txn_receipt | receipt.png | Ledger | ☐ |
| 3 | txn_purchase | purchase.png | — | ☐ |
| 4 | txn_payment | payment.png | — | ☐ |
| 5 | txn_order | order.png | Invoices | ☐ |
| 6a | txn_credit_note | credit-note.png | Ledger | ☐ |
| 6b | txn_debit_note | debit-note.png | Ledger | ☐ |
| 7 | quotation_sent | quotation.png | — | ☐ |
| 8 | order_dispatched_photo | dispatched.png (sample) | Invoices | ☐ |
| 9 | order_dispatched | dispatched.png | Invoices | ☐ |
| 10 | gstr1_filing_reminder | any (live = GST banner) | — | ☐ |
| 11 | portal_login_otp | — (Authentication) | Copy code | ☐ only if needed |
| 12 | staff_followup_morning | staff-followup.png | Open my list (URL) | ☐ |
| 13 | staff_followup_evening | staff-evening.png | Open Today's follow-ups (URL) | ☐ |
| 14 | staff_red_alert | staff-red-alert.png | Answer in HQ (URL) · Reply to admin (dynamic URL) | ☐ |
| 15 | staff_purchase_bill | staff-purchase.png | Open Purchase Summary (URL) | ☐ |
| 16 | staff_purchase_summary | staff-purchase.png | Open Purchase Summary (URL) | ☐ |
| 17 | gst_mismatch_summary | — (Document header) | — | ☐ |
| 18 | staff_orders_pending | staff-orders.png | Open Material (URL) | ☐ |
