export type ApiPayload = {
  iso3ToIntensity: Record<string, number>;
  countryDetails: Array<{
    iso3: string;
    name: string;
    region: string;
    revenueMillions: number;
    share: number;
    population: number | null;
    flagUrl: string | null;
    segment: string;
    office: boolean;
    hub: boolean;
    nearZero: boolean;
  }>;
  geo: {
    features?: Array<{
      properties?: Record<string, unknown>;
    }>;
  };
  totalRevenueMillions: number;
  maxShare: number;
  meta: { note: string };
};

// FY2025 segment revenues from FactSet 10-K (USD millions)
const SEGMENT_REVENUE_USD_M: Record<string, number> = {
  AMERICAS: 1_506_108 / 1_000,
  EMEA: 580_284 / 1_000,
  APAC: 235_356 / 1_000,
};

const ISO_CSV_URL =
  "https://raw.githubusercontent.com/lukes/iso-3166-countries-with-regional-codes/master/all/all.csv";
const COUNTRIES_GEOJSON =
  "https://raw.githubusercontent.com/datasets/geo-countries/main/data/countries.geojson";
const WB = (indicator: string) =>
  `https://api.worldbank.org/v2/country/all/indicator/${indicator}?format=json&per_page=20000&date=2018:2024`;
const IND_GDP = "NY.GDP.MKTP.CD"; // GDP current US$
const IND_MCAP_PCT = "CM.MKT.LCAP.GD.ZS"; // Market cap % GDP
const IND_CREDIT_PCT = "FS.AST.PRVT.GD.ZS"; // Private credit % GDP
const IND_GDP_PC = "NY.GDP.PCAP.CD"; // GDP per capita current US$
const IND_NET = "IT.NET.USER.ZS"; // Internet users % population

