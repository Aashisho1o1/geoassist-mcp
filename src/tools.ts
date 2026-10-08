import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DATASETS, DATASET_IDS } from "./datasets.js";
import { getSchema, findNearby } from "./arcgis.js";
import { listHazards, getHazard, inUS, HAZARD_CATEGORIES } from "./eonet.js";
import { checkWhere, checkFields } from "./where.js";

const MAX_RADIUS = 100;
const MAX_LIMIT = 25;

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});
const fail = (err: unknown) => ({
  content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});

export function buildServer(): McpServer {
  const server = new McpServer({ name: "geoassist-hazard-proximity", version: "0.1.0" });

  server.registerTool(
    "list_active_hazards",
    {
      title: "List active natural hazards in the US",
      description:
        "Open wildfires, severe storms, volcanoes, or floods in the US from NASA EONET, newest first. " +
        "Use an event id from here with find_nearby to see which hospitals or schools are close to it.",
      inputSchema: {
        category: z.enum(HAZARD_CATEGORIES).default("wildfires"),
        days: z.number().int().min(1).max(60).default(14).describe("Only events reported in the last N days."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ category, days }) => {
      try {
        const hazards = await listHazards(category, days);
        return text({
          count: hazards.length,
          hazards,
          note: "Locations are the latest point NASA EONET reported, not a fire perimeter or storm footprint.",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_dataset_schema",
    {
      title: "Describe a Living Atlas dataset",
      description:
        "Fields, types, and real example values for one dataset (hospitals, schools, or cities). " +
        "Call this before writing a where filter so field names and value formats are right.",
      inputSchema: { dataset: z.enum(DATASET_IDS) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ dataset }) => {
      const ds = DATASETS[dataset];
      try {
        const fields = await getSchema(ds);
        return text({ dataset: ds.id, name: ds.name, description: ds.description, fields, caveat: ds.caveat });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "find_nearby",
    {
      title: "Find places near a hazard or a point",
      description:
        "Hospitals, schools, or cities within a radius of an EONET event or a lat/lon point, closest first, " +
        "with an optional where filter (for example TRAUMA LIKE 'LEVEL I%'). Returns the exact query sent " +
        "to ArcGIS so the person can see what was asked.",
      inputSchema: {
        dataset: z.enum(DATASET_IDS),
        event_id: z.string().optional().describe("An id from list_active_hazards. Use this or latitude/longitude."),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        radius_miles: z.number().positive().max(MAX_RADIUS).default(25),
        where: z.string().optional().describe("Optional SQL-style filter using only fields from get_dataset_schema."),
        out_fields: z.array(z.string()).optional().describe("Extra fields to return. Name and contact fields are always included."),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const ds = DATASETS[args.dataset];
      try {
        // 1. Resolve the center point.
        let center: { latitude: number; longitude: number; label: string; hazard?: unknown };
        if (args.event_id) {
          const h = await getHazard(args.event_id);
          center = { latitude: h.latitude, longitude: h.longitude, label: h.title, hazard: h };
        } else if (args.latitude !== undefined && args.longitude !== undefined) {
          center = { latitude: args.latitude, longitude: args.longitude, label: "given point" };
        } else {
          return fail("Give either event_id or both latitude and longitude.");
        }

        // 2. Check the model's filter and fields against the live schema.
        const names = (await getSchema(ds)).map((f) => f.name);
        const where = checkWhere(args.where, names);
        if (!where.ok) return fail(where.error);
        const fields = checkFields(args.out_fields, names, ds.contactFields);
        if (!fields.ok) return fail(fields.error);

        // 3. Run it.
        const result = await findNearby(ds, {
          where: where.where,
          outFields: fields.list,
          latitude: center.latitude,
          longitude: center.longitude,
          radiusMiles: args.radius_miles,
          limit: args.limit,
        });

        const isInsideUS = inUS(center.latitude, center.longitude);

        return text({
          center,
          radius_miles: args.radius_miles,
          ...result,
          notes: [
            ds.caveat,
            "Distances are straight-line miles, not driving distance.",
            ...(!isInsideUS
              ? ["Center point is outside the US. The queried Living Atlas layers only cover US territory, so matches may be empty."]
              : []),
            ...(result.matches_found === 0 && isInsideUS
              ? ["Nothing matched. Try a larger radius or a looser filter before concluding there is none."]
              : []),
          ],
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
