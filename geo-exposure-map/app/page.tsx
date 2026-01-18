"use client";
/* eslint-disable @next/next/no-img-element */

import React, { useEffect, useMemo, useState } from "react";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import type { Feature, Geometry } from "geojson";
import Image from "next/image";
import { buildExposureData, type ApiPayload } from "../lib/exposure-core";

type GeoFeature = Feature<Geometry, Record<string, unknown>>;

type CountryDetail = {
  iso3: string;
  name: string;
  region: string;
  revenueMillions: number;
  share: number;
  population: number | null;
  flagUrl: string | null;
   gdpCurrentUsd: number | null;
   gdpYear: number | null;
};

const NAME_OVERRIDES: Record<string, string> = {
  FRA: "France",
  NOR: "Norway",
};

const NAME_TO_ISO_OVERRIDES: Record<string, string> = {
  France: "FRA",
  FRANCE: "FRA",
  Norvège: "NOR",
  Norway: "NOR",
  NORWAY: "NOR",
  "UNITED KINGDOM": "GBR",
  "GREAT BRITAIN": "GBR",
  "U.K.": "GBR",
  UK: "GBR",
  BRITAIN: "GBR",
  "UNITED STATES": "USA",
  "UNITED STATES OF AMERICA": "USA",
  USA: "USA",
  "U.S.": "USA",
  US: "USA",
  "UNITED ARAB EMIRATES": "ARE",
  UAE: "ARE",
  "SAUDI ARABIA": "SAU",
  KSA: "SAU",
};

const BG = "#05090d";
const PANEL = "#0b1118";
const BORDER = "#16202b";
const BASE = "/FactSet_Revenue_by_Country";
const HEADSHOT_SRC = `${BASE}/headshot.jpg`;
const LOGO_SRC = `${BASE}/factset_logo.png`;

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function colorFor(v: number, maxShare: number) {
  // enhance sensitivity: normalize by max share and apply gamma
  const norm = maxShare > 0 ? v / maxShare : 0;
  const t = Math.pow(clamp01(norm), 0.35); // gamma < 1 to boost small values
  // brand-forward ramp: deep navy -> FactSet blue -> aqua
  const start = [10, 25, 40];
  const mid = [0, 174, 239]; // FactSet blue
  const end = [120, 230, 255];
  const mix = (a: number[], b: number[], f: number) => a.map((v, i) => Math.round(v + (b[i] - v) * f));
  const midMix = mix(start, mid, t * 0.7);
  const finalMix = mix(midMix, end, Math.pow(t, 1.2));
  return `rgb(${finalMix[0]},${finalMix[1]},${finalMix[2]})`;
}

function iso3FromFeature(f: GeoFeature): string | undefined {
  const props = f.properties || {};
  const nmRaw =
    (props["name"] as string | undefined) ||
    (props["NAME"] as string | undefined) ||
    (props["NAME_LONG"] as string | undefined);
  if (nmRaw) {
    const nm = nmRaw.trim();
    if (NAME_TO_ISO_OVERRIDES[nm]) return NAME_TO_ISO_OVERRIDES[nm];
    if (NAME_TO_ISO_OVERRIDES[nm.toUpperCase()]) return NAME_TO_ISO_OVERRIDES[nm.toUpperCase()];
  }
  return (
    (props["id"] as string | undefined)?.toUpperCase() ||
    (props["ISO3166-1-Alpha-3"] as string | undefined) ||
    (props["ISO_A3"] as string | undefined) ||
    (props["iso_a3"] as string | undefined) ||
    (props["adm0_a3"] as string | undefined) ||
    undefined
  );
}

const fmtRev = (millions: number) => {
  if (millions >= 1000) {
    const b = millions / 1000;
    return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: b >= 10 ? 1 : 2 }).format(b)}B`;
  }
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: millions >= 10 ? 1 : 2 }).format(millions)}M`;
};
const fmtPopulation = (v: number | null) =>
  v == null ? "n/a" : new Intl.NumberFormat("en-US", { notation: "compact" }).format(v);
const fmtCurrency = (v: number | null) =>
  v == null
    ? "n/a"
    : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v);

