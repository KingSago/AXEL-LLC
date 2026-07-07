/* ============================================================
   Axel's Trusted LLC — lawn tracker Cloud Functions
   ============================================================ */
const { setGlobalOptions } = require("firebase-functions/v2");

setGlobalOptions({ region: "us-central1", maxInstances: 10 });

// Callable functions (require Axel's auth)
exports.sendInvoice = require("./sendInvoice");
exports.createAutopayEnrollment = require("./createAutopayEnrollment");
exports.cancelAutopay = require("./cancelAutopay");
exports.createCardOnFileEnrollment = require("./createCardOnFileEnrollment");
exports.cancelCardOnFile = require("./cancelCardOnFile");
exports.markInvoicePaid = require("./markInvoicePaid");
exports.resendInvoice = require("./resendInvoice");

// HTTPS webhook (called by Stripe)
exports.stripeWebhook = require("./stripeWebhook");

// Scheduled: bill per-cut auto-charge accounts on the 1st of each month.
exports.monthlyAutoCharge = require("./monthlyAutoCharge");

// HTTPS ingest (called by the Gmail Apps Script forwarder) — queues forwarded
// Zelle/Venmo alerts for in-app review. Auth via shared secret.
exports.inboundPayment = require("./inboundPayment");
