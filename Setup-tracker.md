# Axel's Tracker — Setup & Runbook

The tracker is a private web app (Firebase Hosting) + a small backend (Firebase
Cloud Functions) that handles Stripe billing. The marketing site stays on Vercel,
untouched. This guide takes you from zero to a working app.

> You only do the **one-time setup** once. After that, `firebase deploy` ships updates.

---

## 0. Install tools (one time)

```powershell
npm install -g firebase-tools
# Stripe CLI (for local webhook testing): https://stripe.com/docs/stripe-cli
firebase login
```

Install function dependencies:

```powershell
cd functions
npm install
cd ..
```

---

## 1. Create the Firebase project

1. Go to https://console.firebase.google.com → **Add project** (e.g. `axels-tracker`).
2. **Upgrade to the Blaze (pay-as-you-go) plan** — required for Cloud Functions.
   Cost at this scale is effectively $0 (generous free tier). Set a budget alert
   ($5) for peace of mind.
3. **Build → Authentication → Get started → Email/Password → Enable.**
   - In **Authentication → Settings → User actions**, turn **off** "Enable create
     (sign-up)" so nobody but Axel can make an account.
   - **Authentication → Users → Add user** → create Axel's email + password.
   - Copy his **User UID** — you'll need it in step 3.
4. **Build → Firestore Database → Create database → Production mode** (any region,
   e.g. `nam5`/us-central).
5. **Project settings (gear) → General → Your apps → Web app (`</>`)** → register an
   app. Copy the `firebaseConfig` values.

Put those values into **`tracker/firebase-config.js`** (replace the `REPLACE_*`
placeholders). Set the project id in **`.firebaserc`** (replace
`REPLACE_WITH_FIREBASE_PROJECT_ID`).

---

## 2. Create the Stripe account

1. https://dashboard.stripe.com → create account. Keep it in **Test mode** while setting up.
2. **Settings → Branding** → add logo/colors/business info (these appear on hosted invoices).
3. **Settings → Payment methods** → enable **ACH Direct Debit** (cheaper than cards)
   in addition to Cards.
4. **Developers → API keys** → copy the **Secret key** (`sk_test_…`).
5. The **publishable key** isn't needed by this app (all card entry is on Stripe-hosted
   pages), so you can ignore it.

---

## 3. Configure secrets & params

**Firestore rules** — open `firestore.rules` and replace `AXELS_UID` with Axel's UID
from step 1.3.

**Function secrets** (stored encrypted by Firebase, never in code):

```powershell
firebase functions:secrets:set STRIPE_SECRET_KEY
# paste sk_test_... when prompted
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
# paste the webhook signing secret from step 5 (or 6 for local) when prompted
firebase functions:secrets:set INBOUND_SHARED_SECRET
# paste any long random string — the SAME value goes in the Apps Script (step 6)
```

> Tip for `INBOUND_SHARED_SECRET`: generate a random value with
> `powershell -c "[guid]::NewGuid().ToString('N')"` and keep it handy for step 6.

**Non-secret params** — copy `functions/.env.example` to `functions/.env` and set:

```
APP_BASE_URL=https://YOUR-PROJECT.web.app   # used for Stripe redirect links
ALLOWED_UID=                                 # optional; paste Axel's UID to hard-lock functions
```

---

## 4. Run locally (test mode)

```powershell
firebase emulators:start --only auth,functions,firestore,hosting
```

- App: http://localhost:5000
- Emulator UI: http://localhost:4000

Because the emulator has its own (empty) Auth, create a local user in the Emulator UI
(Authentication tab) to log in, or point the app at the real project (see note below).

### Test Stripe webhooks locally

In a second terminal:

```powershell
stripe login
stripe listen --forward-to http://localhost:5001/YOUR-PROJECT/us-central1/stripeWebhook
```

`stripe listen` prints a `whsec_…` signing secret — use it as `STRIPE_WEBHOOK_SECRET`
for local testing. Trigger events with the dashboard (Test mode) or:

```powershell
stripe trigger invoice.paid
```

Use Stripe **test cards** (e.g. `4242 4242 4242 4242`) and **test bank**
(routing `110000000`, account `000123456789`) on the hosted pages.

---

## 5. Deploy

```powershell
firebase deploy --only firestore:rules,functions,hosting
```

- The app is live at `https://YOUR-PROJECT.web.app`.
- Get the deployed webhook URL (printed after deploy, or in the Functions console):
  `https://us-central1-YOUR-PROJECT.cloudfunctions.net/stripeWebhook`
- In **Stripe → Developers → Webhooks → Add endpoint**, paste that URL and subscribe to:
  `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`,
  `customer.subscription.deleted`.
