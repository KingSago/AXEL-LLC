# Zelle / Venmo Payment Automation — Plan (lighter middle ground)

## Goal

Stop hand-typing every Zelle and Venmo payment. Instead, the bank/Venmo
notification emails flow into the tracker on their own and land in a **review
queue** on a new **Payments** tab. When Axel has a minute (not while mowing), he
taps **Confirm** and the payment posts to the right account. **Nothing touches a
customer's balance until he confirms it** — so a wrong auto-match can never
silently corrupt a balance.

This is the "lighter middle ground": full automation of *capture + matching*,
but a human still approves each post.

## Confirmed decisions

- **Capture:** forward the notification emails to the app (no Plaid, no bank API).
- **Email pipeline:** a free **dedicated Gmail** (e.g. `axelpayments@gmail.com`)
  + a tiny **Google Apps Script** on that inbox that POSTs new emails to a Cloud
  Function. No DNS changes, no domain risk, free.
- **Queue behavior:** **everything** lands in the Payments queue. Confident
  matches are pre-selected (one-tap **Confirm**); uncertain ones show the top
  suggestions to pick from. No auto-posting.
- **Low-confidence matches:** show top suggested accounts, all sitting in the
  Payments tab so they don't interrupt fieldwork.
- **Sources:** **Fifth Third Bank** Zelle "you received" alerts + **Venmo** "you
  received" alerts. (Cash/check still recorded by hand — they can't be emailed.)

## How it flows

```
Fifth Third Zelle alert  ┐
Venmo "you received" email ┘
        │  (auto-forward filters in Axel's main inbox)
        ▼
  axelpayments@gmail.com  (dedicated, free)
        │  Apps Script time trigger (~every 1–5 min):
        │  finds unprocessed mail → POSTs {from, subject, body, date, id}
        │  with a shared-secret header → labels it "processed"
        ▼
  inboundPayment()  Cloud Function (Firebase)
        │  • verify shared secret
        │  • detect method (Fifth Third → zelle, venmo → venmo)
        │  • parse amount, payer name, date, txn id
        │  • dedup on email message id (idempotent)
        │  • fuzzy-match payer name → accounts (+ learned aliases)
        │  • write pendingPayments/{id}  (status: "pending")  ── NO balance change
        ▼
  Firestore: pendingPayments queue
        ▼
  Tracker app → "Payments" tab (live)
        • confident: account pre-selected → [Confirm]   (1 tap)
        • unsure:    [Smith] [Soto] [search…] → [Confirm]
        • [Dismiss] for non-payments / spam
        │  Confirm = existing recordManualPayment() in a transaction
        ▼
  Account balance + ledger update (method = Zelle/Venmo, date = email date)
```

## New / changed pieces

### Backend (`functions/`)
- **`functions/inboundPayment.js`** *(new, HTTPS)* — verifies the shared secret,
  runs the parser + matcher, writes a `pendingPayments` doc via the Admin SDK.
  Idempotent on email message id (a double-forward never duplicates).
- **`functions/parsePaymentEmail.js`** *(new)* — pure parser. Two formats:
  Fifth Third Zelle and Venmo. Returns `{ method, amount, payerName, receivedAt,
  externalId }`. Tolerant regex; unit-tested against real samples.
