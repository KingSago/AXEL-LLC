/* ============================================================
   inboundPayment — HTTPS endpoint the Gmail Apps Script POSTs each
   forwarded Zelle/Venmo alert to. It parses the email, fuzzy-matches
   it to an account, and writes a pendingPayments doc for Axel to
   review. It NEVER touches an account balance — confirmation happens
   in the app (one tap), so a wrong match can't silently corrupt data.

   Security: requires the shared secret (header x-inbound-secret, or a
   `secret` field in the body) matching INBOUND_SHARED_SECRET.
   Idempotent: dedups on the Gmail message id, so a re-forwarded or
   retried email never creates a duplicate queue item.

   Expected JSON body:
     { secret, messageId, from, subject, body, receivedAt }
   ============================================================ */
const { onRequest } = require("firebase-functions/v2/https");
const { db, FieldValue, INBOUND_SHARED_SECRET } = require("./lib/init");
const parsePaymentEmail = require("./parsePaymentEmail");
const matchAccount = require("./matchAccount");

module.exports = onRequest({ secrets: [INBOUND_SHARED_SECRET] }, async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const provided = req.get("x-inbound-secret") || req.body?.secret;
  if (!provided || provided !== INBOUND_SHARED_SECRET.value()) {
    return res.status(401).send("Unauthorized");
  }

  const { messageId, from, subject, body, receivedAt } = req.body || {};
  if (!messageId) {
    return res.status(400).send("messageId required");
  }

  try {
    // Idempotency: skip if we've already queued this email.
    const dup = await db
      .collection("pendingPayments")
      .where("emailMessageId", "==", messageId)
      .limit(1)
      .get();
    if (!dup.empty) {
      return res.json({ ok: true, deduped: true });
    }

    const parsed = parsePaymentEmail({ from, subject, body, receivedAt, messageId });

    // Load accounts (only the fields the matcher needs would be ideal, but the
    // collection is ~50 docs, so a full read is cheap and simpler).
    const accSnap = await db.collection("accounts").get();
    const accounts = accSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const { candidates, suggestedAccountId, confidence } = matchAccount(parsed, accounts);

    await db.collection("pendingPayments").add({
      method: parsed.method,
      amount: parsed.amount,
      payerNameRaw: parsed.payerName || "",
      payerNameNormalized: (parsed.payerName || "").toLowerCase(),
      note: parsed.note || "",
      receivedAt: toDateStr(receivedAt),
      externalId: parsed.externalId || null,
      emailMessageId: messageId,
      rawSnippet: (subject || "").slice(0, 300),
      candidates,
      suggestedAccountId,
      confidence,
      status: "pending",
      confirmedAccountId: null,
      confirmedPaymentId: null,
      createdAt: FieldValue.serverTimestamp(),
      resolvedAt: null,
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("inboundPayment error:", err);
    // 500 so the Apps Script can retry on the next run (the item stays
    // unlabeled and will be re-sent; dedup guards against duplicates).
    return res.status(500).send("Handler error");
  }
});

// Normalize the email date to YYYY-MM-DD (the date format used by payments).
function toDateStr(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? new Date().toISOString().slice(0, 10)
    : d.toISOString().slice(0, 10);
}
