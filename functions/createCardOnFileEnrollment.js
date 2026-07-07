/* ============================================================
   createCardOnFileEnrollment — returns a Stripe-hosted Checkout
   link (SETUP mode) that saves a per-cut customer's card or bank
   ONCE. After they save it, the monthlyAutoCharge scheduled job
   bills that month's un-billed cuts to it on the 1st.
   ============================================================ */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const {
  getStripe,
  assertAxel,
  accountRef,
  APP_BASE_URL,
  STRIPE_SECRET_KEY,
} = require("./lib/init");
const { ensureCustomer } = require("./lib/customer");

module.exports = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  assertAxel(request);
  const { accountId } = request.data || {};
  if (!accountId) throw new HttpsError("invalid-argument", "accountId required.");

  const stripe = getStripe();
  const ref = accountRef(accountId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Account not found.");
  const account = snap.data();
  if (account.billingType !== "percut") {
    throw new HttpsError(
      "failed-precondition",
      "Auto-charge is for per-cut accounts. Monthly accounts use Autopay.",
    );
  }

  const customerId = await ensureCustomer(stripe, accountId);
  const base = APP_BASE_URL.value();

  // Setup mode captures a reusable payment method without charging anything now.
  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: customerId,
    currency: "usd",
    payment_method_types: ["card", "us_bank_account"],
    setup_intent_data: { metadata: { accountId } },
    metadata: { accountId, purpose: "autocharge_setup" },
    success_url: `${base}/?autocharge=success&account=${accountId}`,
    cancel_url: `${base}/?autocharge=cancel&account=${accountId}`,
  });

  await ref.set(
    { autoCharge: { status: "pending", setupCheckoutSessionId: session.id } },
    { merge: true },
  );

  return { url: session.url };
});
