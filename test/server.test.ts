import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/tools.js";
import { checkWhere, applyOpenOnly, checkValues, checkOrderBy } from "../src/where.js";
import { checkFilter, getSchema } from "../src/core.js";
import { latestPoint, inUS } from "../src/eonet.js";
import { clearSchemaCache } from "../src/arcgis.js";
import { DATASETS, isLevelI } from "../src/datasets.js";

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
    fields: ["BEDS", "STATE"],
    comparisons: [{ field: "STATE", negated: false, values: ["CA", "NV"] }],
  });
  assert.equal(checkWhere("", f).ok, true);
  assert.equal(checkWhere("NAME = 'x'; DROP TABLE t", f).ok, false);
  assert.equal(checkWhere("NAME = 'x' -- comment", f).ok, false);
  assert.equal(checkWhere("1=1 UNION SELECT NAME", f).ok, false);
  assert.equal(checkWhere("(BEDS > 1", f).ok, false);
  assert.equal(checkWhere("NAME = 'O''Brien'", f).ok, true);
  assert.equal(checkWhere("UPPER(NAME) LIKE '%MERCY%'", f).ok, true);
  assert.equal(checkWhere("VAL_DATE >= DATE '2024-01-01'", f).ok, true);
  assert.equal(checkWhere("STATE IN ()", f).ok, false);
  assert.equal(checkWhere("STATE IN ( )", f).ok, false);
  assert.equal(checkWhere("NAME = 'IN ()'", f).ok, true);
});

test("open-only rule looks at fields, not text", () => {
  const f = ["NAME", "STATUS"];
  const gate = (w: string) => checkWhere(w, f) as { ok: true; where: string; fields: string[] };
  assert.equal(applyOpenOnly("hospitals", gate("NAME LIKE '%STATUS%'")).where, "(NAME LIKE '%STATUS%') AND STATUS = 'OPEN'");
  assert.deepEqual(applyOpenOnly("hospitals", gate("status = 'CLOSED'")), { where: "STATUS = 'CLOSED'", applied: false });
  assert.deepEqual(applyOpenOnly("hospitals", gate("")), { where: "STATUS = 'OPEN'", applied: true });
  assert.equal(applyOpenOnly("schools", gate("")).applied, false);
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
  assert.equal(r.matches_in_effective_radius, 2);
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
  assert.equal(r.closest_guaranteed, true);
  assert.ok(r.notes.some((n: string) => n.includes("25-mile circle")));
});

// Fake layer: one hospital every 0.2 miles due north. The service overflows
// whenever more than 200 fall inside the circle, like a dense city would.
function denseFetch(perMile: number) {
  return (async (input: string | URL) => {
    const url = String(input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.endsWith("?f=json")) return json(layerJson);
    const u = new URL(url);
    if (u.searchParams.get("returnDistinctValues")) return json({ features: [] });
    const dist = Number(u.searchParams.get("distance") ?? 0);
    const n = Math.floor(dist * perMile);
    const all = Array.from({ length: n }, (_, i) => ({
      attributes: { NAME: `H${i}` },
      geometry: { x: -117.7, y: 34.1 + ((i + 1) / perMile) / 69 },
    })).reverse(); // storage order: farthest first
    return json({ exceededTransferLimit: n > 200, features: all.slice(0, 200) });
  }) as typeof fetch;
}

test("dense area: shrinks to a circle that fits and still has enough results", async () => {
  globalThis.fetch = denseFetch(20); // 2,000 within 100 miles
  const r = body(
    await (await connect()).callTool({
      name: "find_nearby",
      arguments: { dataset: "hospitals", latitude: 34.1, longitude: -117.7, radius_miles: 100, limit: 10 },
    }),
  );
  assert.equal(r.closest_guaranteed, true);
  assert.equal(r.results.length, 10);
  assert.equal(r.results[0].attributes.NAME, "H0"); // the true nearest one
});

test("never returns fewer results than asked when more exist", async () => {
  globalThis.fetch = denseFetch(20);
  const r = body(
    await (await connect()).callTool({
      name: "find_nearby",
      arguments: { dataset: "hospitals", latitude: 34.1, longitude: -117.7, radius_miles: 100, limit: 25 },
    }),
  );
  assert.equal(r.results.length, 25);
  assert.equal(r.results[0].attributes.NAME, "H0");
});

test("too dense to resolve: says the list is not guaranteed", async () => {
  globalThis.fetch = denseFetch(100000);
  const r = body(
    await (await connect()).callTool({
      name: "find_nearby",
      arguments: { dataset: "hospitals", latitude: 34.1, longitude: -117.7, radius_miles: 10, limit: 10 },
    }),
  );
  assert.equal(r.closest_guaranteed, false);
  assert.ok(r.notes.some((n: string) => n.includes("nearer place may be missing")));
});

