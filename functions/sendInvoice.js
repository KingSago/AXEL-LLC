/* ============================================================
   sendInvoice — create + send a Stripe invoice for a per-cut /
   variable account from its selected unpaid charges.
   ============================================================ */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const {
  db,
  FieldValue,
  getStripe,
  assertAxel,
  accountRef,
  STRIPE_SECRET_KEY,
} = require("./lib/init");
const { ensureCustomer } = require("./lib/customer");

module.exports = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  assertAxel(request);
  const { accountId, chargeIds, daysUntilDue = 14 } = request.data || {};
  if (!accountId || !Array.isArray(chargeIds) || chargeIds.length === 0) {
    throw new HttpsError("invalid-argument", "accountId and chargeIds required.");
  }

  const stripe = getStripe();
  const acctRef = accountRef(accountId);
  const acctSnap = await acctRef.get();
  if (!acctSnap.exists) throw new HttpsError("not-found", "Account not found.");

  // Load the selected charges, skipping any already attached to an invoice.
  const chargeRefs = chargeIds.map((id) => acctRef.collection("charges").doc(id));
  const chargeSnaps = await db.getAll(...chargeRefs);
  const charges = chargeSnaps
    .filter((s) => s.exists && !s.data().invoiceId)
    .map((s) => ({ id: s.id, ...s.data() }));
  if (charges.length === 0) {
    throw new HttpsError("failed-precondition", "No un-billed charges selected.");
  }

  const customerId = await ensureCustomer(stripe, accountId);
  const total = charges.reduce((sum, c) => sum + Number(c.amount || 0), 0);

  // Create a draft invoice, attach an invoice item per charge, finalize, send.
  const invoice = await stripe.invoices.create({
    customer: customerId,
    collection_method: "send_invoice",
    days_until_due: daysUntilDue,
    auto_advance: false,
    payment_settings: {
      payment_method_types: ["card", "us_bank_account"],
    },
    metadata: { accountId },
  });

  for (const c of charges) {
    await stripe.invoiceItems.create({
      customer: customerId,
      invoice: invoice.id,
      currency: "usd",
      amount: Math.round(Number(c.amount) * 100),
      description: c.description || labelForCharge(c),
    });
  }

  await stripe.invoices.finalizeInvoice(invoice.id);
  const sent = await stripe.invoices.sendInvoice(invoice.id);

  // Mirror the invoice locally and tag the charges.
  const localRef = acctRef.collection("invoices").doc();
  const batch = db.batch();
  batch.set(localRef, {
    stripeInvoiceId: sent.id,
    number: sent.number || null,
    hostedInvoiceUrl: sent.hosted_invoice_url || null,
    pdfUrl: sent.invoice_pdf || null,
    lineItems: charges.map((c) => ({
      description: c.description || labelForCharge(c),
      amount: Number(c.amount),
      date: c.date || null,
    })),
    total,
    status: "open",
    dateIssued: FieldValue.serverTimestamp(),
    paidAt: null,
    createdAt: FieldValue.serverTimestamp(),
  });
  for (const c of charges) {
    batch.update(acctRef.collection("charges").doc(c.id), {
      invoiceId: localRef.id,
      stripeInvoiceId: sent.id,
    });
  }
  // Map the Stripe invoice back to the local doc for the webhook.
  batch.set(db.collection("stripeInvoices").doc(sent.id), {
    accountId,
    localInvoiceId: localRef.id,
  });
  await batch.commit();

  return {
    invoiceId: localRef.id,
    stripeInvoiceId: sent.id,
    hostedInvoiceUrl: sent.hosted_invoice_url,
    total,
  };
});

function labelForCharge(c) {
  if (c.type === "cut") return `Lawn service${c.date ? " — " + c.date : ""}`;
  if (c.type === "monthly") return `Monthly service${c.period ? " — " + c.period : ""}`;
  return "Service";
}