- Copy the endpoint's **Signing secret** and update `STRIPE_WEBHOOK_SECRET`
  (`firebase functions:secrets:set STRIPE_WEBHOOK_SECRET`), then redeploy functions.

When everything works in **Test mode**, flip Stripe to **Live mode**, repeat steps
2.4 and 5 with the **live** secret key + a **live** webhook endpoint/secret.

> Optional: point a branded subdomain (e.g. `app.axelstrusted.com`) at Firebase
> Hosting via **Hosting → Add custom domain**, then update `APP_BASE_URL`.

---

## 6. Payments automation (Zelle / Venmo email forwarding)

Goal: forwarded Venmo and Fifth Third Zelle alerts land in the app's **Payments**
tab as a review queue. Axel taps **Confirm** to post each one — nothing changes a
balance until he does. (Cash/check are still recorded by hand.)

```
Venmo / Fifth Third alert → (Gmail filter) → dedicated Gmail
   → Apps Script (every 5 min) → inboundPayment Cloud Function
   → pendingPayments queue → Payments tab → Confirm → posts to the account
```

### 6.1 Make `axelpayments1@gmail.com`

The dedicated Gmail for this is **`axelpayments1@gmail.com`**. It needs its own
inbox because the Apps Script runs over the whole mailbox — keep it free of
everything except payment alerts.

### 6.2 Auto-forward the alerts into it

In Axel's **everyday inbox** (where the bank + Venmo currently send alerts):

1. **Settings → See all settings → Forwarding and POP/IMAP → Add a forwarding
   address** → enter `axelpayments1@gmail.com` → confirm the verification link it emails
   to that inbox. (Leave the top "Forward a copy…" option **off** — the filters
   below do the targeted forwarding.)
2. Create **two filters** (search bar → filter icon → fill **From** → Create
   filter → check **Forward it to** → `axelpayments1@gmail.com` → Create filter):
   - **Venmo:** From `venmo@venmo.com`
   - **Fifth Third / Zelle:** From the bank's alert address — confirm it from a
     real alert (commonly under `53.com`). *(Needed before Zelle works.)*

> Alternative: change the notification email at Venmo/Fifth Third directly to the
> dedicated Gmail. Then no filters are needed — that inbox only ever gets alerts.

### 6.3 Install the Apps Script forwarder

1. Signed in as the **dedicated Gmail**, go to https://script.google.com → **New
   project**. Paste in [`apps-script/forwarder.gs`](apps-script/forwarder.gs).
2. Set the two constants at the top:
   - `FUNCTION_URL` → your deployed function URL:
     `https://us-central1-YOUR-PROJECT.cloudfunctions.net/inboundPayment`
   - `SHARED_SECRET` → the **same value** you set for `INBOUND_SHARED_SECRET`.
3. **Run** `forwardPayments` once and grant the Gmail + external-request
   permissions it requests.
4. Click the **clock icon (Triggers) → Add Trigger**: function `forwardPayments`,
   **Time-driven → Minutes timer → Every 5 minutes**. Save.

### 6.4 Test it

- Forward (or wait for) a real Venmo alert into `axelpayments1@gmail.com` → within ~5
  min it appears in the **Payments** tab with the amount, payer, and note. Confirm
  it → the payment posts to the chosen account and the balance drops.
- Re-run the script / forward the same email again → **no duplicate** appears
  (deduped by Gmail message id).