- **`functions/matchAccount.js`** *(new)* — normalizes the payer name and scores
  it against account names + learned aliases (token-set similarity). Returns
  ranked candidates + a `high`/`low` confidence flag (high = top score ≥ ~0.85
  with a clear lead over #2).
- **`functions/index.js`** — export `inboundPayment`.
- **Secret:** `INBOUND_SHARED_SECRET` (set via `firebase functions:secrets:set`),
  the same value pasted into the Apps Script. Rejects any unsigned POST.

### Email pipeline (`apps-script/`)
- **`apps-script/forwarder.gs`** *(new)* — paste-in Apps Script for the dedicated
  Gmail: time-driven trigger, `search` for unprocessed messages, POST each to
  `inboundPayment`, then label/archive as processed. ~40 lines, no build step.

### Frontend (`tracker/`)
- **`tracker/index.html`** — add a **Payments** nav tab with an unread-count badge.
- **`tracker/tracker.js`** — Payments view: live listener on `pendingPayments`
  (status `pending`); render each as a card with pre-selected/suggested account +
  search; **Confirm** reuses `recordManualPayment()` (passing the email's amount,
  method, and date) inside a transaction that also flips the pending doc to
  `confirmed`; **Dismiss** sets `dismissed`. Badge = count of pending.
- **`tracker/tracker.css`** — queue card styling, badge, confidence colors.

### Data model (Firestore)
- **`pendingPayments/{id}`** *(new top-level collection)*:
  `method` (`zelle|venmo`), `amount`, `payerNameRaw`, `payerNameNormalized`,
  `receivedAt` (from the email), `externalId`, `emailMessageId` (dedup key),
  `rawSnippet`, `candidates` `[{accountId, name, score}]`, `suggestedAccountId`,
  `confidence` (`high|low`), `status` (`pending|confirmed|dismissed`),
  `confirmedAccountId`, `confirmedPaymentId`, `createdAt`, `resolvedAt`.
- **`accounts/{id}`** — add `paymentAliases: string[]`. When Axel confirms a
  low-confidence match, the raw payer name is saved here so the *next* email from
  that person matches confidently. The matcher learns over time.
- **`firestore.rules`** — the existing `/{document=**}` rule already locks
  `pendingPayments` to Axel's UID for the in-app confirm/dismiss; `inboundPayment`
  writes via the Admin SDK (bypasses rules). No rule change required.

### Docs
- **`Setup-tracker.md`** — add a "Payments automation" section: create the
  dedicated Gmail, set the auto-forward filters (Fifth Third sender + Venmo
  sender), paste the Apps Script + its trigger, set `INBOUND_SHARED_SECRET`,
  register the function URL in the script.

## Why this is safe

- **No auto-posting** — every payment is human-approved; a confident-but-wrong
  match is caught at the one-tap review, not after a balance is corrupted.
- **Idempotent ingest** — dedup on email message id; confirm guarded against
  double-posting.
- **Read-only on the bank** — we only read forwarded *notification* emails; no
  bank credentials, no Plaid, no API into Zelle/Venmo (neither offers one).
- **Self-improving matching** — confirmed aliases make future matches confident,
  shrinking the queue work over time.
- **Field-friendly** — it's a passive queue; it never interrupts him mowing.

## One thing needed before building the parser

Real sample emails so the regex is exact (formats differ by bank/Venmo version):
1. One **Fifth Third** Zelle "you received money" alert.
2. One **Venmo** "you received / paid you" alert.

(Forward them to yourself, or paste the subject + body text.) The architecture
above is final regardless; only `parsePaymentEmail.js` needs the samples to be
reliable.

## Verification

1. **Parser** — unit tests pass against the real Fifth Third + Venmo samples
   (amount, name, date, method extracted correctly).
2. **Ingest** — forward a test alert → a `pendingPayments` doc appears; a second
   forward of the same email does **not** create a duplicate.
3. **Queue UI** — Payments tab shows the item with the right method/amount;
   confident match pre-selected, low-confidence shows suggestions + search; badge
   count correct.
4. **Confirm** — tap Confirm → payment posts to the account (method = Zelle/
   Venmo, date = email date), balance + ledger update, pending doc → `confirmed`.
5. **Alias learning** — confirm a low-confidence match → the raw name is saved as
   an alias → a fresh email from that payer now matches confidently.
6. **Dismiss** — non-payment email → Dismiss → no balance change, leaves queue.
7. **Security** — `inboundPayment` rejects a POST without the shared secret; the
   Payments tab is invisible/denied when logged out.
8. **Cost** — Apps Script free; function invocations + Firestore well within the
   Blaze free tier (~$0 at this volume).
```
