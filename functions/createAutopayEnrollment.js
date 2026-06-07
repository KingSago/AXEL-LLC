/* ============================================================
   createAutopayEnrollment — returns a Stripe-hosted Checkout
   link (subscription mode) that captures the customer's card or
   bank ONCE and starts the monthly subscription in one step.
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

module.exports = onCall(
  { secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    assertAxel(request);
    const { accountId } = request.data || {};
    if (!accountId) throw new HttpsError("invalid-argument", "accountId required.");

    const stripe = getStripe();
    const ref = accountRef(accountId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Account not found.");
    const account = snap.data();
    if (account.billingType !== "monthly") {
      throw new HttpsError("failed-precondition", "Autopay is for monthly accounts only.");
    }
    if (!account.rate || account.rate <= 0) {
      throw new HttpsError("failed-precondition", "Set a monthly rate first.");
    }

    const customerId = await ensureCustomer(stripe, accountId);
    const base = APP_BASE_URL.value();

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      payment_method_types: ["card", "us_bank_account"],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            product_data: { name: `Monthly lawn service — ${account.name}` },
            recurring: { interval: "month" },
            unit_amount: Math.round(Number(account.rate) * 100),
          },
        },
      ],
      subscription_data: { metadata: { accountId } },
      metadata: { accountId },
      success_url: `${base}/?autopay=success&account=${accountId}`,
      cancel_url: `${base}/?autopay=cancel&account=${accountId}`,
    });

    await ref.set(
      { autopay: { status: "pending", checkoutSessionId: session.id } },
      { merge: true }
    );

    return { url: session.url };
  }
);
