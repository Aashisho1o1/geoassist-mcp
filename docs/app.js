// Live demo of the GeoAssist MCP server. The lib/ files are the server's own
// compiled modules (npm run build:demo copies them here), so the filter check,
// the radius search, and the EONET handling are the exact code an AI client
// reaches through MCP. Only the map and the page are new.

import { DATASETS } from "./lib/datasets.js";
import { getSchema, findNearby } from "./lib/arcgis.js";
import { listHazards, inUS } from "./lib/eonet.js";
import { checkWhere, checkFields } from "./lib/where.js";

const [EsriMap, MapView, Basemap, TileLayer, GraphicsLayer, Graphic, Circle, Point] = await new Promise((resolve) =>
  window.require(
    [
      "esri/Map",
      "esri/views/MapView",
      "esri/Basemap",
      "esri/layers/TileLayer",
      "esri/layers/GraphicsLayer",
      "esri/Graphic",
      "esri/geometry/Circle",
      "esri/geometry/Point",
    ],
    (...mods) => resolve(mods),
  ),
);

// ---------- presets ----------

// Values like 'LEVEL I', 'LEVEL  I', 'I', 'LEVEL I TRAUMA', 'PEDIATRIC LEVEL I'
// all mean a Level I center. Split on anything that isn't a letter or digit
// and look for a standalone I or 1, which never matches II, III, or IV.
const isLevelI = (v) => v.toUpperCase().split(/[^A-Z0-9]+/).some((t) => t === "I" || t === "1");
const sqlList = (vals) => vals.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");

const PRESETS = {
  hospitals: [
    { id: "all", label: "All open hospitals", where: () => "" },
    { id: "level1", label: "Level I trauma", where: (schema) => `TRAUMA IN (${sqlList(levelISpellings(schema))})` },
    { id: "helipad", label: "Has a helipad", where: () => "HELIPAD = 'Y'" },
    { id: "children", label: "Children's hospitals", where: () => "TYPE = 'CHILDREN'" },
    { id: "big", label: "200+ beds", where: () => "BEDS >= 200" },
  ],
  schools: [
    { id: "all", label: "All public schools", where: () => "" },
    { id: "shelter", label: "Has a shelter ID", where: () => "SHELTER_ID IS NOT NULL AND SHELTER_ID <> 'NOT AVAILABLE'" },
    { id: "elem", label: "Elementary", where: () => "LEVEL_ = 'ELEMENTARY'" },
    { id: "high", label: "High schools", where: () => "LEVEL_ = 'HIGH'" },
    { id: "big", label: "1,000+ students", where: () => "ENROLLMENT >= 1000" },
  ],
};

const EXTRA_FIELDS = {
  hospitals: ["TYPE", "TRAUMA", "HELIPAD", "BEDS"],
  schools: ["LEVEL_", "ST_GRADE", "END_GRADE", "SHELTER_ID"],
};

function levelISpellings(schema) {
  const f = schema.find((x) => x.name === "TRAUMA");
  return (f?.examples ?? []).filter(isLevelI);
}

// ---------- state ----------

const state = {
  category: "wildfires",
  hazards: [],
  center: null, // { latitude, longitude, label, hazardId? }
  ds: "hospitals",
  preset: "all",
  custom: null,
  radius: 25,
};
let runToken = 0;

const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const known = (v) => v !== null && v !== undefined && v !== "" && !/^(NOT AVAILABLE|NOT APPLICABLE|NOT REPORTED|-999)$/i.test(String(v));
// The layers store names in capitals. Title-case them for reading, but keep
// short codes (VA, NE, II) that would look wrong otherwise.
const KEEP_UPPER = new Set(["VA", "BHC", "HCA", "UC", "UCLA", "UCSF", "USC", "LLC", "PO", "NE", "NW", "SE", "SW", "II", "III", "IV", "LDS", "MD", "PK"]);
const SMALL = new Set(["of", "and", "the", "at", "for", "in", "on"]);
const titleCase = (s) =>
  String(s ?? "")
    .toLowerCase()
    .split(/(\s+|-|\/)/)
    .map((w, i) => {
      if (KEEP_UPPER.has(w.toUpperCase())) return w.toUpperCase();
      if (i > 0 && SMALL.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).replace(/^c([a-z])/, (m, c) => (w.startsWith("mc") ? "c" + c.toUpperCase() : m));
    })
    .join("");

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const h = Math.round(ms / 36e5);
  if (h < 1) return "reported within the hour";
  if (h < 48) return `reported ${h} hour${h === 1 ? "" : "s"} ago`;
  return `reported ${Math.round(h / 24)} days ago`;
}

