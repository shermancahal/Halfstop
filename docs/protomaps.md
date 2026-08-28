# The Protomaps archive

Byways Topo is this project's own cartography — the palette, the road
hierarchy, the route shields — applied to somebody else's geometry. Which
geometry is a configuration value, and this document is about the second one.

Today the geometry comes from Mapbox. That has two costs, and only one of them
is money:

- **Every view is metered.** Looking at the map costs a tile request against a
  monthly allowance.
- **It cannot be taken offline.** Mapbox reserve offline storage of their data
  to their own native mobile toolkit, which this app is not built on. So the
  best-looking map here is the one that stops working where there is no signal,
  which is the wrong way round for a back-roads atlas.

A Protomaps archive fixes both. It is one `.pmtiles` file holding the whole
tile pyramid, read a slice at a time with HTTP range requests. Static bytes on
a bucket: nothing meters them, and the whole map is a *file*, which is what
makes "download this region" a sentence that can mean something.

The cartography is unchanged. Only the schema underneath differs, and the style
reads its layer and field names from one object per source — see
`MAPBOX_SCHEMA` and `PROTOMAPS_SCHEMA` in `assets/js/lib/byways-style.js`.

## Turning it on

Set one value:

```js
// assets/js/token.js
window.ABMAP_PROTOMAPS_ARCHIVE = 'https://tiles.example.com/byways.pmtiles';
window.ABMAP_PROTOMAPS_MAXZOOM = '15';
```

In CI these come from repository **variables** (not secrets — the URL is
public) named `PROTOMAPS_ARCHIVE` and `PROTOMAPS_MAXZOOM`. Both deploy
workflows write them into `token.js` alongside the Mapbox and Supabase values.

With it set, Byways Topo draws from the archive and the app loads MapLibre.
With it empty, Byways Topo draws from Mapbox and the app loads Mapbox GL,
exactly as before. **Byways Topo (Mapbox)** stays in the basemap list either
way, visible to editors only, so the two can be compared side by side.

## What has to be true of the host

Three things, and a host that fails any of them produces a blank map rather
than an error:

1. **Range requests.** The reader asks for `bytes=0-16383` and then for a few
   hundred bytes per tile. A host that answers `200` with the whole file is
   handled — the slice is cut client-side — but it will have sent the entire
   archive to read one tile, which is not a thing to rely on.
2. **CORS.** `Access-Control-Allow-Origin` covering the site's origin, and
   `Access-Control-Expose-Headers: content-range` so the browser can see what
   it got. Protomaps' own `demo-bucket.protomaps.com` sends no CORS headers at
   all, which is why it cannot be pointed at directly.
3. **gzip, not brotli or zstd.** Browsers decompress gzip; nothing decompresses
   brotli or zstd from JavaScript without a library. An archive built with
   either is refused by name at the first tile rather than drawing empty
   ground.

Cloudflare R2, Backblaze B2 and S3 all satisfy these with the right bucket
settings. GitHub Pages does not: a 100 MB per-file limit and a soft 1 GB
repository limit rule out anything larger than a couple of states.

## Building one

The archive is an extract of an OpenStreetMap-derived planet build. Protomaps
publish a daily one; `pmtiles` cuts a region out of it without downloading the
whole thing, because the format is designed to be read remotely.

```sh
# The extract tool. Also available as a static binary from the releases page.
go install github.com/protomaps/go-pmtiles@latest

# A bounding box, at the depth the style declares.
pmtiles extract \
  https://build.protomaps.com/20240101.pmtiles \
  byways.pmtiles \
  --bbox=-89.6,34.9,-77.7,40.7 \
  --maxzoom=15
```

Rough sizes at maxzoom 15: a single state is tens of megabytes, the
Appalachians a few hundred, the lower forty-eight several gigabytes. Zoom is
the expensive axis — each level is four times the one below it — so the honest
question is what depth the map is actually read at rather than how much ground
it covers.

Then check it, before pointing the site at it:

```sh
npm run check:archive -- https://tiles.example.com/byways.pmtiles
```

That asks the three questions above of the host itself — whether it honoured
the `Range` header, what CORS it sent, what the archive is compressed with —
reads the zoom range and bounds out of the header, and then reads an actual
tile from the middle of the archive's own declared coverage, because a
perfectly well-formed header can sit on a file whose directories do not
decompress. It prints the two config lines to paste, with the maxzoom the file
really has.

There is a local archive to try it against, which needs no network and no
bucket:

```sh
node tools/serve-archive.mjs &
npm run check:archive -- http://127.0.0.1:8788/byways.pmtiles
```

It takes `--ignore-range` and `--no-cors` so each of the three failures can be
seen being reported rather than taken on trust.

Overstating `ABMAP_PROTOMAPS_MAXZOOM` draws blank ground past the archive's
real depth. The app reads the header when it opens the archive and says so in
the console when the two disagree — a warning if the style asks for more than
the file has, a note if the file has more than the style uses.

## What the port gains and what it loses

Gains, both larger than expected:

- **The road hierarchy survives intact.** Protomaps' `kind` has five values and
  would have collapsed motorway into trunk and primary into secondary. Roads
  read `kind_detail` instead, which carries the original OSM highway tag, so
  the eleven weights this map is drawn for map onto eleven.
- **The shields stop guessing.** Mapbox names a marker's *shape* and leaves who
  numbered the road to be inferred from wherever the map is looking — wrong
  within a few miles of a state line. Protomaps names the *network*: `US:I`,
  `US:US`, `US:KY`. The design is chosen from that, and `shield_text` supplies
  the number already stripped of its system.

Losses, each of which drops a layer rather than drawing it empty:

| Layer | Why | Where the answer is |
| --- | --- | --- |
| `contour`, `contour-index`, `contour-label` | No contour layer in the schema | The USGS contour overlay, already in the catalogue |
| `hillshade` | No hillshade layer | Terrain relief is already its own overlay |
| `label-water`, `label-summit` | Not established which layer carries natural-feature names | Probe `pm:doc-physical` |
| `national-park` | One landuse layer here rather than a base and an overlay; the right `kind` value is unconfirmed | Probe `pm:doc-protected` |
| `road-unpaved` | No surface field named in the schema | Probe `pm:doc-surface` |
| `road-shield-first`, `road-shield-second` | Nothing marks a road carrying two route numbers, and splitting on any hyphen would cut "21/2" in half | Probe `pm:doc-concurrency` |

The probes are in `tools/layer-candidates.json` and run from the **Check map
layers** workflow with `only: pm:doc`. Every one of these gaps is a layer that
would otherwise have been shipped drawing nothing, which is the failure mode
this whole seam exists to make visible.

## Still to do

- **Offline.** The per-tile cache in `assets/js/lib/offline.js` stores tile
  URLs, and an archive has none — it is one file read by byte range. Regional
  downloads want a different mechanism: either a per-region extract served as
  its own archive, or caching the byte ranges a region touches.
- **Per-feature state shields.** The network names the state exactly. Every
  size, offset and colour is computed per design, so reading the state per
  feature turns each into fifty-one arms — worth doing on its own, with a
  border crossing as its test.
