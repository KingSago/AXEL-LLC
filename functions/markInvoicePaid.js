/* ============================================================
   markInvoicePaid — when a customer pays an open Stripe invoice
   by cash/check/Zelle/etc., mark it paid "out of band" so Stripe
   and the dashboard agree. The payment row is recorded by the
   webhook (single writer), using the method we stash in metadata.
   ============================================================ */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getStripe, assertAxel, accountRef, STRIPE_SECRET_KEY } = require("./lib/init");

const MANUAL_METHODS = ["cash", "check", "zelle", "venmo", "cashapp"];

module.exports = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  assertAxel(request);
  const { accountId, invoiceId, method } = request.data || {};
  if (!accountId || !invoiceId || !MANUAL_METHODS.includes(method)) {
    throw new HttpsError("invalid-argument", "accountId, invoiceId, valid method required.");
  }

  const ref = accountRef(accountId);
  const invSnap = await ref.collection("invoices").doc(invoiceId).get();
  if (!invSnap.exists) throw new HttpsError("not-found", "Invoice not found.");
  const stripeInvoiceId = invSnap.data().stripeInvoiceId;
  if (!stripeInvoiceId) throw new HttpsError("failed-precondition", "No Stripe invoice id.");

  const stripe = getStripe();
  // Record the real payment method so the webhook can label the payment row.
  await stripe.invoices.update(stripeInvoiceId, { metadata: { paidMethod: method } });
  await stripe.invoices.pay(stripeInvoiceId, { paid_out_of_band: true });

  return { ok: true };
});
