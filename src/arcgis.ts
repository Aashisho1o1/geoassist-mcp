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
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`ArcGIS returned HTTP ${res.status} for ${url.split("?")[0]}`);
  const body = await res.json();
  if (body?.error) throw new Error(`ArcGIS error: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body;
}

const CATEGORICAL_FIELDS = new Set(["TRAUMA", "HELIPAD", "STATUS", "LEVEL_", "TYPE", "OWNER"]);

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

  // For low-cardinality/categorical fields, fetch distinct values so the model
  // sees the real dictionary of values rather than missing values like 'LEVEL I'.
  for (const f of fields) {
    if (CATEGORICAL_FIELDS.has(f.name.toUpperCase())) {
      try {
        const distinct = await getJson(
          `${ds.url}/query?${new URLSearchParams({
            where: "1=1",
            outFields: f.name,
            returnDistinctValues: "true",
            returnGeometry: "false",
            resultRecordCount: "25",
            f: "json",
          })}`,
        );
        const vals = (distinct.features ?? [])
          .map((feat: any) => feat.attributes?.[f.name])
          .filter((v: unknown) => v !== null && v !== undefined && v !== "");
        if (vals.length > 0) {
          f.examples = vals.slice(0, 20).map(String);
        }
      } catch {
        // fall back to sampled values
      }
    }
  }

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

  let currentRadius = q.radiusMiles;
  let params = makeParams(currentRadius);
  let body = await getJson(`${ds.url}/query?${new URLSearchParams(params)}`);
  let features = body.features ?? [];
  let exceeded = Boolean(body.exceededTransferLimit);

  // In dense metro areas where exceededTransferLimit is true, ArcGIS returns matches
  // in arbitrary storage order. To guarantee the nearest facilities aren't missed,
  // adaptively shrink the radius until all facilities inside the circle fit under FETCH_CAP.
  let iterations = 0;
  while (exceeded && currentRadius > 1.0 && iterations < 4) {
    iterations++;
    const nextRadius = round1(currentRadius / 2);
    const nextParams = makeParams(nextRadius);
    const nextBody = await getJson(`${ds.url}/query?${new URLSearchParams(nextParams)}`);
    const nextFeatures = nextBody.features ?? [];
    const nextExceeded = Boolean(nextBody.exceededTransferLimit);

    if (nextFeatures.length >= q.limit || !nextExceeded) {
      currentRadius = nextRadius;
      params = nextParams;
      body = nextBody;
      features = nextFeatures;
      exceeded = nextExceeded;
      if (!exceeded) break;
    } else {
      break;
    }
  }

  const results: NearbyResult[] = features
    .map((f: any) => ({
      distance_miles: round1(milesBetween(q.latitude, q.longitude, f.geometry?.y, f.geometry?.x)),
      attributes: f.attributes ?? {},
    }))
    .filter((r: NearbyResult) => !Number.isNaN(r.distance_miles))
    .sort((a: NearbyResult, b: NearbyResult) => a.distance_miles - b.distance_miles);

  return {
    query_sent: { endpoint: `${ds.url}/query`, ...params },
    matches_found: results.length,
    more_beyond_cap: exceeded,
    effective_radius_miles: currentRadius,
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