- Locally you can simulate the Apps Script POST without Gmail:

  ```powershell
  $body = '{"secret":"YOUR_SECRET","messageId":"test-1","from":"Venmo <venmo@venmo.com>","subject":"Y Acosta paid you $85.00","body":"Y Acosta paid you `$85.00 Porto bello yard See transaction","receivedAt":"2026-06-03T15:50:00Z"}'
  curl.exe -X POST "http://localhost:5001/YOUR-PROJECT/us-central1/inboundPayment" -H "content-type: application/json" -d $body
  ```

> **Zelle:** the parser ships with a Venmo-complete implementation and a Fifth
> Third **stub** that still queues the amount for manual assignment. Once you
> capture a real Fifth Third alert, finalize the Zelle branch in
> [`functions/parsePaymentEmail.js`](functions/parsePaymentEmail.js) and add the
> bank's sender to the Gmail filter + the script's `SEARCH_QUERY`.

---

## 7. Monthly auto-charge (bills on the 1st)

Every account can be billed automatically on the **1st of each month**. Each
account is set to **one** mode (the tracker keeps these mutually exclusive):

**Charge a saved card/bank (no customer action after enrollment):**

- **Monthly accounts** → **Enable Autopay** (unchanged flow) creates a Stripe
  subscription. New subscriptions are anchored to the 1st; any pre-existing
  Autopay subscriptions are moved to the 1st automatically the first time the
  monthly job runs (a one-time free gap of up to one month, no double charge).
- **Per-cut accounts** → **Enable Auto-charge** texts the customer a Stripe
  "save your card/bank" link (Checkout in setup mode). Once saved, the monthly
  job bills **all their un-billed cuts** on the 1st (variable amount). Skips
  accounts with no un-billed cuts. A failed charge flags the account
  ("Auto-charge failed") and leaves the invoice open for follow-up.

**Email an invoice the customer pays themselves (no saved card):**

- **Auto-invoice on the 1st** — a per-account toggle on either type. On the 1st
  the job emails a Stripe invoice: **monthly** accounts get their fixed rate;
  **per-cut** accounts get all their un-billed cuts. The customer pays via the
  hosted link (card or bank). Needs an email on the account, nothing else — no
  enrollment link, no saved card. Turn it on/off from the account screen.

The engine for all of the above is the **`monthlyAutoCharge`** scheduled function
(`functions/monthlyAutoCharge.js`), which runs at **08:00 America/New_York on the
1st** (`0 8 1 * *`).

**Setup:** nothing extra beyond a normal deploy.

- Deploying an `onSchedule` function **auto-provisions a Cloud Scheduler job**
  (Blaze plan required — already needed for Functions). Firebase enables the
  Cloud Scheduler API on first deploy; approve it if prompted.
- **No new Stripe webhook events** are required — setup-mode enrollment arrives
  on the `checkout.session.completed` event, and auto-charges settle on
  `invoice.paid` / `invoice.payment_failed`, all already subscribed in step 5.

```powershell
firebase deploy --only functions
# confirm the schedule exists:
gcloud scheduler jobs list --project YOUR-PROJECT
```

To change the day/time, edit the `schedule` / `timeZone` in
`functions/monthlyAutoCharge.js` and redeploy.

**Test it (Test mode):**

1. On a **per-cut** account, click **Enable Auto-charge**, open the link, save a
   Stripe **test card** (`4242 4242 4242 4242`). The account shows an
   "Auto-charge" pill.
2. Log a cut or two so there are un-billed charges.
3. Force a run without waiting for the 1st:
   ```powershell
   gcloud scheduler jobs run firebase-schedule-monthlyAutoCharge-us-central1 --project YOUR-PROJECT
   ```
   (or **Cloud Scheduler → the job → Force run** in the console.)
4. The cuts get billed on one Stripe invoice, charged automatically, and the
   webhook posts the payment — the balance nets to zero and the invoice shows paid.

---

## How it works (quick reference)

| Action | What happens |
|---|---|
| **Log Cut** (per-cut acct) | Adds a charge = the cut price; balance goes up. |
| **Log Cut** (monthly acct) | Records service history only; no charge (subscription is the bill). |
| **Add Charge** | Extra one-off work; balance goes up. |
| **Send Invoice** | Creates + emails a Stripe invoice for the selected un-billed charges (card/ACH). |
| **Enable Autopay** (monthly) | Generates a Stripe enrollment link to text the customer; once they enter a card/bank, a monthly subscription auto-charges them **on the 1st**. |
| **Enable Auto-charge** (per-cut) | Generates a Stripe "save your card/bank" link to text the customer; once saved, **all un-billed cuts are auto-charged on the 1st of each month** (variable amount). |
| **Auto-invoice on the 1st** (either type) | Emails a Stripe invoice on the 1st that the customer pays via the link — **no saved card**. Monthly = the fixed rate; per-cut = all un-billed cuts. Mutually exclusive with the card auto-billing above. |
| **Record Payment** | Logs a direct cash/check/Zelle payment not tied to an invoice. |
| **Mark Paid** (on an open invoice) | Marks the Stripe invoice paid out-of-band (customer paid by cash/check/Zelle). |
| Venmo/Zelle alert is forwarded | `inboundPayment` parses it, fuzzy-matches an account, and queues it on the **Payments** tab. |
| **Confirm** (Payments tab) | Posts the queued payment to the chosen account (date = email date); learns the payer name as an alias. No balance change until confirmed. |
| Stripe charges/pays an invoice | The webhook records the charge + payment automatically; dashboard updates. |
| **Monthly auto-charge job** (1st, 8am ET) | Re-anchors monthly Autopay to the 1st (one-time each), then auto-charges every per-cut auto-charge account's un-billed cuts. |

**Data lives in Firestore** under `accounts/{id}` with `charges`, `payments`,
`invoices`, and `cuts` subcollections. Account rollups (`balance`, `totalPaid`, …)
are kept accurate by transactions (manual actions) and the webhook (Stripe actions).

**Security:** only Axel's signed-in account can read/write data (Firestore rules).
Callable functions require his auth; the webhook verifies Stripe's signature. No raw
card data ever touches this app — Stripe-hosted pages handle all card/bank entry.