export default function Page() {
  const [countries, setCountries] = useState<GeoFeature[]>([]);
  const [intensity, setIntensity] = useState<Record<string, number>>({});
  const [details, setDetails] = useState<Record<string, CountryDetail>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [hoverIso3, setHoverIso3] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metaNote, setMetaNote] = useState<string>("");
  const [maxShare, setMaxShare] = useState<number>(1);
  const [showDetails, setShowDetails] = useState<boolean>(false);
  const [showFullMethod, setShowFullMethod] = useState<boolean>(false);
  const [search, setSearch] = useState<string>("");
  const [searchIso, setSearchIso] = useState<string | null>(null);

  const applySearch = (val: string) => {
    setSearch(val);
    const term = val.trim().toUpperCase();
    if (!term) {
      setSearchIso(null);
      setHoverIso3(null);
      return;
    }
    // Direct alias mapping (e.g., UK -> GBR)
    if (NAME_TO_ISO_OVERRIDES[term]) {
      const iso = NAME_TO_ISO_OVERRIDES[term];
      if (details[iso]) {
        setSearchIso(iso);
        setHoverIso3(iso);
        return;
      }
    }
    if (details[term]) {
      setSearchIso(term);
      setHoverIso3(term);
      return;
    }
    // Prefer startsWith matches before substring to avoid "UK" -> "Ukraine"
    const startsWith = Object.entries(details).find(([, v]) => v.name.toUpperCase().startsWith(term));
    if (startsWith) {
      setSearchIso(startsWith[0]);
      setHoverIso3(startsWith[0]);
      return;
    }
    const match = Object.entries(details).find(([, v]) => v.name.toUpperCase().includes(term));
    if (match) {
      setSearchIso(match[0]);
      setHoverIso3(match[0]);
    }
  };

  useEffect(() => {
    async function load() {
      setError(null);
      try {
        const j = await buildExposureData();
        const normIntensity: Record<string, number> = {};
        for (const [k, v] of Object.entries(j.iso3ToIntensity || {})) {
          normIntensity[k.toUpperCase()] = v;
        }
        setIntensity(normIntensity);
        setMaxShare(j.maxShare || 1);
        const map: Record<string, CountryDetail> = {};
        for (const d of j.countryDetails || []) {
          const iso = d.iso3.toUpperCase();
          map[iso] = { ...d, iso3: iso, name: NAME_OVERRIDES[iso] ?? d.name };
        }
        setDetails(map);
        const feats = (j.geo?.features as GeoFeature[] | undefined) || [];
        setCountries(feats);
        const nameMap: Record<string, string> = {};
        for (const f of feats) {
          const iso3 = iso3FromFeature(f)?.toUpperCase();
          const nm = (f.properties?.["name"] as string | undefined) || (f.properties?.["NAME"] as string | undefined);
          if (iso3) nameMap[iso3] = NAME_OVERRIDES[iso3] ?? nm ?? iso3;
        }
        setNames(nameMap);
        setMetaNote(j.meta?.note || "");
      } catch (e) {
        console.error(e);
        setError("Failed to load data");
      }
    }
    load();
  }, []);

  const projection = useMemo(() => geoNaturalEarth1().scale(150).translate([425, 235]), []);
  const path = useMemo(() => geoPath(projection), [projection]);

  // Precompute paths once per geo load for smoother hover/search updates
  const countryShapes = useMemo(
    () =>
      countries
        .map((f) => {
          const iso3 = iso3FromFeature(f)?.toUpperCase();
          if (!iso3) return null;
          const d = path(f) ?? "";
          return { iso3, d, feature: f };
        })
        .filter(Boolean) as Array<{ iso3: string; d: string; feature: GeoFeature }>,
    [countries, path],
  );

  const tinyShapes = useMemo(() => {
    const list: Array<{ iso3: string; cx: number; cy: number }> = [];
    for (const f of countries) {
      const iso3 = iso3FromFeature(f)?.toUpperCase();
      if (!iso3 || !f.geometry) continue;
      const bbox = (f as { bbox?: number[] }).bbox;
      if (bbox && bbox.length === 4) {
        const width = Math.abs(bbox[2] - bbox[0]);
        const height = Math.abs(bbox[3] - bbox[1]);
        if (width < 5 && height < 5) {
          const centroid = f.geometry ? (geoPath(projection).centroid(f as GeoFeature) as [number, number]) : null;
          if (centroid) list.push({ iso3, cx: centroid[0], cy: centroid[1] });
        }
      }
    }
    return list;
  }, [countries, projection]);

  const hoverDetail = hoverIso3
    ? details[hoverIso3] ?? {
        iso3: hoverIso3,
        name: NAME_OVERRIDES[hoverIso3] ?? names[hoverIso3] ?? hoverIso3,
        region: "",
        revenueMillions: 0,
        share: intensity[hoverIso3] ?? 0,
        population: null,
        flagUrl: hoverIso3.length >= 2 ? `https://flagcdn.com/${hoverIso3.slice(0, 2).toLowerCase()}.svg` : null,
        segment: "",
        office: false,
        hub: false,
        nearZero: false,
      }
    : null;

  return (
    <main className="min-h-screen" style={{ background: BG, color: "#e6f1fb" }}>
      <div className="mx-auto w-full max-w-6xl px-4 py-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Image src={LOGO_SRC} alt="FactSet" width={120} height={28} priority />
            <div className="text-lg font-semibold text-white">Revenue by Country</div>
            <div className="relative group inline-flex items-center text-xs text-sky-200/80">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-sky-900/60 text-[10px] font-semibold text-sky-100">
                i
              </span>
              <div className="pointer-events-none absolute left-0 top-6 z-10 hidden w-72 rounded-md bg-[#0f1722] px-3 py-2 text-[11px] text-sky-100 ring-1 ring-[#1f2b38] group-hover:block">
                FY2025 GDP-based allocation of reported segment buckets (Americas, EMEA, APAC) with explicit multipliers for hubs, offices, and sanctions.
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-sky-100/80">
            <div className="flex flex-col items-end leading-tight text-right">
              <div className="font-semibold text-sky-50">Project by Marty Hendricks</div>
              <div className="text-sky-100/80">Buy-Side Analytics Intern candidate</div>
              <div className="flex gap-3">
                <a className="text-sky-300 hover:text-sky-100 underline underline-offset-4" href="https://www.linkedin.com/in/marty-hendricks/" target="_blank" rel="noreferrer">
                  LinkedIn
                </a>
                <a className="text-sky-300 hover:text-sky-100 underline underline-offset-4" href="https://martyhendricks.notion.site/" target="_blank" rel="noreferrer">
                  Portfolio
                </a>
                <a className="text-sky-300 hover:text-sky-100 underline underline-offset-4" href="https://drive.google.com/file/d/1pGtQoBwVnPPCO1DFlzkVWjYvUAAz_Omr/view?usp=sharing" target="_blank" rel="noreferrer">
                  Resume
                </a>
              </div>
            </div>
            <div className="h-12 w-12 overflow-hidden rounded-full ring-1 ring-[#1f2b38]">
              <Image src={HEADSHOT_SRC} alt="Marty Hendricks headshot" width={48} height={48} className="h-full w-full object-cover" />
            </div>
          </div>
        </div>

        {error ? <div className="mt-3 text-sm text-red-400">{error}</div> : null}

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-sky-100/80">Hover the map or type a country</div>
          <div className="flex gap-2">
            <input
              className="w-52 rounded-md bg-[#0f1722] px-3 py-2 text-sm text-sky-50 outline-none ring-1 ring-[#1f2b38] focus:ring-sky-600"
              placeholder="Search country"
              value={search}
              onChange={(e) => applySearch(e.target.value)}
            />
          </div>
        </div>

        <div
          className="mt-6 w-full max-w-3xl mx-auto rounded-xl p-4"
          style={{ background: PANEL, border: `1px solid ${BORDER}` }}
        >
          <div className="relative max-w-3xl mx-auto">
            <svg viewBox="0 0 820 450" className="w-full h-auto">
              <rect x="0" y="0" width="820" height="450" fill="#050a10" />
              <g>
                {countryShapes.map(({ iso3, d }) => {
                  const v = intensity[iso3] ?? 0;
                  const fill = colorFor(v, maxShare);
                  const isActive = hoverIso3 === iso3;
                  return (
                    <path
                      key={iso3}
                      d={d}
                      fill={fill}
                      stroke={isActive ? "#8ae1ff" : "#0f172a"}
                      strokeWidth={isActive ? 1.4 : 0.6}
                      opacity={isActive ? 1 : 0.9}
                      style={{ transition: "fill 200ms ease, stroke 120ms ease, opacity 120ms ease, stroke-width 120ms ease" }}
                      onMouseEnter={() => iso3 && iso3 !== hoverIso3 && setHoverIso3(iso3)}
                      onMouseLeave={() => setHoverIso3(searchIso)}
                    />
                  );
                })}
              </g>
              {/* Tiny overlays for small countries */}
              <g>
                {tinyShapes.map(({ iso3, cx, cy }) => {
                  const v = intensity[iso3] ?? 0;
                  const fill = colorFor(v, maxShare);
                  const isActive = hoverIso3 === iso3;
                  return (
                    <circle
                      key={`tiny-${iso3}`}
                      cx={cx}
                      cy={cy}
                      r={isActive ? 7 : 6}
                      fill={fill}
                      stroke={isActive ? "#8ae1ff" : "#0f172a"}
                      strokeWidth={isActive ? 0.8 : 0.4}
                      opacity={isActive ? 1 : 0.85}
                      style={{ cursor: "pointer", transition: "fill 120ms ease, opacity 120ms ease, stroke-width 120ms ease, r 120ms ease" }}
                      onMouseEnter={() => iso3 && iso3 !== hoverIso3 && setHoverIso3(iso3)}
                      onMouseLeave={() => setHoverIso3(searchIso)}
                    />
                  );
                })}
              </g>
            </svg>
          </div>

          <div className="mt-6 flex justify-center">
            <div
              className="w-full max-w-3xl rounded-lg px-4 py-5 text-xs"
              style={{
                background: PANEL,
                border: `1px solid ${BORDER}`,
                minHeight: 320,
                maxHeight: 320,
                overflowY: "auto",
              }}
            >
              <div className="flex items-center gap-2 text-sky-100">
                <span>Revenue share</span>
                <div className="relative group inline-flex items-center">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-sky-900/60 text-[10px] font-semibold text-sky-100">
                    i
                  </span>
                  <div className="pointer-events-none absolute left-0 top-6 z-10 hidden w-64 rounded-md bg-[#0f1722] px-3 py-2 text-[11px] text-sky-100 ring-1 ring-[#1f2b38] group-hover:block">
                    Higher color = higher share of total estimated revenue. Units displayed below as M or B USD.
                  </div>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <span className="text-slate-400">low</span>
                <div
                  className="h-2 flex-1 rounded-full"
                  style={{
                    background: "linear-gradient(90deg, rgb(10,25,40), rgb(0,174,239), rgb(120,230,255))",
                  }}
                />
                <span className="text-slate-400">high</span>
              </div>
              {hoverDetail ? (
                <div className="mt-4 space-y-1 text-sky-50 text-sm">
                  <div className="flex items-center gap-3">
                    {hoverDetail.flagUrl ? (
                      <img
                        src={hoverDetail.flagUrl}
                        alt=""
                        className="h-5 w-8 rounded-sm border border-zinc-800 bg-zinc-900 object-cover"
                      />
                    ) : null}
                    <div className="font-semibold leading-tight">{hoverDetail.name}</div>
                  </div>
                  <div className="text-sky-100/80">
                    {hoverDetail.iso3} · {hoverDetail.region || "Region n/a"}
                  </div>
                  <div className="text-sky-50">Revenue: ${fmtRev(hoverDetail.revenueMillions)}</div>
                  <div className="text-sky-50">
                    Share: {Math.round(hoverDetail.share * 10000) / 100}%
                  </div>
                  <div className="text-sky-200/70">
                    Population: {fmtPopulation(hoverDetail.population)}
                  </div>
                  <div className="text-sky-200/70">
                    GDP: ${fmtCurrency(hoverDetail.gdpCurrentUsd)}
                  </div>
                </div>
              ) : (
                <div className="mt-4 text-slate-400">hover a country</div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4 text-xs text-slate-400">
          <button
            className="rounded-md px-3 py-2 text-sky-50"
            style={{ background: PANEL, border: `1px solid ${BORDER}` }}
            onClick={() => setShowDetails((s) => !s)}
          >
            {showDetails ? "Hide method" : "Show method"}
          </button>
          {showDetails ? (
            <div className="mt-2 space-y-2 leading-relaxed text-sky-200/80">
              <div>
                {metaNote ||
                  "Estimated per-country revenue derived from FactSet FY2025 reported segment totals. Allocation blends GDP, market depth, credit, GDP per capita, internet use, plus explicit multipliers for hubs, disclosed offices, and comprehensive-sanctions near-zero. Units in USD millions."}
              </div>
              <div>
                <button
                  className="rounded-md px-2 py-1 text-[11px] text-sky-50"
                  style={{ background: PANEL, border: `1px solid ${BORDER}` }}
                  onClick={() => setShowFullMethod((s) => !s)}
                >
                  {showFullMethod ? "Hide full method" : "Full method"}
                </button>
                {showFullMethod ? (
                  <div className="mt-2 space-y-2 text-[11px] text-sky-100/80">
                    <div>
                      1) Anchors: FactSet FY2025 segment totals (Americas, EMEA, APAC) in USD millions.
                    </div>
                    <div>
                      2) ISO universe: ISO-3166 countries with UN regions/sub-regions. We keep every country, even if revenue is near-zero.
                    </div>
                    <div>
                      3) Indicators (latest 2018–2024, World Bank): GDP, market cap % GDP, private credit % GDP, GDP per capita, internet users % population. Segment medians fill missing values.
                    </div>
                    <div>
                      4) Base score per country in segment:&nbsp;
                      <span className="font-semibold">
                        GDP
                        <sup>0.70</sup> · (1 + mcap%)
                        <sup>0.90</sup> · (1 + credit%)
                        <sup>0.60</sup> · (1 + min(gdppc, 80k)/50k)
                        <sup>0.35</sup> · (0.2 + internet%)
                        <sup>0.25</sup>
                      </span>
                    </div>
                    <div>
                      5) Explicit multipliers: hubs (e.g., USA, GBR, CHE, LUX, SGP, HKG…), offices per FY2025 10-K, and comprehensive-sanctions near-zero (CUB, IRN, PRK, RUS).
                    </div>
                    <div>
                      6) Normalize scores within each segment to the segment total; sum across segments; report per-country revenue (USD millions) and share.
                    </div>
                    <div>
                      7) Flags and hover data: ISO3/ISO2-driven, with overrides for name/ISO mismatches.
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
