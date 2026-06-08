/* ============================================================
   Shared init + helpers for Axel's tracker Cloud Functions
   ============================================================ */
const admin = require("firebase-admin");
const { defineSecret, defineString } = require("firebase-functions/params");
const { HttpsError } = require("firebase-functions/v2/https");
const Stripe = require("stripe");

if (admin.apps.length === 0) admin.initializeApp();

const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;

// Secrets / params (set with:  firebase functions:secrets:set STRIPE_SECRET_KEY)
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");
// Shared secret between the Gmail Apps Script forwarder and inboundPayment.
const INBOUND_SHARED_SECRET = defineSecret("INBOUND_SHARED_SECRET");

// Public base URL of the deployed tracker app (for Stripe redirect URLs).
// Set with:  firebase functions:config is deprecated, so use a param:
//   firebase deploy ... (reads APP_BASE_URL from .env in functions/ or env)
const APP_BASE_URL = defineString("APP_BASE_URL", {
  default: "http://localhost:5000",
});

// Optional: lock callable functions to Axel's UID. If left empty, any
// authenticated user is allowed (sign-up is disabled, so only Axel exists).
const ALLOWED_UID = defineString("ALLOWED_UID", { default: "" });

function getStripe() {
  return new Stripe(STRIPE_SECRET_KEY.value(), { apiVersion: "2024-06-20" });
}

/** Throw unless the caller is Axel (authenticated, and matching ALLOWED_UID if set). */
function assertAxel(request) {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const allowed = ALLOWED_UID.value();
  if (allowed && auth.uid !== allowed) {
    throw new HttpsError("permission-denied", "Not authorized.");
  }
  return auth.uid;
}

const accountRef = (accountId) => db.collection("accounts").doc(accountId);

/** Resolve the local accountId for a Stripe customer id (fast Firestore lookup). */
async function accountIdForCustomer(customerId) {
  if (!customerId) return null;
  const snap = await db.collection("stripeCustomers").doc(customerId).get();
  return snap.exists ? snap.data().accountId : null;
}

module.exports = {
  admin,
  db,
  FieldValue,
  Timestamp,
  getStripe,
  assertAxel,
  accountRef,
  accountIdForCustomer,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  INBOUND_SHARED_SECRET,
  APP_BASE_URL,
  ALLOWED_UID,
};