// ---------- map ----------

const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
const tiles = (name) => new TileLayer({ url: `https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/${name}/MapServer` });
const basemap = new Basemap({
  baseLayers: [tiles(dark ? "World_Dark_Gray_Base" : "World_Light_Gray_Base")],
  referenceLayers: [tiles(dark ? "World_Dark_Gray_Reference" : "World_Light_Gray_Reference")],
});

const ringLayer = new GraphicsLayer();
const hazardLayer = new GraphicsLayer();
const placeLayer = new GraphicsLayer();
const map = new EsriMap({ basemap, layers: [ringLayer, placeLayer, hazardLayer] });
const view = new MapView({
  container: "map",
  map,
  center: [-98.5, 39.5],
  zoom: 4,
  constraints: { minZoom: 3 },
  popup: { dockEnabled: false, dockOptions: { buttonEnabled: false } },
});

const FIRE = dark ? [255, 122, 61] : [217, 72, 15];
const ACCENT = dark ? [111, 178, 242] : [11, 92, 173];

function drawHazards() {
  hazardLayer.removeAll();
  for (const h of state.hazards) {
    const selected = state.center?.hazardId === h.id;
    hazardLayer.add(
      new Graphic({
        geometry: new Point({ longitude: h.longitude, latitude: h.latitude }),
        attributes: { hazardId: h.id },
        symbol: {
          type: "simple-marker",
          style: "circle",
          size: selected ? 16 : 10,
          color: [...FIRE, selected ? 1 : 0.75],
          outline: { color: [255, 255, 255, 0.95], width: selected ? 2 : 1 },
        },
      }),
    );
  }
}

function drawCenter(radius, effective) {
  ringLayer.removeAll();
  if (!state.center) return null;
  const center = new Point({ longitude: state.center.longitude, latitude: state.center.latitude });
  const ring = new Circle({ center, radius, radiusUnit: "miles", geodesic: true, numberOfPoints: 120 });
  ringLayer.add(
    new Graphic({
      geometry: ring,
      symbol: {
        type: "simple-fill",
        color: [...FIRE, 0.05],
        outline: { color: [...FIRE, 0.9], width: 1.5, style: "dash" },
      },
    }),
  );
  if (effective && effective < radius) {
    ringLayer.add(
      new Graphic({
        geometry: new Circle({ center, radius: effective, radiusUnit: "miles", geodesic: true, numberOfPoints: 90 }),
        symbol: { type: "simple-fill", color: [0, 0, 0, 0], outline: { color: [...ACCENT, 0.8], width: 1 } },
      }),
    );
  }
  if (!state.center.hazardId) {
    ringLayer.add(
      new Graphic({
        geometry: center,
        symbol: { type: "simple-marker", style: "x", size: 12, outline: { color: [...FIRE, 1], width: 2.5 } },
      }),
    );
  }
  return ring;
}

const placeGraphics = [];
function drawPlaces(results, dsId) {
  placeLayer.removeAll();
  placeGraphics.length = 0;
  results.forEach((r, i) => {
    const a = r.attributes;
    const geometry = new Point({ longitude: r.longitude, latitude: r.latitude });
    const marker = new Graphic({
      geometry,
      attributes: { rank: i + 1 },
      symbol: { type: "simple-marker", size: 20, color: ACCENT, outline: { color: [255, 255, 255], width: 1.5 } },
      popupTemplate: {
        title: esc(titleCase(a.NAME)),
        content: () => popupHtml(r, dsId),
      },
    });
    const label = new Graphic({
      geometry,
      symbol: {
        type: "text",
        text: String(i + 1),
        color: "white",
        yoffset: -4,
        font: { size: 9, weight: "bold", family: "sans-serif" },
      },
    });
    placeLayer.addMany([marker, label]);
    placeGraphics.push(marker);
  });
}

