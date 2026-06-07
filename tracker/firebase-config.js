/* ------------------------------------------------------------
   Firebase web config + Stripe publishable key.
   These values are PUBLIC by design (security is enforced by
   Firestore rules + auth-checked Cloud Functions). Replace the
   placeholders with the values from your Firebase project
   (Project settings > General > Your apps > Web app).
   ------------------------------------------------------------ */
export const firebaseConfig = {
  apiKey: "AIzaSyBfwfn9_12WFx8VZ15RQWNODOxNyerEU8Y",
  authDomain: "axels-tracker.firebaseapp.com",
  projectId: "axels-tracker",
  storageBucket: "axels-tracker.firebasestorage.app",
  messagingSenderId: "1069639427786",
  appId: "1:1069639427786:web:b2546a88644a848b31f633",
};

// Region your Cloud Functions are deployed to (matches functions/index.js).
export const functionsRegion = "us-central1";
