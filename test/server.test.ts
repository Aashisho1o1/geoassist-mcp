import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/tools.js";
import { checkWhere, applyOpenOnly, checkValues, checkOrderBy } from "../src/where.js";
import { isAdultLevelI } from "../src/datasets.js";
import { checkFilter, getSchema } from "../src/core.js";
import { latestPoint, inUS } from "../src/eonet.js";
import { clearSchemaCache, arcgisRequest, MAX_GET_URL } from "../src/arcgis.js";
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
    // No value lists in the default mock, so coded fields keep their sampled
    // values and nothing is value-checked. Tests of the value check use codedFetch.
    if (url.includes("returnDistinctValues")) return json({ features: [] });
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
  // The pointer to the schema tool is added by the MCP layer, not the shared core.
  assert.match(r.content[0].text, /Call get_dataset_schema/);
  assert.equal(String((checkWhere("TRAUMMA = 'x'", ["TRAUMA"]) as { error: string }).error).includes("get_dataset_schema"), false);
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
    hasOr: false,
    hasNot: false,
    // BEDS > 100 is a range, not a recorded comparison.
    unread: ["BEDS"],
    required: [{ field: "STATE", negated: false, values: ["CA", "NV"] }],
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
  // ; and -- inside a quoted value are part of the value (real school names have them).
  assert.equal(checkWhere("NAME = 'A--B'", f).ok, true);
  assert.equal(checkWhere("NAME LIKE '%SMITH; JONES%'", f).ok, true);
  assert.equal(checkWhere("NAME = 'x' /* c */", f).ok, false);
  // The full Level I list is over 400 characters, so the cap leaves room for more conditions.
  assert.equal(checkWhere(`NAME IN (${Array(90).fill("'ABCDEFGH'").join(",")})`, f).ok, true);
  assert.equal(checkWhere(`NAME IN (${Array(120).fill("'ABCDEFGH'").join(",")})`, f).ok, false);
});

test("the gate notes OR and a negating NOT, but not NOT IN or IS NOT NULL", () => {
  const f = ["NAME", "STATE", "BEDS"];
  const flags = (w: string) => {
    const r = checkWhere(w, f);
    assert.ok(r.ok, w);
    return r.ok ? [r.hasOr, r.hasNot] : [];
  };
  assert.deepEqual(flags("STATE = 'CA' AND BEDS > 1"), [false, false]);
  assert.deepEqual(flags("STATE = 'CA' OR BEDS > 1"), [true, false]);
  assert.deepEqual(flags("NOT (STATE = 'CA')"), [false, true]);
  assert.deepEqual(flags("NOT STATE = 'CA'"), [false, true]);
  assert.deepEqual(flags("STATE NOT IN ('CA') AND NAME IS NOT NULL AND NAME NOT LIKE 'A%' AND BEDS NOT BETWEEN 1 AND 2"), [false, false]);
  assert.deepEqual(flags("NAME = 'this OR that, NOT both'"), [false, false]);
});

test("open-only rule is decided by what the filter asks of STATUS, not by text", () => {
  const f = ["NAME", "STATUS", "BEDS"];
  const open = (w: string) => {
    const r = checkWhere(w, f);
    assert.ok(r.ok, w);
    return applyOpenOnly("hospitals", r as Extract<typeof r, { ok: true }>);
  };
  assert.equal(open("NAME LIKE '%STATUS%'").where, "(NAME LIKE '%STATUS%') AND STATUS = 'OPEN'");
  assert.deepEqual(open(""), { where: "STATUS = 'OPEN'", applied: true });
  // Asking for another status switches the rule off.
  assert.deepEqual(open("status = 'CLOSED'"), { where: "STATUS = 'CLOSED'", applied: false });
  assert.equal(open("STATUS IN ('OPEN', 'CLOSED')").applied, false);
  assert.equal(open("STATUS <> 'OPEN'").applied, false);
  assert.equal(open("STATUS NOT IN ('open')").applied, false);
  assert.equal(open("NOT (STATUS = 'OPEN')").applied, false);
  assert.equal(open("BEDS > 5 OR STATUS = 'CLOSED'").applied, false);
  // Naming the field without asking for another status does not.
  assert.deepEqual(open("STATUS IS NOT NULL"), { where: "(STATUS IS NOT NULL) AND STATUS = 'OPEN'", applied: true });
  assert.equal(open("STATUS <> 'UNKNOWN'").where, "(STATUS <> 'UNKNOWN') AND STATUS = 'OPEN'");
  assert.equal(open("BEDS > 5 OR STATUS = 'OPEN'").where, "(BEDS > 5 OR STATUS = 'OPEN') AND STATUS = 'OPEN'");
  // Already limited to OPEN: nothing is added, and the answer still says so.
  assert.deepEqual(open("BEDS > 5 AND status = 'open'"), { where: "BEDS > 5 AND STATUS = 'open'", applied: true });
  assert.equal(applyOpenOnly("schools", { where: "1=1" }).applied, false);
});

