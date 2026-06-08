/* ============================================================
   matchAccount — fuzzy-match a parsed payment to one of Axel's
   accounts. Pure (no I/O) so it's unit-testable.

   Why two signals: a customer's Venmo display name often won't match
   the account name ("Y Acosta" vs an account named for the property),
   but the payment NOTE frequently carries the address/job
   ("Porto bello yard"). We score the payer name AND the note against
   each account's name, address, and learned aliases, then take the best.

   Returns { candidates, suggestedAccountId, confidence }:
     candidates: up to 4 { accountId, name, score } sorted high→low
     confidence: "high" only when the top score is strong AND clearly
                 ahead of the runner-up (so a near-tie never auto-suggests
                 with false certainty).
   ============================================================ */

const HIGH_SCORE = 0.85; // top score must clear this to be "high" confidence
const LEAD = 0.15; // ...and beat #2 by at least this much
const SUGGEST_FLOOR = 0.5; // below this we pre-select nothing

module.exports = matchAccount;

function matchAccount(parsed = {}, accounts = []) {
  const scored = accounts
    .filter((a) => a && a.active !== false)
    .map((a) => ({
      accountId: a.id,
      name: a.name || "(unnamed)",
      score: round(bestScore(parsed, a)),
    }))
    .sort((x, y) => y.score - x.score);

  const candidates = scored.slice(0, 4);
  const best = candidates[0]?.score || 0;
  const second = candidates[1]?.score || 0;

  const confidence = best >= HIGH_SCORE && best - second >= LEAD ? "high" : "low";
  const suggestedAccountId = best >= SUGGEST_FLOOR ? candidates[0].accountId : null;

  return { candidates, suggestedAccountId, confidence };
}

// Best of: payerName vs (name, aliases); note vs (name, address, aliases).
function bestScore(parsed, acc) {
  const aliases = Array.isArray(acc.paymentAliases) ? acc.paymentAliases : [];
  const nameTargets = [acc.name, ...aliases];
  const noteTargets = [acc.name, acc.address, ...aliases];

  let best = 0;
  if (parsed.payerName) {
    for (const t of nameTargets) best = Math.max(best, scorePair(parsed.payerName, t));
  }
  if (parsed.note) {
    // Slightly discount note matches so an exact name match wins ties.
    for (const t of noteTargets) best = Math.max(best, scorePair(parsed.note, t) * 0.95);
  }
  return best;
}

function scorePair(query, target) {
  const q = normalize(query);
  const t = normalize(target);
  if (!q || !t) return 0;
  if (q === t) return 1;

  const overlap = tokenOverlap(q, t);
  const contain = t.includes(q) || q.includes(t) ? 0.8 : 0;
  return Math.max(overlap, contain);
}

// Shared-token ratio over the larger token set, with a small fuzzy credit for
// near-identical tokens ("portobello" ≈ "porto"+"bello" won't match, but
// "smith" ≈ "smiths" will via the similarity check).
function tokenOverlap(q, t) {
  const A = q.split(" ").filter(Boolean);
  const B = t.split(" ").filter(Boolean);
  if (!A.length || !B.length) return 0;

  let matched = 0;
  const used = new Array(B.length).fill(false);
  for (const a of A) {
    let bestIdx = -1;
    let bestSim = 0;
    for (let i = 0; i < B.length; i++) {
      if (used[i]) continue;
      const sim = tokenSim(a, B[i]);
      if (sim > bestSim) { bestSim = sim; bestIdx = i; }
    }
    if (bestIdx !== -1 && bestSim >= 0.8) { used[bestIdx] = true; matched += bestSim; }
  }
  return matched / Math.max(A.length, B.length);
}

function tokenSim(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD") // decompose accents; the next line drops the marks
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function round(n) {
  return Math.round(n * 100) / 100;
}

// Exposed for unit tests.
module.exports.scorePair = scorePair;
module.exports.normalize = normalize;