function popupHtml(r, dsId) {
  const a = r.attributes;
  const phone = known(a.TELEPHONE) ? `<a href="tel:${esc(String(a.TELEPHONE).replace(/[^\d+]/g, ""))}">${esc(a.TELEPHONE)}</a>` : "No phone on file";
  return `<div>${esc(titleCase(a.ADDRESS))}, ${esc(titleCase(a.CITY))}, ${esc(a.STATE)}</div>
    <div>${phone}</div>
    <div><strong>${r.distance_miles} mi</strong> straight-line from ${esc(state.center?.label ?? "the point")}</div>
    <div style="margin-top:4px">${tags(a, dsId).map((t) => esc(t.text)).join(" · ")}</div>`;
}

view.on("click", async (event) => {
  const hit = await view.hitTest(event, { include: [hazardLayer, placeLayer] });
  const g = hit.results[0]?.graphic;
  if (g?.attributes?.hazardId) {
    const h = state.hazards.find((x) => x.id === g.attributes.hazardId);
    if (h) selectHazard(h);
    return;
  }
  if (g) return; // a place marker: its popup opens on its own
  const { latitude, longitude } = event.mapPoint;
  state.center = {
    latitude: Math.round(latitude * 1e4) / 1e4,
    longitude: Math.round(longitude * 1e4) / 1e4,
    label: "the dropped pin",
  };
  renderHazardList();
  drawHazards();
  run({ zoom: true });
});

// ---------- hazards ----------

async function loadHazards(category, { autoselect = false } = {}) {
  state.category = category;
  for (const b of $("categoryTabs").children) b.setAttribute("aria-selected", String(b.dataset.cat === category));
  $("hazardList").innerHTML = `<li class="empty">Loading open events from NASA EONET…</li>`;
  try {
    state.hazards = await listHazards(category, 30);
  } catch (e) {
    state.hazards = [];
    $("hazardList").innerHTML = `<li class="empty">Couldn't reach NASA EONET (${esc(e.message)}). You can still click the map.</li>`;
    drawHazards();
    return false;
  }
  renderHazardList();
  drawHazards();
  if (autoselect && state.hazards.length) {
    // Open on the newest real event rather than a planned prescribed burn.
    selectHazard(state.hazards.find((h) => !/prescribed/i.test(h.title)) ?? state.hazards[0]);
    return true;
  }
  return state.hazards.length > 0;
}

function renderHazardList() {
  const list = $("hazardList");
  if (!state.hazards.length) {
    const name = $("categoryTabs").querySelector(`[data-cat="${state.category}"]`).textContent.toLowerCase();
    list.innerHTML = `<li class="empty">No open ${esc(name)} in the US in the last 30 days. Good news, or try another type.</li>`;
    return;
  }
  list.innerHTML = state.hazards
    .map(
      (h) => `<li><button data-id="${esc(h.id)}" aria-current="${state.center?.hazardId === h.id}">
        <span class="t">${esc(h.title)}</span>
        <span class="m">${esc(ago(h.last_reported))}</span>
      </button></li>`,
    )
    .join("");
}

$("hazardList").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-id]");
  const h = b && state.hazards.find((x) => x.id === b.dataset.id);
  if (h) selectHazard(h);
});

function selectHazard(h) {
  state.center = { latitude: h.latitude, longitude: h.longitude, label: h.title, hazardId: h.id, hazard: h };
  renderHazardList();
  drawHazards();
  run({ zoom: true });
}

$("categoryTabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-cat]");
  if (b && b.dataset.cat !== state.category) loadHazards(b.dataset.cat);
});

// ---------- controls ----------

function renderPresets() {
  $("presetChips").innerHTML = PRESETS[state.ds]
    .map((p) => `<button data-p="${p.id}" aria-pressed="${state.custom === null && state.preset === p.id}">${esc(p.label)}</button>`)
    .join("");
}

$("datasetTabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-ds]");
  if (!b || b.dataset.ds === state.ds) return;
  state.ds = b.dataset.ds;
  state.preset = "all";
  state.custom = null;
  $("customWhere").value = "";
  for (const x of $("datasetTabs").children) x.setAttribute("aria-selected", String(x.dataset.ds === state.ds));
  $("customWhere").placeholder = state.ds === "hospitals" ? "BEDS >= 200 AND HELIPAD = 'Y'" : "ENROLLMENT > 500 AND LEVEL_ = 'MIDDLE'";
  renderPresets();
  run();
});

