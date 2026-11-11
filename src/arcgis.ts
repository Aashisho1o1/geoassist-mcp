import type { Dataset } from "./datasets.js";

export interface FieldInfo {
  name: string;
  type: string;
  alias?: string;
  examples: string[];
  // True when examples is the complete list of values in the layer.
  all_values?: boolean;
  // True when the full value list was asked for and could not be read, so
  // values of this field are not being checked.
  values_unavailable?: boolean;
  // Named sets of values that mean the same thing (see ValueGroup).
  value_groups?: Record<string, { description: string; values: string[] }>;
}

// Schemas are read from the live layer and reused for an hour, so a layer
// that changes is picked up without a restart. A schema whose value lists
// could not all be read is not kept, so the next call tries again.
const SCHEMA_TTL_MS = 60 * 60 * 1000;
const schemaCache = new Map<string, { at: number; fields: FieldInfo[] }>();

// Facts about the layer itself, read from the same response as the fields.
export interface LayerInfo {
  // Most rows the service will return for one request.
  maxRecordCount: number;
  // When the layer's data was last edited, as YYYY-MM-DD, or null if the
  // service doesn't say.
  lastEdited: string | null;
}
const layerCache = new Map<string, LayerInfo>();

export function clearSchemaCache(): void {
  schemaCache.clear();
  layerCache.clear();
}

// Used when a layer doesn't report its own limit.
const DEFAULT_FETCH_CAP = 200;

function readLayerInfo(layer: any): LayerInfo {
  const max = Number(layer?.maxRecordCount);
  const edited = layer?.editingInfo?.dataLastEditDate ?? layer?.editingInfo?.lastEditDate;
  return {
    maxRecordCount: Number.isFinite(max) && max > 0 ? max : DEFAULT_FETCH_CAP,
    lastEdited: typeof edited === "number" ? new Date(edited).toISOString().slice(0, 10) : null,
  };
}

export async function getLayerInfo(ds: Dataset): Promise<LayerInfo> {
  const cached = layerCache.get(ds.id);
  if (cached) return cached;
  const info = readLayerInfo(await getJson(`${ds.url}?f=json`));
  layerCache.set(ds.id, info);
  return info;
}

// What every answer says about where its data came from.
export async function getDataSource(ds: Dataset) {
  const info = await getLayerInfo(ds);
  return { ...ds.source, layer_last_edited: info.lastEdited };
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`ArcGIS returned HTTP ${res.status} for ${url.split("?")[0]}`);
  const body = await res.json();
  if (body?.error) throw new Error(`ArcGIS error: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body;
}

const MAX_DISTINCT = 100;

export async function getSchema(ds: Dataset): Promise<FieldInfo[]> {
  const cached = schemaCache.get(ds.id);
  if (cached && Date.now() - cached.at < SCHEMA_TTL_MS) return cached.fields;

  const layer = await getJson(`${ds.url}?f=json`);
  layerCache.set(ds.id, readLayerInfo(layer));
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

  // Coded fields like TRAUMA are messy in practice (60 distinct values for
  // trauma levels: 'LEVEL I', 'I', 'LEVEL 1', 'PEDIATRIC LEVEL I', ...). A sample
  // misses most of them, so fetch the full list for these fields. The model
  // can only write a filter that catches every Level I center if it sees them all.
  const coded = new Set(ds.codedFields.map((f) => f.toUpperCase()));
  let complete = true;
  await Promise.all(
    fields
      .filter((f) => coded.has(f.name.toUpperCase()))
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
            // Null is dropped (= never matches it). An empty string is kept:
            // it is a real value that FIELD = '' matches.
            .filter((v: unknown) => v !== null && v !== undefined)
            .map(String);
          if (vals.length > 0) {
            f.examples = [...new Set(vals)].sort().slice(0, MAX_DISTINCT);
            // Complete only if the service sent every value and they all fit.
            f.all_values = vals.length <= MAX_DISTINCT && !distinct.exceededTransferLimit;
          }
        } catch {
          // Keep the sampled values for this answer, but don't remember them,
          // and say that values of this field are not being checked.
          f.values_unavailable = true;
          complete = false;
        }
      }),
  );

  for (const group of ds.valueGroups ?? []) {
    const f = fields.find((x) => x.name.toUpperCase() === group.field.toUpperCase());
    if (!f?.all_values) continue;
    const values = f.examples.filter(group.matches);
    if (values.length) (f.value_groups ??= {})[group.name] = { description: group.description, values };
  }

  if (complete) schemaCache.set(ds.id, { at: Date.now(), fields });
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

// A feature service returns at most its maxRecordCount rows per request (2,000
// on the layers used here), in storage order rather than by distance. If
// everything inside the circle fits, sorting here gives the true closest
// places. If it doesn't fit (a big radius in a dense city), the rows we got
// are an arbitrary subset, so we search for a smaller radius that both fits
// under the cap and still holds at least `limit` places.
const MAX_SHRINK_STEPS = 6;

export async function findNearby(ds: Dataset, q: NearbyQuery) {
  const fetchCap = (await getLayerInfo(ds)).maxRecordCount;
  const spatial = (radius: number) => ({
    where: q.where,
    geometry: `${q.longitude},${q.latitude}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    distance: String(radius),
    units: "esriSRUnit_StatuteMile",
  });
  // How many places match inside the radius that was asked for. The list
  // below can come from a smaller circle, so this is the only honest total.
  // A failed count is reported as unknown (null), never as 0.
  const countAll = async (): Promise<number | null> => {
    try {
      const body = await getJson(
        `${ds.url}/query?${new URLSearchParams({ ...spatial(q.radiusMiles), returnCountOnly: "true", f: "json" })}`,
      );
      return typeof body.count === "number" ? body.count : null;
    } catch {
      return null;
    }
  };
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
    resultRecordCount: String(fetchCap),
    f: "json",
  });
  const run = async (radius: number) => {
    const params = makeParams(radius);
    const body = await getJson(`${ds.url}/query?${new URLSearchParams(params)}`);
    return { radius, params, features: (body.features ?? []) as any[], exceeded: Boolean(body.exceededTransferLimit) };
  };

  const [first, total] = await Promise.all([run(q.radiusMiles), countAll()]);
  let chosen = first;

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
    // Every match inside radius_miles, or null if the count request failed.
    total_in_radius: total,
    // Matches read from the circle that was actually searched
    // (effective_radius_miles), which can be smaller than radius_miles.
    matches_in_effective_radius: results.length,
    more_beyond_cap: chosen.exceeded,
    fetch_cap: fetchCap,
    // False only when even the smallest circle tried had more than fetch_cap
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
