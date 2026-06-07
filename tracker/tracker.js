/* ============================================================
   Axel's Trusted — Tracker app logic (Firebase + Stripe)
   ============================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  collection, collectionGroup, doc, getDoc, getDocs, setDoc,
  updateDoc, addDoc, deleteField, onSnapshot, query, where, orderBy, limit,
  runTransaction, increment, serverTimestamp, connectFirestoreEmulator,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  getFunctions, httpsCallable, connectFunctionsEmulator,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import { firebaseConfig, functionsRegion } from "./firebase-config.js";

/* ---------- init ---------- */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Persistent local cache: queues writes made while offline (e.g. logging a
// cut with no signal) and syncs them automatically once back online.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
});
const fns = getFunctions(app, functionsRegion);

const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
if (isLocal) {
  connectAuthEmulator(auth, "http://localhost:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "localhost", 8080);
  connectFunctionsEmulator(fns, "localhost", 5001);
}

// Register the service worker so the app shell loads instantly and works offline.
if ("serviceWorker" in navigator && !isLocal) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });
}

const call = (name) => httpsCallable(fns, name);

/* ---------- helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const fmt = (n) => money.format(Number(n || 0));
const today = () => new Date().toISOString().slice(0, 10);
const PAYMENT_METHODS = ["cash", "check", "zelle", "venmo", "cashapp"];
const METHOD_LABEL = {
  cash: "Cash", check: "Check", zelle: "Zelle", venmo: "Venmo", cashapp: "Cash App",
  stripe_card: "Card (Stripe)", stripe_ach: "Bank/ACH (Stripe)",
};

const MOWER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 22" width="22" height="18" aria-hidden="true">
  <circle cx="6" cy="18" r="3.5" fill="currentColor"/>
  <circle cx="20" cy="18" r="3.5" fill="currentColor"/>
  <rect x="2" y="10" width="22" height="7" rx="2" fill="currentColor"/>
  <rect x="8" y="4" width="10" height="7" rx="1.5" fill="currentColor" opacity="0.65"/>
  <line x1="22" y1="10" x2="27" y2="2" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  return n;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
}

function modal({ title, body, submitLabel = "Save", onSubmit }) {
  const root = $("#modal-root");
  const form = el("form", { class: "form" });
  form.append(body);
  const actions = el("div", { class: "modal__actions" },
    el("button", { type: "button", class: "btn btn-outline", onclick: close }, "Cancel"),
    el("button", { type: "submit", class: "btn btn-primary" }, submitLabel),
  );
  form.append(actions);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await onSubmit(form); close(); }
    catch (err) { toast(err.message || "Something went wrong", true); }
  });
  const box = el("div", { class: "modal" }, el("h3", {}, title), form);
  root.replaceChildren(box);
  root.classList.remove("hidden");
  function close() { root.classList.add("hidden"); root.replaceChildren(); }
  return close;
}

/* ============================================================
   AUTH
   ============================================================ */
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  try {
    await signInWithEmailAndPassword(auth, $("#login-email").value, $("#login-password").value);
  } catch (err) {
    $("#login-error").textContent = "Sign-in failed. Check your email and password.";
  }
});
$("#signout-btn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  if (user) {
    $("#login-view").classList.add("hidden");
    $("#app").classList.remove("hidden");
    startApp();
  } else {
    $("#app").classList.add("hidden");
    $("#login-view").classList.remove("hidden");
    if (unsubAccounts) { unsubAccounts(); unsubAccounts = null; }
    accounts = [];
  }
});

/* ============================================================
   DATA LAYER
   ============================================================ */
const accountsCol = collection(db, "accounts");

async function createAccount(data) {
  await addDoc(accountsCol, {
    ...data, active: true,
    totalCharged: 0, totalPaid: 0, balance: 0,
    lastPaymentAt: null, lastCutAt: null,
    autopay: { status: "none" },
    createdAt: serverTimestamp(),
  });
}

async function logCut(acc) {
  const ref = doc(db, "accounts", acc.id);
  if (acc.billingType === "percut") {
    const rate = Number(acc.rate || 0);
    await runTransaction(db, async (tx) => {
      const chargeRef = doc(collection(ref, "charges"));
      tx.set(chargeRef, { type: "cut", amount: rate, date: today(), createdAt: serverTimestamp() });
      tx.set(ref, {
        totalCharged: increment(rate), balance: increment(rate), lastCutAt: serverTimestamp(),
      }, { merge: true });
    });
  } else {
    await addDoc(collection(ref, "cuts"), { date: today(), createdAt: serverTimestamp() });
    await updateDoc(ref, { lastCutAt: serverTimestamp() });
  }
}

