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

  if (account.stripeCustomerId) return account.stripeCustomerId;

  const customer = await stripe.customers.create({
    name: account.name,
    email: account.email || undefined,
    phone: account.phone || undefined,
    metadata: { accountId },
  });

  await ref.update({ stripeCustomerId: customer.id });
  await db.collection("stripeCustomers").doc(customer.id).set({ accountId });
  return customer.id;
}

module.exports = { ensureCustomer };
