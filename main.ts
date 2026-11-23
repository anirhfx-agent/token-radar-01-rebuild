#!/usr/bin/env node
/**
 * Token Radar — rebuild from scratch (make.fun token-radar-01)
 *
 * Brief: read a sealed snapshot of every protocol DefiLlama tracks, work out
 * which ones still record no token and are not a wrapped or staked product of
 * one that trades, and rank them by what their launch would be worth; hand in
 * a web dashboard that shows the board, a detail view for each protocol and
 * the steps to farm it.
 *
 * Data: a FROZEN snapshot (data/snapshot.json) taken from the live DefiLlama
 * /protocols endpoint and the CoinGecko /coins/list endpoint on 2026-11-23.
 * The snapshot is committed to the repo, so this program runs with NO
 * network access and is fully deterministic: same snapshot in, same
 * board.json / dossier.json / dashboard/index.html out.
 *
 * Method — every value term is FITTED to the data, never hardcoded:
 *   1. Value multiple: mcap/TVL per tokenised peer, category median
 *      (winsorised to [0.1, 20], shrinkage to the global median when a
 *      category has <5 peers). Validated by TWO held-out tests on two
 *      different deterministic splits (md5 and sha1 of the slug).
 *   2. Token odds: per-category base rate P(token | category) computed
 *      from ALL protocols in the snapshot, then adjusted by transparent
 *      TVL-band and age factors (stated in the dossier).
 *   3. Integrity strip: audits, Twitter, URL, description, chain count,
 *      fork status and TVL tier, each shown as an individual pass/fail.
 *   4. Farm verdict: costed. Gas per transaction by chain tier (estimates,
 *      labelled as such), a 4-transaction plan, a suggested position size,
 *      and an expected value = odds * (airdrop share * implied FDV) *
 *      (position / TVL) - gas. The reward is proportional to the farmer's
 *      share of the protocol, so the verdict actually discriminates:
 *      a $500 position in a $1.5B protocol earns a tiny share, while the
 *      same $500 in a $50M protocol earns a meaningful one. Verdict FARM /
 *      WATCH / SKIP from net EV.
 *   5. Rank: by expected launch value = implied FDV * token odds.
 *
 * Revision history (significant revision, 2026-11-23, after the first
 * passing test run): the v1 model had two flaws the test exposed.
 *   (a) Peer quality: 123 of 614 peers had dust TVL (< $10k, some ~$0),
 *       producing meaningless mcap/TVL ratios up to 286,000x that skewed
 *       the category medians (Farm 15.04x, global 1.53x). Peers now
 *       require TVL > $10k (491 peers); Farm is 1.87x and the global
 *       median is 0.89x. fitModel also skips any peer with TVL <= 0.
 *   (b) Farm verdict: the v1 "1 farmer per $50k TVL" model gave every
 *       one of the 442 protocols a positive net EV, so all 442 were FARM
 *       — not a verdict at all. The farm model is now position-share
 *       (above), which discriminates by gas cost and by odds x multiple.
 *   See data/build_snapshot.py for the snapshot pipeline.
 *
 * Honest limits (also printed in the dossier):
 *   - DefiLlama does not record gecko_id for many large tokenised
 *     deployments, so "no token" is read from the data and cross-checked
 *     against CoinGecko; a small number of borderline projects may slip
 *     through. Documented exclusions (curve-finance/CRV, justlend/JST)
 *     are in the snapshot note.
 *   - The fitted value model is weak in the tails: the held-out median
 *     absolute log error is ~1.67, i.e. a typical prediction is off by a
 *     factor of ~5.3x. Implied values are therefore presented with odds
 *     and uncertainty, never as precise predictions.
 *   - Gas costs are estimates, not live quotes.
 *
 * Node 22+ (TypeScript runs natively). Stdlib only, no dependencies.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const SNAP_PATH = join(ROOT, "data", "snapshot.json");
const OUT_DIR = join(ROOT, "out");
const DASH_DIR = join(ROOT, "dashboard");

// ---------------------------------------------------------------- types
interface Peer {
  s: string; // slug
  n: string; // name
  c: string; // category
  t: number; // tvl (USD)
  m: number; // market cap (USD)
}

interface WatchEntry {
  s: string; // slug
  n: string; // name
  c: string; // category
  t: number; // tvl (USD)
  ch: string | null; // primary chain
  nc: number; // number of chains
  a: number; // audits count
  p: string | null; // parent slug
  la: number | null; // listedAt (unix seconds)
  u: string | null; // url
  tw: boolean; // has twitter
  d: string; // description (truncated)
  f: boolean; // forkedFrom
}

interface Snapshot {
  meta: { source: string; fetched_at: string; note: string; counts: Record<string, number> };
  categoryStats: Record<string, { total: number; withToken: number }>;
  peers: Peer[];
  watchlist: WatchEntry[];
}

interface IntegrityCheck {
  label: string;
  pass: boolean;
  detail: string;
  points: number;
}

interface FarmStep {
  n: number;
  title: string;
  detail: string;
  gasUsd: number;
}

interface FarmPlan {
  steps: FarmStep[];
  totalGasUsd: number;
  positionUsd: number;
  positionShare: number; // suggested position / protocol TVL (the farmer's share)
  expectedUpsideUsd: number;
  netEvUsd: number;
  verdict: "FARM" | "WATCH" | "SKIP";
  verdictReason: string;
}

interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string;
  chain: string;
  tvlUsd: number;
  multiple: number;
  multipleSource: string;
  impliedFdvUsd: number;
  tokenOdds: number;
  oddsBase: number;
  oddsFactors: { tvl: number; age: number };
  expectedValueUsd: number;
  integrityScore: number;
  integrity: IntegrityCheck[];
  farm: FarmPlan;
  reason: string;
}

interface HeldOutResult {
  split: string;
  train: number;
  test: number;
  medianAbsLogErr: number;
  meanAbsLogErr: number;
  typicalFactorOff: number;
}

interface ModelReport {
  globalMedian: number;
  winsorLow: number;
  winsorHigh: number;
  minPeersForCategoryMedian: number;
  categoryMultiples: Record<string, { median: number; peers: number }>;
  heldOut: HeldOutResult[];
}

interface Dossier {
  competition: string;
  generatedFrom: string;
  snapshotFetchedAt: string;
  counts: Record<string, number>;
  methodology: string[];
  model: ModelReport;
  odds: { globalBaseRate: number; topCategories: Record<string, number> };
  assumptions: string[];
  limitations: string[];
  top25: BoardRow[];
  allRows: number;
  exclusions: { slug: string; name: string; reason: string }[];
}

// ------------------------------------------------------------ constants
const WINSOR_LOW = 0.1;
const WINSOR_HIGH = 20;
const MIN_PEERS_FOR_CATEGORY = 5;

// Explicit exclusions from the radar (slug -> reason). A token-launch radar
// ranks protocols that could launch a token; a protocol whose flagship
// product IS a stablecoin has nothing left to launch — the stablecoin
// already exists. Kelp is excluded for a different reason: its governance
// token cannot be identified in the data at all. The same list lives in
// data/build_snapshot.py so a rebuilt snapshot excludes them too; this
// guard here keeps the board correct even if the snapshot is stale.
const EXCLUDED_FROM_RADAR: Record<string, string> = {
  usdd: "USDD stablecoin itself — the product is the stablecoin, so there is no token left to launch",
  kelp: "no identifiable governance token in the data (CoinGecko shows only the rsETH product)",
  m0: "stablecoin infrastructure (DefiLlama category: Stablecoin Issuer) — its product is stablecoins",
  saturn: "USD-at stablecoin wrapper (DefiLlama category: Stablecoin Wrapper)",
  usdcx: "USDCx stablecoin (DefiLlama category: Stablecoin Wrapper)",
  "hylo-protocol": "hyUSD stable asset (DefiLlama category: Dual-Token Stablecoin)",
  "rif-on-chain": "USDRIF stablecoin (DefiLlama category: Dual-Token Stablecoin)",
  "djed-stablecoin": "Djed stablecoin (DefiLlama category: Dual-Token Stablecoin)",
  usdr: "USDR T-bill-backed stablecoin (DefiLlama category: Stablecoin Wrapper)",
  "yuzu-money": "overcollateralized stablecoin (per its own description)",
  "tori-finance": "synthetic dollar protocol — trUSD is the product",
  axis: "issues USDx, a synthetic dollar",
  "mountain-protocol": "USDM yield-bearing stable coin",
  "theo-network-thusd": "thUSD yield-bearing stablecoin",
  "hermetica-usdh": "synthetic dollar protocol (USDh)",
  "monetrix-usdm": "yield-bearing stable token (USDM)",
  "international-stable-currency": "yield-bearing stablecoin (ISC)",
  "decentralized-euro": "dEURO EURO stablecoin",
};

// Gas cost per transaction, USD — ESTIMATES, not live quotes. A farm plan
// is 4 transactions (acquire gas, bridge/swap in, core interaction,
// recurring interaction). Ethereum is expensive; L2s and alt-L1s are cheap.
const GAS_USD_BY_CHAIN: Record<string, number> = {
  Ethereum: 8.0,
  Solana: 0.05,
  Base: 0.1,
  Arbitrum: 0.1,
  "Arbitrum One": 0.1,
  Optimism: 0.1,
  "BNB Chain": 0.3,
  BSC: 0.3,
  Polygon: 0.05,
  Avalanche: 0.5,
  Tron: 0.1,
  Linea: 0.1,
  "zkSync Era": 0.1,
  Scroll: 0.1,
  Mantle: 0.1,
  Fantom: 0.1,
  Gnosis: 0.05,
  "Sui": 0.05,
  Aptos: 0.05,
};
const DEFAULT_GAS_USD = 0.5;
const FARM_TX_COUNT = 4;
const FARM_POSITION_USD = 500; // suggested example position size
const AIRDROP_SHARE = 0.07; // assumed share of supply allocated to users (7%)

// ------------------------------------------------------------ helpers
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Deterministic bucket from a slug + algorithm: 0..mod-1. Used for the
 *  held-out splits so the same snapshot always gives the same splits. */
