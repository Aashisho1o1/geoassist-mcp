# GeoAssist Hazard Proximity (MCP)

**[Try the live map →](https://aashisho1o1.github.io/geoassist-mcp/)** No install, no sign-in. It opens on a real active US wildfire.

When a wildfire or a severe storm is active, the first questions are usually simple ones. Which hospitals are close to it? Which schools might need to close or serve as shelters? Is there a trauma center with a helipad nearby?

The data to answer those questions is already public in Esri's Living Atlas, and NASA EONET already tracks the events. This MCP server connects the two, so anyone using Claude Desktop, Cursor, or another MCP client can ask in plain English and get a short list of nearby places, closest first, with phone numbers.

It grew out of two earlier projects of mine: a NASA EONET disaster monitor I built at Soka, and GeoAssist, a natural-language front end for ArcGIS Feature Services.

## The live map

The [demo](https://aashisho1o1.github.io/geoassist-mcp/) is a static page built with the ArcGIS Maps SDK for JavaScript. It calls NASA EONET and the Living Atlas layers straight from the browser, and it runs the server's own compiled modules (`docs/lib/`, copied by `npm run build:demo`). The filter check, the distance search, and the hazard handling you see on the map are the same code an AI client reaches through MCP.

Things to try on it:

- Pick a fire, then **Level I trauma**. A card shows how many Level I hospitals an exact `TRAUMA = 'LEVEL I'` filter finds nationwide, and how many it misses.
- Open **Write your own filter** and try the typo. It is refused with "Did you mean 'TRAUMA'?" before anything is sent to ArcGIS.
- Switch to **Schools → Has a shelter ID** to see which nearby schools have a shelter ID in the layer.
- Open **How this answer was made** to see the exact query, with a link that runs it in the ArcGIS REST API.

## What I found in the data

The hospital layer's `TRAUMA` field is free text. Level I alone is written 16 different ways: `LEVEL I`, `LEVEL  I` (two spaces), `I`, `LEVEL I TRAUMA`, `LEVEL I ADULT/PEDIATRIC`, `PEDIATRIC 1`, and more. When I checked, a filter for exactly `'LEVEL I'` found 98 open Level I hospitals in the US and missed 142.

A query like that doesn't fail. It returns a shorter list, and nothing tells the reader that most of the answers are missing. So the server now sends the model the full list of values for coded fields, and its tool description tells the model to match every spelling, not a single `LIKE` pattern.

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
- Closed hospitals are left out by default (`STATUS = 'OPEN'`), since sending someone to a closed hospital is worse than a shorter list.
- `get_dataset_schema` shows real values (for example `TRAUMA = 'LEVEL II'`), because one example teaches the format better than a description. For coded fields like `TRAUMA`, `HELIPAD`, and `STATUS` it lists every value in the layer.
- Feature services return at most 200 matches, in storage order rather than by distance. In a dense city a 25-mile circle can hold thousands of schools, so those 200 would be an arbitrary subset. When that happens the server searches for a smaller circle that fits under the cap and still holds enough results, then sorts by distance. If even that isn't possible, the answer says the list is not guaranteed to be the closest.
- Each result includes its latitude and longitude, so a client can put it on a map.

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

### Live map, locally

```bash
npm run build:demo
python3 -m http.server 8080 --directory docs
```

Then open http://localhost:8080. `build:demo` copies the compiled server modules into `docs/lib/`, so run it after changing anything in `src/`.

### MCP Inspector

To call the tools by hand without an AI client:

```bash
npm run inspect
```

## Things to try

- "What wildfires are active in the US right now?"
- "For the newest fire in California, which hospitals with a trauma center are within 30 miles?"
- "List public schools within 10 miles of that fire with enrollment over 1,000."
- "Which hospitals near 34.1, -117.7 have a helipad?"

## Limits

- EONET gives a point for each event, not a fire perimeter or storm footprint. Distances are straight-line miles from that point, not driving distance.
- The hospital and school layers are public snapshots, not live status.
- Coverage is the US only, since the Living Atlas layers used here are US datasets.

## Tests

`npm test` runs the server end to end through a real MCP client with ArcGIS and EONET mocked, so it works offline. It covers distance sorting, the where gate, field suggestions, US filtering, polygon events, the open-only default, the full value lists for coded fields, and the dense-area radius search.
