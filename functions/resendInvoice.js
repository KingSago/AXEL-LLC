/* ============================================================
   resendInvoice — re-email an already-sent Stripe invoice to the
   customer as a reminder. No new invoice or charge is created; the
   local invoice stays "open" and is flipped to "paid" by the
   webhook when the customer eventually pays.
   ============================================================ */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getStripe, assertAxel, accountRef, STRIPE_SECRET_KEY } = require("./lib/init");

module.exports = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  assertAxel(request);
  const { accountId, invoiceId } = request.data || {};
  if (!accountId || !invoiceId) {
    throw new HttpsError("invalid-argument", "accountId and invoiceId required.");
  }

  const acctRef = accountRef(accountId);
  const acctSnap = await acctRef.get();
  if (!acctSnap.exists) throw new HttpsError("not-found", "Account not found.");

  // Stripe can only email an invoice to a customer with an email address.
  if (!(acctSnap.data().email || "").trim()) {
    throw new HttpsError(
      "failed-precondition",
      "This account has no email address. Add the customer's email on the account, then resend the invoice.",
    );
  }

  const invSnap = await acctRef.collection("invoices").doc(invoiceId).get();
  if (!invSnap.exists) throw new HttpsError("not-found", "Invoice not found.");
  const inv = invSnap.data();
  if (inv.status !== "open") {
    throw new HttpsError("failed-precondition", "Only unpaid invoices can be resent.");
  }
  if (!inv.stripeInvoiceId) {
    throw new HttpsError("failed-precondition", "No Stripe invoice id on this invoice.");
  }

  try {
    await getStripe().invoices.sendInvoice(inv.stripeInvoiceId);
  } catch (err) {
    throw stripeToHttpsError(err);
  }

  return { ok: true };
});

/** Convert a Stripe (or other) error into a client-readable HttpsError. */
function stripeToHttpsError(err) {
  if (err instanceof HttpsError) return err;
  const message =
    (err && (err.raw?.message || err.message)) || "Failed to resend invoice.";
  if (err && err.type === "StripeInvalidRequestError") {
    return new HttpsError("failed-precondition", message);
  }
  return new HttpsError("internal", message);
}