async function addCharge(acc, { amount, description }) {
  const ref = doc(db, "accounts", acc.id);
  const amt = Number(amount);
  await runTransaction(db, async (tx) => {
    const chargeRef = doc(collection(ref, "charges"));
    tx.set(chargeRef, { type: "extra", amount: amt, description, date: today(), createdAt: serverTimestamp() });
    tx.set(ref, { totalCharged: increment(amt), balance: increment(amt) }, { merge: true });
  });
}

async function recordManualPayment(acc, { amount, method, note }) {
  const ref = doc(db, "accounts", acc.id);
  const amt = Number(amount);
  await runTransaction(db, async (tx) => {
    const payRef = doc(collection(ref, "payments"));
    tx.set(payRef, { amount: amt, method, note: note || "", date: today(), createdAt: serverTimestamp() });
    tx.set(ref, {
      totalPaid: increment(amt), balance: increment(-amt), lastPaymentAt: serverTimestamp(),
    }, { merge: true });
  });
}

/* ============================================================
   APP START / NAV
   ============================================================ */
let accounts = [];
let unsubAccounts = null;
let currentSort = "balance-desc";

function tsMs(ts) {
  if (!ts) return 0;
  try { return ts.toDate ? ts.toDate().getTime() : new Date(ts).getTime(); } catch { return 0; }
}
function streetName(addr) {
  return (addr || "").replace(/^\d+\s*/, "").toLowerCase();
}
function cityFrom(addr) {
  const parts = (addr || "").split(",");
  return (parts.length > 1 ? parts[1] : parts[0] || "").trim().toLowerCase();
}
function sortAccounts(list, key) {
  const copy = [...list];
  switch (key) {
    case "last-cut":      return copy.sort((a, b) => tsMs(b.lastCutAt) - tsMs(a.lastCutAt));
    case "oldest-cut":    return copy.sort((a, b) => tsMs(a.lastCutAt) - tsMs(b.lastCutAt));
    case "name-az":       return copy.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    case "address-az":    return copy.sort((a, b) => streetName(a.address).localeCompare(streetName(b.address)));
    case "city-az":       return copy.sort((a, b) => cityFrom(a.address).localeCompare(cityFrom(b.address)));
    case "billing-type":  return copy.sort((a, b) => (a.billingType || "").localeCompare(b.billingType || ""));
    default:              return copy.sort((a, b) => Number(b.balance || 0) - Number(a.balance || 0));
  }
}

function startApp() {
  if (unsubAccounts) return;
  const q = query(accountsCol, orderBy("balance", "desc"));
  unsubAccounts = onSnapshot(q,
    (snap) => {
      accounts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (currentView === "dashboard") renderDashboard();
      if (currentView === "account" && currentAccountId) renderAccountDetail(currentAccountId);
    },
    (err) => toast("Data sync error: " + err.message, true),
  );
  loadSettings();
  show("dashboard");
}

let currentView = "dashboard";
let currentAccountId = null;

document.querySelectorAll("[data-nav]").forEach((b) =>
  b.addEventListener("click", () => show(b.dataset.nav)));
$("#back-to-dash").addEventListener("click", () => show("dashboard"));
$("#add-account-btn").addEventListener("click", accountFormModal);
$("#quick-pay-btn").addEventListener("click", quickPayModal);

function show(view) {
  currentView = view;
  for (const v of ["dashboard", "account", "reports", "settings"]) {
    $(`#${v}-view`).classList.toggle("hidden", v !== view);
  }
  document.querySelectorAll("[data-nav]").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.nav === view));
  if (view === "dashboard") renderDashboard();
  if (view === "reports") renderReports();
  if (view === "settings") renderSettings();
}

/* ============================================================
   DASHBOARD
   ============================================================ */
async function renderDashboard() {
  const active = accounts.filter((a) => a.active !== false);
  const outstanding = active.reduce((s, a) => s + Math.max(0, Number(a.balance || 0)), 0);
  const overdue = active.filter((a) => Number(a.balance || 0) > 0.005).length;
  const autopay = active.filter((a) => a.autopay?.status === "active").length;

  const collected = await collectedThisMonth();

  $("#summary-cards").replaceChildren(
    sumCard("Total Outstanding", fmt(outstanding), outstanding > 0 ? "red" : "green"),
    sumCard("Collected This Month", fmt(collected), "green"),
    sumCard("Accounts Overdue", String(overdue), overdue ? "amber" : ""),
    sumCard("Active Autopay", String(autopay), ""),
  );

  renderIncomeChart();
  renderCutCalendar();

  const term = ($("#account-search").value || "").toLowerCase();
  const rows = sortAccounts(
    active.filter((a) => (a.name?.toLowerCase() ?? "").includes(term)),
    currentSort,
  ).map(accountRow);
  $("#account-list").replaceChildren(...(rows.length ? rows : [el("p", { class: "card" }, "No accounts yet. Add your first account.")]));
}