$("presetChips").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-p]");
  if (!b) return;
  state.preset = b.dataset.p;
  state.custom = null;
  $("customWhere").value = "";
  renderPresets();
  run();
});

$("radius").addEventListener("input", (e) => {
  $("radiusOut").textContent = e.target.value;
});
$("radius").addEventListener("change", (e) => {
  state.radius = Number(e.target.value);
  run({ zoom: true });
});

$("customForm").addEventListener("submit", (e) => {
  e.preventDefault();
  state.custom = $("customWhere").value;
  renderPresets();
  run();
});

$("customBox").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-try]");
  if (!b) return;
  if (state.ds !== "hospitals") $("datasetTabs").querySelector('[data-ds="hospitals"]').click();
  $("customWhere").value = b.dataset.try;
  state.custom = b.dataset.try;
  renderPresets();
  run();
});

// ---------- the search ----------

function setStatus(html, kind = "") {
  $("status").className = `status ${kind}`;
  $("status").innerHTML = html;
}

async function run({ zoom = false } = {}) {
  if (!state.center) return;
  const token = ++runToken;
  const ds = DATASETS[state.ds];
  const ring = drawCenter(state.radius);
  if (zoom && ring) view.when(() => view.goTo(ring.extent.clone().expand(1.25), { duration: 600 })).catch(() => {});

  $("placeList").innerHTML = "";
  $("dataCard").innerHTML = "";
  $("howBody").innerHTML = "";
  $("caveat").textContent = "";
  $("resultsTitle").textContent = `${ds.name} near ${state.center.label}`;
  placeLayer.removeAll();
  setStatus("Reading the live layer schema…");

  try {
    const schema = await getSchema(ds);
    if (token !== runToken) return;
    const names = schema.map((f) => f.name);

    const preset = PRESETS[state.ds].find((p) => p.id === state.preset);
    const raw = state.custom ?? preset.where(schema);

    // 1. The gate. A refused filter never reaches ArcGIS.
    const gate = checkWhere(raw, names);
    if (!gate.ok) {
      setStatus(
        `<strong>Refused before reaching ArcGIS.</strong> ${esc(gate.error)}<br /><span class="small">
        This is the message an AI client gets back, so it can fix the filter and try again instead of
        showing an empty map that looks like "nothing nearby".</span>`,
        "error",
      );
      $("howBody").innerHTML = `<h3>Filter you wrote</h3><pre>${esc(raw)}</pre><p>Nothing was sent to ArcGIS.</p>`;
      return;
    }
    const fields = checkFields(EXTRA_FIELDS[state.ds], names, ds.contactFields);
    if (!fields.ok) throw new Error(fields.error);

    // 2. Same open-only rule the MCP tool applies by default.
    let where = gate.where;
    let filteredOpen = false;
    if (ds.id === "hospitals" && !where.toUpperCase().includes("STATUS")) {
      filteredOpen = true;
      where = where === "1=1" ? "STATUS = 'OPEN'" : `(${where}) AND STATUS = 'OPEN'`;
    }

    setStatus("Asking ArcGIS for places inside the circle…");
    const result = await findNearby(ds, {
      where,
      outFields: fields.list,
      latitude: state.center.latitude,
      longitude: state.center.longitude,
      radiusMiles: state.radius,
      limit: 10,
    });
    if (token !== runToken) return;

    drawCenter(state.radius, result.effective_radius_miles);
    renderResults(ds, result, gate, raw, where, filteredOpen);
    if (state.preset === "level1" && state.custom === null && ds.id === "hospitals") renderLevelICard(ds, schema);
  } catch (e) {
    if (token !== runToken) return;
    setStatus(`Something went wrong talking to the data service: ${esc(e.message)}. Try again in a moment.`, "error");
  }
}