const HUB_MULT = new Map<string, number>([
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

const NEAR_ZERO = new Set(["CUB", "IRN", "PRK", "RUS"]);
const NEAR_ZERO_MULT = 0.01;

type WorldBankDatum = {
  countryiso3code?: string;
  value?: number | null;
  date?: string | number;
};

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
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

function median(arr: number[]): number | null {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function latestByIso3(wbJson: unknown): Map<string, { year: number; value: number }> {
  const rows = Array.isArray(wbJson) && wbJson.length > 1 ? (wbJson[1] as WorldBankDatum[]) : [];
  const best = new Map<string, { year: number; value: number }>();
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

function segmentOfCountry(region: string | null, subRegion: string | null): "AMERICAS" | "EMEA" | "APAC" | null {
  if (region === "Americas") return "AMERICAS";
  if (region === "Europe") return "EMEA";
  if (region === "Africa") return "EMEA";
  if (region === "Asia") {
    if (subRegion === "Western Asia") return "EMEA";
    return "APAC";
  }
  if (region === "Oceania") return "APAC";
  return null;
}

function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

export async function buildExposureData(): Promise<ApiPayload> {
  // 1) ISO list
  const isoRes = await fetch(ISO_CSV_URL, { cache: "force-cache" });
  if (!isoRes.ok) throw new Error("iso fetch failed");
  const isoCsv = await isoRes.text();
  const lines = isoCsv.trim().split("\n");
  const header = splitCsvLine(lines[0]);
  const idx = (name: string) => header.indexOf(name);

  const iso3ToAlpha2: Record<string, string> = {};
  const countries: Array<{
    iso3: string;
    alpha2: string | null;
    name: string;
    region: string | null;
    subRegion: string | null;
    seg: "AMERICAS" | "EMEA" | "APAC" | null;
  }> = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const iso3 = cols[idx("alpha-3")]?.trim().toUpperCase();
    const alpha2Idx = idx("alpha-2");
    const alpha2 = alpha2Idx >= 0 ? (cols[alpha2Idx]?.trim().toUpperCase() || null) : null;
    const name = cols[idx("name")]?.trim();
    const region = cols[idx("region")]?.trim() ?? null;
    const subRegion = cols[idx("sub-region")]?.trim() ?? null;
    if (!iso3 || !name) continue;
    const seg = segmentOfCountry(region, subRegion);
    countries.push({ iso3, alpha2, name, region, subRegion, seg });
    if (alpha2) iso3ToAlpha2[iso3.toUpperCase()] = alpha2.toUpperCase();
  }
  const countryMap = new Map(countries.map((c) => [c.iso3, c]));

  // 2) World Bank indicators (latest 2018–2024)
  const [gdpJson, mcapJson, creditJson, gdpPcJson, netJson, popJson] = await Promise.all([
    fetch(WB(IND_GDP), { cache: "force-cache" }).then((r) => r.json()),
    fetch(WB(IND_MCAP_PCT), { cache: "force-cache" }).then((r) => r.json()),
    fetch(WB(IND_CREDIT_PCT), { cache: "force-cache" }).then((r) => r.json()),
    fetch(WB(IND_GDP_PC), { cache: "force-cache" }).then((r) => r.json()),
    fetch(WB(IND_NET), { cache: "force-cache" }).then((r) => r.json()),
    fetch("https://api.worldbank.org/v2/country/all/indicator/SP.POP.TOTL?format=json&per_page=20000&date=2023", {
      cache: "force-cache",
    }).then((r) => r.json()),
  ]);

  const gdp = latestByIso3(gdpJson);
  const mcapPct = latestByIso3(mcapJson);
  const creditPct = latestByIso3(creditJson);
  const gdpPc = latestByIso3(gdpPcJson);
  const netPct = latestByIso3(netJson);
  const pop = latestByIso3(popJson);

  // 3) Medians per segment for missing data
  const segVals: Record<string, { mcap: number[]; credit: number[]; gdppc: number[]; net: number[] }> = {
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
    if (Number.isFinite(mp)) segVals[c.seg].mcap.push(mp as number);
    if (Number.isFinite(cp)) segVals[c.seg].credit.push(cp as number);
    if (Number.isFinite(gp)) segVals[c.seg].gdppc.push(gp as number);
    if (Number.isFinite(np)) segVals[c.seg].net.push(np as number);
  }

  const segMedian: Record<string, { mcap: number; credit: number; gdppc: number; net: number }> = {};
  for (const seg of Object.keys(segVals)) {
    segMedian[seg] = {
      mcap: median(segVals[seg].mcap) ?? 30,
      credit: median(segVals[seg].credit) ?? 50,
      gdppc: median(segVals[seg].gdppc) ?? 8000,
      net: median(segVals[seg].net) ?? 55,
    };
  }

  // 4) Score + allocate within each segment
  const scores: Record<"AMERICAS" | "EMEA" | "APAC", Map<string, number>> = {
    AMERICAS: new Map(),
    EMEA: new Map(),
    APAC: new Map(),
  };

  for (const c of countries) {
    if (!c.seg) continue;

    const g = gdp.get(c.iso3)?.value;
    if (!Number.isFinite(g) || (g as number) <= 0) {
      scores[c.seg].set(c.iso3, 1e-9);
      continue;
    }

    const mp = mcapPct.get(c.iso3)?.value ?? segMedian[c.seg].mcap;
    const cp = creditPct.get(c.iso3)?.value ?? segMedian[c.seg].credit;
    const gp = gdpPc.get(c.iso3)?.value ?? segMedian[c.seg].gdppc;
    const np = netPct.get(c.iso3)?.value ?? segMedian[c.seg].net;

    const mcapFactor = Math.pow(1 + clamp(mp as number, 0, 400) / 100, 0.9);
    const creditFactor = Math.pow(1 + clamp(cp as number, 0, 300) / 100, 0.6);
    const wealthFactor = Math.pow(1 + clamp(gp as number, 0, 80_000) / 50_000, 0.35);
    const internetFactor = Math.pow(0.2 + clamp(np as number, 0, 100) / 100, 0.25);

    let s = Math.pow(g as number, 0.7) * mcapFactor * creditFactor * wealthFactor * internetFactor;

    s *= HUB_MULT.get(c.iso3) ?? 1.0;
    if (OFFICE_COUNTRIES.has(c.iso3)) s *= OFFICE_MULT;
    if (NEAR_ZERO.has(c.iso3)) s *= NEAR_ZERO_MULT;

    scores[c.seg].set(c.iso3, s);
  }

  const allocations: Array<{
    iso3: string;
    country: string;
    segment: string;
    revenueMillions: number;
    office: boolean;
    hub: boolean;
    nearZero: boolean;
  }> = [];

  for (const seg of Object.keys(scores) as Array<"AMERICAS" | "EMEA" | "APAC">) {
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
        revenueMillions: total * share,
        office: OFFICE_COUNTRIES.has(c.iso3),
        hub: HUB_MULT.has(c.iso3),
        nearZero: NEAR_ZERO.has(c.iso3),
      });
    }
  }

  const totalRevenueMillions = allocations.reduce((a, b) => a + b.revenueMillions, 0);
  const iso3ToIntensity: Record<string, number> = {};
  let maxShare = 0;
  for (const row of allocations) {
    const isoKey = row.iso3.toUpperCase();
    const share = totalRevenueMillions > 0 ? row.revenueMillions / totalRevenueMillions : 0;
    iso3ToIntensity[isoKey] = share;
    if (share > maxShare) maxShare = share;
  }

  const countryDetailsMap: Record<string, {
    iso3: string;
    name: string;
    region: string;
    revenueMillions: number;
    share: number;
    population: number | null;
    flagUrl: string | null;
    segment: string;
    office: boolean;
    hub: boolean;
    nearZero: boolean;
  }> = {};

  for (const row of allocations) {
    const population = pop.get(row.iso3)?.value ?? null;
    const meta = countryMap.get(row.iso3);
    const alpha2 =
      meta?.alpha2 ?? iso3ToAlpha2[row.iso3] ?? (row.iso3.length >= 2 ? row.iso3.slice(0, 2) : null);
    const flagUrl = alpha2 ? `https://flagcdn.com/${alpha2.toLowerCase()}.svg` : null;
    countryDetailsMap[row.iso3] = {
      iso3: row.iso3,
      name: row.country,
      region: meta?.region ?? "",
      revenueMillions: row.revenueMillions,
      share: totalRevenueMillions > 0 ? row.revenueMillions / totalRevenueMillions : 0,
      population,
      flagUrl,
      segment: row.segment,
      office: row.office,
      hub: row.hub,
      nearZero: row.nearZero,
    };
  }

  // ensure every ISO in our country list has an entry (even if zero) for hover usability
  for (const c of countries) {
    if (countryDetailsMap[c.iso3]) continue;
    const alpha2 = c.alpha2 ?? iso3ToAlpha2[c.iso3] ?? (c.iso3.length >= 2 ? c.iso3.slice(0, 2) : null);
    const flagUrl = alpha2 ? `https://flagcdn.com/${alpha2.toLowerCase()}.svg` : null;
    const population = pop.get(c.iso3)?.value ?? null;
    iso3ToIntensity[c.iso3] = iso3ToIntensity[c.iso3] ?? 0;
    countryDetailsMap[c.iso3] = {
      iso3: c.iso3,
      name: c.name,
      region: c.region ?? "",
      revenueMillions: 0,
      share: 0,
      population,
      flagUrl,
      segment: c.seg ?? "",
      office: OFFICE_COUNTRIES.has(c.iso3),
      hub: HUB_MULT.has(c.iso3),
      nearZero: NEAR_ZERO.has(c.iso3),
    };
  }

  return {
    iso3ToIntensity,
    countryDetails: Object.values(countryDetailsMap),
    geo: await fetch(COUNTRIES_GEOJSON, { cache: "force-cache" }).then((r) => r.json()),
    totalRevenueMillions,
    maxShare,
    meta: {
      note:
        "FactSet FY2025 estimated per-country revenue. Anchors: reported segment totals (Americas, EMEA, APAC). Allocation: GDP, market depth, credit, GDP per capita, internet penetration; explicit multipliers for hubs and disclosed office countries; comprehensive-sanctions set near-zero. Outputs USD millions and flags for office/hub/near-zero.",
    },
  };
}
