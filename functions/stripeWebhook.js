/* ============================================================
   stripeWebhook — the single writer of Stripe-driven charges &
   payments. Verifies the Stripe signature, then keeps Firestore
   (accounts, charges, payments, invoices) in sync with Stripe.

   Handled events:
     checkout.session.completed   -> activate monthly autopay
     customer.subscription.deleted-> mark autopay canceled
     invoice.paid                 -> record payment (+ monthly charge)
     invoice.payment_failed       -> flag autopay failure / amount owed
   ============================================================ */
const { onRequest } = require("firebase-functions/v2/https");
const {
  db,
  FieldValue,
  Timestamp,
  getStripe,
  accountRef,
  accountIdForCustomer,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
} = require("./lib/init");

module.exports = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
  async (req, res) => {
    const stripe = getStripe();
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        req.headers["stripe-signature"],
        STRIPE_WEBHOOK_SECRET.value()
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed":
          await onCheckoutCompleted(stripe, event.data.object);
          break;
        case "customer.subscription.deleted":
          await onSubscriptionDeleted(event.data.object);
          break;
        case "invoice.paid":
          await onInvoicePaid(stripe, event.data.object);
          break;
        case "invoice.payment_failed":
          await onInvoiceFailed(event.data.object);
          break;
        default:
          break; // ignore everything else
      }
      return res.json({ received: true });
    } catch (err) {
      console.error(`Error handling ${event.type}:`, err);
      // 500 tells Stripe to retry later.
      return res.status(500).send("Handler error");
    }
  }
);

/* ---------- handlers ---------- */

async function onCheckoutCompleted(stripe, session) {
  if (session.mode !== "subscription") return;
  const accountId = session.metadata?.accountId;
  if (!accountId) return;

  let methodType = null;
  try {
    const sub = await stripe.subscriptions.retrieve(session.subscription, {
      expand: ["default_payment_method"],
    });
    methodType = methodFromPM(sub.default_payment_method);
  } catch (_) {
    /* leave null; refined on first invoice.paid */
  }

  await accountRef(accountId).set(
    {
      autopay: {
        status: "active",
        stripeSubscriptionId: session.subscription,
        methodType,
        lastFailureAt: null,
        checkoutSessionId: null,
      },
    },
    { merge: true }
  );
}

async function onSubscriptionDeleted(subscription) {
  const accountId = subscription.metadata?.accountId
    || (await accountIdForCustomer(subscription.customer));
  if (!accountId) return;
  await accountRef(accountId).set(
    { autopay: { status: "none", stripeSubscriptionId: null } },
    { merge: true }
  );
}

async function onInvoicePaid(stripe, invoice) {
  const accountId =
    invoice.metadata?.accountId || (await accountIdForCustomer(invoice.customer));
  if (!accountId) return;

  const amount = (invoice.amount_paid || 0) / 100;
  const isSubscription = !!invoice.subscription;
  const date = isoDate(invoice.status_transitions?.paid_at || invoice.created);
  const method = await resolveMethod(stripe, invoice);

  // Subscription invoices have no pre-existing charge — post the monthly
  // charge first so the ledger shows the bill, then the payment (nets to 0).
  if (isSubscription) {
    await postOnce(accountId, "charges", `sub_${invoice.id}`, {
      type: "monthly",
      amount,
      date,
      period: yearMonth(date),
      description: "Monthly autopay",
      stripeInvoiceId: invoice.id,
    });
  }

  await recordPaymentOnce(accountId, `inv_${invoice.id}`, {
    amount,
    method,
    date,
    stripeInvoiceId: invoice.id,
  });

  // Mark a one-off (sent) invoice paid locally.
  const map = await db.collection("stripeInvoices").doc(invoice.id).get();
  if (map.exists) {
    const { localInvoiceId } = map.data();
    await accountRef(accountId)
      .collection("invoices")
      .doc(localInvoiceId)
      .set(
        { status: "paid", paidAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
  }

  // A successful subscription charge clears any prior failed flag.
  if (isSubscription) {
    await accountRef(accountId).set(
      { autopay: { status: "active", lastFailureAt: null, methodType: method } },
      { merge: true }
    );
  }
}

async function onInvoiceFailed(invoice) {
  const accountId =
    invoice.metadata?.accountId || (await accountIdForCustomer(invoice.customer));
  if (!accountId) return;

  if (invoice.subscription) {
    const amount = (invoice.amount_due || 0) / 100;
    const date = isoDate(invoice.created);
    // Post the monthly charge so the dashboard shows what's now owed.
    await postOnce(accountId, "charges", `sub_${invoice.id}`, {
      type: "monthly",
      amount,
      date,
      period: yearMonth(date),
      description: "Monthly autopay (payment failed)",
      stripeInvoiceId: invoice.id,
    });
    await accountRef(accountId).set(
      { autopay: { status: "failed", lastFailureAt: FieldValue.serverTimestamp() } },
      { merge: true }
    );
  }
}

/* ---------- idempotent writers ---------- */

// Create a charge (with fixed doc id) once, incrementing account rollups.
async function postOnce(accountId, sub, docId, data) {
  const acct = accountRef(accountId);
  const ref = acct.collection(sub).doc(docId);
  await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return; // already processed
    tx.set(ref, { ...data, createdAt: FieldValue.serverTimestamp() });
    tx.set(
      acct,
      {
        totalCharged: FieldValue.increment(data.amount),
        balance: FieldValue.increment(data.amount),
      },
      { merge: true }
    );
  });
}

// Record a payment (with fixed doc id) once, incrementing account rollups.
async function recordPaymentOnce(accountId, docId, data) {
  const acct = accountRef(accountId);
  const ref = acct.collection("payments").doc(docId);
  await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return;
    tx.set(ref, { ...data, createdAt: FieldValue.serverTimestamp() });
    tx.set(
      acct,
      {
        totalPaid: FieldValue.increment(data.amount),
        balance: FieldValue.increment(-data.amount),
        lastPaymentAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}

/* ---------- helpers ---------- */

function methodFromPM(pm) {
  if (!pm || typeof pm === "string") return null;
  return pm.type === "us_bank_account" ? "stripe_ach" : "stripe_card";
}

// Determine the payment method label for a paid invoice.
async function resolveMethod(stripe, invoice) {
  if (invoice.metadata?.paidMethod) return invoice.metadata.paidMethod; // out-of-band
  try {
    if (invoice.payment_intent) {
      const pi = await stripe.paymentIntents.retrieve(invoice.payment_intent, {
        expand: ["latest_charge"],
      });
      const type = pi.latest_charge?.payment_method_details?.type;
      if (type === "us_bank_account") return "stripe_ach";
      if (type === "card") return "stripe_card";
    }
  } catch (_) {
    /* fall through */
  }
  return "stripe_card";
}

function isoDate(epochSecondsOrIso) {
  if (!epochSecondsOrIso) return new Date().toISOString().slice(0, 10);
  const d =
    typeof epochSecondsOrIso === "number"
      ? new Date(epochSecondsOrIso * 1000)
      : new Date(epochSecondsOrIso);
  return d.toISOString().slice(0, 10);
}

function yearMonth(isoDateStr) {
  return (isoDateStr || "").slice(0, 7); // YYYY-MM
}
