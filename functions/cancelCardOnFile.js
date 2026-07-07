/* ============================================================
   cancelCardOnFile — turn off auto-charge for a per-cut account:
   detach the saved payment method and clear the autoCharge flags.
   ============================================================ */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getStripe, assertAxel, accountRef, STRIPE_SECRET_KEY } = require("./lib/init");

module.exports = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  assertAxel(request);
  const { accountId } = request.data || {};
  if (!accountId) throw new HttpsError("invalid-argument", "accountId required.");

  const ref = accountRef(accountId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Account not found.");
  const account = snap.data();
  const pmId = account.autoCharge?.defaultPaymentMethodId;

  if (pmId) {
    const stripe = getStripe();
    // Detach the saved method and clear the customer's default so nothing can
    // be charged after cancellation. Both are best-effort — if Stripe already
    // lost the method, still clear our local flags below.
    try { await stripe.paymentMethods.detach(pmId); } catch (_) {}
    if (account.stripeCustomerId) {
      try {
        await stripe.customers.update(account.stripeCustomerId, {
          invoice_settings: { default_payment_method: "" },
        });
      } catch (_) {}
    }
  }

  await ref.set(
    {
      autoCharge: {
        status: "none",
        defaultPaymentMethodId: null,
        methodType: null,
        setupCheckoutSessionId: null,
        lastFailureAt: null,
      },
    },
    { merge: true },
  );

  return { ok: true };
});
