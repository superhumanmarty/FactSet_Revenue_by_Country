import { NextResponse } from "next/server";
import { buildExposureData } from "../../../lib/exposure-core";

// Static export requires route handlers to be static; precompute once per build.
export const dynamic = "force-static";
export const revalidate = 86_400; // revalidate daily

export async function GET() {
  const data = await buildExposureData();
  return NextResponse.json(data);
}
