// estimate_factset_country_revenue.mjs
// Output: factset_fy2025_revenue_est_by_country_usd_millions.csv
// Anchors: FY2025 FactSet segment revenues (USD thousands -> USD millions).
// Allocates across every ISO-3166 country using transparent proxies + explicit multipliers.

import fs from "node:fs";

const ISO_CSV_URL =
  "https://raw.githubusercontent.com/lukes/iso-3166-countries-with-regional-codes/master/all/all.csv";

const WB = (indicator) =>
  `https://api.worldbank.org/v2/country/all/indicator/${indicator}?format=json&per_page=20000&date=2018:2024`;

// World Bank indicators (free)
const IND_GDP = "NY.GDP.MKTP.CD"; // GDP current US$
const IND_MCAP_PCT = "CM.MKT.LCAP.GD.ZS"; // Market cap % GDP
const IND_CREDIT_PCT = "FS.AST.PRVT.GD.ZS"; // Private credit % GDP
const IND_GDP_PC = "NY.GDP.PCAP.CD"; // GDP per capita current US$
const IND_NET = "IT.NET.USER.ZS"; // Internet users % population

// FY2025 segment revenues from FactSet 10-K (USD thousands) -> USD millions
const SEGMENT_REVENUE_USD_M = {
  AMERICAS: 1506108 / 1000,
  EMEA: 580284 / 1000,
  APAC: 235356 / 1000,
};

// “Common sense” multipliers (explicit)
const HUB_MULT = new Map([
  ["USA", 1.3],
  ["GBR", 1.3],
  ["CHE", 1.3],
  ["LUX", 1.3],
  ["SGP", 1.3],
  ["HKG", 1.3],
  ["ARE", 1.25],
  ["IRL", 1.2],
  ["NLD", 1.2],
  ["FRA", 1.15],
  ["DEU", 1.15],
  ["JPN", 1.15],
  ["AUS", 1.15],
  ["CAN", 1.15],
]);

// Office-country multiplier (from FY2025 10-K office country list)
const OFFICE_COUNTRIES = new Set([
  // Americas
  "USA",
  "BRA",
  "CAN",
  // EMEA
  "BGR",
  "GBR",
  "FRA",
  "DEU",
  "ITA",
  "LVA",
  "LUX",
  "NLD",
  "SWE",
  "ARE",
  // APAC
  "AUS",
  "CHN",
  "HKG",
  "IND",
  "JPN",
  "PHL",
  "SGP",
]);

const OFFICE_MULT = 1.15;

// Comprehensive-sanctions near-zero (country-level only; regions excluded)
const NEAR_ZERO = new Set(["CUB", "IRN", "PRK", "RUS"]);
const NEAR_ZERO_MULT = 0.01;

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
    } else if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function median(arr) {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch failed ${r.status} ${url}`);
  return r.text();
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch failed ${r.status} ${url}`);
  return r.json();
}

function latestByIso3(wbJson) {
  const rows = wbJson?.[1] ?? [];
  const best = new Map(); // iso3 -> {year, value}
  for (const it of rows) {
    const iso3 = it?.countryiso3code;
    const year = Number(it?.date);
    const val = it?.value;
    if (!iso3 || !Number.isFinite(year) || val == null) continue;
    const prev = best.get(iso3);
    if (!prev || year > prev.year) best.set(iso3, { year, value: Number(val) });
  }
  return best;
}