function tags(a, dsId) {
  const t = [];
  if (dsId === "hospitals") {
    if (known(a.TRAUMA) && !/NOT DESIGNATED|NON-DESIGNATED|UNCLASSIFIED/i.test(a.TRAUMA)) t.push({ text: `Trauma: ${a.TRAUMA}`, good: true });
    if (a.HELIPAD === "Y") t.push({ text: "Helipad", good: true });
    if (known(a.BEDS) && a.BEDS > 0) t.push({ text: `${a.BEDS} beds` });
    if (known(a.TYPE)) t.push({ text: titleCase(a.TYPE) });
  } else {
    if (known(a.LEVEL_)) t.push({ text: titleCase(a.LEVEL_) });
    if (known(a.ST_GRADE) && known(a.END_GRADE)) t.push({ text: `Grades ${a.ST_GRADE}–${a.END_GRADE}` });
    if (known(a.ENROLLMENT) && a.ENROLLMENT > 0) t.push({ text: `${Number(a.ENROLLMENT).toLocaleString()} students` });
    if (known(a.SHELTER_ID)) t.push({ text: "Shelter ID on file", good: true });
  }
  return t;
}

function renderResults(ds, result, gate, raw, where, filteredOpen) {
  const n = result.results.length;
  const what = ds.id === "hospitals" ? (n === 1 ? "hospital" : "hospitals") : n === 1 ? "school" : "schools";
  if (n === 0) {
    const wider = Math.min(100, state.radius * 2);
    setStatus(
      `No matching ${what} within ${state.radius} miles. That doesn't prove there are none nearby, only none inside this circle.` +
        (state.radius < 100 ? ` <button class="link" id="widen">Search ${wider} miles instead</button>` : ""),
    );
    $("widen")?.addEventListener("click", () => {
      state.radius = wider;
      $("radius").value = String(wider);
      $("radiusOut").textContent = String(wider);
      run({ zoom: true });
    });
  } else {
    const shrunk = result.effective_radius_miles < state.radius;
    setStatus(
      (n < 10 ? `${n === 1 ? "The only matching" : `All ${n} matching`} ${what}, closest first` : `The ${n} closest ${what}`) +
        (shrunk
          ? `. This area is dense, so the search narrowed to ${result.effective_radius_miles} miles (inner ring) to be sure these really are the closest.`
          : ` within ${state.radius} miles.`) +
        (result.closest_guaranteed ? "" : " <strong>Too many places to be sure these are the very closest. Try a tighter filter.</strong>"),
    );
  }

  $("placeList").innerHTML = result.results
    .map((r, i) => {
      const a = r.attributes;
      const phone = known(a.TELEPHONE)
        ? `<a class="phone" href="tel:${esc(String(a.TELEPHONE).replace(/[^\d+]/g, ""))}">${esc(a.TELEPHONE)}</a>`
        : `<span class="meta">No phone on file</span>`;
      return `<li><div class="place" data-i="${i}">
        <span class="rank" aria-hidden="true">${i + 1}</span>
        <div>
          <button class="link name" data-i="${i}" style="text-decoration:none;color:inherit;text-align:left">${esc(titleCase(a.NAME))}</button>
          <div class="meta">${esc(titleCase(a.ADDRESS))}, ${esc(titleCase(a.CITY))}, ${esc(a.STATE)}</div>
          <div>${phone}</div>
          <div class="tags">${tags(a, ds.id).map((t) => `<span class="tag ${t.good ? "good" : ""}">${esc(t.text)}</span>`).join("")}</div>
        </div>
        <div class="dist">${r.distance_miles} mi<small>straight-line</small></div>
      </div></li>`;
    })
    .join("");

  drawPlaces(result.results, ds.id);
  $("caveat").textContent = `${ds.caveat}`;

  // "How this answer was made": the same transparency the MCP tool returns.
  const q = { ...result.query_sent };
  const endpoint = q.endpoint;
  delete q.endpoint;
  const url = `${endpoint}?${new URLSearchParams(q)}`;
  const notes = [
    "Distances are straight-line miles, not driving distance.",
    ...(filteredOpen ? ["Closed hospitals are left out by default (STATUS = 'OPEN')."] : []),
    ...(result.effective_radius_miles < state.radius
      ? [`More than 200 places fall inside ${state.radius} miles, and ArcGIS returns at most 200 in no particular order. So the search narrowed the circle to ${result.effective_radius_miles} miles, where every place fits, then sorted by distance.`]
      : []),
    ...(!inUS(state.center.latitude, state.center.longitude) ? ["This point is outside the US. These layers only cover the US."] : []),
  ];
  $("howBody").innerHTML = `
    <h3>1. Filter check <span class="gate-ok">passed</span></h3>
    <p>${
      !raw.trim()
        ? "No filter, so everything inside the circle counts."
        : raw.trim() === gate.where
          ? "Every field name in the filter exists in the live layer, and nothing else is in it but values and basic SQL words."
          : `You wrote <code>${esc(raw)}</code>. Every field exists in the live layer; it was rewritten with the layer's exact spelling:`
    }</p>
    ${raw.trim() && raw.trim() !== gate.where ? `<pre>${esc(gate.where)}</pre>` : ""}
    <h3>2. Sent to ArcGIS</h3>
    <pre>where = ${esc(where)}