$("#account-search").addEventListener("input", renderDashboard);
$("#account-sort").addEventListener("change", (e) => { currentSort = e.target.value; renderDashboard(); });

function sumCard(label, value, cls) {
  return el("div", { class: `sumcard ${cls}` },
    el("div", { class: "sumcard__label" }, label),
    el("div", { class: "sumcard__value" }, value));
}

function accountRow(a) {
  const bal = Number(a.balance || 0);
  const owes = bal > 0.005;
  const pills = el("div", { class: "pill-row" });
  if (a.billingType === "monthly") pills.append(el("span", { class: "pill gray" }, "Monthly"));
  else pills.append(el("span", { class: "pill gray" }, "Per cut"));
  if (a.autopay?.status === "active") pills.append(el("span", { class: "pill green" }, "Autopay"));
  if (a.autopay?.status === "pending") pills.append(el("span", { class: "pill amber" }, "Autopay pending"));
  if (a.autopay?.status === "failed") pills.append(el("span", { class: "pill red" }, "Payment failed"));

  const mowerBtn = el("button", { class: "acct-row__mower", title: "Log cut",
    onclick: (e) => { e.stopPropagation(); confirmLogCut(a); } });
  mowerBtn.innerHTML = MOWER_SVG;

  const paidBtn = el("button", { class: "acct-row__paid", title: "Record payment",
    onclick: (e) => { e.stopPropagation(); rowPayModal(a); } }, "$");

  return el("div", { class: "acct-row", role: "button", tabindex: "0", onclick: () => openAccount(a.id) },
    mowerBtn,
    paidBtn,
    el("div", { class: "acct-row__main" },
      el("div", { class: "acct-row__name" }, a.name),
      el("div", { class: "acct-row__meta" }, a.address || a.phone || ""),
      pills),
    el("div", { class: "acct-row__right" },
      el("div", { class: `acct-row__amt ${owes ? "owe" : "paid"}` }, owes ? fmt(bal) : "Paid up"),
      el("div", { class: "acct-row__meta", style: "text-align:right" },
        a.lastPaymentAt ? "Last paid " + tsDate(a.lastPaymentAt) : "")));
}

function confirmLogCut(a) {
  const note = a.billingType === "monthly"
    ? "Monthly account — adds to cut history only, no charge."
    : `Per-cut account — ${fmt(a.rate)} added to balance.`;
  const body = el("div", {},
    el("p", { style: "font-size:1.05rem;font-weight:600;margin-bottom:6px" }, `Log a cut for ${a.name}?`),
    el("p", { class: "acct-row__meta" }, note));
  modal({ title: "Log Cut", body, submitLabel: "✓ Log Cut", onSubmit: async () => {
    await logCut(a);
    toast(`Cut logged — ${a.name}`);
  }});
}

function rowPayModal(a) {
  const methodOpts = PAYMENT_METHODS.map((m) => `<option value="${m}">${METHOD_LABEL[m]}</option>`).join("");
  const body = el("div", {},
    el("p", { style: "font-weight:600;margin-bottom:8px" }, a.name),
    field("Amount ($)", `<input name="amount" type="number" min="0.01" step="0.01" required>`),
    field("Method", `<select name="method">${methodOpts}</select>`),
    field("Note", `<input name="note" placeholder="Optional">`));
  modal({ title: "Record Payment", body, submitLabel: "Record", onSubmit: async (f) => {
    await recordManualPayment(a, { amount: f.amount.value, method: f.method.value, note: f.note.value.trim() });
    toast(`Payment recorded — ${a.name}`);
  }});
}

function quickPayModal() {
  const active = accounts.filter((a) => a.active !== false);
  if (!active.length) { toast("No accounts yet", true); return; }
  const acctOpts = active.map((a) => `<option value="${a.id}">${a.name}</option>`).join("");
  const methodOpts = PAYMENT_METHODS.map((m) => `<option value="${m}">${METHOD_LABEL[m]}</option>`).join("");
  const body = el("div", {},
    field("Account", `<select name="accountId" required><option value="">Select account…</option>${acctOpts}</select>`),
    field("Amount ($)", `<input name="amount" type="number" min="0.01" step="0.01" required>`),
    field("Method", `<select name="method">${methodOpts}</select>`),
    field("Note", `<input name="note" placeholder="Optional">`));
  modal({ title: "Record Payment", body, submitLabel: "Record", onSubmit: async (f) => {
    const acc = active.find((a) => a.id === f.accountId.value);
    if (!acc) throw new Error("Select an account");
    await recordManualPayment(acc, { amount: f.amount.value, method: f.method.value, note: f.note.value.trim() });
    toast(`Payment recorded — ${acc.name}`);
  }});
}