// ISO dataset uses UN regions: Africa, Americas, Asia, Europe, Oceania
function segmentOfCountry(region, subRegion) {
  if (region === "Americas") return "AMERICAS";
  if (region === "Europe") return "EMEA";
  if (region === "Africa") return "EMEA";
  if (region === "Asia") {
    if (subRegion === "Western Asia") return "EMEA"; // coarse
    return "APAC";
  }
  if (region === "Oceania") return "APAC";
  return null;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

(async () => {
  // 1) ISO list
  const isoCsv = await fetchText(ISO_CSV_URL);
  const lines = isoCsv.trim().split("\n");
  const header = splitCsvLine(lines[0]);
  const idx = (name) => header.indexOf(name);

  const countries = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const iso3 = cols[idx("alpha-3")];
    const name = cols[idx("name")];
    const region = cols[idx("region")];
    const subRegion = cols[idx("sub-region")];
    if (!iso3 || !name) continue;
    const seg = segmentOfCountry(region, subRegion);
    countries.push({ iso3, name, region, subRegion, seg });
  }

  // 2) World Bank indicators (latest 2018–2024)
  const [gdpJson, mcapJson, creditJson, gdpPcJson, netJson] = await Promise.all([
    fetchJson(WB(IND_GDP)),
    fetchJson(WB(IND_MCAP_PCT)),
    fetchJson(WB(IND_CREDIT_PCT)),
    fetchJson(WB(IND_GDP_PC)),
    fetchJson(WB(IND_NET)),
  ]);

  const gdp = latestByIso3(gdpJson);
  const mcapPct = latestByIso3(mcapJson);
  const creditPct = latestByIso3(creditJson);
  const gdpPc = latestByIso3(gdpPcJson);
  const netPct = latestByIso3(netJson);

  // 3) Medians per segment for missing data
  const segVals = {
    AMERICAS: { mcap: [], credit: [], gdppc: [], net: [] },
    EMEA: { mcap: [], credit: [], gdppc: [], net: [] },
    APAC: { mcap: [], credit: [], gdppc: [], net: [] },
  };

  for (const c of countries) {
    if (!c.seg) continue;
    const mp = mcapPct.get(c.iso3)?.value;
    const cp = creditPct.get(c.iso3)?.value;
    const gp = gdpPc.get(c.iso3)?.value;
    const np = netPct.get(c.iso3)?.value;
    if (Number.isFinite(mp)) segVals[c.seg].mcap.push(mp);
    if (Number.isFinite(cp)) segVals[c.seg].credit.push(cp);
    if (Number.isFinite(gp)) segVals[c.seg].gdppc.push(gp);
    if (Number.isFinite(np)) segVals[c.seg].net.push(np);
  }

  const segMedian = {};
  for (const seg of Object.keys(segVals)) {
    segMedian[seg] = {
      mcap: median(segVals[seg].mcap) ?? 30,
      credit: median(segVals[seg].credit) ?? 50,
      gdppc: median(segVals[seg].gdppc) ?? 8000,
      net: median(segVals[seg].net) ?? 55,
    };
  }

  // 4) Score + allocate within each segment
  // Base score (transparent):
  // GDP^0.70 * (1+mcap%/100)^0.90 * (1+credit%/100)^0.60
  // * (1+min(gdppc,80000)/50000)^0.35 * (0.2+internet%/100)^0.25
  // then multipliers: hubs, offices, sanctions.
  const scores = { AMERICAS: new Map(), EMEA: new Map(), APAC: new Map() };

  for (const c of countries) {
    if (!c.seg) continue;

    const g = gdp.get(c.iso3)?.value;
    if (!Number.isFinite(g) || g <= 0) {
      scores[c.seg].set(c.iso3, 1e-9); // keeps “every country” present
      continue;
    }

    const mp = mcapPct.get(c.iso3)?.value ?? segMedian[c.seg].mcap;
    const cp = creditPct.get(c.iso3)?.value ?? segMedian[c.seg].credit;
    const gp = gdpPc.get(c.iso3)?.value ?? segMedian[c.seg].gdppc;
    const np = netPct.get(c.iso3)?.value ?? segMedian[c.seg].net;

    const mcapFactor = Math.pow(1 + clamp(mp, 0, 400) / 100, 0.9);
    const creditFactor = Math.pow(1 + clamp(cp, 0, 300) / 100, 0.6);
    const wealthFactor = Math.pow(1 + clamp(gp, 0, 80000) / 50000, 0.35);
    const internetFactor = Math.pow(0.2 + clamp(np, 0, 100) / 100, 0.25);

    let s = Math.pow(g, 0.7) * mcapFactor * creditFactor * wealthFactor * internetFactor;

    // Explicit multipliers
    s *= HUB_MULT.get(c.iso3) ?? 1.0;
    if (OFFICE_COUNTRIES.has(c.iso3)) s *= OFFICE_MULT;
    if (NEAR_ZERO.has(c.iso3)) s *= NEAR_ZERO_MULT;

    scores[c.seg].set(c.iso3, s);
  }

  const allocations = [];
  for (const seg of Object.keys(scores)) {
    const map = scores[seg];
    let sum = 0;
    for (const v of map.values()) sum += v;
    const total = SEGMENT_REVENUE_USD_M[seg];

    for (const c of countries.filter((x) => x.seg === seg)) {
      const s = map.get(c.iso3) ?? 0;
      const share = sum > 0 ? s / sum : 0;
      allocations.push({
        iso3: c.iso3,
        country: c.name,
        segment: seg,
        revenue_usd_millions_est: total * share,
        office: OFFICE_COUNTRIES.has(c.iso3) ? 1 : 0,
        hub: HUB_MULT.has(c.iso3) ? 1 : 0,
        near_zero: NEAR_ZERO.has(c.iso3) ? 1 : 0,
      });
    }
  }

  allocations.sort((a, b) =>
    a.segment === b.segment
      ? b.revenue_usd_millions_est - a.revenue_usd_millions_est
      : a.segment.localeCompare(b.segment),
  );

  const outPath = "factset_fy2025_revenue_est_by_country_usd_millions.csv";
  const headerOut = ["iso3", "country", "segment", "revenue_usd_millions_est", "office", "hub", "near_zero"];
  const rows = [headerOut.join(",")];

  for (const r of allocations) {
    rows.push(
      [
        r.iso3,
        `"${String(r.country).replaceAll('"', '""')}"`,
        r.segment,
        r.revenue_usd_millions_est.toFixed(6),
        r.office,
        r.hub,
        r.near_zero,
      ].join(","),
    );
  }

  fs.writeFileSync(outPath, rows.join("\n"), "utf8");
  console.log(outPath);
})();
