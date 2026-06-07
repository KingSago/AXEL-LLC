# Lawn Cuts & Payments Tracker for Axel

## Context

Axel runs ~50 lawn accounts and currently tracks cuts and payments in QuickBooks, which he finds confusing. He needs a simpler, private tool to:
- See, on a **simple visual dashboard (mobile + web)**, **who still owes money** (the #1 priority).
- Log cuts as he does them.
- Bill everyone through **Stripe** — one-off invoices for per-cut work and automatic monthly autopay for flat-rate accounts.

The existing project is a **purely static marketing site** (`index.html`, `styles.css`, `script.js`, `LOGO.png`) that **stays on Vercel, untouched**. This feature is a **separate, private, login-protected web app** plus a **small secure backend** (Stripe secret keys can't live in the browser; billing needs webhooks). It runs **alongside QuickBooks** (he keeps QuickBooks for taxes) and is **single-user (just Axel)**.

It is a **web app at a private live URL** (Firebase Hosting) — not an App Store / Play Store app. Works in any browser on phone + desktop with the same live data; optional "Add to Home Screen" (PWA) gives it an app-like icon with no store, no install, no fees.

Decisions confirmed with the client:
- **Storage/access:** Cloud DB + login, reachable from phone and computer, backed up → **Firebase** (Auth + Firestore).
- **Hosting:** the tracker app **and** its backend live on **Firebase (Hosting + Cloud Functions)** — unified with the Auth/Firestore we already use (one CLI, one deploy, one dashboard, native Firestore access from functions). Requires the Blaze pay-as-you-go plan (~$0 at this scale). The marketing site stays on Vercel.
- **Pricing:** Mixed — some accounts **monthly flat-rate**, some **per-cut**, plus **extra one-off charges**.
- **Scheduling:** None — he just **logs cuts after doing them**.
- **Billing: fully Stripe.** Per-cut/variable accounts → a **Stripe invoice** (hosted pay page, card or ACH) sent each time. Monthly accounts → a **Stripe subscription** that auto-charges a saved card/bank each month. Stripe hosts, sends, reminds, and tracks every invoice; webhooks sync status back into the app.
- Customer **enrolls a payment method once** on a Stripe-hosted page (details can never be inherited from a prior Zelle/Venmo/cash payment). He accepts Stripe's fees in exchange for one unified, in-app billing system.
- **Cash/check/Zelle/Venmo still happen sometimes:** the app keeps a "record manual payment" action and can mark a Stripe invoice **paid out-of-band**, so the dashboard stays accurate across all payment types.

## Approach

Two parts, both on **Firebase**:
1. **Frontend** — a private app in `tracker/` (served by Firebase Hosting), vanilla HTML/CSS/JS (matching the no-build style of the marketing site), talking to Firebase via the modular Web SDK (CDN). Gated by Firebase Auth; `noindex`. **Mobile-first and responsive** so the dashboard is equally usable on phone and desktop.
2. **Backend** — **Firebase Cloud Functions** (Node) in `functions/`, holding the Stripe secret key (functions config / secret). They do all privileged Stripe work and receive Stripe webhooks, updating Firestore via the **Admin SDK** (native project credentials — no service-account key to ship around). **No card data touches our code** — all card/bank entry happens on **Stripe-hosted Checkout / hosted invoices** (minimal PCI scope).

### New files
- `firebase.json` — Hosting config (public dir = `tracker/`, SPA rewrites) + Functions config + emulators.
- `.firebaserc` — Firebase project alias (placeholder until project created).
- `firestore.rules` — locks all data to Axel's authenticated UID.
- `firestore.indexes.json` — any composite indexes needed (e.g. payments by date).
- `tracker/index.html` — app shell: login + **dashboard** / account-detail / reports / settings views (view-swapped with JS).
- `tracker/tracker.js` — Firebase init, auth gate, Firestore reads/writes, balance logic, calls to the Cloud Functions, dashboard rendering.
- `tracker/tracker.css` — reuses brand tokens from `styles.css` (`--red`, `--charcoal`, `--cream`, `--amber`, Oswald/Inter/Lora); responsive layout.
- `tracker/manifest.webmanifest` + service worker (optional PWA, "Add to Home Screen").
- `functions/package.json` — `stripe` + `firebase-admin` + `firebase-functions` deps.
- `functions/index.js` — exports the callable/HTTPS functions below.
- `functions/sendInvoice.js` — (callable, auth-checked) creates + finalizes + sends a **Stripe Invoice** from selected unpaid charges for a per-cut/variable account.
- `functions/createAutopayEnrollment.js` — creates/loads a Stripe Customer and returns a Stripe-hosted **Checkout (setup mode)** link to capture a card/bank.
- `functions/startSubscription.js` — creates the monthly **Subscription** (amount = account rate) after enrollment.
- `functions/cancelAutopay.js` — cancels a subscription / detaches the method.
- `functions/markInvoicePaid.js` — marks a Stripe invoice **paid out-of-band** (cash/check/Zelle).
- `functions/stripeWebhook.js` — HTTPS function; verifies the Stripe signature; on `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`, updates Firestore via Admin SDK (records charge/payment, marks invoices paid, flags failures).
- `Setup-tracker.md` — runbook (Firebase, Stripe, config, deploy).

### Prerequisites (console/account actions)
- **Firebase:** create project; upgrade to **Blaze** (needed for Cloud Functions; ~$0 at this scale); enable **Auth → Email/Password** (sign-up disabled); create **Axel's user**; create **Firestore** (Native mode); the Firebase Hosting domain is auto-authorized for Auth.
- **Stripe:** create account; configure **invoice branding** (logo/colors/business info) in the Stripe dashboard; enable **ACH Direct Debit** alongside cards; get **secret key**, **publishable key**, **webhook signing secret**.
- **Functions config / secrets** (set via `firebase functions:secrets:set` or env): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. The Stripe **publishable key** + Firebase **web** config are embedded in the frontend (public by design; secured by rules + auth-checked callable functions). The webhook URL (the deployed `stripeWebhook` function URL) is registered in the Stripe dashboard.

### Data model (Firestore)
- `accounts/{accountId}` — `name`, `address`, `phone`, `email`, `notes`; `billingType` (`"monthly"|"percut"`); `rate`; `active`; **rollups** `totalCharged`/`totalPaid`/`balance`/`lastPaymentAt`/`lastCutAt`; `stripeCustomerId`; `autopay` `{ status: "none"|"pending"|"active"|"failed", stripeSubscriptionId, methodType: "card"|"ach", lastFailureAt }` (monthly only); `createdAt`.
- `accounts/{id}/charges/{chargeId}` — `type` (`"cut"|"monthly"|"extra"`), `amount`, `date`, `description`, `period` (`YYYY-MM`), `invoiceId` (once billed), `createdAt`.
- `accounts/{id}/payments/{paymentId}` — `amount`, `date`, `method` (`stripe_card|stripe_ach|cash|check|zelle|venmo|cashapp`), `note`, `stripeInvoiceId`, `createdAt`.
- `accounts/{id}/invoices/{invoiceId}` — mirrors a Stripe invoice: `stripeInvoiceId`, `hostedInvoiceUrl`, `pdfUrl`, `lineItems`, `total`, `status` (`"open"|"paid"|"void"` synced from Stripe), `dateIssued`, `paidAt`, `createdAt`.
- `settings/business` (single doc) — business contact + default invoice due terms / memo.

**Why rollups:** the dashboard reads only the ~50 account docs, not every line item. Manual writes use a Firestore **transaction** to update rollups atomically; the Stripe webhook does the same via the Admin SDK, so cash and Stripe payments both keep the dashboard correct.

### Behavior
- **Log a cut:** per-cut account → creates a `cut` charge = current rate (snapshotted) → balance up. Monthly account → history only (`lastCutAt`), no charge (the subscription is the bill).
- **Extra work:** "Add charge" → `extra` with amount + description.
- **Send invoice (per-cut/variable):** "Send invoice" bundles the account's unpaid charges → `sendInvoice` creates + sends a **Stripe invoice** (customer pays by card/ACH on Stripe's hosted page; Stripe emails it and sends reminders). Local invoice doc tracks status; `invoice.paid` webhook records a `stripe_*` payment and clears the balance.
- **Monthly autopay (Stripe subscription):**
  1. "Enable autopay" → `createAutopayEnrollment` returns a Stripe Checkout setup link → Axel texts/emails it; `autopay.status="pending"`.
  2. Customer enters card or **bank/ACH** once on Stripe → vaulted.
  3. `startSubscription` creates a monthly subscription at the rate → `autopay.status="active"`.
  4. Each cycle Stripe auto-charges → `invoice.paid` webhook posts a `monthly` charge **and** matching payment → balance nets to ~$0, no action needed.
  5. `invoice.payment_failed` → `autopay.status="failed"`, balance shows owed, account flagged on the dashboard.
  - Steer enrollment toward **ACH/bank** where possible (cheaper: 0.8% capped $5 vs 2.9%+30¢).
- **Record manual / out-of-band payment:** if a customer pays cash/check/Zelle against an open Stripe invoice, Axel records the payment (method + amount) and the app calls `markInvoicePaid` to mark the Stripe invoice paid out-of-band — keeping Stripe and the dashboard in sync.

### Dashboard (the centerpiece — simple, visual, responsive)
- **Summary cards** across the top: **Total Outstanding**, **Collected This Month**, **# Accounts Overdue**, **Active Autopay**. Big numbers, color-coded. (Cards stack on mobile, row on desktop.)
- **Account list** sorted by balance owed (highest first), each row a clear card: name, amount owed, last payment, and a **status pill** — green "Paid up", amber/red "Owes $X", a small "Autopay" badge, and a red **"Payment failed"** flag when relevant. Large tap targets for phone use in the field.
- **Mini income chart:** a lightweight last-6-months collected bar (CSS bars or a tiny chart lib) for at-a-glance trend.
- **Quick actions** always reachable: Log a cut, Send invoice, Add account.
- Fully responsive (CSS grid/flex + clamp), brand-styled, fast (reads only the 50 account docs).

### Screens
1. **Login** — email/password (Axel only).
2. **Dashboard** — as above (priority view).
3. **Account detail** — ledger (charges + payments by date) with running balance; buttons: Log Cut, Add Charge, Send Invoice, Record Payment, **Enable/Manage Autopay** (monthly only), Edit/Deactivate; invoice history with links to the Stripe hosted invoice/PDF; autopay status.
4. **Reports (light)** — month totals: collected, still owed, breakdown by method (Stripe vs cash/check/etc.).
5. **Settings** — business contact + default invoice terms.

### Security
- `firestore.rules`:
  ```
  rules_version = '2';
  service cloud.firestore {
    match /databases/{db}/documents {
      match /{document=**} {
        allow read, write: if request.auth != null
                           && request.auth.uid == "AXELS_UID";
      }
    }
  }
  ```
  Replace `AXELS_UID` after creating Axel's user.
- All callable functions that act on Stripe **verify Axel's Firebase auth** first. The webhook **verifies the Stripe signature** and is the only writer of Stripe-driven charges/payments (Admin SDK, server-side). No raw card data passes through our code.

### Offline & app feel
- Firestore **offline persistence** so logging cuts works with poor signal (Stripe actions need connectivity, which is fine — not done in the field).
- Optional PWA manifest + `LOGO.png` icon for "Add to Home Screen" so it feels like a native app on his phone.

## Critical files
- Frontend: `tracker/index.html`, `tracker/tracker.js`, `tracker/tracker.css`
- Backend: `functions/index.js` + `functions/{sendInvoice,createAutopayEnrollment,startSubscription,cancelAutopay,markInvoicePaid,stripeWebhook}.js`
- Config/docs: `firebase.json`, `.firebaserc`, `firestore.rules`, `firestore.indexes.json`, `functions/package.json`, `Setup-tracker.md`
- Public marketing files (`index.html`, `script.js`, `styles.css`) are **untouched** and stay on Vercel.

## Verification
1. Set up Firebase (Blaze, auth, user, Firestore) and Stripe (**test mode** keys + webhook + invoice branding). Set function secrets; deploy `firestore.rules` with the real UID.
2. Run locally with the **Firebase Emulator Suite** (Hosting + Functions + Firestore + Auth); open the local tracker URL.
3. **Auth:** dashboard blocked until login; log in as Axel.
4. **Accounts:** add a monthly account and a per-cut account.
5. **Cuts:** per-cut cut → balance up by rate; monthly cut → history only.
6. **Extra charge:** balance up.
7. **Send invoice (per-cut):** Send invoice → a Stripe **test-mode** invoice is created/sent; pay it with a Stripe **test card** → `invoice.paid` webhook records the payment and clears the balance; invoice shows `paid` with a working hosted-invoice link.
8. **Autopay happy path:** Enable autopay → open Checkout link → enter a Stripe **test bank/card** → subscription `active`. Trigger `invoice.paid` (Stripe CLI) → webhook posts a monthly charge + payment; balance nets to ~$0.
9. **Autopay failure:** trigger `invoice.payment_failed` → account flips to `failed`, shows owed + "Payment failed" flag.
10. **Out-of-band payment:** record a cash payment against an open invoice → app calls `markInvoicePaid` → Stripe invoice shows paid, dashboard updates.
11. **Dashboard:** summary cards compute correctly; accounts ordered by amount owed with right status pills; income chart renders; **verify layout on a phone width and a desktop width.**
12. **Reports:** month totals + method breakdown match.
13. **Offline:** disable network, log a cut, re-enable → it syncs.
14. **Security:** logged-out session denied Firestore reads; callable functions reject unauthenticated calls; webhook rejects unsigned requests.
15. Deploy with `firebase deploy`; register the live `stripeWebhook` URL in Stripe; smoke-test once on the live URL.