async function collectedThisMonth() {
  const start = today().slice(0, 7) + "-01";
  try {
    const snap = await getDocs(query(collectionGroup(db, "payments"), where("date", ">=", start)));
    return snap.docs.reduce((s, d) => s + Number(d.data().amount || 0), 0);
  } catch { return 0; }
}

async function renderIncomeChart() {
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: d.toISOString().slice(0, 7), label: d.toLocaleString("en-US", { month: "short" }), total: 0 });
  }
  const start = months[0].key + "-01";
  try {
    const snap = await getDocs(query(collectionGroup(db, "payments"), where("date", ">=", start)));
    snap.forEach((d) => {
      const m = months.find((x) => x.key === (d.data().date || "").slice(0, 7));
      if (m) m.total += Number(d.data().amount || 0);
    });
  } catch { /* index building or empty */ }
  const max = Math.max(1, ...months.map((m) => m.total));
  $("#income-chart").replaceChildren(...months.map((m) =>
    el("div", { class: "chart__bar" },
      el("div", { class: "chart__amt" }, m.total ? "$" + Math.round(m.total) : ""),
      el("div", { class: "chart__fill", style: `height:${(m.total / max) * 100}%` }),
      el("div", { class: "chart__label" }, m.label))));
}

async function renderCutCalendar() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
  const start = monthKey + "-01";
  const endDate = new Date(year, month + 1, 1).toISOString().slice(0, 10);
  const cutsPerDay = {};
  try {
    const [chargeSnap, cutSnap] = await Promise.all([
      getDocs(query(collectionGroup(db, "charges"), where("date", ">=", start), where("date", "<", endDate))),
      getDocs(query(collectionGroup(db, "cuts"),    where("date", ">=", start), where("date", "<", endDate))),
    ]);
    chargeSnap.forEach((d) => {
      const { type, date } = d.data();
      if (type === "cut" && date) cutsPerDay[date] = (cutsPerDay[date] || 0) + 1;
    });
    cutSnap.forEach((d) => {
      const { date } = d.data();
      if (date) cutsPerDay[date] = (cutsPerDay[date] || 0) + 1;
    });
  } catch (err) {
    console.error("Cut calendar query failed — collection group index may not be deployed yet:", err);
    toast("Calendar index not ready — deploy Firestore indexes then reload", true);
  }

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDow = new Date(year, month, 1).getDay();
  const todayStr = today();
  const monthLabel = now.toLocaleString("en-US", { month: "long", year: "numeric" });

  const dowRow = el("div", { class: "cal__dow-row" });
  for (const d of ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"])
    dowRow.append(el("div", { class: "cal__dow" }, d));

  const grid = el("div", { class: "cal__grid" });
  for (let i = 0; i < firstDow; i++)
    grid.append(el("div", { class: "cal__cell cal__cell--empty" }));
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${monthKey}-${String(d).padStart(2, "0")}`;
    const n = cutsPerDay[ds] || 0;
    grid.append(el("div", { class: `cal__cell${n ? " has-cuts" : ""}${ds === todayStr ? " is-today" : ""}` },
      el("span", { class: "cal__day-num" }, String(d)),
      n ? el("span", { class: "cal__cuts-badge" }, String(n)) : null,
    ));
  }
  $("#cut-calendar").replaceChildren(
    el("p", { class: "cal__month" }, monthLabel),
    dowRow,
    grid,
  );
}

/* ============================================================
   ACCOUNT DETAIL
   ============================================================ */
function openAccount(id) { currentAccountId = id; show("account"); renderAccountDetail(id); }

async function renderAccountDetail(id) {
  const a = accounts.find((x) => x.id === id);
  if (!a) return;
  const ref = doc(db, "accounts", id);
  const [chargeSnap, paySnap, invSnap, cutSnap] = await Promise.all([
    getDocs(query(collection(ref, "charges"), orderBy("date", "desc"))),
    getDocs(query(collection(ref, "payments"), orderBy("date", "desc"))),
    getDocs(query(collection(ref, "invoices"), orderBy("createdAt", "desc"))),
    getDocs(query(collection(ref, "cuts"), orderBy("date", "desc"))),
  ]);
  const charges = chargeSnap.docs.map((d) => ({ id: d.id, kind: "charge", ...d.data() }));
  const payments = paySnap.docs.map((d) => ({ id: d.id, kind: "payment", ...d.data() }));
  const invoices = invSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const monthlyCuts = cutSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const unbilled = charges.filter((c) => !c.invoiceId);
  const openInvoices = invoices.filter((i) => i.status === "open");

  const bal = Number(a.balance || 0);
  const owes = bal > 0.005;

  const wrap = el("div", {});

  // header
  wrap.append(el("div", { class: "detail__head" },
    el("div", {},
      el("div", { class: "detail__name" }, a.name),
      el("div", { class: "acct-row__meta" }, [a.address, a.phone, a.email].filter(Boolean).join(" · ")),
      el("div", { class: "acct-row__meta" }, a.billingType === "monthly" ? `Monthly · ${fmt(a.rate)}/mo` : `Per cut · ${fmt(a.rate)}/cut`)),
    el("div", { style: "text-align:right" },
      el("div", { class: `detail__bal ${owes ? "owe" : "paid"}` }, owes ? fmt(bal) : "Paid up"),
      el("button", { class: "btn btn-outline btn-sm", onclick: () => accountFormModal(a) }, "Edit"))));

  // actions
  const actions = el("div", { class: "detail__actions" },
    el("button", { class: "btn btn-green", onclick: async () => { await logCut(a); toast("Cut logged"); renderAccountDetail(id); } }, "Log Cut"),
    el("button", { class: "btn btn-outline", onclick: () => chargeModal(a) }, "Add Charge"),
    el("button", { class: "btn btn-outline", onclick: () => paymentModal(a) }, "Record Payment"),
  );
  if (a.billingType === "percut" || unbilled.length) {
    actions.append(el("button", { class: "btn btn-primary", onclick: () => sendInvoiceModal(a, unbilled) }, "Send Invoice"));
  }
  if (a.billingType === "monthly") {
    if (a.autopay?.status === "active" || a.autopay?.status === "failed") {
      actions.append(el("button", { class: "btn btn-outline", onclick: () => cancelAutopayConfirm(a) }, "Cancel Autopay"));
    } else {
      actions.append(el("button", { class: "btn btn-primary", onclick: () => enableAutopay(a) }, "Enable Autopay"));
    }
  }
  wrap.append(actions);

  const cutCharges = charges.filter((c) => c.type === "cut");
  const undoRow = el("div", { class: "detail__actions detail__undo" },
    el("button", { class: "btn btn-outline btn-sm",
      onclick: () => undoCutModal(a, cutCharges[0]) }, "↩ Undo Last Cut"),
    el("button", { class: "btn btn-outline btn-sm",
      onclick: () => undoPaymentModal(a, payments[0], payments[1]) }, "↩ Undo Last Payment"),
  );
  wrap.append(undoRow);

  // open invoices
  if (openInvoices.length) {
    const card = el("div", { class: "card" }, el("h3", {}, "Open invoices"));
    openInvoices.forEach((inv) => {
      card.append(el("div", { class: "pill-row", style: "justify-content:space-between;align-items:center" },
        el("span", {}, `${fmt(inv.total)} · ${inv.number || "invoice"}`),
        el("span", {},
          inv.hostedInvoiceUrl ? el("a", { href: inv.hostedInvoiceUrl, target: "_blank", class: "btn btn-outline btn-sm" }, "View") : "",
          el("button", { class: "btn btn-green btn-sm", onclick: () => markPaidModal(a, inv) }, "Mark paid"))));
    });
    wrap.append(card);
  }

  // ledger
  const entries = [...charges, ...payments].sort((x, y) => (y.date || "").localeCompare(x.date || ""));
  const table = el("table", { class: "ledger" },
    el("tr", {}, el("th", {}, "Date"), el("th", {}, "Description"), el("th", { class: "amt" }, "Amount")));
  entries.forEach((e) => {
    const isCharge = e.kind === "charge";
    table.append(el("tr", {},
      el("td", {}, e.date || ""),
      el("td", {}, isCharge ? (e.description || labelCharge(e)) : ("Payment · " + (METHOD_LABEL[e.method] || e.method))),
      el("td", { class: "amt " + (isCharge ? "charge" : "payment") }, (isCharge ? "" : "−") + fmt(e.amount))));
  });
  if (!entries.length) table.append(el("tr", {}, el("td", { colspan: "3" }, "No activity yet.")));
  wrap.append(el("div", { class: "card" }, el("h3", {}, "Ledger"), table));

  // mow history
  const mowList = a.billingType === "monthly"
    ? monthlyCuts
    : charges.filter((c) => c.type === "cut");
  const mowCard = el("div", { class: "card" },
    el("h3", {}, `Mow History (${mowList.length})`));
  if (!mowList.length) {
    mowCard.append(el("p", { class: "acct-row__meta" }, "No cuts logged yet."));
  } else {
    const mowTable = el("table", { class: "ledger" },
      el("tr", {},
        el("th", {}, "Date"),
        a.billingType === "percut" ? el("th", { class: "amt" }, "Amount") : el("th", {}, ""),
      ));
    mowList.forEach((m) => {
      mowTable.append(el("tr", {},
        el("td", {}, fmtDate(m.date)),
        a.billingType === "percut"
          ? el("td", { class: "amt charge" }, fmt(m.amount))
          : el("td", {}, ""),
      ));
    });
    mowCard.append(mowTable);
  }
  wrap.append(mowCard);

  $("#account-detail").replaceChildren(wrap);
}

function labelCharge(c) {
  if (c.type === "cut") return "Lawn service";
  if (c.type === "monthly") return "Monthly service" + (c.period ? ` (${c.period})` : "");
  return "Charge";
}

/* ---------- modals ---------- */
function accountFormModal(existing) {
  const a = existing && existing.id ? existing : {};
  const body = el("div", {},
    field("Name", `<input name="name" required value="${a.name || ""}">`),
    el("div", { class: "row" },
      field("Phone", `<input name="phone" value="${a.phone || ""}">`),
      field("Email", `<input name="email" type="email" value="${a.email || ""}">`)),
    field("Address", `<input name="address" value="${a.address || ""}">`),
    el("div", { class: "row" },
      field("Billing", `<select name="billingType"><option value="percut"${a.billingType === "percut" ? " selected" : ""}>Per cut</option><option value="monthly"${a.billingType === "monthly" ? " selected" : ""}>Monthly</option></select>`),
      field("Rate ($)", `<input name="rate" type="number" min="0" step="0.01" required value="${a.rate ?? ""}">`)),
    field("Notes", `<textarea name="notes" rows="2">${a.notes || ""}</textarea>`),
  );
  modal({
    title: a.id ? "Edit Account" : "Add Account",
    body, submitLabel: a.id ? "Save" : "Add",
    onSubmit: async (form) => {
      const data = {
        name: form.name.value.trim(),
        phone: form.phone.value.trim(),
        email: form.email.value.trim(),
        address: form.address.value.trim(),
        billingType: form.billingType.value,
        rate: Number(form.rate.value),
        notes: form.notes.value.trim(),
      };
      if (a.id) await updateDoc(doc(db, "accounts", a.id), data);
      else await createAccount(data);
      toast(a.id ? "Account updated" : "Account added");
      if (a.id) renderAccountDetail(a.id);
    },
  });
}

function chargeModal(a) {
  const body = el("div", {},
    field("Amount ($)", `<input name="amount" type="number" min="0" step="0.01" required>`),
    field("Description", `<input name="description" placeholder="Extra work, e.g. hedge trimming" required>`));
  modal({ title: "Add Charge", body, submitLabel: "Add charge", onSubmit: async (f) => {
    await addCharge(a, { amount: f.amount.value, description: f.description.value.trim() });
    toast("Charge added"); renderAccountDetail(a.id);
  } });
}

function paymentModal(a) {
  const opts = PAYMENT_METHODS.map((m) => `<option value="${m}">${METHOD_LABEL[m]}</option>`).join("");
  const body = el("div", {},
    el("p", { class: "acct-row__meta" }, "Use this for direct payments not tied to a Stripe invoice (e.g. cash handed to you)."),
    field("Amount ($)", `<input name="amount" type="number" min="0" step="0.01" required>`),
    field("Method", `<select name="method">${opts}</select>`),
    field("Note", `<input name="note">`));
  modal({ title: "Record Payment", body, submitLabel: "Record", onSubmit: async (f) => {
    await recordManualPayment(a, { amount: f.amount.value, method: f.method.value, note: f.note.value.trim() });
    toast("Payment recorded"); renderAccountDetail(a.id);
  } });
}

function markPaidModal(a, inv) {
  const opts = PAYMENT_METHODS.map((m) => `<option value="${m}">${METHOD_LABEL[m]}</option>`).join("");
  const body = el("div", {},
    el("p", { class: "acct-row__meta" }, `Mark invoice ${inv.number || ""} (${fmt(inv.total)}) as paid by:`),
    field("Method", `<select name="method">${opts}</select>`));
  modal({ title: "Mark Invoice Paid", body, submitLabel: "Mark paid", onSubmit: async (f) => {
    await call("markInvoicePaid")({ accountId: a.id, invoiceId: inv.id, method: f.method.value });
    toast("Invoice marked paid"); setTimeout(() => renderAccountDetail(a.id), 800);
  } });
}

function sendInvoiceModal(a, unbilled) {
  if (!unbilled.length) { toast("No un-billed charges to invoice", true); return; }
  const checks = el("div", { class: "checks" });
  unbilled.forEach((c) => {
    checks.append(el("label", {},
      el("input", { type: "checkbox", name: "charge", value: c.id, checked: "checked" }),
      `${c.date} · ${c.description || labelCharge(c)} · ${fmt(c.amount)}`));
  });
  const body = el("div", {},
    el("p", { class: "acct-row__meta" }, "A Stripe invoice will be emailed to the customer (card or bank payment)."),
    checks);
  modal({ title: "Send Invoice", body, submitLabel: "Send via Stripe", onSubmit: async (form) => {
    const ids = [...form.querySelectorAll('input[name="charge"]:checked')].map((c) => c.value);
    if (!ids.length) throw new Error("Select at least one charge.");
    toast("Creating invoice…");
    const res = await call("sendInvoice")({ accountId: a.id, chargeIds: ids });
    toast("Invoice sent");
    if (res.data?.hostedInvoiceUrl) window.open(res.data.hostedInvoiceUrl, "_blank");
    setTimeout(() => renderAccountDetail(a.id), 800);
  } });
}

async function enableAutopay(a) {
  toast("Creating secure enrollment link…");
  try {
    const res = await call("createAutopayEnrollment")({ accountId: a.id });
    const url = res.data?.url;
    const body = el("div", {},
      el("p", {}, "Send this secure link to the customer. They enter their card or bank once, and monthly payments are automatic."),
      field("Enrollment link", `<input value="${url}" readonly onclick="this.select()">`));
    modal({ title: "Autopay Enrollment", body, submitLabel: "Copy & open", onSubmit: async () => {
      try { await navigator.clipboard.writeText(url); } catch {}
      window.open(url, "_blank");
    } });
  } catch (err) { toast(err.message || "Could not start enrollment", true); }
}

function cancelAutopayConfirm(a) {
  const body = el("div", {}, el("p", {}, `Cancel autopay for ${a.name}? The customer's subscription will be stopped.`));
  modal({ title: "Cancel Autopay", body, submitLabel: "Cancel autopay", onSubmit: async () => {
    await call("cancelAutopay")({ accountId: a.id });
    toast("Autopay canceled"); setTimeout(() => renderAccountDetail(a.id), 600);
  } });
}

