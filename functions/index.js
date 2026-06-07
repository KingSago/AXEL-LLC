/* ============================================================
   Axel's Trusted LLC — lawn tracker Cloud Functions
   ============================================================ */
const { setGlobalOptions } = require("firebase-functions/v2");

setGlobalOptions({ region: "us-central1", maxInstances: 10 });

// Callable functions (require Axel's auth)
exports.sendInvoice = require("./sendInvoice");
exports.createAutopayEnrollment = require("./createAutopayEnrollment");
exports.cancelAutopay = require("./cancelAutopay");
exports.markInvoicePaid = require("./markInvoicePaid");

// HTTPS webhook (called by Stripe)
exports.stripeWebhook = require("./stripeWebhook");
