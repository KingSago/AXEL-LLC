/* ============================================================
   Shared invoice helpers used by both the manual sendInvoice
   flow (per-cut "Send Invoice") and the scheduled monthly
   auto-charge. Keeping the charge-collecting, invoice-item, and
   local-mirroring logic here keeps the two callers in sync.
   ============================================================ */
const { db, FieldValue } = require("./init");

// Shown at the bottom of every invoice (hosted page + PDF).
const INVOICE_FOOTER = [
  "Axel's Trusted LLC",
  "Facebook: https://www.facebook.com/profile.php?id=61573187173394",
].join("\n");

/** Human-readable label for a charge with no description. */
function labelForCharge(c) {
  if (c.type === "cut") return `Lawn service${c.date ? " — " + c.date : ""}`;
  if (c.type === "monthly") return `Monthly service${c.period ? " — " + c.period : ""}`;
  return "Service";
}

/** Load every charge on an account that isn't already attached to an invoice. */
async function loadAllUnbilledCharges(acctRef) {
  const snap = await acctRef.collection("charges").get();
  return snap.docs
    .filter((s) => !s.data().invoiceId)
    .map((s) => ({ id: s.id, ...s.data() }));
}

/** Attach one Stripe invoice item per charge to a draft invoice. */
async function addInvoiceItems(stripe, { customerId, invoiceId, charges }) {
  for (const c of charges) {
    await stripe.invoiceItems.create({
      customer: customerId,
      invoice: invoiceId,
      currency: "usd",
      amount: Math.round(Number(c.amount) * 100),
      description: c.description || labelForCharge(c),
    });
  }
}

/**
 * Mirror a Stripe invoice into Firestore and tag its charges, in one batch:
 *   - accounts/{id}/invoices/{localId}   the local invoice record
 *   - each charge gets invoiceId + stripeInvoiceId
 *   - stripeInvoices/{stripeId} -> { accountId, localInvoiceId }  (webhook lookup)
 *
 * `stripeInvoice` may be a draft (number/urls null) — call before finalizing so
 * the webhook can map an immediate invoice.paid back to this local doc, then
 * backfill number/urls afterward. Returns the local invoice id.
 */
async function mirrorInvoiceLocally({ acctRef, accountId, stripeInvoice, charges, total }) {
  const localRef = acctRef.collection("invoices").doc();
  const batch = db.batch();
  batch.set(localRef, {
    stripeInvoiceId: stripeInvoice.id,
    number: stripeInvoice.number || null,
    hostedInvoiceUrl: stripeInvoice.hosted_invoice_url || null,
    pdfUrl: stripeInvoice.invoice_pdf || null,
    lineItems: charges.map((c) => ({
      description: c.description || labelForCharge(c),
      amount: Number(c.amount),
      date: c.date || null,
    })),
    total,
    status: "open",
    dueDate: stripeInvoice.due_date
      ? new Date(stripeInvoice.due_date * 1000).toISOString().slice(0, 10)
      : null,
    dateIssued: FieldValue.serverTimestamp(),
    paidAt: null,
    createdAt: FieldValue.serverTimestamp(),
  });
  for (const c of charges) {
    batch.update(acctRef.collection("charges").doc(c.id), {
      invoiceId: localRef.id,
      stripeInvoiceId: stripeInvoice.id,
    });
  }
  batch.set(db.collection("stripeInvoices").doc(stripeInvoice.id), {
    accountId,
    localInvoiceId: localRef.id,
  });
  await batch.commit();
  return localRef.id;
}

/**
 * Finalize an invoice, retrying as card-only if the total is below Stripe's
 * ACH (us_bank_account) minimum. Cards have a far lower floor, so small
 * invoices still go out — just without the bank-payment option.
 */
async function finalizeWithFallback(stripe, invoiceId) {
  try {
    return await stripe.invoices.finalizeInvoice(invoiceId);
  } catch (err) {
    if (err && err.code === "amount_too_small") {
      // Drop bank/ACH while the invoice is still a draft, then finalize again.
      await stripe.invoices.update(invoiceId, {
        payment_settings: { payment_method_types: ["card"] },
      });
      return stripe.invoices.finalizeInvoice(invoiceId);
    }
    throw err;
  }
}

/** Finalize (with the ACH fallback) then email the invoice; returns the sent invoice. */
async function finalizeAndSendInvoice(stripe, invoiceId) {
  await finalizeWithFallback(stripe, invoiceId);
  return stripe.invoices.sendInvoice(invoiceId);
}

module.exports = {
  INVOICE_FOOTER,
  labelForCharge,
  loadAllUnbilledCharges,
  addInvoiceItems,
  mirrorInvoiceLocally,
  finalizeWithFallback,
  finalizeAndSendInvoice,
};