async function undoCutModal(acc, lastCutCharge) {
  if (acc.billingType === "monthly") {
    const accRef = doc(db, "accounts", acc.id);
    let cutDoc;
    try {
      const snap = await getDocs(query(collection(accRef, "cuts"), orderBy("createdAt", "desc"), limit(1)));
      if (snap.empty) { toast("No cuts to remove", true); return; }
      cutDoc = snap.docs[0];
    } catch { toast("Could not load cuts", true); return; }
    const body = el("div", {},
      el("p", { style: "font-weight:600;margin-bottom:6px" }, `Remove cut from ${cutDoc.data().date}?`),
      el("p", { class: "acct-row__meta" }, "Deletes this cut from history. No balance change on monthly accounts."));
    modal({ title: "Undo Last Cut", body, submitLabel: "Remove", onSubmit: async () => {
      await runTransaction(db, async (tx) => { tx.delete(cutDoc.ref); });
      toast("Cut removed");
      renderAccountDetail(acc.id);
    }});
    return;
  }
  if (!lastCutCharge) { toast("No cuts to remove", true); return; }
  const amount = Number(lastCutCharge.amount || 0);
  const body = el("div", {},
    el("p", { style: "font-weight:600;margin-bottom:6px" }, `Remove cut from ${lastCutCharge.date}?`),
    el("p", { class: "acct-row__meta" }, `${fmt(amount)} will be removed from the balance.`));
  modal({ title: "Undo Last Cut", body, submitLabel: "Remove", onSubmit: async () => {
    const accRef = doc(db, "accounts", acc.id);
    await runTransaction(db, async (tx) => {
      tx.delete(doc(collection(accRef, "charges"), lastCutCharge.id));
      tx.set(accRef, { totalCharged: increment(-amount), balance: increment(-amount) }, { merge: true });
    });
    toast("Cut removed");
    renderAccountDetail(acc.id);
  }});
}

