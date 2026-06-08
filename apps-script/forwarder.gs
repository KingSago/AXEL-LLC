/**
 * Axel's Tracker — payment email forwarder (Google Apps Script).
 *
 * Runs ON the dedicated Gmail inbox (axelpayments1@gmail.com) that
 * receives auto-forwarded Venmo / Fifth Third Zelle alerts. On a time trigger it
 * finds new alerts, POSTs each to the inboundPayment Cloud Function, then labels
 * the thread "tracker-processed" so it's never sent twice.
 *
 * ── SETUP ──────────────────────────────────────────────────────────────────
 *  1. In the dedicated Gmail, go to script.google.com → New project.
 *  2. Paste this file in (replace Code.gs). Rename project "Tracker Forwarder".
 *  3. Fill in FUNCTION_URL and SHARED_SECRET below.
 *  4. Run forwardPayments once (Run ▶) and grant the permissions it asks for.
 *  5. Click the clock icon (Triggers) → Add Trigger:
 *        Function: forwardPayments
 *        Event source: Time-driven → Minutes timer → Every 5 minutes.
 *
 * The Gmail forwarding filters that feed this inbox are set up separately
 * (see Setup-tracker.md → "Payments automation").
 */

// ── CONFIG ──────────────────────────────────────────────────────────────────
var FUNCTION_URL = "https://us-central1-YOUR-PROJECT.cloudfunctions.net/inboundPayment";
var SHARED_SECRET = "PASTE_THE_SAME_VALUE_AS_INBOUND_SHARED_SECRET";

var PROCESSED_LABEL = "tracker-processed";
// Senders to forward. Venmo is confirmed; refine the Zelle sender once you have
// a real Fifth Third alert (e.g. add `OR from:alerts@53.com`).
var SEARCH_QUERY =
  '(from:venmo@venmo.com OR from:53.com OR subject:zelle) ' +
  '-label:' + PROCESSED_LABEL + ' newer_than:14d';
var MAX_THREADS = 25;

// ── MAIN ─────────────────────────────────────────────────────────────────────
function forwardPayments() {
  var label = getOrCreateLabel_(PROCESSED_LABEL);
  var threads = GmailApp.search(SEARCH_QUERY, 0, MAX_THREADS);

  threads.forEach(function (thread) {
    var allSent = true;
    thread.getMessages().forEach(function (msg) {
      try {
        postMessage_(msg);
      } catch (e) {
        allSent = false;
        console.error("Failed to post message " + msg.getId() + ": " + e);
      }
    });
    // Only mark the thread done if every message posted OK; otherwise it stays
    // unlabeled and is retried next run (inboundPayment dedups by message id).
    if (allSent) thread.addLabel(label);
  });
}

function postMessage_(msg) {
  var payload = {
    secret: SHARED_SECRET,
    messageId: msg.getId(),
    from: msg.getFrom(),
    subject: msg.getSubject(),
    body: msg.getPlainBody(),
    receivedAt: msg.getDate().toISOString(),
  };

  var resp = UrlFetchApp.fetch(FUNCTION_URL, {
    method: "post",
    contentType: "application/json",
    headers: { "x-inbound-secret": SHARED_SECRET },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error("HTTP " + code + ": " + resp.getContentText());
  }
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}
