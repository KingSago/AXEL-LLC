/* ============================================================
   monthlyAutoCharge — runs on the 1st of every month (8am ET).

   1) Re-anchors any existing monthly Autopay subscriptions to the
      1st of the month (one-time each, so all monthly billing lands
      on the same day going forward).
   2) Auto-charges every per-cut account that has a saved card/bank:
      gathers ALL un-billed cuts, bills them on one Stripe invoice
      set to charge_automatically, and Stripe collects off-session.
   3) Auto-invoices every account set to autoInvoice (no saved card):
      emails a Stripe invoice the customer pays via the link. Monthly
      accounts are billed their fixed rate; per-cut accounts get all
      their un-billed cuts. Card billing and auto-invoice are mutually
      exclusive per account (enforced in the UI + guarded here).

   The existing stripeWebhook records the payment + marks the invoice
   paid (invoice.paid) or flags a failure (invoice.payment_failed).
   ============================================================ */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const {
  db,
  FieldValue,
  getStripe,
  accountRef,
  nextFirstOfMonthUnix,
  STRIPE_SECRET_KEY,
} = require("./lib/init");
const { ensureCustomer } = require("./lib/customer");
const {
  INVOICE_FOOTER,
  loadAllUnbilledCharges,
  addInvoiceItems,
  mirrorInvoiceLocally,
  finalizeAndSendInvoice,
} = require("./lib/invoice");

module.exports = onSchedule(
  {
    schedule: "0 8 1 * *",
    timeZone: "America/New_York",
    secrets: [STRIPE_SECRET_KEY],
  },
  async () => {
    const stripe = getStripe();
    const period = new Date().toISOString().slice(0, 7); // YYYY-MM

    await reanchorMonthlyAutopay(stripe);

    // Per-cut accounts with a saved payment method (status "active").
    const chargeSnap = await db
      .collection("accounts")
      .where("autoCharge.status", "==", "active")
      .get();

    for (const doc of chargeSnap.docs) {
      const account = { id: doc.id, ...doc.data() };
      if (account.billingType !== "percut") continue; // defensive
      if (account.autoInvoice?.status === "active") continue; // never both
      try {
        await chargeAccount(stripe, account, period);
      } catch (err) {
        // One account's failure must never abort the whole monthly run.
        console.error(`monthlyAutoCharge: charge ${account.id} failed:`, err.message);
      }
    }

    // Accounts set to auto-invoice (emailed, customer pays — no saved card).
    const invoiceSnap = await db
      .collection("accounts")
      .where("autoInvoice.status", "==", "active")
      .get();

    for (const doc of invoiceSnap.docs) {
      const account = { id: doc.id, ...doc.data() };
      // Never bill an account two ways.
      if (account.autopay?.status === "active" || account.autoCharge?.status === "active") continue;
      try {
        await autoInvoiceAccount(stripe, account, period);
      } catch (err) {
        console.error(`monthlyAutoCharge: invoice ${account.id} failed:`, err.message);
      }
    }
  },
);

/**
 * Bill an account's un-billed cuts to its saved payment method.
 * Claims the period first (transaction) so a re-run can never double-charge —
 * we prefer a rare missed charge (recoverable) over ever billing twice.
 */
async function chargeAccount(stripe, account, period) {
  const acctRef = accountRef(account.id);

  const claimed = await db.runTransaction(async (tx) => {
    const ac = (await tx.get(acctRef)).data()?.autoCharge || {};
    if (ac.status !== "active") return false;
    if (ac.lastBilledPeriod === period) return false; // already billed this month
    tx.set(acctRef, { autoCharge: { lastBilledPeriod: period } }, { merge: true });
    return true;
  });
  if (!claimed) return;

  const charges = await loadAllUnbilledCharges(acctRef);
  if (!charges.length) return; // nothing to bill this month
  const total = charges.reduce((sum, c) => sum + Number(c.amount || 0), 0);

  const customerId = account.stripeCustomerId;
  const pmId = account.autoCharge?.defaultPaymentMethodId || undefined;

  // Draft invoice that will collect automatically from the saved method.
  const invoice = await stripe.invoices.create({
    customer: customerId,
    collection_method: "charge_automatically",
    default_payment_method: pmId,
    auto_advance: false,
    footer: INVOICE_FOOTER,
    metadata: { accountId: account.id },
  });

  await addInvoiceItems(stripe, { customerId, invoiceId: invoice.id, charges });

  // Mirror BEFORE finalizing so an immediate invoice.paid webhook can map back
  // to this local doc. Number/urls are filled in after finalize below.
  const localInvoiceId = await mirrorInvoiceLocally({
    acctRef,
    accountId: account.id,
    stripeInvoice: invoice,
    charges,
    total,
  });

  const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
  await acctRef.collection("invoices").doc(localInvoiceId).set(
    {
      number: finalized.number || null,
      hostedInvoiceUrl: finalized.hosted_invoice_url || null,
      pdfUrl: finalized.invoice_pdf || null,
    },
    { merge: true },
  );

  // Charge the saved method now (off-session). auto_advance is off, so we must
  // trigger collection explicitly. A decline throws here AND fires
  // invoice.payment_failed, which flags the account; the invoice stays open for
  // Axel to follow up — so we swallow the throw and let the webhook record state.
  try {
    await stripe.invoices.pay(invoice.id);
  } catch (err) {
    console.warn(`monthlyAutoCharge: charge failed for ${account.id}:`, err.message);
  }
}