function undoPaymentModal(acc, lastPayment, prevPayment) {
  if (!lastPayment) { toast("No payments to remove", true); return; }
  const amount = Number(lastPayment.amount || 0);
  const body = el("div", {},
    el("p", { style: "font-weight:600;margin-bottom:6px" },
      `Remove ${fmt(amount)} ${METHOD_LABEL[lastPayment.method] || ""} payment from ${lastPayment.date}?`),
    el("p", { class: "acct-row__meta" }, "This amount will be added back to the balance."));
  modal({ title: "Undo Last Payment", body, submitLabel: "Remove", onSubmit: async () => {
    const accRef = doc(db, "accounts", acc.id);
    await runTransaction(db, async (tx) => {
      tx.delete(doc(collection(accRef, "payments"), lastPayment.id));
      tx.set(accRef, {
        totalPaid: increment(-amount),
        balance: increment(amount),
        lastPaymentAt: prevPayment ? new Date(prevPayment.date) : deleteField(),
      }, { merge: true });
    });
    toast("Payment removed");
    renderAccountDetail(acc.id);
  }});
}

function field(label, innerHtml) {
  return el("label", { html: `${label}${innerHtml}` });
}

/* ============================================================
   REPORTS
   ============================================================ */
$("#reports-month").addEventListener("change", renderReports);