test("open-only rule stays off, with a note, when STATUS is used in a form the gate can't read", () => {
  const f = ["NAME", "STATUS", "BEDS"];
  const open = (w: string) => {
    const r = checkWhere(w, f);
    assert.ok(r.ok, w);
    return applyOpenOnly("hospitals", r as Extract<typeof r, { ok: true }>);
  };
  // Each of these matches 354 closed hospitals live. Adding STATUS = 'OPEN'
  // would turn them into an empty answer.
  for (const w of [
    "STATUS LIKE 'C%'",
    "(STATUS) = 'CLOSED'",
    "UPPER(UPPER(STATUS)) = 'CLOSED'",
    "STATUS IN (('CLOSED'))",
    "STATUS BETWEEN 'A' AND 'D'",
    "STATUS NOT LIKE 'O%'",
    "STATUS = STATUS",
    // One unread use is enough, even next to a readable one.
    "STATUS = 'CLOSED' AND STATUS LIKE 'C%'",
  ]) {
    const r = open(w);
    assert.equal(r.applied, false, w);
    assert.equal(r.where, checkWhere(w, f).ok && (checkWhere(w, f) as { where: string }).where, w);
    assert.equal(r.statusUnread, true, w);
    assert.match(r.note ?? "", /in a form this check can't read, so hospitals not marked OPEN were not left out automatically/, w);
  }
  // STATUS IS NULL asks for rows without a status: STATUS = 'OPEN' would empty it.
  assert.equal(open("STATUS IS NULL").applied, false);
  assert.equal(open("STATUS IS NULL").statusUnread, true);
  // STATUS IS NOT NULL is read and keeps the rule on; negated, it asks for the others.
  assert.equal(open("STATUS IS NOT NULL").where, "(STATUS IS NOT NULL) AND STATUS = 'OPEN'");
  assert.deepEqual(open("NOT (STATUS IS NOT NULL)"), { where: "NOT (STATUS IS NOT NULL)", applied: false });
  // A top-level AND STATUS = 'OPEN' already limits every row, whatever else is
  // there. This is also the form the advice asks for, so following it settles it.
  for (const w of [
    "STATUS LIKE 'O%' AND STATUS = 'OPEN'",
    "(STATUS LIKE 'C%' OR NAME = 'X') AND STATUS = 'OPEN'",
    "NOT NAME = 'X' AND STATUS = 'OPEN'",
    "BEDS BETWEEN 1 AND 9 AND ((status = 'open'))",
    "'OPEN' = STATUS AND BEDS > 1",
  ]) {
    assert.deepEqual(open(w), { where: checkWhere(w, f).ok ? (checkWhere(w, f) as { where: string }).where : "", applied: true }, w);
  }
  // Not at the top level, or under NOT: not required, so the usual rules apply.
  assert.equal(open("STATUS LIKE 'C%' OR NAME = 'X' AND STATUS = 'OPEN'").applied, false);
  assert.equal(open("NOT STATUS = 'OPEN' AND BEDS > 1").applied, false);
  // Readable forms are unchanged.
  assert.equal(open("UPPER(STATUS) = 'CLOSED'").applied, false);
  assert.equal(open("UPPER(STATUS) = 'CLOSED'").note, undefined);
  assert.equal(open("'CLOSED' = STATUS").applied, false);
  assert.equal(open("NAME LIKE 'A%'").where, "(NAME LIKE 'A%') AND STATUS = 'OPEN'");
});

test("unread lists fields the comparison scan could not account for", () => {
  const f = ["NAME", "STATUS", "BEDS"];
  const unread = (w: string) => {
    const r = checkWhere(w, f);
    assert.ok(r.ok, w);
    return r.ok ? r.unread : [];
  };
  assert.deepEqual(unread("STATUS = 'OPEN' AND NAME IN ('A','B')"), []);
  assert.deepEqual(unread("'A' = NAME AND LOWER(STATUS) <> 'x'"), []);
  assert.deepEqual(unread("NAME IS NOT NULL AND STATUS IS NOT NULL"), []);
  assert.deepEqual(unread("NAME LIKE 'A%'"), ["NAME"]);
  assert.deepEqual(unread("STATUS IN ('A', 1)"), ["STATUS"]);
  assert.deepEqual(unread("NAME = 'A' AND NAME LIKE 'B%'"), ["NAME"]);
  assert.deepEqual(unread("NAME IS NULL"), ["NAME"]);
});

test("required lists the comparisons that are whole top-level AND terms", () => {
  const f = ["NAME", "STATUS", "BEDS"];
  const req = (w: string) => {
    const r = checkWhere(w, f);
    assert.ok(r.ok, w);
    return r.ok ? r.required.map((c) => `${c.negated ? "!" : ""}${c.field}:${c.values.join("|")}`) : [];
  };
  assert.deepEqual(req("STATUS = 'OPEN'"), ["STATUS:OPEN"]);
  assert.deepEqual(req("BEDS > 1 AND (STATUS IN ('OPEN')) AND NAME <> 'X'"), ["STATUS:OPEN", "!NAME:X"]);
  assert.deepEqual(req("UPPER(STATUS) = 'OPEN' AND LOWER(NAME) NOT IN ('a','b')"), ["STATUS:OPEN", "!NAME:a|b"]);
  assert.deepEqual(req("BEDS BETWEEN 1 AND 2 AND STATUS = 'OPEN'"), ["STATUS:OPEN"]);
  assert.deepEqual(req("STATUS = 'OPEN' OR BEDS > 1"), []);
  assert.deepEqual(req("(STATUS = 'OPEN' OR BEDS > 1) AND NAME = 'X'"), ["NAME:X"]);
  assert.deepEqual(req("NOT STATUS = 'OPEN' AND NOT (NAME = 'X')"), []);
  assert.deepEqual(req("(STATUS) = 'OPEN' AND STATUS = NAME"), []);
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

test("US test covers the territories that have hospitals in the layer", () => {
  assert.equal(inUS(13.4443, 144.7937), true, "Guam");
  assert.equal(inUS(15.21, 145.72), true, "Saipan");
  assert.equal(inUS(-14.29, -170.69), true, "Pago Pago");
  assert.equal(inUS(18.34, -64.91), true, "St Thomas");
  assert.equal(inUS(17.73, -64.75), true, "St Croix");
  assert.equal(inUS(18.45, -66.07), true, "San Juan");
  assert.equal(inUS(23.13, -82.38), false, "Havana");
  // A known limit, stated in the README: the main box takes in southern Canada.
  assert.equal(inUS(43.6532, -79.3832), true, "Toronto");
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
  // Patterns and numbers are not value comparisons.
  assert.deepEqual(comparisonsOf("NAME LIKE '%MERCY%' AND BEDS = 100 AND BEDS BETWEEN 1 AND 2", f), []);
  // The value first, and the field inside UPPER() or LOWER(), are the same comparison.
  assert.deepEqual(comparisonsOf("'OPEN' = STATUS AND 'I' <> trauma", f), [
    { field: "STATUS", negated: false, values: ["OPEN"] },
    { field: "TRAUMA", negated: true, values: ["I"] },
  ]);
  assert.deepEqual(comparisonsOf("UPPER(status) = 'OPEN' AND LOWER(TRAUMA) IN ('i')", f), [
    { field: "STATUS", negated: false, values: ["OPEN"] },
    { field: "TRAUMA", negated: false, values: ["i"] },
  ]);
  assert.deepEqual(comparisonsOf("NAME = 'A' AND STATUS = 'OPEN'", f).length, 2);
});

const SCHEMA = [
  { name: "STATUS", examples: ["CLOSED", "OPEN"], all_values: true },
  { name: "TRAUMA", examples: ["LEVEL I", "LEVEL II", "I"], all_values: true },
  { name: "NAME", examples: ["Sample Hospital"] },
  { name: "STATE", examples: ["AK", "AL", "AR", "AS", "AZ", "CA", "CO", "CT", "DC", "DE", "FL", "GA", "HI", "NC", "ND", "NE"], all_values: true },
  { name: "CAPITAL", examples: ["", "National", "State"], all_values: true },
  { name: "CITY", examples: ["O'FALLON", "SPRINGFIELD"], all_values: true },
  { name: "OWNER", examples: ["PROPRIETARY"], values_unavailable: true },
];
const SCHEMA_FIELDS = SCHEMA.map((f) => f.name);
const valuesOf = (where: string) => {
  const r = checkWhere(where, SCHEMA_FIELDS);
  assert.ok(r.ok, where);
  return checkValues(r.ok ? r.comparisons : [], SCHEMA, r.ok && !r.hasOr && !r.hasNot);
};
const errorOf = (where: string) => (valuesOf(where) as { error: string }).error;
const warningsOf = (where: string) => (valuesOf(where) as { warnings: string[] }).warnings;

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

test("with OR or NOT in the filter, an unknown value is a warning, not a refusal", () => {
  // Refusing is only right when the whole filter is provably empty.
  assert.equal(valuesOf("STATUS = 'OPENED' AND NAME = 'A'").ok, false);
  assert.equal(valuesOf("(STATUS = 'OPENED') AND (NAME = 'A')").ok, false);
  for (const w of ["STATUS = 'OPENED' OR NAME = 'A'", "NOT (STATUS = 'OPENED')", "NOT STATUS = 'OPENED'", "NAME = 'A' OR TRAUMA IN ('NOPE')"]) {
    const r = valuesOf(w);
    assert.equal(r.ok, true, w);
    assert.equal(warningsOf(w).length, 1, w);
    assert.match(warningsOf(w)[0], /so that part of the filter matches nothing/);
  }
  assert.match(warningsOf("STATUS = 'OPENED' OR NAME = 'A'")[0], /Did you mean 'OPEN'\?/);
});

test("an empty string is a value like any other", () => {
  assert.deepEqual(valuesOf("CAPITAL = ''"), { ok: true, warnings: [] });
  assert.deepEqual(valuesOf("CAPITAL IN ('', 'State')"), { ok: true, warnings: [] });
  assert.equal(valuesOf("STATUS = ''").ok, false);
});

test("the hint is only given when one value is clearly the nearest", () => {
  // Two-letter codes are within two edits of many others: no guess.
  assert.doesNotMatch(errorOf("STATE = 'CAL'"), /Did you mean/);
  assert.doesNotMatch(errorOf("STATE = 'NB'"), /Did you mean/);
  assert.match(errorOf("STATE = 'CAL'"), /STATE has 16 values in the layer and none is a near match/);
  assert.match(errorOf("TRAUMA = 'LEVEL 1'"), /Did you mean 'LEVEL I'\?/);
  // Equally near to 'LEVEL I' and 'LEVEL II' is a tie: no guess.
  assert.doesNotMatch(errorOf("TRAUMA = 'LEVEL IJ'"), /Did you mean/);
  assert.doesNotMatch(errorOf("TRAUMA = 'LEVEL ONE'"), /Did you mean/);
});

test("values with an apostrophe compare unescaped and print as SQL literals", () => {
  assert.deepEqual(valuesOf("CITY = 'o''fallon '"), { ok: true, warnings: [] });
  assert.match(errorOf("CITY = 'OFALLON'"), /Did you mean 'O''FALLON'\?/);
  assert.match(warningsOf("CITY IN ('SPRINGFIELD', 'O''FALON')")[0], /'O''FALON' is not a value of CITY/);
});

test("a field whose value list could not be read says its values were not checked", () => {
  const w = warningsOf("OWNER = 'ANYTHING'");
  assert.equal(w.length, 1);
  assert.match(w[0], /values of OWNER could not be read.*'ANYTHING' was not checked/);
  assert.deepEqual(warningsOf("OWNER <> 'ANYTHING'"), []);
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
  const methods: string[] = [];
  const lists: Record<string, string[]> = {
    TRAUMA: ["LEVEL I", "LEVEL II", "I", "PEDIATRIC 1", "NOT AVAILABLE"],
    STATUS: ["OPEN", "CLOSED"],
    HELIPAD: ["Y", "N"],
  };
  const fn = (async (input: string | URL, init?: RequestInit) => {
    // A POST carries the same parameters in its body.
    const url = init?.method === "POST" ? `${String(input)}?${String(init.body)}` : String(input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.endsWith("?f=json")) return json(layerJson);
    const u = new URL(url);
    calls.push(u);
    methods.push(init?.method ?? "GET");
    if (u.searchParams.get("returnDistinctValues")) {
      if (opts.failDistinct?.()) return new Response("boom", { status: 500 });
      const field = u.searchParams.get("outFields")!;
      return json({ features: (lists[field] ?? []).map((v) => ({ attributes: { [field]: v } })) });
    }
    if (u.searchParams.get("returnCountOnly")) return json({ count: 2 });
    if (u.searchParams.get("geometryType")) return json(nearbyJson);
    return json(sampleJson);
  }) as typeof fetch;
  return { fn, calls, methods };
}

test("a request URL over the GET limit is sent as a POST with the same parameters", () => {
  const short = "https://x.test/query?where=1%3D1&f=json";
  assert.deepEqual(arcgisRequest(short), { url: short, init: {} });
  const params = new URLSearchParams({ where: `NAME = '${"&".repeat(700)}'`, f: "json" });
  const long = `https://x.test/query?${params}`;
  assert.ok(long.length > MAX_GET_URL);
  const r = arcgisRequest(long);
  assert.equal(r.url, "https://x.test/query");
  assert.equal(r.init.method, "POST");
  assert.equal(new URLSearchParams(String(r.init.body)).get("where"), params.get("where"));
});

test("find_nearby with a long filter sends its queries as POST", async () => {
  const { fn, calls, methods } = codedFetch();
  globalThis.fetch = fn;
  const where = `NAME = '${"&".repeat(900)}'`;
  const r: any = await (await connect()).callTool({
    name: "find_nearby",
    arguments: { dataset: "hospitals", latitude: 34, longitude: -117, where },
  });
  assert.notEqual(r.isError, true);
  const spatial = calls.map((u, i) => ({ u, m: methods[i] })).filter(({ u }) => u.searchParams.get("geometryType"));
  assert.ok(spatial.length >= 2);
  for (const { u, m } of spatial) {
    assert.equal(m, "POST");
    assert.equal(u.searchParams.get("where"), `(${where}) AND STATUS = 'OPEN'`);
  }
});

test("find_nearby with an unreadable STATUS use says so and gives the form that keeps open ones", async () => {
  const { fn, calls } = codedFetch();
  globalThis.fetch = fn;
  const r: any = await (await connect()).callTool({
    name: "find_nearby",
    arguments: { dataset: "hospitals", latitude: 34, longitude: -117, where: "status like 'C%'" },
  });
  const out = body(r);
  assert.equal(out.query_sent.where, "STATUS LIKE 'C%'");
  assert.ok(out.notes.some((n: string) => /not left out automatically/.test(n)));
  assert.ok(out.notes.includes("To keep only open hospitals, send the filter as (STATUS LIKE 'C%') AND STATUS = 'OPEN'."));
  assert.ok(!out.notes.some((n: string) => /^Limited to hospitals marked OPEN/.test(n)));
  assert.ok(calls.length > 0);
});

test("schema names the Level I spellings as a value group", async () => {
  globalThis.fetch = codedFetch().fn;
  const r = body(await (await connect()).callTool({ name: "get_dataset_schema", arguments: { dataset: "hospitals" } }));
  const trauma = r.fields.find((f: any) => f.name === "TRAUMA");
  assert.deepEqual(trauma.value_groups.LEVEL_I.values, ["I", "LEVEL I", "PEDIATRIC 1"]);
  assert.match(trauma.value_groups.LEVEL_I.description, /children only/);
  assert.deepEqual(trauma.value_groups.LEVEL_I_ADULT.values, ["I", "LEVEL I"]);
});

test("adult Level I rule leaves out values that are Level I for children only", () => {
  for (const v of ["LEVEL I", "I", "1", "LEVEL 1", "LEVEL I, PEDIATRIC II", "I, II PEDIATRIC", "I , II PEDIATIRCS", "LEVEL I ADULT & PEDIATRIC", "I, I PEDIATRIC", "I,PEDIATRIC I", "LEVEL I, PEDIACTRIC II"]) {
    assert.equal(isAdultLevelI(v), true, v);
  }
  for (const v of ["PEDIATRIC 1", "PEDIATRIC I", "PEDIATRICS I", "PEDIATRIC LEVEL I", "I PEDIATRIC", "LEVEL I PEDIATRIC", "LEVEL II, PEDIATRIC I", "LEVEL II", "III", ""]) {
    assert.equal(isAdultLevelI(v), false, v);
  }
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
  assert.match(r.content[0].text, /Call get_dataset_schema/);
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
    statusUnread: false,
    warnings: [],
  });
  assert.equal(checkFilter(DATASETS.hospitals, schema, "HELIPAD = 'YES'").ok, false);
  assert.equal(checkFilter(DATASETS.hospitals, schema, "HELIPADD = 'Y'").ok, false);
  const noOpen = checkFilter(DATASETS.hospitals, schema, "", { openOnly: false });
  assert.equal(noOpen.ok && noOpen.where, "1=1");
  // OR keeps the filter alive, so the unknown value is reported, not refused.
  const or = checkFilter(DATASETS.hospitals, schema, "HELIPAD = 'YES' OR STATUS = 'OPEN'");
  assert.equal(or.ok && or.warnings.length, 1);
  // An unreadable STATUS use leaves the filter as written and says why in the warnings.
  const like = checkFilter(DATASETS.hospitals, schema, "STATUS LIKE 'C%'");
  assert.ok(like.ok);
  assert.equal(like.ok && like.where, "STATUS LIKE 'C%'");
  assert.equal(like.ok && like.openOnlyApplied, false);
  assert.match(like.ok ? like.warnings.join(" ") : "", /were not left out/);
  assert.equal(like.ok && like.statusUnread, true);
  // The core's messages do not name an MCP tool; the MCP layer adds that.
  for (const w of ["HELIPAD = 'YES'", "HELIPADD = 'Y'", "HELIPAD IN ()"]) {
    const r = checkFilter(DATASETS.hospitals, schema, w);
    assert.equal(!r.ok && r.error.includes("get_dataset_schema"), false, w);
  }
});

test("a failed value list is flagged on the field and in the answer", async () => {
  const { fn } = codedFetch({ failDistinct: () => true });
  globalThis.fetch = fn;
  const client = await connect();
  const schema = body(await client.callTool({ name: "get_dataset_schema", arguments: { dataset: "hospitals" } }));
  assert.equal(schema.fields.find((f: any) => f.name === "TRAUMA").values_unavailable, true);
  const r = body(
    await client.callTool({
      name: "find_nearby",
      arguments: { dataset: "hospitals", latitude: 34.1, longitude: -117.7, where: "TRAUMA = 'LEVEL ONE'" },
    }),
  );
  assert.ok(r.notes.some((n: string) => /values of TRAUMA could not be read/.test(n)));
});

test("an empty string in a value list is kept, null is dropped", async () => {
  const base = codedFetch().fn;
  globalThis.fetch = (async (input: string | URL) => {
    const u = new URL(String(input));
    if (u.searchParams.get("returnDistinctValues") && u.searchParams.get("outFields") === "HELIPAD") {
      return new Response(JSON.stringify({ features: [{ attributes: { HELIPAD: "" } }, { attributes: { HELIPAD: null } }, { attributes: { HELIPAD: "Y" } }] }), { status: 200 });
    }
    return base(input);
  }) as typeof fetch;
  const schema = await getSchema(DATASETS.hospitals);
  assert.deepEqual(schema.find((f) => f.name === "HELIPAD")?.examples, ["", "Y"]);
  assert.equal(checkFilter(DATASETS.hospitals, schema, "HELIPAD = ''").ok, true);
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