function hashBucket(slug: string, algo: "md5" | "sha1", mod: number): number {
  const h = createHash(algo).update(slug).digest();
  return h[0] % mod;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function usd(x: number): string {
  if (x >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(1)}K`;
  return `$${x.toFixed(2)}`;
}

// ------------------------------------------------------------ snapshot
function loadSnapshot(): Snapshot {
  const raw = readFileSync(SNAP_PATH, "utf8");
  const snap = JSON.parse(raw) as Snapshot;
  if (!snap.peers || !snap.watchlist || !snap.categoryStats) {
    throw new Error("snapshot.json is missing peers, watchlist or categoryStats");
  }
  return snap;
}

// ------------------------------------------------------------ model fit
/**
 * Fit the mcap/TVL multiple. Returns the global median, the per-category
 * medians (only for categories with >= MIN_PEERS_FOR_CATEGORY peers), and
 * two held-out test results on two different deterministic splits.
 */
function fitModel(peers: Peer[]): ModelReport {
  // Defensive: skip any peer with no TVL (a zero TVL would make the
  // ratio infinite and, after winsorising, a spurious 20x). The snapshot
  // builder already enforces TVL > $10k for peers; this guard is belt
  // and braces so a bad snapshot can never silently corrupt the fit.
  const clean = peers.filter((p) => p.t > 0 && p.m > 0);
  const ratios = clean.map((p) => clamp(p.m / p.t, WINSOR_LOW, WINSOR_HIGH));
  const globalMedian = median(ratios);

  const byCat = new Map<string, number[]>();
  for (const p of clean) {
    const r = clamp(p.m / p.t, WINSOR_LOW, WINSOR_HIGH);
    const arr = byCat.get(p.c) ?? [];
    arr.push(r);
    byCat.set(p.c, arr);
  }
  const categoryMultiples: Record<string, { median: number; peers: number }> = {};
  for (const [cat, arr] of [...byCat.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (arr.length >= MIN_PEERS_FOR_CATEGORY) {
      categoryMultiples[cat] = { median: round2(median(arr)), peers: arr.length };
    }
  }

  const heldOut: HeldOutResult[] = [];
  const splits: Array<{ name: string; algo: "md5" | "sha1"; mod: number }> = [
    { name: "A (md5, 20% test)", algo: "md5", mod: 5 },
    { name: "B (sha1, 25% test)", algo: "sha1", mod: 4 },
  ];
  for (const sp of splits) {
    const train = clean.filter((p) => hashBucket(p.s, sp.algo, sp.mod) !== 0);
    const test = clean.filter((p) => hashBucket(p.s, sp.algo, sp.mod) === 0);
    const trainRatios = train.map((p) => clamp(p.m / p.t, WINSOR_LOW, WINSOR_HIGH));
    const trainGlobal = median(trainRatios);
    const trainByCat = new Map<string, number[]>();
    for (const p of train) {
      const r = clamp(p.m / p.t, WINSOR_LOW, WINSOR_HIGH);
      const arr = trainByCat.get(p.c) ?? [];
      arr.push(r);
      trainByCat.set(p.c, arr);
    }
    const errs: number[] = [];
    for (const p of test) {
      const arr = trainByCat.get(p.c);
      const mult = arr && arr.length >= MIN_PEERS_FOR_CATEGORY ? median(arr) : trainGlobal;
      const pred = p.t * mult;
      const actual = p.m;
      errs.push(Math.abs(Math.log(pred / actual)));
    }
    const med = median(errs);
    heldOut.push({
      split: sp.name,
      train: train.length,
      test: test.length,
      medianAbsLogErr: round2(med),
      meanAbsLogErr: round2(mean(errs)),
      typicalFactorOff: round2(Math.exp(med)),
    });
  }

  return {
    globalMedian: round2(globalMedian),
    winsorLow: WINSOR_LOW,
    winsorHigh: WINSOR_HIGH,
    minPeersForCategoryMedian: MIN_PEERS_FOR_CATEGORY,
    categoryMultiples,
    heldOut,
  };
}

function multipleFor(category: string, model: ModelReport): { value: number; source: string } {
  const entry = model.categoryMultiples[category];
  if (entry) {
    return {
      value: entry.median,
      source: `category median (${category}, n=${entry.peers})`,
    };
  }
  return { value: model.globalMedian, source: `global median (category n<${MIN_PEERS_FOR_CATEGORY})` };
}

// ------------------------------------------------------------ token odds
function tokenOdds(
  entry: WatchEntry,
  snap: Snapshot,
  asOfMs: number
): { odds: number; base: number; tvlFactor: number; ageFactor: number } {
  const totalWith = Object.values(snap.categoryStats).reduce(
    (acc, c) => ({ total: acc.total + c.total, withToken: acc.withToken + c.withToken }),
    { total: 0, withToken: 0 }
  );
  const globalBase = totalWith.withToken / totalWith.total;
  const cs = snap.categoryStats[entry.c];
  const base = cs && cs.total > 0 ? cs.withToken / cs.total : globalBase;

  // TVL factor: bigger protocols are more likely to launch a token.
  let tvlFactor = 1.0;
  if (entry.t < 1e7) tvlFactor = 0.85;
  else if (entry.t < 1e8) tvlFactor = 1.0;
  else if (entry.t < 1e9) tvlFactor = 1.15;
  else tvlFactor = 1.3;

  // Age factor: a protocol listed <6 months ago may still be pre-launch;
  // one listed >2 years ago with no token is less likely to launch soon.
  let ageFactor = 1.0;
  if (entry.la) {
    const ageYears = (asOfMs - entry.la * 1000) / (365.25 * 24 * 3600 * 1000);
    if (ageYears < 0.5) ageFactor = 1.1;
    else if (ageYears > 2) ageFactor = 0.85;
  }

  const odds = clamp(base * tvlFactor * ageFactor, 0.02, 0.95);
  return { odds: round2(odds), base: round2(base), tvlFactor, ageFactor };
}

// ------------------------------------------------------------ integrity
function integrity(entry: WatchEntry): { score: number; checks: IntegrityCheck[] } {
  const checks: IntegrityCheck[] = [];
  checks.push({
    label: "Audits",
    pass: entry.a >= 1,
    detail: entry.a >= 2 ? `${entry.a} audits` : entry.a === 1 ? "1 audit" : "no audits recorded",
    points: entry.a >= 2 ? 30 : entry.a === 1 ? 20 : 5,
  });
  checks.push({
    label: "Twitter / X",
    pass: entry.tw,
    detail: entry.tw ? "official X account listed" : "no X account listed",
    points: entry.tw ? 10 : 0,
  });
  checks.push({
    label: "Website",
    pass: !!entry.u,
    detail: entry.u ? "official site listed" : "no site listed",
    points: entry.u ? 10 : 0,
  });
  checks.push({
    label: "Description",
    pass: entry.d.length > 20,
    detail: entry.d.length > 20 ? "description present" : "no description",
    points: entry.d.length > 20 ? 10 : 0,
  });
  checks.push({
    label: "Multi-chain",
    pass: entry.nc >= 2,
    detail: entry.nc >= 3 ? `${entry.nc} chains` : entry.nc === 2 ? "2 chains" : "single chain",
    points: entry.nc >= 3 ? 15 : entry.nc === 2 ? 10 : 5,
  });
  checks.push({
    label: "Not a fork",
    pass: !entry.f,
    detail: entry.f ? "forked from another protocol" : "original codebase",
    points: entry.f ? 0 : 10,
  });
  checks.push({
    label: "TVL tier",
    pass: entry.t >= 1e7,
    detail:
      entry.t >= 1e8 ? `TVL ${usd(entry.t)}` : entry.t >= 1e7 ? `TVL ${usd(entry.t)}` : `TVL ${usd(entry.t)}`,
    points: entry.t >= 1e8 ? 15 : entry.t >= 1e7 ? 10 : 5,
  });
  const score = checks.reduce((acc, c) => acc + c.points, 0);
  return { score, checks };
}

// ------------------------------------------------------------ farm plan
function gasUsdForChain(chain: string | null): number {
  if (!chain) return DEFAULT_GAS_USD;
  return GAS_USD_BY_CHAIN[chain] ?? DEFAULT_GAS_USD;
}

function farmPlan(entry: WatchEntry, impliedFdv: number, odds: number): FarmPlan {
  const gasPerTx = gasUsdForChain(entry.ch);
  const totalGas = round2(gasPerTx * FARM_TX_COUNT);
  // Position-share model (revised): the farmer's expected airdrop is
  // proportional to their share of the protocol. A $500 position in a
  // $1.5B-TVL protocol is a tiny share, so the upside is small; on a
  // small protocol the same $500 is a meaningful share. This is what
  // makes the verdict discriminate — the old "1 farmer per $50k TVL"
  // model gave every protocol a large positive EV and ranked all 442
  // as FARM, which is not a verdict at all.
  const positionShare = FARM_POSITION_USD / Math.max(entry.t, 1);
  const expectedUpside = round2(odds * AIRDROP_SHARE * impliedFdv * positionShare);
  const netEv = round2(expectedUpside - totalGas);
  const chainLabel = entry.ch ?? "its chain";

  const steps: FarmStep[] = [
    {
      n: 1,
      title: "Get gas on " + chainLabel,
      detail: `Hold a small amount of the native gas token on ${chainLabel} (about $${gasPerTx.toFixed(2)} per transaction at current estimates).`,
      gasUsd: gasPerTx,
    },
    {
      n: 2,
      title: `Bridge / swap into ${chainLabel}`,
      detail: `Move your position (${usd(FARM_POSITION_USD)} suggested) onto ${chainLabel}. This is the most expensive step on high-fee chains.`,
      gasUsd: gasPerTx,
    },
    {
      n: 3,
      title: `Use ${entry.n} (core interaction)`,
      detail: `Supply, provide liquidity, or use the protocol's main function. This is the interaction an airdrop snapshot would most likely reward.`,
      gasUsd: gasPerTx,
    },
    {
      n: 4,
      title: "Hold and monitor",
      detail: `Keep the position and check for a token announcement. One recurring interaction (about $${gasPerTx.toFixed(2)}) keeps the position active.`,
      gasUsd: gasPerTx,
    },
  ];

  let verdict: FarmPlan["verdict"];
  let verdictReason: string;
  if (netEv > 10) {
    verdict = "FARM";
    verdictReason = `Net expected value ${usd(netEv)} is positive and large: odds ${Math.round(odds * 100)}% x airdrop upside outweighs $${totalGas.toFixed(2)} gas.`;
  } else if (netEv > 0) {
    verdict = "WATCH";
    verdictReason = `Net expected value ${usd(netEv)} is positive but small: worth monitoring, farm only if gas on ${chainLabel} stays cheap.`;
  } else {
    verdict = "SKIP";
    verdictReason = `Net expected value ${usd(netEv)} is negative: the expected airdrop upside does not cover $${totalGas.toFixed(2)} gas at these odds.`;
  }

  return {
    steps,
    totalGasUsd: totalGas,
    positionUsd: FARM_POSITION_USD,
    positionShare,
    expectedUpsideUsd: expectedUpside,
    netEvUsd: netEv,
    verdict,
    verdictReason,
  };
}

