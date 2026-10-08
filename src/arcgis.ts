import type { Dataset } from "./datasets.js";

export interface FieldInfo {
  name: string;
  type: string;
  alias?: string;
  examples: string[];
  // True when examples is the complete list of values in the layer.
  all_values?: boolean;
}

// Schemas are read once per process from the live layer, then reused.
const schemaCache = new Map<string, FieldInfo[]>();

export function clearSchemaCache(): void {
  schemaCache.clear();
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`ArcGIS returned HTTP ${res.status} for ${url.split("?")[0]}`);
  const body = await res.json();
  if (body?.error) throw new Error(`ArcGIS error: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body;
}

const CATEGORICAL_FIELDS = new Set(["TRAUMA", "HELIPAD", "STATUS", "LEVEL_", "TYPE", "OWNER"]);
const MAX_DISTINCT = 100;

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

  // Coded fields like TRAUMA are messy in practice (about 55 spellings of
  // trauma levels: 'LEVEL I', 'LEVEL  I', 'I', 'LEVEL I TRAUMA', ...). A sample
  // misses most of them, so fetch the full list for these fields. The model
  // can only write a filter that catches every Level I center if it sees them all.
  await Promise.all(
    fields
      .filter((f) => CATEGORICAL_FIELDS.has(f.name.toUpperCase()))
      .map(async (f) => {
        try {
          const distinct = await getJson(
            `${ds.url}/query?${new URLSearchParams({
              where: "1=1",
              outFields: f.name,
              returnDistinctValues: "true",
              returnGeometry: "false",
              f: "json",
            })}`,
          );
          const vals: string[] = (distinct.features ?? [])
            .map((feat: any) => feat.attributes?.[f.name])
            .filter((v: unknown) => v !== null && v !== undefined && v !== "")
            .map(String);
          if (vals.length > 0) {
            f.examples = [...new Set(vals)].sort().slice(0, MAX_DISTINCT);
            f.all_values = vals.length <= MAX_DISTINCT;
          }
        } catch {
          // keep the sampled values
        }
      }),
  );

  schemaCache.set(ds.id, fields);
  return fields;
}

export interface NearbyResult {
  distance_miles: number;
  latitude: number;
  longitude: number;
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

// Feature services return at most FETCH_CAP matches, in storage order rather
// than by distance. If everything inside the circle fits, sorting here gives
// the true closest places. If it doesn't fit (a big radius in a dense city),
// the 200 we got are an arbitrary subset, so we search for a smaller radius
// that both fits under the cap and still holds at least `limit` places.
const FETCH_CAP = 200;
const MAX_SHRINK_STEPS = 6;

export async function findNearby(ds: Dataset, q: NearbyQuery) {
  const makeParams = (radius: number) => ({
    where: q.where,
    outFields: q.outFields.join(","),
    geometry: `${q.longitude},${q.latitude}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    distance: String(radius),
    units: "esriSRUnit_StatuteMile",
    returnGeometry: "true",
    resultRecordCount: String(FETCH_CAP),
    f: "json",
  });
  const run = async (radius: number) => {
    const params = makeParams(radius);
    const body = await getJson(`${ds.url}/query?${new URLSearchParams(params)}`);
    return { radius, params, features: (body.features ?? []) as any[], exceeded: Boolean(body.exceededTransferLimit) };
  };

  let chosen = await run(q.radiusMiles);

  if (chosen.exceeded) {
    // Binary search between a radius known to hold too few (lo) and one known
    // to overflow the cap (hi).
    let lo = 0;
    let hi = q.radiusMiles;
    let fallback = chosen;
    let found = false;
    for (let i = 0; i < MAX_SHRINK_STEPS; i++) {
      const mid = round1((lo + hi) / 2);
      if (mid <= lo || mid >= hi) break;
      const r = await run(mid);
      if (r.exceeded) {
        hi = mid;
        fallback = r; // smaller overflowing circle: still a subset, but a tighter one
      } else if (r.features.length >= q.limit) {
        chosen = r;
        found = true;
        break;
      } else {
        lo = mid;
      }
    }
    if (!found) chosen = fallback;
  }

  // Sort on the exact distance and round only for display, so two places
  // that both show as 0.1 mi still come back in the right order.
  const results: NearbyResult[] = chosen.features
    .map((f: any) => ({ miles: milesBetween(q.latitude, q.longitude, f.geometry?.y, f.geometry?.x), f }))
    .filter((r: { miles: number }) => !Number.isNaN(r.miles))
    .sort((a: { miles: number }, b: { miles: number }) => a.miles - b.miles)
    .map(({ miles, f }: { miles: number; f: any }) => ({
      distance_miles: round1(miles),
      latitude: f.geometry.y,
      longitude: f.geometry.x,
      attributes: f.attributes ?? {},
    }));

  return {
    query_sent: { endpoint: `${ds.url}/query`, ...chosen.params },
    matches_found: results.length,
    more_beyond_cap: chosen.exceeded,
    // False only when even the smallest circle tried had more than FETCH_CAP
    // places, so the list is the closest of a subset, not guaranteed closest.
    closest_guaranteed: !chosen.exceeded,
    effective_radius_miles: chosen.radius,
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
