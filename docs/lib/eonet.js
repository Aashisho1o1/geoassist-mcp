// NASA EONET v3: open natural events (wildfires, storms, volcanoes, floods).
// Same feed the Soka disaster monitor used, now feeding an Esri layer query.
const EONET = "https://eonet.gsfc.nasa.gov/api/v3/events";
export const HAZARD_CATEGORIES = ["wildfires", "severeStorms", "volcanoes", "floods"];
// Rough boxes for the contiguous US, Alaska, Hawaii, and Puerto Rico. The
// Living Atlas layers here only cover the US, so events elsewhere are noise.
const US_BOXES = [
    [-125, 24, -66, 50], // [minLon, minLat, maxLon, maxLat]
    [-180, 51, -129, 72],
    [-161, 18, -154, 23],
    [-68, 17, -65, 19],
];
export function inUS(lat, lon) {
    return US_BOXES.some(([a, b, c, d]) => lon >= a && lon <= c && lat >= b && lat <= d);
}
// EONET gives a history of geometries. We use the most recent one, and for a
// polygon we take the average of its outer ring as a single point.
export function latestPoint(geometry) {
    const g = geometry?.[geometry.length - 1];
    if (!g)
        return null;
    if (g.type === "Point")
        return { lon: g.coordinates[0], lat: g.coordinates[1], date: g.date };
    if (g.type === "Polygon") {
        let ring = g.coordinates?.[0] ?? [];
        if (!ring.length)
            return null;
        // GeoJSON polygons close their linear rings by repeating the first vertex at the end.
        // Drop the duplicate closing vertex if present so the centroid average isn't biased.
        if (ring.length > 3 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) {
            ring = ring.slice(0, -1);
        }
        const lon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
        const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
        return { lon, lat, date: g.date };
    }
    return null;
}
export async function listHazards(category, days) {
    const url = `${EONET}?${new URLSearchParams({ status: "open", category, days: String(days) })}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok)
        throw new Error(`NASA EONET returned HTTP ${res.status}`);
    const body = await res.json();
    const out = [];
    for (const e of body.events ?? []) {
        const p = latestPoint(e.geometry);
        if (!p || !inUS(p.lat, p.lon))
            continue;
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
export async function getHazard(id) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id))
        throw new Error(`'${id}' is not a valid EONET event id.`);
    const res = await fetch(`${EONET}/${id}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok)
        throw new Error(`No EONET event found with id '${id}' (HTTP ${res.status}).`);
    const e = await res.json();
    const p = latestPoint(e.geometry);
    if (!p)
        throw new Error(`EONET event '${id}' has no usable location.`);
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
