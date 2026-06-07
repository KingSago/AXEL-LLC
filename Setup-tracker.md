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
```

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

## How it works (quick reference)

| Action | What happens |
|---|---|
| **Log Cut** (per-cut acct) | Adds a charge = the cut price; balance goes up. |
| **Log Cut** (monthly acct) | Records service history only; no charge (subscription is the bill). |
| **Add Charge** | Extra one-off work; balance goes up. |
| **Send Invoice** | Creates + emails a Stripe invoice for the selected un-billed charges (card/ACH). |
| **Enable Autopay** (monthly) | Generates a Stripe enrollment link to text the customer; once they enter a card/bank, a monthly subscription auto-charges them. |
| **Record Payment** | Logs a direct cash/check/Zelle payment not tied to an invoice. |
| **Mark Paid** (on an open invoice) | Marks the Stripe invoice paid out-of-band (customer paid by cash/check/Zelle). |
| Stripe charges/pays an invoice | The webhook records the charge + payment automatically; dashboard updates. |

**Data lives in Firestore** under `accounts/{id}` with `charges`, `payments`,
`invoices`, and `cuts` subcollections. Account rollups (`balance`, `totalPaid`, …)
are kept accurate by transactions (manual actions) and the webhook (Stripe actions).

**Security:** only Axel's signed-in account can read/write data (Firestore rules).
Callable functions require his auth; the webhook verifies Stripe's signature. No raw
card data ever touches this app — Stripe-hosted pages handle all card/bank entry.