distance = ${esc(q.distance)} ${esc(q.units.replace("esriSRUnit_", "").toLowerCase())}s around ${esc(q.geometry)}</pre>
    <p><a href="${esc(url)}" target="_blank" rel="noopener">Open this exact query in the ArcGIS REST API</a></p>
    <h3>3. Notes</h3>
    <ul>${notes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
}

$("placeList").addEventListener("click", (e) => {
  if (e.target.closest("a")) return;
  const row = e.target.closest("[data-i]");
  const g = row && placeGraphics[Number(row.dataset.i)];
  if (!g) return;
  view.goTo({ target: g.geometry, zoom: Math.max(view.zoom, 12) }, { duration: 500 }).then(() =>
    view.openPopup({ features: [g], location: g.geometry }),
  ).catch(() => {});
});

// ---------- the messy-data card ----------

async function count(ds, where, nearby) {
  const p = { where, returnCountOnly: "true", f: "json" };
  if (nearby) {
    Object.assign(p, {
      geometry: `${state.center.longitude},${state.center.latitude}`,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      distance: String(state.radius),
      units: "esriSRUnit_StatuteMile",
    });
  }
  const res = await fetch(`${ds.url}/query?${new URLSearchParams(p)}`, { signal: AbortSignal.timeout(10_000) });
  return (await res.json()).count ?? 0;
}

async function renderLevelICard(ds, schema) {
  const token = runToken;
  const spellings = levelISpellings(schema);
  const naive = "TRAUMA = 'LEVEL I' AND STATUS = 'OPEN'";
  const full = `TRAUMA IN (${sqlList(spellings)}) AND STATUS = 'OPEN'`;
  try {
    const [nNaive, nFull, usNaive, usFull] = await Promise.all([
      count(ds, naive, true),
      count(ds, full, true),
      count(ds, naive, false),
      count(ds, full, false),
    ]);
    if (token !== runToken) return;
    const missed = usFull - usNaive;
    $("dataCard").innerHTML = `<div class="card">
      <strong>The trauma field is spelled ${spellings.length} different ways for Level I alone.</strong>
      A filter for exactly <code>'LEVEL I'</code> looks right${missed > 0 ? ` and quietly misses ${missed > usNaive ? "most of them" : "many of them"}` : ""}.
      <div class="vs">
        <div><span>Exact 'LEVEL I', in this circle</span><span class="big">${nNaive}</span></div>
        <div><span>Every Level I spelling, in this circle</span><span class="big">${nFull}</span></div>
      </div>
      Across the US, the exact match finds ${usNaive.toLocaleString()} open Level I hospitals and misses
      ${missed.toLocaleString()} more. This search uses every spelling.
      <details><summary>See the ${spellings.length} spellings it matched</summary>
        <div class="spellings">${spellings.map((s) => `<code>${esc(s)}</code>`).join("")}</div>
        <p class="small">Includes pediatric Level I centers. Any value with a standalone "I" or "1" counts; II, III and IV never match.</p>
      </details>
    </div>`;
  } catch {
    // The card is a bonus; the results above already stand on their own.
  }
}

// ---------- start ----------

renderPresets();
const ok = (await loadHazards("wildfires", { autoselect: true })) || (await loadHazards("severeStorms", { autoselect: true }));
if (!ok) {
  state.center = { latitude: 34.0522, longitude: -118.2437, label: "Los Angeles (sample point)" };
  setStatus("No open US wildfires or storms right now, so here's a sample point in Los Angeles.");
  run({ zoom: true });
}
