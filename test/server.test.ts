import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/tools.js";
import { checkWhere } from "../src/where.js";
import { latestPoint, inUS } from "../src/eonet.js";
import { clearSchemaCache } from "../src/arcgis.js";
import { DATASETS } from "../src/datasets.js";

const HOSPITAL_FIELDS = ["OBJECTID", "NAME", "ADDRESS", "CITY", "STATE", "TELEPHONE", "STATUS", "BEDS", "TRAUMA", "HELIPAD"];

const layerJson = { fields: HOSPITAL_FIELDS.map((name) => ({ name, type: "esriFieldTypeString" })) };
const sampleJson = {
  features: [
    { attributes: { NAME: "Sample Hospital", TRAUMA: "LEVEL II", HELIPAD: "Y", STATE: "CA" } },
  ],
};
// Returned in storage order: far one first, so sorting is actually tested.
const nearbyJson = {
  features: [
    { attributes: { NAME: "Far Regional", TRAUMA: "LEVEL I" }, geometry: { x: -117.0, y: 34.5 } },
    { attributes: { NAME: "Close Community", TRAUMA: "LEVEL II" }, geometry: { x: -117.7, y: 34.1 } },
    { attributes: { NAME: "No Geometry Place" }, geometry: null },
  ],
};
const eventsJson = {
  events: [
    {
      id: "EONET_1001", title: "Canyon Fire, Los Angeles County, CA",
      categories: [{ title: "Wildfires" }], sources: [{ url: "https://inciweb.example" }],
      geometry: [{ date: "2026-10-07T00:00:00Z", type: "Point", coordinates: [-117.72, 34.11] }],
    },
    {
      id: "EONET_2002", title: "Fire outside the US",
      categories: [{ title: "Wildfires" }],
      geometry: [{ date: "2026-10-06T00:00:00Z", type: "Point", coordinates: [150.0, -33.0] }],
    },
  ],
};

let requested: string[] = [];

beforeEach(() => {
  requested = [];
  clearSchemaCache();
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    requested.push(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes("eonet") && url.includes("/events/EONET_1001")) return json(eventsJson.events[0]);
    if (url.includes("eonet")) return json(eventsJson);
    if (url.includes("geometryType")) return json(nearbyJson);
    if (url.includes("/query?")) return json(sampleJson);
    if (url.endsWith("?f=json")) return json(layerJson);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([buildServer().connect(a), client.connect(b)]);
  return client;
}

const body = (r: any) => JSON.parse(r.content[0].text);

test("exposes exactly three read-only tools", async () => {
  const { tools } = await (await connect()).listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["find_nearby", "get_dataset_schema", "list_active_hazards"]);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint));
});

test("list_active_hazards keeps US events only", async () => {
  const r = body(await (await connect()).callTool({ name: "list_active_hazards", arguments: {} }));
  assert.equal(r.count, 1);
  assert.equal(r.hazards[0].id, "EONET_1001");
});

test("get_dataset_schema returns real example values", async () => {
  const r = body(await (await connect()).callTool({ name: "get_dataset_schema", arguments: { dataset: "hospitals" } }));
  const trauma = r.fields.find((f: any) => f.name === "TRAUMA");
  assert.deepEqual(trauma.examples, ["LEVEL II"]);
  assert.match(r.caveat, /Call ahead/);
});

test("find_nearby resolves an event, sorts by distance, and shows the query", async () => {
  const r = body(
    await (await connect()).callTool({
      name: "find_nearby",
      arguments: { dataset: "hospitals", event_id: "EONET_1001", where: "trauma like 'LEVEL%'", radius_miles: 50 },
    }),
  );
  assert.equal(r.results[0].attributes.NAME, "Close Community");
  assert.ok(r.results[0].distance_miles < r.results[1].distance_miles);
  assert.equal(r.query_sent.where, "(TRAUMA LIKE 'LEVEL%') AND STATUS = 'OPEN'"); // canonical spelling and open-only filter
  assert.equal(r.query_sent.distance, "50");
  assert.match(r.query_sent.outFields, /TELEPHONE/); // contact fields always included
});

test("find_nearby respects open_only: false", async () => {
  const r = body(
    await (await connect()).callTool({
      name: "find_nearby",
      arguments: { dataset: "hospitals", event_id: "EONET_1001", where: "trauma like 'LEVEL%'", open_only: false, radius_miles: 50 },
    }),
  );
  assert.equal(r.query_sent.where, "TRAUMA LIKE 'LEVEL%'");
});

