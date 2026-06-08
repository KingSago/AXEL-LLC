/* ============================================================
   parsePaymentEmail — turns a forwarded bank/Venmo notification
   email into structured payment data. Pure (no I/O) so it can be
   unit-tested with sample emails.

   Input:  { from, subject, body, receivedAt, messageId }
   Output: { method, amount, payerName, note, receivedAt, externalId }
           method ∈ "venmo" | "zelle" | "unknown"
           amount is a Number (dollars) or null when it couldn't be read.

   Venmo is fully implemented from a real sample. The Fifth Third Zelle
   branch is a deliberate STUB (see parseZelle) — it still extracts an
   amount so the payment queues for manual review, and will be filled in
   once a real Fifth Third alert is captured.
   ============================================================ */

module.exports = parsePaymentEmail;

function parsePaymentEmail(email = {}) {
  const method = detectMethod(email);
  if (method === "venmo") return parseVenmo(email);
  if (method === "zelle") return parseZelle(email);
  return blank("unknown", email);
}

/* ---------- method detection ---------- */
function detectMethod(email) {
  const from = (email.from || "").toLowerCase();
  const subject = (email.subject || "").toLowerCase();
  const body = textOf(email.body).toLowerCase();
  if (from.includes("venmo.com") || /\bpaid you\b/.test(subject)) return "venmo";
  if (
    from.includes("53.com") ||
    from.includes("fifththird") ||
    /\bzelle\b/.test(subject) ||
    /\bzelle\b/.test(body)
  ) {
    return "zelle";
  }
  return "unknown";
}

/* ---------- Venmo (confirmed from a real sample) ----------
   Sample:
     From:    Venmo <venmo@venmo.com>
     Subject: "Y Acosta paid you $85.00"
     Body:    ...  Y Acosta paid you  $85.00  Porto bello yard  See transaction
              Money credited to your Venmo account ...
*/
function parseVenmo(email) {
  const subject = email.subject || "";
  const text = textOf(email.body);

  // "<Name> paid you $<amount>"  — prefer the subject, fall back to the body.
  let payerName = null;
  let amount = null;
  const m =
    subject.match(/^(.+?)\s+paid you\s+\$([\d,]+(?:\.\d{2})?)/i) ||
    text.match(/(.+?)\s+paid you\s+\$([\d,]+(?:\.\d{2})?)/i);
  if (m) {
    payerName = cleanName(m[1]);
    amount = toAmount(m[2]);
  } else {
    const am = text.match(/paid you\s+\$([\d,]+(?:\.\d{2})?)/i);
    if (am) amount = toAmount(am[1]);
  }

  return {
    method: "venmo",
    amount,
    payerName,
    note: extractVenmoNote(text, payerName, amount),
    receivedAt: email.receivedAt || null,
    externalId: null,
  };
}

// The Venmo memo (e.g. "Porto bello yard") sits between the amount and the
// "See transaction" / "Money credited" boilerplate. Best-effort line scan.
function extractVenmoNote(text, payerName, amount) {
  const stop = /(see transaction|money credited|transaction details|view in venmo|why did you|payment id|completed|transfer)/i;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const amtStr = amount != null ? amount.toFixed(2) : null;

  // Anchor on the last line that mentions "paid you" / the amount.
  let anchor = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/paid you/i.test(lines[i]) || (amtStr && lines[i].includes(amtStr)) || /^\$\s*[\d,]/.test(lines[i])) {
      anchor = i;
    }
  }
  if (anchor === -1) return "";

  for (let j = anchor + 1; j < lines.length; j++) {
    const line = lines[j];
    if (stop.test(line)) break;
    if (/^\$\s*[\d,]/.test(line)) continue; // a stray amount line
    if (payerName && line.toLowerCase() === payerName.toLowerCase()) continue;
    return line; // first real content line after the amount = the note
  }
  return "";
}

/* ---------- Zelle / Fifth Third (STUB) ----------
   TODO: finalize once a real Fifth Third alert is captured. Expected wording
   is roughly "You received $45.00 from JOHN SMITH" but the exact subject/body
   and sender address must be confirmed. Until then we pull out an amount (so
   the payment still lands in the review queue) and take a best-effort name.
*/
function parseZelle(email) {
  const text = `${email.subject || ""}\n${textOf(email.body)}`;

  const am = text.match(/\$([\d,]+(?:\.\d{2})?)/);
  const amount = am ? toAmount(am[1]) : null;

  // Best-effort: "from <Name>" with title-cased words.
  const nm = text.match(/from\s+([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+){0,3})/);
  const payerName = nm ? cleanName(nm[1]) : null;

  return {
    method: "zelle",
    amount,
    payerName,
    note: "",
    receivedAt: email.receivedAt || null,
    externalId: null,
  };
}

/* ---------- helpers ---------- */
function blank(method, email) {
  return {
    method,
    amount: null,
    payerName: null,
    note: "",
    receivedAt: email.receivedAt || null,
    externalId: null,
  };
}

// Strip HTML to plain-ish text (Apps Script sends getPlainBody(), but be safe).
function textOf(body) {
  if (!body) return "";
  return String(body)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|tr|li|h[1-6]|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ");
}

function toAmount(str) {
  const n = Number(String(str).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function cleanName(str) {
  return String(str || "")
    .replace(/\s+/g, " ")
    .replace(/[\s.,]+$/, "")
    .trim();
}

// Exposed for unit tests.
module.exports.textOf = textOf;
module.exports.detectMethod = detectMethod;