test("schema lists every value of a coded field", async () => {
  const many = Array.from({ length: 55 }, (_, i) => ({ attributes: { TRAUMA: `V${String(i).padStart(2, "0")}` } }));
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("returnDistinctValues=true") && url.includes("outFields=TRAUMA"))
      return new Response(JSON.stringify({ features: many }), { status: 200 });
    if (url.includes("returnDistinctValues=true")) return new Response(JSON.stringify({ features: [] }), { status: 200 });
    return prev(input);
  }) as typeof fetch;
  const r = body(await (await connect()).callTool({ name: "get_dataset_schema", arguments: { dataset: "hospitals" } }));
  const trauma = r.fields.find((f: any) => f.name === "TRAUMA");
  assert.equal(trauma.examples.length, 55);
  assert.equal(trauma.all_values, true);
});

// ---- data source and honest totals ----

// A layer that reports its own limits and edit date, and answers count queries.
function describedFetch(opts: { total?: number; countFails?: boolean } = {}) {
  const calls: URL[] = [];
  const fn = (async (input: string | URL) => {
    const url = String(input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.endsWith("?f=json")) {
      return json({ ...layerJson, maxRecordCount: 2000, editingInfo: { dataLastEditDate: Date.UTC(2021, 7, 30) } });
    }
    const u = new URL(url);
    calls.push(u);
    if (u.searchParams.get("returnCountOnly")) {
      return opts.countFails ? new Response("boom", { status: 500 }) : json({ count: opts.total ?? 2 });
    }
    if (u.searchParams.get("returnDistinctValues")) return json({ features: [] });
    if (u.searchParams.get("geometryType")) return json(nearbyJson);
    return json(sampleJson);
  }) as typeof fetch;
  return { fn, calls };
}

test("every answer says where the data comes from and how old the layer is", async () => {
  globalThis.fetch = describedFetch().fn;
  const client = await connect();
  const schema = body(await client.callTool({ name: "get_dataset_schema", arguments: { dataset: "hospitals" } }));
  assert.equal(schema.data_source.living_atlas, false);
  assert.equal(schema.data_source.layer_last_edited, "2021-08-30");
  assert.match(schema.data_source.hosted_by, /FEMA/);

  const r = body(
    await client.callTool({ name: "find_nearby", arguments: { dataset: "hospitals", latitude: 34.1, longitude: -117.7 } }),
  );
  assert.equal(r.data_source.layer_last_edited, "2021-08-30");
  assert.ok(r.notes.some((n: string) => n.includes("last edited on 2021-08-30")));
});

test("only the cities layer is described as Living Atlas", () => {
  assert.equal(DATASETS.cities.source.living_atlas, true);
  assert.equal(DATASETS.hospitals.source.living_atlas, false);
  assert.equal(DATASETS.schools.source.living_atlas, false);
  for (const ds of Object.values(DATASETS)) {
    if (!ds.source.living_atlas) assert.doesNotMatch(ds.caveat + ds.description, /Living Atlas/);
  }
});

test("total_in_radius is the count for the radius asked for, not the rows returned", async () => {
  const { fn, calls } = describedFetch({ total: 137 });
  globalThis.fetch = fn;
  const r = body(
    await (await connect()).callTool({
      name: "find_nearby",
      arguments: { dataset: "hospitals", latitude: 34.1, longitude: -117.7, radius_miles: 40, limit: 1 },
    }),
  );
  assert.equal(r.total_in_radius, 137);
  assert.equal(r.results.length, 1);
  assert.equal(r.matches_in_effective_radius, 2);
  const count = calls.find((u) => u.searchParams.get("returnCountOnly"))!;
  assert.equal(count.searchParams.get("distance"), "40");
  assert.equal(count.searchParams.get("where"), "STATUS = 'OPEN'"); // same filter as the list
});

test("a failed count is reported as unknown, never as zero", async () => {
  globalThis.fetch = describedFetch({ countFails: true }).fn;
  const r = body(
    await (await connect()).callTool({ name: "find_nearby", arguments: { dataset: "hospitals", latitude: 34.1, longitude: -117.7 } }),
  );
  assert.equal(r.total_in_radius, null);
  assert.equal(r.results.length, 2);
});

test("asks for as many rows as the layer allows, not a fixed 200", async () => {
  const { fn, calls } = describedFetch();
  globalThis.fetch = fn;
  const r = body(
    await (await connect()).callTool({ name: "find_nearby", arguments: { dataset: "hospitals", latitude: 34.1, longitude: -117.7 } }),
  );
  assert.equal(r.fetch_cap, 2000);
  const list = calls.find((u) => u.searchParams.get("geometryType") && !u.searchParams.get("returnCountOnly"))!;
  assert.equal(list.searchParams.get("resultRecordCount"), "2000");
});