async function renderReports() {
  const monthInput = $("#reports-month");
  if (!monthInput.value) monthInput.value = today().slice(0, 7);
  const month = monthInput.value;
  const start = month + "-01";
  const [yy, mm] = month.split("-").map(Number);
  const end = new Date(yy, mm, 1).toISOString().slice(0, 10); // first day next month

  let collected = 0; const byMethod = {};
  try {
    const snap = await getDocs(query(collectionGroup(db, "payments"),
      where("date", ">=", start), where("date", "<", end)));
    snap.forEach((d) => {
      const p = d.data(); const amt = Number(p.amount || 0);
      collected += amt; byMethod[p.method] = (byMethod[p.method] || 0) + amt;
    });
  } catch (e) { /* may need an index the first time */ }

  const outstanding = accounts.filter((a) => a.active !== false)
    .reduce((s, a) => s + Math.max(0, Number(a.balance || 0)), 0);

  const methodRows = Object.entries(byMethod).sort((a, b) => b[1] - a[1])
    .map(([m, v]) => el("tr", {}, el("td", {}, METHOD_LABEL[m] || m), el("td", { class: "amt" }, fmt(v))));

  $("#reports-body").replaceChildren(
    el("div", { class: "summary" },
      sumCard("Collected", fmt(collected), "green"),
      sumCard("Still Outstanding", fmt(outstanding), outstanding ? "red" : "green")),
    el("div", { class: "card" }, el("h3", {}, "By payment method"),
      el("table", { class: "ledger" },
        el("tr", {}, el("th", {}, "Method"), el("th", { class: "amt" }, "Collected")),
        ...(methodRows.length ? methodRows : [el("tr", {}, el("td", { colspan: "2" }, "No payments this month."))]))));
}

