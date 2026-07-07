/* Ensure each account has a Stripe Customer, and a reverse lookup doc. */
const { db, accountRef } = require("./init");

/**
 * Returns the Stripe customer id for an account, creating one if needed.
 * Also writes stripeCustomers/{customerId} -> { accountId } for webhook lookups.
 */
async function ensureCustomer(stripe, accountId) {
  const ref = accountRef(accountId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Account ${accountId} not found`);
  const account = snap.data();

  // Contact details live on the account doc and can be edited after the Stripe
  // customer was first created. Push the current values to Stripe every time so
  // an email added/changed later actually reaches Stripe — otherwise sending an
  // invoice fails with "no email" even though the app shows one. Undefined keys
  // are omitted by the Stripe SDK, so a blank field never clears existing data.
  const contact = {
    name: account.name || undefined,
    email: account.email || undefined,
    phone: account.phone || undefined,
  };

  if (account.stripeCustomerId) {
    await stripe.customers.update(account.stripeCustomerId, contact);
    return account.stripeCustomerId;
  }

  const customer = await stripe.customers.create({
    ...contact,
    metadata: { accountId },
  });

  await ref.update({ stripeCustomerId: customer.id });
  await db.collection("stripeCustomers").doc(customer.id).set({ accountId });
  return customer.id;
}

module.exports = { ensureCustomer };
