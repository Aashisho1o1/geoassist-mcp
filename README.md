# GeoAssist Hazard Proximity (MCP)

When a wildfire or a severe storm is active, the first questions are usually simple ones. Which hospitals are close to it? Which schools might need to close or serve as shelters? Is there a trauma center with a helipad nearby?

The data to answer those questions is already public in Esri's Living Atlas, and NASA EONET already tracks the events. This MCP server connects the two, so anyone using Claude Desktop, Cursor, or another MCP client can ask in plain English and get a short list of nearby places, closest first, with phone numbers.

It grew out of two earlier projects of mine: a NASA EONET disaster monitor I built at Soka, and GeoAssist, a natural-language front end for ArcGIS Feature Services.

## Tools

| Tool | What it does |
| --- | --- |
| `list_active_hazards` | Open US wildfires, severe storms, volcanoes, or floods from NASA EONET, newest first. |
| `get_dataset_schema` | Fields, types, and real example values for the hospitals, schools, or cities layer. |
| `find_nearby` | Places within a radius of an EONET event or a lat/lon point, sorted by distance, with an optional filter. Returns the exact query sent to ArcGIS. |

## How it is built, and why

The model proposes and the server decides. There is no LLM call inside this server. The AI client writes the filter, and plain TypeScript checks it against the live layer schema before anything reaches ArcGIS:

- every field name must exist in the layer (a typo like `TRAUMMA` comes back with "Did you mean 'TRAUMA'?")
- `;`, `--`, `/*`, and any word that is not a field or a basic SQL keyword are rejected
- radius is capped at 100 miles and results at 25

I built it this way because a wrong answer here is worse than no answer. If the model guesses a field name, the old GeoAssist would quietly return an empty map, and someone might read that as "there is no hospital nearby." Here the guess is caught and the model gets a message it can fix.

A few other choices made with the person on the other end in mind:

- Name, address, phone, and status are always returned, even if the model forgets to ask for them.
- Every result carries a note that the data can be out of date and that an emergency means calling 911.
- An empty result tells the model to widen the search before concluding nothing is there.
- `get_dataset_schema` shows real values (for example `TRAUMA = 'LEVEL II'`), because one example teaches the format better than a description.
- Feature services return matches in storage order, so the server pulls up to 200 inside the radius and sorts them by distance itself.

Because there is no LLM inside, there is also no API key to protect and no cost to run it. All three data sources are public.

## Setup

Requires Node 20 or later.

```bash
npm install
npm run build
npm test
```

### Claude Desktop

Add this to `claude_desktop_config.json` (Settings, Developer, Edit Config), using the full path to this folder:

```json
{
  "mcpServers": {
    "geoassist": {
      "command": "node",
      "args": ["/full/path/to/geoassist-mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop and the three tools appear.

### MCP Inspector

To call the tools by hand without an AI client:

```bash
npm run inspect
```

## Things to try

- "What wildfires are active in the US right now?"
- "For the newest fire in California, which hospitals with a trauma center are within 30 miles?"
- "List public schools within 10 miles of that fire, biggest enrollment first."
- "Which hospitals near 34.1, -117.7 have a helipad?"

## Limits

- EONET gives a point for each event, not a fire perimeter or storm footprint. Distances are straight-line miles from that point, not driving distance.
- The hospital and school layers are public snapshots, not live status.
- Coverage is the US only, since the Living Atlas layers used here are US datasets.

## Tests

`npm test` runs the server end to end through a real MCP client with ArcGIS and EONET mocked, so it works offline. It covers distance sorting, the where gate, field suggestions, US filtering, and polygon events.