/* ============================================================
   SETTINGS
   ============================================================ */
let settings = {};
async function loadSettings() {
  try { const s = await getDoc(doc(db, "settings", "business")); settings = s.exists() ? s.data() : {}; }
  catch { settings = {}; }
}

function renderSettings() {
  const s = settings || {};
  const form = $("#settings-form");
  form.replaceChildren(
    el("h3", {}, "Business info (shown on invoices via Stripe branding)"),
    field("Business name", `<input name="bizName" value="${s.bizName || "Axel's Trusted LLC"}">`),
    el("div", { class: "row" },
      field("Phone", `<input name="bizPhone" value="${s.bizPhone || ""}">`),
      field("Email", `<input name="bizEmail" value="${s.bizEmail || ""}">`)),
    field("Default invoice due (days)", `<input name="dueDays" type="number" min="0" value="${s.dueDays ?? 14}">`),
    field("Invoice memo / note", `<textarea name="memo" rows="2">${s.memo || ""}</textarea>`),
    el("button", { class: "btn btn-primary", type: "submit" }, "Save settings"));
  form.onsubmit = async (e) => {
    e.preventDefault();
    settings = {
      bizName: form.bizName.value.trim(), bizPhone: form.bizPhone.value.trim(),
      bizEmail: form.bizEmail.value.trim(), dueDays: Number(form.dueDays.value), memo: form.memo.value.trim(),
    };
    await setDoc(doc(db, "settings", "business"), settings, { merge: true });
    toast("Settings saved");
  };
}

/* ---------- misc ---------- */
function tsDate(ts) {
  try { return ts.toDate().toLocaleDateString("en-US"); } catch { return ""; }
}
function fmtDate(str) {
  if (!str) return "";
  try { return new Date(str + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
  catch { return str; }
}
