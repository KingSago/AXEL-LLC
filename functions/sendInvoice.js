/* ============================================================
   sendInvoice — create + send a Stripe invoice for a per-cut /
   variable account from its selected unpaid charges.
   ============================================================ */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { db, getStripe, assertAxel, accountRef, STRIPE_SECRET_KEY } = require("./lib/init");
const { ensureCustomer } = require("./lib/customer");
const {
  INVOICE_FOOTER,
  addInvoiceItems,
  mirrorInvoiceLocally,
  finalizeAndSendInvoice,
} = require("./lib/invoice");

module.exports = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  assertAxel(request);
  const { accountId, chargeIds, daysUntilDue = 7 } = request.data || {};
  if (!accountId || !Array.isArray(chargeIds) || chargeIds.length === 0) {
    throw new HttpsError("invalid-argument", "accountId and chargeIds required.");
  }

  const stripe = getStripe();
  const acctRef = accountRef(accountId);
  const acctSnap = await acctRef.get();
  if (!acctSnap.exists) throw new HttpsError("not-found", "Account not found.");

  // Stripe can only email an invoice to a customer with an email address.
  // Catch the empty case here so the client gets a clear, fixable message.
  if (!(acctSnap.data().email || "").trim()) {
    throw new HttpsError(
      "failed-precondition",
      "This account has no email address. Add the customer's email on the account, then send the invoice.",
    );
  }

  // Load the selected charges, skipping any already attached to an invoice.
  const chargeRefs = chargeIds.map((id) => acctRef.collection("charges").doc(id));
  const chargeSnaps = await db.getAll(...chargeRefs);
  const charges = chargeSnaps
    .filter((s) => s.exists && !s.data().invoiceId)
    .map((s) => ({ id: s.id, ...s.data() }));
  if (charges.length === 0) {
    throw new HttpsError("failed-precondition", "No un-billed charges selected.");
  }

  const total = charges.reduce((sum, c) => sum + Number(c.amount || 0), 0);

  // All Stripe calls run inside this try so any Stripe rejection reaches the
  // client as a readable message instead of a generic "internal" error.
  let sent;
  try {
    const customerId = await ensureCustomer(stripe, accountId);

    // Create a draft invoice, attach an invoice item per charge, finalize, send.
    const invoice = await stripe.invoices.create({
      customer: customerId,
      collection_method: "send_invoice",
      days_until_due: daysUntilDue,
      auto_advance: false,
      payment_settings: {
        payment_method_types: ["card", "us_bank_account"],
      },
      footer: INVOICE_FOOTER,
      metadata: { accountId },
    });

    await addInvoiceItems(stripe, { customerId, invoiceId: invoice.id, charges });

    sent = await finalizeAndSendInvoice(stripe, invoice.id);
  } catch (err) {
    throw stripeToHttpsError(err);
  }

  // Mirror the invoice locally and tag the charges.
  const localInvoiceId = await mirrorInvoiceLocally({
    acctRef,
    accountId,
    stripeInvoice: sent,
    charges,
    total,
  });

  return {
    invoiceId: localInvoiceId,
    stripeInvoiceId: sent.id,
    hostedInvoiceUrl: sent.hosted_invoice_url,
    total,
  };
});

/** Convert a Stripe (or other) error into a client-readable HttpsError. */
function stripeToHttpsError(err) {
  if (err instanceof HttpsError) return err;
  const message =
    (err && (err.raw?.message || err.message)) || "Failed to send invoice.";
  // Invalid-request errors are caller-fixable (amount too small, missing
  // customer email, etc.) — surface the real reason, not a generic failure.
  if (err && err.type === "StripeInvalidRequestError") {
    return new HttpsError("failed-precondition", message);
  }
  return new HttpsError("internal", message);
}