// ---- shared core: values, value groups, cache ----

const comparisonsOf = (where: string, fields: string[]) => {
  const r = checkWhere(where, fields);
  assert.ok(r.ok, where);
  return r.ok ? r.comparisons : [];
};

test("the gate records which quoted values each field is compared with", () => {
  const f = ["NAME", "STATUS", "TRAUMA", "BEDS"];
  assert.deepEqual(comparisonsOf("status = 'OPEN' and trauma not in ('I', 'O''NEIL')", f), [
    { field: "STATUS", negated: false, values: ["OPEN"] },
    { field: "TRAUMA", negated: true, values: ["I", "O'NEIL"] },
  ]);
  assert.deepEqual(comparisonsOf("STATUS <> 'CLOSED'", f), [{ field: "STATUS", negated: true, values: ["CLOSED"] }]);
  // Patterns, numbers and function calls are not value comparisons.
  assert.deepEqual(comparisonsOf("NAME LIKE '%MERCY%' AND BEDS = 100 AND UPPER(NAME) = 'X'", f), []);
});

const SCHEMA = [
  { name: "STATUS", examples: ["CLOSED", "OPEN"], all_values: true },
  { name: "TRAUMA", examples: ["LEVEL I", "LEVEL II", "I"], all_values: true },
  { name: "NAME", examples: ["Sample Hospital"] },
];
const valuesOf = (where: string) => checkValues(comparisonsOf(where, ["STATUS", "TRAUMA", "NAME"]), SCHEMA);

test("a value that is not in a coded field is refused, with the nearest real one", () => {
  const r = valuesOf("STATUS = 'OPENED'");
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /'OPENED' is not a value of STATUS/);
  assert.match((r as { error: string }).error, /Did you mean 'OPEN'\?/);
  assert.match((r as { error: string }).error, /'CLOSED', 'OPEN'/);
  assert.equal(valuesOf("TRAUMA IN ('LEVEL ONE', 'FIRST')").ok, false);
});

test("value check matches the way the layer compares text", () => {
  // The service ignores letter case and trailing spaces, so these do match rows.
  assert.deepEqual(valuesOf("STATUS = 'open'"), { ok: true, warnings: [] });
  assert.deepEqual(valuesOf("STATUS = 'OPEN '"), { ok: true, warnings: [] });
});

test("an IN list with some unknown values runs, and says which matched nothing", () => {
  const r = valuesOf("TRAUMA IN ('LEVEL I', 'LEVEL  I', 'I')");
  assert.equal(r.ok, true);
  assert.equal((r as { warnings: string[] }).warnings.length, 1);
  assert.match((r as { warnings: string[] }).warnings[0], /'LEVEL  I' is not a value of TRAUMA/);
});

test("value check leaves alone what it cannot judge", () => {
  assert.equal(valuesOf("NAME = 'ANYTHING'").ok, true); // full value list not known
  assert.equal(valuesOf("STATUS <> 'BOGUS'").ok, true); // excluding a missing value changes nothing
  assert.equal(valuesOf("STATUS NOT IN ('BOGUS')").ok, true);
  assert.equal(valuesOf("TRAUMA LIKE 'LEVEL ONE%'").ok, true); // patterns are not checked
});

test("ORDER BY accepts only fields with ASC or DESC", () => {
  const f = ["NAME", "BEDS"];
  assert.deepEqual(checkOrderBy("beds desc, name", f), { ok: true, orderBy: "BEDS DESC, NAME" });
  assert.deepEqual(checkOrderBy("", f), { ok: true, orderBy: "" });
  assert.equal(checkOrderBy("BEDZ DESC", f).ok, false);
  assert.equal(checkOrderBy("BEDS DESC NULLS LAST", f).ok, false);
  assert.equal(checkOrderBy("BEDS; DROP TABLE t", f).ok, false);
});

test("Level I rule: standalone I or 1, never II, III or IV", () => {
  for (const v of ["LEVEL I", "I", "LEVEL 1", "1", "LEVEL I, PEDIATRIC II", "PEDIATRIC LEVEL I", "I,PEDIATRIC I", "PEDIATRIC 1"]) {
    assert.equal(isLevelI(v), true, v);
  }
  for (const v of ["LEVEL II", "LEVEL III", "IV", "II, III PEDIATRIC", "NOT AVAILABLE", "LEVEL 2", "AREA", "LEVEL IV"]) {
    assert.equal(isLevelI(v), false, v);
  }
});