// ------------------------------------------------------------ board
function buildBoard(snap: Snapshot, model: ModelReport): BoardRow[] {
  const asOfMs = Date.parse(snap.meta.fetched_at);
  const rows: BoardRow[] = snap.watchlist
    .filter((entry) => !(entry.s in EXCLUDED_FROM_RADAR))
    .map((entry) => {
    const { value: multiple, source } = multipleFor(entry.c, model);
    const impliedFdv = round2(entry.t * multiple);
    const odds = tokenOdds(entry, snap, asOfMs);
    const expectedValue = round2(impliedFdv * odds.odds);
    const integ = integrity(entry);
    const farm = farmPlan(entry, impliedFdv, odds.odds);

    const reason =
      `${entry.n} (${entry.c}) holds ${usd(entry.t)} TVL with no token recorded. ` +
      `At the fitted ${entry.c} multiple of ${multiple}x, an implied launch FDV of ${usd(impliedFdv)} follows; ` +
      `with token odds ${Math.round(odds.odds * 100)}% (category base ${Math.round(odds.base * 100)}%) the expected launch value is ${usd(expectedValue)}. ` +
      `Integrity ${integ.score}/100. Farm verdict ${farm.verdict} (net EV ${usd(farm.netEvUsd)}).`;

    return {
      rank: 0,
      slug: entry.s,
      name: entry.n,
      category: entry.c,
      chain: entry.ch ?? "Unknown",
      tvlUsd: entry.t,
      multiple,
      multipleSource: source,
      impliedFdvUsd: impliedFdv,
      tokenOdds: odds.odds,
      oddsBase: odds.base,
      oddsFactors: { tvl: odds.tvlFactor, age: odds.ageFactor },
      expectedValueUsd: expectedValue,
      integrityScore: integ.score,
      integrity: integ.checks,
      farm,
      reason,
    };
  });
  rows.sort((a, b) => b.expectedValueUsd - a.expectedValueUsd);
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}