/**
 * Email an invoice the customer pays themselves (no saved card). Monthly
 * accounts are billed their fixed rate (posted as this month's charge first);
 * per-cut accounts get all their un-billed cuts. Claims the period first so a
 * re-run can never email twice.
 */
async function autoInvoiceAccount(stripe, account, period) {
  const acctRef = accountRef(account.id);

  // Stripe can only email an invoice to a customer with an address on file.
  if (!(account.email || "").trim()) {
    console.warn(`monthlyAutoCharge: ${account.id} has no email; auto-invoice skipped.`);
    return;
  }

  const claimed = await db.runTransaction(async (tx) => {
    const ai = (await tx.get(acctRef)).data()?.autoInvoice || {};
    if (ai.status !== "active") return false;
    if (ai.lastInvoicedPeriod === period) return false; // already invoiced this month
    tx.set(acctRef, { autoInvoice: { lastInvoicedPeriod: period } }, { merge: true });
    return true;
  });
  if (!claimed) return;

  // Monthly accounts don't accrue charges on their own — post this month's
  // fixed rate as a charge (idempotent on the period) so there's something to
  // invoice and the balance reflects it.
  if (account.billingType === "monthly") {
    const rate = Number(account.rate || 0);
    if (rate > 0) {
      await postChargeOnce(acctRef, `monthly_${period}`, {
        type: "monthly",
        amount: rate,
        date: `${period}-01`,
        period,
        description: `Monthly service — ${period}`,
      });
    }
  }

  // Bill the fixed rate just posted plus any un-billed extras/cuts.
  const charges = await loadAllUnbilledCharges(acctRef);
  if (!charges.length) return; // per-cut account with no cuts this month
  const total = charges.reduce((sum, c) => sum + Number(c.amount || 0), 0);

  const customerId = await ensureCustomer(stripe, account.id);
  const invoice = await stripe.invoices.create({
    customer: customerId,
    collection_method: "send_invoice",
    days_until_due: 7,
    auto_advance: false,
    payment_settings: { payment_method_types: ["card", "us_bank_account"] },
    footer: INVOICE_FOOTER,
    metadata: { accountId: account.id },
  });

  await addInvoiceItems(stripe, { customerId, invoiceId: invoice.id, charges });
  const sent = await finalizeAndSendInvoice(stripe, invoice.id);

  await mirrorInvoiceLocally({
    acctRef,
    accountId: account.id,
    stripeInvoice: sent,
    charges,
    total,
  });
}

/** Create a charge with a fixed doc id once, bumping the account rollups. */
async function postChargeOnce(acctRef, docId, data) {
  const ref = acctRef.collection("charges").doc(docId);
  await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return; // already posted this period
    tx.set(ref, { ...data, createdAt: FieldValue.serverTimestamp() });
    tx.set(
      acctRef,
      {
        totalCharged: FieldValue.increment(data.amount),
        balance: FieldValue.increment(data.amount),
      },
      { merge: true },
    );
  });
}

/**
 * Move existing active Autopay subscriptions to bill on the 1st. One-time per
 * account (guarded by autopay.billingAnchor === "first"). Setting trial_end to
 * the next 1st pauses billing until then, then anchors monthly billing to the
 * 1st — no immediate or double charge.
 */
async function reanchorMonthlyAutopay(stripe) {
  const snap = await db
    .collection("accounts")
    .where("autopay.status", "==", "active")
    .get();
  const anchor = nextFirstOfMonthUnix();

  for (const doc of snap.docs) {
    const a = doc.data();
    if (a.autopay?.billingAnchor === "first") continue; // already on the 1st
    const subId = a.autopay?.stripeSubscriptionId;
    if (!subId) continue;
    try {
      await stripe.subscriptions.update(subId, {
        trial_end: anchor,
        proration_behavior: "none",
      });
      await accountRef(doc.id).set(
        { autopay: { billingAnchor: "first" } },
        { merge: true },
      );
    } catch (err) {
      console.error(`monthlyAutoCharge: re-anchor ${doc.id} failed:`, err.message);
    }
  }
}
