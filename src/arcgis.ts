import type { Dataset } from "./datasets.js";

export interface FieldInfo {
  name: string;
  type: string;
  alias?: string;
  examples: string[];
}

// Schemas are read once per process from the live layer, then reused.
const schemaCache = new Map<string, FieldInfo[]>();

export function clearSchemaCache(): void {
  schemaCache.clear();
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ArcGIS returned HTTP ${res.status} for ${url.split("?")[0]}`);
  const body = await res.json();
  if (body?.error) throw new Error(`ArcGIS error: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body;
}

export async function getSchema(ds: Dataset): Promise<FieldInfo[]> {
  const cached = schemaCache.get(ds.id);
  if (cached) return cached;

  const layer = await getJson(`${ds.url}?f=json`);
  const sample = await getJson(
    `${ds.url}/query?${new URLSearchParams({
      where: "1=1",
      outFields: "*",
      returnGeometry: "false",
      resultRecordCount: "25",
      f: "json",
    })}`,
  );

  // Collect a few real values per field. Seeing TRAUMA = 'LEVEL II' once is
  // worth more to the model than any description of the field.
  const rows: Record<string, unknown>[] = (sample.features ?? []).map((f: any) => f.attributes ?? {});
  const fields: FieldInfo[] = (layer.fields ?? []).map((f: any) => {
    const seen = new Set<string>();
    for (const r of rows) {
      const v = r[f.name];
      if (v !== null && v !== undefined && v !== "" && seen.size < 4) seen.add(String(v));
    }
    return {
      name: f.name,
      type: String(f.type ?? "").replace("esriFieldType", ""),
      alias: f.alias && f.alias !== f.name ? f.alias : undefined,
      examples: [...seen],
    };
  });

  schemaCache.set(ds.id, fields);
  return fields;
}

export interface NearbyResult {
  distance_miles: number;
  attributes: Record<string, unknown>;
}

export interface NearbyQuery {
  where: string;
  outFields: string[];
  latitude: number;
  longitude: number;
  radiusMiles: number;
  limit: number;
}

// Feature services return matches in storage order, not by distance, so we
// pull up to 200 inside the radius, sort by straight-line distance here, and
// keep the closest ones.
const FETCH_CAP = 200;

export async function findNearby(ds: Dataset, q: NearbyQuery) {
  const params = {
    where: q.where,
    outFields: q.outFields.join(","),
    geometry: `${q.longitude},${q.latitude}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    distance: String(q.radiusMiles),
    units: "esriSRUnit_StatuteMile",
    returnGeometry: "true",
    resultRecordCount: String(FETCH_CAP),
    f: "json",
  };
  const body = await getJson(`${ds.url}/query?${new URLSearchParams(params)}`);

  const results: NearbyResult[] = (body.features ?? [])
    .map((f: any) => ({
      distance_miles: round1(milesBetween(q.latitude, q.longitude, f.geometry?.y, f.geometry?.x)),
      attributes: f.attributes ?? {},
    }))
    .filter((r: NearbyResult) => !Number.isNaN(r.distance_miles))
    .sort((a: NearbyResult, b: NearbyResult) => a.distance_miles - b.distance_miles);

  return {
    query_sent: { endpoint: `${ds.url}/query`, ...params },
    matches_found: results.length,
    more_beyond_cap: Boolean(body.exceededTransferLimit),
    results: results.slice(0, q.limit),
  };
}

export function milesBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  if ([lat1, lon1, lat2, lon2].some((v) => typeof v !== "number" || Number.isNaN(v))) return Number.NaN;
  const r = 3958.8;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  const clampedA = Math.min(1, Math.max(0, a));
  return 2 * r * Math.asin(Math.sqrt(clampedA));
}

const round1 = (n: number) => Math.round(n * 10) / 10;