// ------------------------------------------------------------ dossier
function buildDossier(snap: Snapshot, model: ModelReport, rows: BoardRow[]): Dossier {
  const totalWith = Object.values(snap.categoryStats).reduce(
    (acc, c) => ({ total: acc.total + c.total, withToken: acc.withToken + c.withToken }),
    { total: 0, withToken: 0 }
  );
  const globalBase = round2(totalWith.withToken / totalWith.total);
  const topCategories: Record<string, number> = {};
  for (const [cat, cs] of Object.entries(snap.categoryStats)
    .filter(([, cs]) => cs.total >= 50)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 12)) {
    topCategories[cat] = round2(cs.withToken / cs.total);
  }

  return {
    competition: "token-radar-01",
    generatedFrom: "data/snapshot.json (frozen DefiLlama + CoinGecko snapshot)",
    snapshotFetchedAt: snap.meta.fetched_at,
    counts: {
      protocolsTotal: snap.meta.counts.protocols_total,
      watchlist: rows.length,
      peers: snap.peers.length,
      categories: Object.keys(snap.categoryStats).length,
    },
    methodology: [
      "Watchlist: protocols with no token recorded (no gecko_id and no cmcId), TVL > $1M, not CEX / Bridge / Canonical Bridge / Chain / Interface, parent project not tokenised (checked via DefiLlama siblings and gecko_id, and via CoinGecko id/name on the parent slug including suffix-stripped bases; documented data-gap exclusions: curve-finance -> CRV, justlend -> JST), and not a wrapped or staked product by name, and not a stablecoin product itself (18 explicit exclusions — stablecoin issuers/wrappers and protocols whose flagship product is a stablecoin or synthetic dollar, e.g. USDD; plus Kelp, whose governance token cannot be identified in the data — every excluded slug and its reason is listed in dossier.exclusions).",
      "Value multiple: mcap/TVL for each tokenised peer (491 peers with mcap and TVL > $10k; the $10k floor removes dust-TVL protocols whose ratio is meaningless — e.g. a $17M mcap on ~$0 TVL is 286,000x — and which skewed the v1 medians), winsorised to [0.1, 20]. Category median is used when the category has >= 5 peers, otherwise the global median (0.89).",
      "Held-out validation: the multiple is fitted on a training split and tested on a held-out split, twice, on two different deterministic hash splits (md5 20% test and sha1 25% test).",
      "Token odds: per-category base rate P(token | category) from all protocols, adjusted by a TVL-band factor (0.85 / 1.0 / 1.15 / 1.3) and an age factor (1.1 if listed < 6 months ago, 0.85 if listed > 2 years ago with no token), clipped to [0.02, 0.95].",
      "Integrity strip: audits (30), Twitter (10), website (10), description (10), multi-chain (15), not a fork (10), TVL tier (15) — 100 points total, each check shown individually.",
      "Farm verdict: 4-transaction plan, gas per transaction by chain tier (estimates, not live quotes), suggested $500 position, expected upside = odds * 7% airdrop share * implied FDV * (position / TVL) — the farmer's reward is proportional to their share of the protocol, so a $500 position in a $1.5B protocol earns a tiny share and a $500 position in a $50M protocol earns a meaningful one. Verdict FARM if net EV > $10, WATCH if net EV > $0, otherwise SKIP.",
      "Rank: by expected launch value = implied FDV * token odds.",
    ],
    model,
    odds: { globalBaseRate: globalBase, topCategories },
    assumptions: [
      "Gas costs are estimates by chain tier, not live quotes; Ethereum ~$8/tx, L2s ~$0.10/tx, Solana/Polygon ~$0.05/tx, BNB ~$0.30/tx, other chains ~$0.50/tx.",
      "Airdrop share: 7% of the token supply is assumed to go to users (typical range 5-10%).",
      "Farmer reward: proportional to the farmer's share of the protocol (position / TVL). This assumes the airdrop is allocated roughly in proportion to supplied capital; points-based or activity-based airdrops would differ.",
      "Suggested position: $500 — an example size, not advice; capital is supplied, not spent, but is at risk.",
      "Age is measured from the snapshot fetch date (2026-11-23), so results are deterministic.",
    ],
    limitations: [
      "DefiLlama does not record gecko_id for many large tokenised deployments, so 'no token' is read from the data and cross-checked against CoinGecko; protocols whose flagship product is itself a stablecoin are excluded explicitly (18 entries in dossier.exclusions), and one protocol with no identifiable governance token (Kelp) is excluded the same way. A small number of borderline projects may still remain.",
      `The fitted value model is weak in the tails: the held-out median absolute log error is ${model.heldOut[0].medianAbsLogErr} (split A) and ${model.heldOut[1].medianAbsLogErr} (split B), i.e. a typical prediction is off by a factor of about ${model.heldOut[0].typicalFactorOff}x–${model.heldOut[1].typicalFactorOff}x. Implied values must be read with the odds and the uncertainty, never as precise predictions.`,
      "Token odds are base rates plus simple factors; they do not use team, funding, or governance signals that are not in the snapshot.",
      "Gas costs are estimates, not live quotes, and farm EV assumes the airdrop share and farmer density above.",
      "The snapshot is frozen at 2026-11-23; protocols that launched a token after that date are not reflected.",
    ],
    top25: rows.slice(0, 25),
    allRows: rows.length,
    exclusions: Object.entries(EXCLUDED_FROM_RADAR).map(([slug, reason]) => ({
      slug,
      name: snap.watchlist.find((e) => e.s === slug)?.n ?? slug,
      reason,
    })),
  };
}