// A layer whose coded fields have known value lists.
function codedFetch(opts: { failDistinct?: () => boolean } = {}) {
  const calls: URL[] = [];
  const lists: Record<string, string[]> = {
    TRAUMA: ["LEVEL I", "LEVEL II", "I", "PEDIATRIC 1", "NOT AVAILABLE"],
    STATUS: ["OPEN", "CLOSED"],
    HELIPAD: ["Y", "N"],
  };
  const fn = (async (input: string | URL) => {
    const url = String(input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.endsWith("?f=json")) return json(layerJson);
    const u = new URL(url);
    calls.push(u);
    if (u.searchParams.get("returnDistinctValues")) {
      if (opts.failDistinct?.()) return new Response("boom", { status: 500 });
      const field = u.searchParams.get("outFields")!;
      return json({ features: (lists[field] ?? []).map((v) => ({ attributes: { [field]: v } })) });
    }
    if (u.searchParams.get("returnCountOnly")) return json({ count: 2 });
    if (u.searchParams.get("geometryType")) return json(nearbyJson);
    return json(sampleJson);
  }) as typeof fetch;
  return { fn, calls };
}

test("schema names the Level I spellings as a value group", async () => {
  globalThis.fetch = codedFetch().fn;
  const r = body(await (await connect()).callTool({ name: "get_dataset_schema", arguments: { dataset: "hospitals" } }));
  const trauma = r.fields.find((f: any) => f.name === "TRAUMA");
  assert.deepEqual(trauma.value_groups.LEVEL_I.values, ["I", "LEVEL I", "PEDIATRIC 1"]);
  assert.match(trauma.value_groups.LEVEL_I.description, /children only/);
});

test("find_nearby refuses a value that is not in the layer before asking ArcGIS", async () => {
  const { fn, calls } = codedFetch();
  globalThis.fetch = fn;
  const r: any = await (await connect()).callTool({
    name: "find_nearby",
    arguments: { dataset: "hospitals", latitude: 34.1, longitude: -117.7, where: "TRAUMA = 'LEVEL ONE'" },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /'LEVEL ONE' is not a value of TRAUMA/);
  assert.ok(!calls.some((u) => u.searchParams.get("geometryType")), "nothing should be sent to ArcGIS");
});

test("find_nearby passes on a warning for IN values that matched nothing", async () => {
  globalThis.fetch = codedFetch().fn;
  const r = body(
    await (await connect()).callTool({
      name: "find_nearby",
      arguments: { dataset: "hospitals", latitude: 34.1, longitude: -117.7, where: "TRAUMA IN ('LEVEL I', 'LEVEL  I')" },
    }),
  );
  assert.ok(r.notes.some((n: string) => n.includes("'LEVEL  I' is not a value of TRAUMA")));
  assert.equal(r.query_sent.where, "(TRAUMA IN ('LEVEL I', 'LEVEL  I')) AND STATUS = 'OPEN'");
});

test("checkFilter runs shape, values and the open-only rule in one call", async () => {
  globalThis.fetch = codedFetch().fn;
  const schema = await getSchema(DATASETS.hospitals);
  assert.deepEqual(checkFilter(DATASETS.hospitals, schema, "helipad = 'Y'"), {
    ok: true,
    where: "(HELIPAD = 'Y') AND STATUS = 'OPEN'",
    checked: "HELIPAD = 'Y'",
    openOnlyApplied: true,
    warnings: [],
  });
  assert.equal(checkFilter(DATASETS.hospitals, schema, "HELIPAD = 'YES'").ok, false);
  assert.equal(checkFilter(DATASETS.hospitals, schema, "HELIPADD = 'Y'").ok, false);
  const noOpen = checkFilter(DATASETS.hospitals, schema, "", { openOnly: false });
  assert.equal(noOpen.ok && noOpen.where, "1=1");
});

test("a schema whose value lists failed to load is not remembered", async () => {
  let fail = true;
  const { fn, calls } = codedFetch({ failDistinct: () => fail });
  globalThis.fetch = fn;
  const first = await getSchema(DATASETS.hospitals);
  assert.notEqual(first.find((f) => f.name === "STATUS")?.all_values, true);

  fail = false;
  const second = await getSchema(DATASETS.hospitals);
  assert.equal(second.find((f) => f.name === "STATUS")?.all_values, true);

  // Now complete, so the third call is served from the cache.
  const before = calls.length;
  await getSchema(DATASETS.hospitals);
  assert.equal(calls.length, before);
});

test("a cached schema expires after an hour", async (t) => {
  const { fn, calls } = codedFetch();
  globalThis.fetch = fn;
  t.mock.timers.enable({ apis: ["Date"] });
  await getSchema(DATASETS.hospitals);
  const before = calls.length;
  t.mock.timers.tick(59 * 60 * 1000);
  await getSchema(DATASETS.hospitals);
  assert.equal(calls.length, before);
  t.mock.timers.tick(2 * 60 * 1000);
  await getSchema(DATASETS.hospitals);
  assert.ok(calls.length > before);
});
