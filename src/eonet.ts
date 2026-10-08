// NASA EONET v3: open natural events (wildfires, storms, volcanoes, floods).
// Same feed the Soka disaster monitor used, now feeding an Esri layer query.

const EONET = "https://eonet.gsfc.nasa.gov/api/v3/events";

export const HAZARD_CATEGORIES = ["wildfires", "severeStorms", "volcanoes", "floods"] as const;
export type HazardCategory = (typeof HAZARD_CATEGORIES)[number];

export interface Hazard {
  id: string;
  title: string;
  category: string;
  last_reported: string;
  latitude: number;
  longitude: number;
  source_url?: string;
}

// Rough boxes for the contiguous US, Alaska, Hawaii, and Puerto Rico. The
// Living Atlas layers here only cover the US, so events elsewhere are noise.
const US_BOXES: [number, number, number, number][] = [
  [-125, 24, -66, 50], // [minLon, minLat, maxLon, maxLat]
  [-180, 51, -129, 72],
  [-161, 18, -154, 23],
  [-68, 17, -65, 19],
];

export function inUS(lat: number, lon: number): boolean {
  return US_BOXES.some(([a, b, c, d]) => lon >= a && lon <= c && lat >= b && lat <= d);
}

// EONET gives a history of geometries. We use the most recent one, and for a
// polygon we take the average of its outer ring as a single point.
export function latestPoint(geometry: any[]): { lat: number; lon: number; date: string } | null {
  const g = geometry?.[geometry.length - 1];
  if (!g) return null;
  if (g.type === "Point") return { lon: g.coordinates[0], lat: g.coordinates[1], date: g.date };
  if (g.type === "Polygon") {
    const ring: number[][] = g.coordinates?.[0] ?? [];
    if (!ring.length) return null;
    const lon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    return { lon, lat, date: g.date };
  }
  return null;
}

export async function listHazards(category: HazardCategory, days: number): Promise<Hazard[]> {
  const url = `${EONET}?${new URLSearchParams({ status: "open", category, days: String(days) })}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NASA EONET returned HTTP ${res.status}`);
  const body = await res.json();

  const out: Hazard[] = [];
  for (const e of body.events ?? []) {
    const p = latestPoint(e.geometry);
    if (!p || !inUS(p.lat, p.lon)) continue;
    out.push({
      id: e.id,
      title: e.title,
      category: e.categories?.[0]?.title ?? category,
      last_reported: p.date,
      latitude: Math.round(p.lat * 1e4) / 1e4,
      longitude: Math.round(p.lon * 1e4) / 1e4,
      source_url: e.sources?.[0]?.url,
    });
  }
  return out.sort((a, b) => b.last_reported.localeCompare(a.last_reported));
}

export async function getHazard(id: string): Promise<Hazard> {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error(`'${id}' is not a valid EONET event id.`);
  const res = await fetch(`${EONET}/${id}`);
  if (!res.ok) throw new Error(`No EONET event found with id '${id}' (HTTP ${res.status}).`);
  const e = await res.json();
  const p = latestPoint(e.geometry);
  if (!p) throw new Error(`EONET event '${id}' has no usable location.`);
  return {
    id: e.id,
    title: e.title,
    category: e.categories?.[0]?.title ?? "",
    last_reported: p.date,
    latitude: Math.round(p.lat * 1e4) / 1e4,
    longitude: Math.round(p.lon * 1e4) / 1e4,
    source_url: e.sources?.[0]?.url,
  };
}
