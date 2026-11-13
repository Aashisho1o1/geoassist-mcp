import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DATASETS, DATASET_IDS } from "./datasets.js";
import { getSchema, findNearby, getDataSource } from "./arcgis.js";
import { listHazards, getHazard, inUS, HAZARD_CATEGORIES } from "./eonet.js";
import { checkFields, checkFilter, openOnlyAdvice, MAX_WHERE_LENGTH } from "./core.js";

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
      title: "Describe a dataset",
      description:
        "Fields, types, and real example values for one public ArcGIS layer (hospitals, schools, or cities), " +
        "plus where the data comes from and when the layer was last edited. " +
        "Call this before writing a where filter so field names and value formats are right.",
      inputSchema: { dataset: z.enum(DATASET_IDS) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ dataset }) => {
      const ds = DATASETS[dataset];
      try {
        const fields = await getSchema(ds);
        return text({
          dataset: ds.id,
          name: ds.name,
          description: ds.description,
          data_source: await getDataSource(ds),
          fields,
          caveat: ds.caveat,
        });
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
        "with an optional where filter (for example HELIPAD = 'Y'). Coded fields such as TRAUMA are spelled many ways " +
        "('LEVEL I', 'I', 'LEVEL 1', 'PEDIATRIC LEVEL I', ...): get_dataset_schema lists every value, so filter with " +
        "IN (...) over all the spellings that match, not a single LIKE pattern. Where the schema gives a value_groups entry " +
        "(for example LEVEL_I on TRAUMA), use its values. A value that does not exist in a coded field is refused when it is written as FIELD = 'x' or FIELD IN (...) and joined to the rest of the filter by AND only; below an OR it comes back as a warning in notes, and after <>, NOT IN or NOT it is not checked. " +
        "Returns the exact query sent to ArcGIS so the person can see what was asked. " +
        "total_in_radius is the number of matches inside the radius asked for; results is only the closest few. " +
        "data_source says who hosts the layer and when it was last edited: tell the person if it is old.",
      inputSchema: {
        dataset: z.enum(DATASET_IDS),
        event_id: z.string().optional().describe("An id from list_active_hazards. Use this or latitude/longitude."),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        radius_miles: z.number().positive().max(MAX_RADIUS).default(25),
        where: z.string().max(MAX_WHERE_LENGTH).optional().describe("Optional SQL-style filter using only fields from get_dataset_schema."),
        open_only: z.boolean().default(true).describe("Hospitals only. If true (default), leaves out hospitals not marked OPEN in the layer's snapshot, unless the where filter itself asks for another STATUS value (for example STATUS = 'CLOSED') or uses STATUS in a form the check can't read (STATUS LIKE 'C%', STATUS IS NULL), which the answer's notes say. Set false to include every status. Has no effect on schools or cities."),
        out_fields: z.array(z.string().max(64)).max(30).optional().describe("Extra fields to return. Name and contact fields are always included."),
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

        // 2. Check the model's filter and fields against the live schema:
        //    field names, SQL shape, values of coded fields. Then leave closed
        //    facilities out by default (hospitals).
        const schema = await getSchema(ds);
        const names = schema.map((f) => f.name);
        const filter = checkFilter(ds, schema, args.where, { openOnly: args.open_only });
        if (!filter.ok) return fail(`${filter.error} Call get_dataset_schema to see the valid fields and values.`);
        const fields = checkFields(args.out_fields, names, ds.contactFields);
        if (!fields.ok) return fail(fields.error);

        // 3. Run it.
        const result = await findNearby(ds, {
          where: filter.where,
          outFields: fields.list,
          latitude: center.latitude,
          longitude: center.longitude,
          radiusMiles: args.radius_miles,
          limit: args.limit,
        });

        const isInsideUS = inUS(center.latitude, center.longitude);
        const dataSource = await getDataSource(ds);

        return text({
          center,
          radius_miles: args.radius_miles,
          ...result,
          data_source: dataSource,
          notes: [
            ds.caveat,
            dataSource.layer_last_edited
              ? `This layer was last edited on ${dataSource.layer_last_edited}. Anything that changed after that date is not in it.`
              : "This layer does not report when it was last edited, so its age is unknown.",
            "Distances are straight-line miles, not driving distance.",
            ...filter.warnings,
            ...(filter.statusUnread ? [openOnlyAdvice(filter.checked)] : []),
            ...(filter.openOnlyApplied
              ? [
                  filter.where === filter.checked
                    ? "Limited to hospitals marked OPEN in this snapshot, because the filter itself says STATUS = 'OPEN'. To include closed hospitals, change that part of the filter."
                    : "Limited to hospitals marked OPEN in this snapshot (STATUS = 'OPEN' was added). To include closed hospitals, set open_only: false or filter on STATUS = 'CLOSED'.",
                ]
              : []),
            ...(result.effective_radius_miles < args.radius_miles && result.closest_guaranteed
              ? [`This area is dense, so the search used a ${result.effective_radius_miles}-mile circle: small enough to fetch every place inside it, which guarantees these are the closest ones.`]
              : []),
            ...(!result.closest_guaranteed
              ? [`This area has more than ${result.fetch_cap} matches even within ${result.effective_radius_miles} miles, so these are the closest of a subset and a nearer place may be missing. Use a tighter filter or a smaller radius.`]
              : []),
            ...(!isInsideUS
              ? ["Center point is outside the US. These layers only cover US territory, so matches may be empty."]
              : []),
            ...(result.matches_in_effective_radius === 0 && isInsideUS
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