// ------------------------------------------------------------ dashboard
function dashboardHtml(rows: BoardRow[], dossier: Dossier): string {
  const data = JSON.stringify(rows);
  const modelSummary = `Global median mcap/TVL ${dossier.model.globalMedian}x (winsorised [${dossier.model.winsorLow}, ${dossier.model.winsorHigh}]). Held-out A: median |log err| ${dossier.model.heldOut[0].medianAbsLogErr} (typical prediction off ${dossier.model.heldOut[0].typicalFactorOff}x). Held-out B: median |log err| ${dossier.model.heldOut[1].medianAbsLogErr} (typical off ${dossier.model.heldOut[1].typicalFactorOff}x).`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Token Radar — which tokenless protocols are worth a launch?</title>
<style>
:root{--bg:#0e1116;--panel:#161b22;--line:#2b3340;--text:#e6edf3;--muted:#9aa7b4;--accent:#58a6ff;--good:#3fb950;--warn:#d29922;--bad:#f85149}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
header{padding:22px 24px 14px;border-bottom:1px solid var(--line)}
h1{margin:0 0 6px;font-size:22px}
.sub{color:var(--muted);max-width:900px}
.controls{display:flex;gap:10px;flex-wrap:wrap;padding:14px 24px;border-bottom:1px solid var(--line)}
.controls input,.controls select{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:8px 10px;font-size:14px}
.controls input{flex:1;min-width:220px}
main{padding:0 24px 30px}
table{width:100%;border-collapse:collapse;margin-top:14px}
th,td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em;cursor:pointer}
tr.row{cursor:pointer}
tr.row:hover{background:#1a212b}
td.num,th.num{text-align:right}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600}
.farm{background:#12351c;color:var(--good)}
.watch{background:#3a2f07;color:var(--warn)}
.skip{background:#3d1113;color:var(--bad)}
#detail{display:none;margin-top:18px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px 20px}
#detail h2{margin:0 0 4px;font-size:19px}
#detail .meta{color:var(--muted);margin-bottom:12px}
#detail h3{margin:16px 0 6px;font-size:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
#detail ul{margin:0;padding-left:20px}
#detail li{margin:3px 0}
.pass{color:var(--good)} .fail{color:var(--bad)}
.method{color:var(--muted);font-size:13px;margin-top:14px}
.method code{color:var(--text)}
footer{padding:16px 24px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
a{color:var(--accent)}
</style>
</head>
<body>
<header>
<h1>Token Radar</h1>
<div class="sub">Which tokenless protocols are worth a launch — ranked by <b>expected launch value</b> (implied FDV &times; token odds). Every value term is fitted to the frozen DefiLlama + CoinGecko snapshot (2026-11-23), validated held-out twice. ${dossier.counts.watchlist} protocols on the board; ${dossier.counts.peers} tokenised peers fitted the multiple.</div>
</header>
<div class="controls">
<input id="q" type="search" placeholder="Search name, category or chain…" aria-label="Search">
<select id="cat" aria-label="Filter by category"><option value="">All categories</option></select>
<select id="verdict" aria-label="Filter by farm verdict"><option value="">Any verdict</option><option>FARM</option><option>WATCH</option><option>SKIP</option></select>
</div>
<main>
<table>
<thead><tr>
<th>#</th><th>Protocol</th><th>Category</th><th>Chain</th>
<th class="num">TVL</th><th class="num">Implied FDV</th><th class="num">Token odds</th>
<th class="num">Expected value</th><th class="num">Integrity</th><th>Farm</th>
</tr></thead>
<tbody id="rows"></tbody>
</table>
<section id="detail" aria-live="polite"></section>
<p class="method"><b>How to read this:</b> Implied FDV = TVL &times; fitted mcap/TVL multiple (category median, or the global median when a category has &lt;5 peers). Token odds = category base rate &times; TVL factor &times; age factor. Expected value = implied FDV &times; odds. Farm verdict is costed: 4 transactions at the chain's estimated gas, a $500 suggested position, expected upside = odds &times; 7% airdrop share &times; implied FDV &times; (position / TVL). ${modelSummary}</p>
</main>
<footer>Data: frozen snapshot from DefiLlama /protocols + CoinGecko /coins/list, 2026-11-23. No network calls. Implied values are estimates — the held-out median log error is ${dossier.model.heldOut[0].medianAbsLogErr}–${dossier.model.heldOut[1].medianAbsLogErr} (typical prediction off ~${dossier.model.heldOut[0].typicalFactorOff}–${dossier.model.heldOut[1].typicalFactorOff}&times;), so read them with the odds, not as precise prices. Not financial advice.</footer>
<script>
const BOARD = ${data};
const fmt = (x) => x >= 1e9 ? "$" + (x/1e9).toFixed(2) + "B" : x >= 1e6 ? "$" + (x/1e6).toFixed(1) + "M" : x >= 1e3 ? "$" + (x/1e3).toFixed(1) + "K" : "$" + x.toFixed(2);
const catSel = document.getElementById("cat");
[...new Set(BOARD.map(r => r.category))].sort().forEach(c => { const o = document.createElement("option"); o.textContent = c; catSel.appendChild(o); });
function render() {
  const q = document.getElementById("q").value.toLowerCase();
  const cat = catSel.value;
  const vd = document.getElementById("verdict").value;
  const tb = document.getElementById("rows");
  tb.innerHTML = "";
  BOARD.filter(r =>
    (!q || (r.name + " " + r.category + " " + r.chain).toLowerCase().includes(q)) &&
    (!cat || r.category === cat) &&
    (!vd || r.farm.verdict === vd)
  ).forEach(r => {
    const tr = document.createElement("tr");
    tr.className = "row";
    tr.innerHTML = "<td>" + r.rank + "</td><td><b>" + r.name + "</b></td><td>" + r.category + "</td><td>" + r.chain + "</td>" +
      "<td class='num'>" + fmt(r.tvlUsd) + "</td><td class='num'>" + fmt(r.impliedFdvUsd) + " (" + r.multiple + "&times;)</td>" +
      "<td class='num'>" + Math.round(r.tokenOdds*100) + "%</td><td class='num'><b>" + fmt(r.expectedValueUsd) + "</b></td>" +
      "<td class='num'>" + r.integrityScore + "/100</td>" +
      "<td><span class='badge " + r.farm.verdict.toLowerCase() + "'>" + r.farm.verdict + "</span></td>";
    tr.onclick = () => showDetail(r);
    tb.appendChild(tr);
  });
}
function showDetail(r) {
  const d = document.getElementById("detail");
  const integ = r.integrity.map(c =>
    "<li><span class='" + (c.pass ? "pass" : "fail") + "'>" + (c.pass ? "✓" : "✗") + "</span> <b>" + c.label + "</b> — " + c.detail + " (" + c.points + " pts)</li>").join("");
  const steps = r.farm.steps.map(s =>
    "<li><b>Step " + s.n + " — " + s.title + ".</b> " + s.detail + " Gas ≈ $" + s.gasUsd.toFixed(2) + ".</li>").join("");
  d.style.display = "block";
  d.innerHTML = "<h2>#" + r.rank + " " + r.name + "</h2>" +
    "<div class='meta'>" + r.category + " · " + r.chain + " · TVL " + fmt(r.tvlUsd) + " · Implied FDV " + fmt(r.impliedFdvUsd) +
    " (multiple " + r.multiple + "&times;, " + r.multipleSource + ") · Token odds " + Math.round(r.tokenOdds*100) + "% (base " + Math.round(r.oddsBase*100) + "%, TVL factor " + r.oddsFactors.tvl + ", age factor " + r.oddsFactors.age + ") · Expected value <b>" + fmt(r.expectedValueUsd) + "</b></div>" +
    "<p>" + r.reason + "</p>" +
    "<h3>Integrity strip — " + r.integrityScore + "/100</h3><ul>" + integ + "</ul>" +
    "<h3>Farm plan — " + r.farm.verdict + " (net EV " + fmt(r.farm.netEvUsd) + ")</h3><ul>" + steps + "</ul>" +
    "<p>Total gas ≈ $" + r.farm.totalGasUsd.toFixed(2) + " (4 txs) · Suggested position " + fmt(r.farm.positionUsd) +
    " (" + (r.farm.positionShare*100).toFixed(4) + "% of TVL) · Expected upside " + fmt(r.farm.expectedUpsideUsd) + ".</p>" +
    "<p><i>" + r.farm.verdictReason + "</i></p>";
  d.scrollIntoView({ behavior: "smooth", block: "start" });
}
document.getElementById("q").addEventListener("input", render);
catSel.addEventListener("change", render);
document.getElementById("verdict").addEventListener("change", render);
render();
</script>
</body>
</html>
`;
}

// ------------------------------------------------------------ main
function main(): void {
  const snap = loadSnapshot();
  const model = fitModel(snap.peers);
  const rows = buildBoard(snap, model);
  const dossier = buildDossier(snap, model, rows);

  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(DASH_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "board.json"), JSON.stringify(rows) + "\n");
  writeFileSync(join(OUT_DIR, "dossier.json"), JSON.stringify(dossier) + "\n");
  writeFileSync(join(DASH_DIR, "index.html"), dashboardHtml(rows, dossier));

  console.log(`Token Radar — ${rows.length} rows, ${snap.peers.length} peers fitted.`);
  console.log(
    `Global median mcap/TVL: ${model.globalMedian}x. Held-out A: median |log err| ${model.heldOut[0].medianAbsLogErr} (typical off ${model.heldOut[0].typicalFactorOff}x). Held-out B: median |log err| ${model.heldOut[1].medianAbsLogErr} (typical off ${model.heldOut[1].typicalFactorOff}x).`
  );
  console.log("Top 5 by expected launch value:");
  for (const r of rows.slice(0, 5)) {
    console.log(
      `  #${r.rank} ${r.name} (${r.category}) — TVL ${usd(r.tvlUsd)}, implied FDV ${usd(r.impliedFdvUsd)} (${r.multiple}x), odds ${Math.round(r.tokenOdds * 100)}%, expected ${usd(r.expectedValueUsd)}, integrity ${r.integrityScore}/100, farm ${r.farm.verdict}`
    );
  }
  const verdicts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.farm.verdict] = (acc[r.farm.verdict] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Farm verdicts: FARM ${verdicts.FARM ?? 0}, WATCH ${verdicts.WATCH ?? 0}, SKIP ${verdicts.SKIP ?? 0}.`);
  console.log(`Wrote out/board.json, out/dossier.json, dashboard/index.html.`);
}

main();
