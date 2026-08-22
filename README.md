# American Byways Maps

A hosted library and browser viewer for GPS maps exported from GaiaGPS, built as
a subsidiary site of [American Byways](https://americanbyways.com).

Two things live here:

1. **The library** (`index.html`) — a searchable catalogue of published maps,
   each downloadable in its original GPX/KML/KMZ form.
2. **The viewer** (`map.html`) — a Mapbox-ready map that renders those files over
   switchable topo, imagery and street basemaps, with stackable overlays,
   distance and elevation statistics, and a shareable URL for any view. It will
   also open a file straight from your own computer.

The whole thing is static: HTML, CSS and ES modules with no framework, no
bundler and no runtime dependencies. `npm` is used only for the local dev server
and the catalogue build script, both of which are plain Node.

---

## Quick start

```bash
npm start           # serves the site at http://localhost:8080
```

The site uses ES modules and `fetch()`, so it needs a real origin — opening
`index.html` from the filesystem will not work.

```bash
npm run build       # regenerate data/catalog.json from data/maps/
npm run check       # verify the committed catalogue is current (used by CI)
npm test            # run the parser and geometry test suite
```

---

## Publishing a map

1. **Export from GaiaGPS.** Open the track, folder or saved map and choose
   *Export*.
   - **GPX** is the best default: tracks, routes, waypoints, elevation and
     per-point timestamps all survive.
   - **KML/KMZ** is better when you want folder grouping and per-feature colours
     preserved.

2. **Drop the file into `data/maps/`.** Use a stable, descriptive filename —
   it becomes the download URL.

3. **Optionally add a sidecar** named after the file, e.g.
   `data/maps/cherohala-skyway.meta.json`:

   ```json
   {
     "title": "Cherohala Skyway",
     "description": "The full ridge run from Tellico Plains to Robbinsville.",
     "region": "Southern Appalachians",
     "tags": ["byway", "driving", "fall color"],
     "slug": "cherohala-skyway",
     "updated": "2025-10-11T13:40:00Z"
   }
   ```

   Every field is optional. Without a sidecar the builder uses the map's own
   embedded name, or derives a title from the filename.

4. **Run `npm run build` and commit both the map file and `data/catalog.json`.**

The builder measures each file rather than trusting metadata: bounds, distance,
ascent, descent, elevation range, duration and feature counts are all computed
from the geometry, using the same code the viewer runs in the browser.

### Supported formats

| Format | Extension | Notes |
| --- | --- | --- |
| GPX 1.0 / 1.1 | `.gpx` | Tracks (incl. multi-segment), routes, waypoints, elevation, timestamps, Garmin `DisplayColor` and `gpx_style` colours |
| KML | `.kml` | Placemarks, folders, `Style`/`StyleMap` colours, polygons, `MultiGeometry`, `gx:Track`, `ExtendedData` |
| KMZ | `.kmz` | Unzipped in the browser via `DecompressionStream`; the first `.kml` entry is used |
| GeoJSON | `.geojson` | Passed through, with feature kinds inferred from geometry type |

---

## Configuration

Everything an operator normally changes lives in
[`assets/js/config.js`](assets/js/config.js): site name and tagline, the parent
site link, the default view and units, the Mapbox token, and the full
basemap/overlay catalogue.

### Adding a Mapbox token

```js
export const MAPBOX_TOKEN = 'pk.your_public_token_here';
```

That is the only change required. With a token present the site loads Mapbox GL
JS instead of MapLibre GL, and the Mapbox styles in `BASEMAPS` — which are hidden
without one — appear in the layer picker. Without a token the site runs fully on
the open USGS/Esri/OpenStreetMap basemaps and needs no account at all.

A `pk.*` token is a **public** token and is meant to ship in client code, but
restrict it to your domain in the Mapbox account settings so it cannot be reused
elsewhere. Set `MAP_ENGINE` to `'mapbox'` or `'maplibre'` to override the
automatic choice.

### Adding a custom layer

Append to `BASEMAPS` or `OVERLAYS`. Any XYZ raster tile service works:

```js
{
  id: 'usfs-roads',
  name: 'Forest Service roads',
  description: 'Motor vehicle use map road classes.',
  tiles: ['https://example.org/tiles/{z}/{x}/{y}.png'],
  tileSize: 256,
  maxzoom: 16,
  opacity: 0.9,
  enabled: false,
  attribution: 'Data © the publishing agency',
}
```

Note that ArcGIS and USGS services use `{z}/{y}/{x}` order — the y and x are
swapped relative to the usual XYZ convention. Overlays get an independent
visibility toggle and opacity slider in the viewer with no further code.

### Layer sources

The bundled basemaps and overlays point at public tile services run by USGS,
Esri and the OpenStreetMap Foundation. They are configured but **were not
reachable from the sandbox this was built in**, so confirm each one renders in
your browser before relying on it, and review each provider's terms — the
OSM tile policy in particular is intended for modest traffic. If any endpoint
has moved, the fix is a URL edit in `config.js`.

---

## Deploying

`.github/workflows/pages.yml` runs the test suite, verifies `data/catalog.json`
matches `data/maps/`, and deploys to GitHub Pages on every push to `main`.

To enable it: **Settings → Pages → Build and deployment → Source: GitHub
Actions.**

For a custom subdomain such as `maps.americanbyways.com`, add a `CNAME` file at
the repository root containing the hostname, and point a DNS CNAME record at
`<user>.github.io`.

Nothing about the site is Pages-specific — it is a directory of static files and
will deploy to Netlify, Cloudflare Pages, S3 or any web server just as happily.

---

## How it is put together

```
index.html                  library / landing page
map.html                    the viewer
assets/
  css/site.css              design tokens, shared chrome, landing page
  css/viewer.css            the viewer's app shell
  js/config.js              ← branding, Mapbox token, basemaps, overlays
  js/home.js                landing page: catalogue rendering and filters
  js/viewer.js              the viewer application
  js/lib/
    xml.js                  dependency-free XML parser (browser + Node)
    gpx.js  kml.js  kmz.js  format readers → GeoJSON
    parse.js                format dispatch + distance/elevation statistics
    geo.js                  haversine, bounds, simplification, formatting
    engine.js               Mapbox GL / MapLibre GL loader and style builder
    catalog.js  ui.js  icons.js
data/
  maps/                     published map files (+ optional .meta.json sidecars)
  catalog.json              generated — do not edit by hand
tools/
  build-catalog.mjs         scans data/maps/, writes data/catalog.json
  serve.mjs                 local dev server
test/parsers.test.mjs       parser and geometry tests
```

Two decisions are worth knowing about:

**The parsers run in both environments.** `assets/js/lib/` has no DOM or Node
dependencies — the XML parser is hand-written precisely so the browser and the
build script share one implementation. The distance shown on a catalogue card and
the distance shown in the viewer cannot drift apart, because they are the same
function.

**The viewer is written against the Mapbox GL API.** MapLibre GL implements the
same surface, so the site works today with no account and no key, and adopting
Mapbox later is a config change rather than a rewrite. That is what makes the
"long term, move to Mapbox with custom layers" path cheap.

---

## Where this is going

- **Shipped** — hosted library, viewer, client-side GPX/KML/KMZ parsing,
  stackable overlays, elevation profiles, shareable views.
- **Next** — Mapbox vector styles, 3D terrain and Mapbox Studio layers behind the
  existing engine abstraction.
- **Next** — an offline-capable installable version with cached tiles, which is
  the part of GaiaGPS that matters most away from signal.
- **Later** — drawing and editing routes in the browser and exporting them back
  out as GPX.

---

## Licence and attribution

Site code is © American Byways. Published track data is © its contributors.
Basemap and overlay tiles belong to their respective providers (USGS, Esri, the
OpenStreetMap contributors, Mapbox) and are subject to those providers' terms and
attribution requirements, which the viewer displays in the map's attribution
control.

The two `sample-*` files in `data/maps/` are **synthetic demonstration data**.
Their coordinates were generated, not surveyed, and they do not describe real
roads. Delete them once you have published real maps.