test("find_nearby rejects an unknown field with a useful hint", async () => {
  const r: any = await (await connect()).callTool({
    name: "find_nearby",
    arguments: { dataset: "hospitals", latitude: 34.1, longitude: -117.7, where: "TRAUMMA = 'LEVEL I'" },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Did you mean 'TRAUMA'/);
  assert.ok(!requested.some((u) => u.includes("geometryType")), "nothing should be sent to ArcGIS");
});

test("find_nearby needs a center", async () => {
  const r: any = await (await connect()).callTool({ name: "find_nearby", arguments: { dataset: "schools" } });
  assert.equal(r.isError, true);
});

test("radius above the cap is refused by the schema", async () => {
  const r: any = await (await connect()).callTool({
    name: "find_nearby",
    arguments: { dataset: "hospitals", latitude: 34, longitude: -117, radius_miles: 5000 },
  });
  assert.equal(r.isError, true);
});

test("where gate", () => {
  const f = ["NAME", "BEDS", "STATE", "VAL_DATE"];
  assert.deepEqual(checkWhere("beds > 100 and state in ('CA','NV')", f), {
    ok: true,
    where: "BEDS > 100 AND STATE IN ('CA','NV')",
  });
  assert.equal(checkWhere("", f).ok, true);
  assert.equal(checkWhere("NAME = 'x'; DROP TABLE t", f).ok, false);
  assert.equal(checkWhere("NAME = 'x' -- comment", f).ok, false);
  assert.equal(checkWhere("1=1 UNION SELECT NAME", f).ok, false);
  assert.equal(checkWhere("(BEDS > 1", f).ok, false);
  assert.equal(checkWhere("NAME = 'O''Brien'", f).ok, true);
  assert.equal(checkWhere("UPPER(NAME) LIKE '%MERCY%'", f).ok, true);
  assert.equal(checkWhere("VAL_DATE >= DATE '2024-01-01'", f).ok, true);
});

test("polygon events use the average of the outer ring", () => {
  // Open ring test
  const pOpen = latestPoint([{ type: "Polygon", date: "d", coordinates: [[[-118, 34], [-116, 34], [-116, 36], [-118, 36]]] }]);
  assert.deepEqual(pOpen, { lon: -117, lat: 35, date: "d" });

  // Closed GeoJSON ring (closing coordinate duplicated at end)
  const pClosed = latestPoint([{ type: "Polygon", date: "d", coordinates: [[[-118, 34], [-116, 34], [-116, 36], [-118, 36], [-118, 34]]] }]);
  assert.deepEqual(pClosed, { lon: -117, lat: 35, date: "d" });

  assert.equal(inUS(35, -117), true);
  assert.equal(inUS(-33, 150), false);
  // Western Aleutians (-176 deg lon) included
  assert.equal(inUS(52, -176), true);
});

test("cities dataset contactFields match live layer schema", () => {
  assert.deepEqual(DATASETS.cities.contactFields, ["NAME", "STATE_ABBR", "POPULATION"]);
});

test("find_nearby filters out null/NaN geometries and sorts remaining cleanly", async () => {
  const r = body(
    await (await connect()).callTool({
      name: "find_nearby",
      arguments: { dataset: "hospitals", latitude: 34.1, longitude: -117.7, radius_miles: 50 },
    }),
  );
  // nearbyJson had 2 with geometry and 1 with null geometry
  assert.equal(r.matches_found, 2);
  assert.equal(r.results.length, 2);
  assert.equal(r.results[0].attributes.NAME, "Close Community");
});

test("find_nearby provides note when center point is outside US", async () => {
  const r = body(
    await (await connect()).callTool({
      name: "find_nearby",
      arguments: { dataset: "hospitals", latitude: 51.5, longitude: -0.1, radius_miles: 50 },
    }),
  );
  assert.ok(r.notes.some((n: string) => n.includes("outside the US")));
});

test("find_nearby adaptively shrinks radius when exceededTransferLimit is true", async () => {
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.endsWith("?f=json")) return json(layerJson);
    if (url.includes("/query?")) {
      const u = new URL(url);
      const dist = Number(u.searchParams.get("distance"));
      if (dist >= 50) {
        // High density: exceeded transfer limit
        return json({
          exceededTransferLimit: true,
          features: Array.from({ length: 20 }, (_, i) => ({
            attributes: { NAME: `Hospital ${i}` },
            geometry: { x: -117.7, y: 34.1 + i * 0.01 },
          })),
        });
      }
      // Shrunk radius fits under cap
      return json({
        exceededTransferLimit: false,
        features: Array.from({ length: 15 }, (_, i) => ({
          attributes: { NAME: `Inner Hospital ${i}` },
          geometry: { x: -117.7, y: 34.1 + i * 0.005 },
        })),
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const r = body(
    await (await connect()).callTool({
      name: "find_nearby",
      arguments: { dataset: "hospitals", latitude: 34.1, longitude: -117.7, radius_miles: 50, limit: 10 },
    }),
  );
  assert.equal(r.effective_radius_miles, 25);
  assert.ok(r.notes.some((n: string) => n.includes("reduced to 25 miles")));
});
