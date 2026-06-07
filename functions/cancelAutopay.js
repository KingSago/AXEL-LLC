/* ============================================================
   cancelAutopay — cancel a monthly account's Stripe subscription.
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
  const subId = snap.data()?.autopay?.stripeSubscriptionId;

  if (subId) {
    const stripe = getStripe();
    try {
      await stripe.subscriptions.cancel(subId);
    } catch (err) {
      // If it's already gone on Stripe's side, proceed to clear locally.
      if (err?.code !== "resource_missing") throw err;
    }
  }

  await ref.set(
    {
      autopay: {
        status: "none",
        stripeSubscriptionId: null,
        methodType: null,
        checkoutSessionId: null,
      },
    },
    { merge: true }
  );

  return { ok: true };
});
