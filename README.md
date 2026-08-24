# American Byways GPS

A hosted library and browser viewer for GPS maps exported from GaiaGPS, built as
a subsidiary site of [American Byways](https://americanbyways.com).

The site opens directly into the map. Three things live here:

1. **The map** (`index.html`) — the homepage. A Mapbox-ready map with switchable
   topo, imagery and street basemaps, stackable overlays, distance and elevation
   statistics, and a shareable URL for any view. It will open a GPX, KML, KMZ or
   GeoJSON file straight from your own computer.
2. **Folders** — your own organisation of saved waypoints and tracks, built
   inside the map. Import waypoints out of any file into a folder, move them
   between folders, and export a folder back out as GPX.
3. **The library** (`library.html`) — a searchable catalogue of published maps,
   each downloadable in its original GPX/KML/KMZ form.

`map.html` redirects to the homepage, preserving any query and hash, so older
links keep working.

The whole thing is static: HTML, CSS and ES modules with no framework, no
bundler and no runtime dependencies. `npm` is used only for the local dev server
and the catalogue build script, both of which are plain Node.

---

## Quick start

```bash
npm start           # serves the site at http://localhost:8080
```

That opens on the map. The catalogue is at `/library.html`.

The site uses ES modules and `fetch()`, so it needs a real origin — opening
`index.html` from the filesystem will not work.

```bash
npm run build       # regenerate data/catalog.json from data/maps/
npm run check       # verify the committed catalogue is current (used by CI)
npm run dist        # stage an upload-ready copy in dist/ (plus a .zip)
npm test            # run the parser and geometry test suite
```

Two further checks need tools installed, so they are not part of `npm test`:

```bash
npm run validate:style   # check the Byways Topo style against the GL style spec
                         # needs: npm install --no-save @mapbox/mapbox-gl-style-spec

npm run smoke            # drive the real app in a browser against a stubbed
                         # map engine — basemap switches, saved pins, the
                         # Details panel's memory across a reload
                         # needs: npm install --no-save playwright
```

`npm run smoke` builds `dist/` and serves that build on a port it picks itself,
so it always tests the current source. Set `SMOKE_URL` to point it at a deployed
origin instead, and `CHROMIUM_PATH` if Playwright's browser lives somewhere it
cannot find on its own.

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

## The panel

Four tabs:

- **Layers** — the basemap (pick one) and overlays (stack any number).
- **Folders** — your saved collection, plus the files you have opened this
  session and the drop zone that files their waypoints away.
- **Waypoints** — every saved waypoint in one flat searchable list. The folder
  tree answers "what is in this trip"; this answers "where did I save that
  spring", which is the question you actually have in the field.
- **Details** — everything known about the selected pin: coordinates in four
  formats with one-press copying, elevation, distance and bearing from where you
  are, sunrise and sunset, and the nearest town and address.

Everything in Details except the place lookup is arithmetic done on the device,
which is deliberate: that panel is most useful where there is no signal.

## Folders and pin styling

Folders are the map's own organiser, and they are entirely client-side.

- **Create** a folder from the Folders tab, or from the map's floating
  **Folders** button.
- **Import into it** with *Import from a map…*: pick any loaded map, choose
  waypoints / tracks / everything, and choose the destination. Tick *split into
  folders using the file's own folder names* and a KML's folder structure is
  reproduced as separate folders.
- **Save a single point** by clicking it on the map and choosing *Save to
  folder* in the popup.
- **Move items** by dragging them onto another folder, or via *Move to…* in a
  saved item's popup.
- **Export** a folder as GPX from the download button in its header.
- **Style a pin** with the brush button on its row: pick a colour and one of
  ~47 icons grouped by Camp / Water / Terrain / Access / Services / Interest /
  Hazard.
- **Style many at once** by ticking pins and using the brush in the folder
  header — with nothing ticked it applies to the whole folder. Only the fields
  you actually touch are applied, so changing an icon in bulk leaves everyone's
  colours alone.

Imported files bring their own styling where they have any. GPX `<sym>` values
(GaiaGPS and Garmin write one on every waypoint) and KML `IconStyle` names are
matched to the icon set on import, so a GaiaGPS export arrives already looking
like something rather than as a field of identical dots. Track and route
colours from GPX `DisplayColor`/`gpx_style` and KML `LineStyle` were already
honoured. Per-pin styling overrides the folder's colour; clearing an override
falls back to it.

Two behaviours worth knowing:

**A folder owns copies of what you put in it.** It does not reference the source
file. Unload the map, change the catalogue, or come back tomorrow — the folder
is unaffected. It is your collection, not a view over someone else's data.

**Folders live in this browser.** They are stored in `localStorage`: not
uploaded, not synced, not visible to anyone else, and not carried to another
device. The UI says so, and warns if the browser refuses storage entirely
(private mode, blocked site data). Export as GPX to keep or move a folder.
Re-importing the same points is safe — duplicates are detected by name and
position and skipped.

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

### Photos on pins

Photos attach to a saved pin and are stored in IndexedDB, not localStorage — a
single phone photo would exhaust the few megabytes localStorage allows and take
the folders down with it. The pin records only photo ids; images up to 8 MB each
are held separately, and orphans are swept on load.

Import offers "also download photos the file links to". Expect it to fail for
GaiaGPS: a browser may not read another site's images unless that site sends
CORS headers, and Gaia does not. The attempt is still worth making for
permissive hosts, and the failure says exactly why rather than going quiet. Add
those photos from your device instead.

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

## Deploying by FTP

Optional, and not how the live site is published — see GitHub Pages below.
`.github/workflows/deploy-ftp.yml` is manual-run only, kept for the day a real
domain points at shared hosting.

`npm run dist` rebuilds the catalogue, then stages everything the live site
needs — and nothing else — into `dist/`, along with:

- **`.htaccess`** — correct MIME types for `.gpx`/`.kml`/`.kmz` (shared hosts
  often serve them as `text/plain`, which breaks the download links),
  compression, short cache lifetimes, and a commented-out HTTPS redirect.
- **`UPLOAD-INSTRUCTIONS.txt`** — the same guidance in plain text, so it
  travels with the files.
- **`american-byways-maps.zip`** — the same tree as an archive, for hosts whose
  file manager can upload and extract one.

The test suite, `tools/`, `package.json` and the git metadata are deliberately
excluded: a web server has no business serving them.

Upload the contents of `dist/` to `public_html/` (whole domain) or
`public_html/maps/` (subfolder). Both work — the site uses no absolute paths,
so it runs from any directory depth without edits.

Two things that catch people out:

- **HTTPS is not optional.** The geolocate button silently fails on plain
  `http://`; browsers only expose the Geolocation API on secure origins.
- **Restrict your Mapbox token to the deployed domain** if you have added one.
- **Confirm the document root before trusting a deploy.** An FTP upload writes
  where you tell it to and cannot know whether the web server reads that
  directory; when the two disagree, every run succeeds and the site never
  changes. Fetch `deployed.txt` from the site and check the commit it names.

---

## Deploying with GitHub Pages

This is the live host: <https://shermancahal.github.io/Map/>

`.github/workflows/deploy-pages.yml` runs the test suite, verifies
`data/catalog.json` matches `data/maps/`, builds `dist/`, and publishes it on
every push to `main` or a `claude/**` branch.

To enable it on a fresh clone: **Settings → Pages → Build and deployment →
Source: GitHub Actions.**

Every deploy writes `deployed.txt` alongside the site, carrying the commit,
branch, run number, build time and host. Fetch it before concluding anything
about which version is live — the site shows its version nowhere else, and a
deploy that quietly changed nothing looks exactly like one that worked.

For a custom subdomain such as `maps.americanbyways.com`, add a `CNAME` file at
the repository root containing the hostname, and point a DNS CNAME record at
`<user>.github.io`.

Nothing about the site is Pages-specific — it is a directory of static files and
will deploy to Netlify, Cloudflare Pages, S3 or any web server just as happily.
Pages is chosen here because it serves the artifact the workflow uploads or
fails loudly, with no document root to misconfigure.

---

## How it is put together

```
index.html                  the map — the homepage
library.html                the published-map catalogue
map.html                    redirect to the homepage (legacy links)
assets/
  css/site.css              design tokens, shared chrome, landing page
  css/viewer.css            the viewer's app shell
  js/config.js              ← branding, Mapbox token, basemaps, overlays
  js/home.js                library page: catalogue rendering and filters
  js/viewer.js              the map application
  js/lib/
    xml.js                  dependency-free XML parser (browser + Node)
    gpx.js  kml.js  kmz.js  format readers → GeoJSON
    gpx-write.js            GeoJSON → GPX, for folder export
    folders.js              the folder store (state, de-duplication, persistence)
    parse.js                format dispatch + distance/elevation statistics
    geo.js                  haversine, bounds, simplification, formatting
    engine.js               Mapbox GL / MapLibre GL loader and style builder
    catalog.js  ui.js  icons.js
data/
  maps/                     published map files (+ optional .meta.json sidecars)
  catalog.json              generated — do not edit by hand
tools/
  build-catalog.mjs         scans data/maps/, writes data/catalog.json
  build-dist.mjs            stages an upload-ready copy in dist/
  zip.mjs                   dependency-free ZIP writer used by build-dist
  serve.mjs                 local dev server
assets/js/lib/sky.js        sun, moon and galactic core positions and times
assets/js/lib/storms.js     NWS warnings and published storm motion
test/parsers.test.mjs       parser and geometry tests
test/folders.test.mjs       folder store and GPX writer tests
```

Two decisions are worth knowing about:

**The parsers run in both environments.** `assets/js/lib/` has no DOM or Node
dependencies — the XML parser is hand-written precisely so the browser and the
build script share one implementation. The distance shown on a catalogue card and
the distance shown in the viewer cannot drift apart, because they are the same
function.

**The map is written against the Mapbox GL API.** MapLibre GL implements the
same surface, so the site works today with no account and no key, and adopting
Mapbox later is a config change rather than a rewrite. That is what makes the
"long term, move to Mapbox with custom layers" path cheap.

---

## Where this is going

- **Shipped** — map-first homepage, hosted library, client-side GPX/KML/KMZ
  parsing, stackable overlays, elevation profiles, shareable views, and folders
  for organising saved waypoints with GPX export.
- **Next** — Mapbox vector styles, 3D terrain and Mapbox Studio layers behind the
  existing engine abstraction.
- **Next** — an offline-capable installable version with cached tiles, which is
  the part of GaiaGPS that matters most away from signal.
- **Later** — drawing and editing routes in the browser and exporting them back
  out as GPX; syncing folders across devices, which is the one thing
  `localStorage` cannot do.

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
