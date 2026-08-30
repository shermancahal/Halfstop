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

## The switch

One value decides everything:

```js
// assets/js/token.js
window.ABMAP_PROTOMAPS_ARCHIVE = 'https://tiles.example.com/byways.pmtiles';
window.ABMAP_PROTOMAPS_MAXZOOM = '13';
```

Set, and Byways Topo draws from the archive and the app loads MapLibre. Empty,
and Byways Topo draws from Mapbox and the app loads Mapbox GL, exactly as
before. **Byways Topo (Mapbox)** stays in the basemap list either way, visible
to editors only, so the two can be compared side by side.

Getting a URL to put there is the eight steps below.

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
settings.

**So does GitHub Pages**, which is worth knowing because it means an archive
can be tried with no account and no bill. Measured rather than assumed: a
request for a slice from the middle of a deployed file comes back `206`, the
right length, from the right offset, with `Access-Control-Allow-Origin: *`.
(The probes are `pages:range` and `pages:range-tail` in
`tools/layer-candidates.json`. Two of them, because a host can answer 206 to
`bytes=0-N` by truncating the response it was going to send anyway — the second
asks for a slice that is not the head of the file.)

An earlier version of this document said Pages was ruled out by a 100 MB
per-file limit. That is a limit on files in *git*, and an archive published
this way never goes near git — it is cut during the build and added to the
Pages artifact. The real ceiling is the 1 GB published site.

## The short way: publish it with the site

Before standing up a bucket, it is worth finding out whether you like the map.
The deploy workflow can cut an extract and publish it alongside the site, and
then there is nothing external at all.

Try a coverage without committing to it — Actions → **Publish to GitHub Pages**
→ **Run workflow**, and fill in:

    bbox      -85.0,35.0,-82.0,37.0
    maxzoom   12

To make it the standing arrangement, set repository **variables** instead:
`PROTOMAPS_BBOX` and `PROTOMAPS_MAXZOOM`. The extract is cached between
deploys, keyed on the bbox and the zoom, so only the first one pays for it;
bump a `PROTOMAPS_REBUILD` variable to force a fresh cut from a newer planet
build.

The run reports what it cut, from which planet build, and how large it came
out, in the job summary. It refuses above 800 MB, which leaves room under the
1 GB site limit for the site.

`PROTOMAPS_ARCHIVE` always wins where it is set. A bucket is a deliberate
choice and is never replaced by a test extract.

**What this is not.** A published Pages site is capped at 1 GB and every deploy
re-uploads the whole thing, so this is right for a region and wrong for a
continent. When the coverage outgrows it, the rest of this document is the
answer, and switching is one variable.

**And one measured caveat.** Pages does not answer `Range` reliably on a large
object. It answered `206` on every probe made with curl and with Node, and then
`tools/check-site.mjs` — which watches what a real browser actually receives —
caught it answering a ranged request with `200` and the whole 463 MB file. The
reader copes by slicing, so nothing looks wrong; a visitor on a phone simply
downloads the entire archive. Treat Pages as fine for a small extract and as
unsuitable for anything continental, and read the transfer sizes in a
`check-site` run rather than trusting a `206` from the terminal.

## Going national, without ever touching the file

The walkthrough further down is the manual route, and it is still the right
reference for what a bucket has to do. But nothing about a continental archive
should involve a laptop: it is several gigabytes, it is cut by reading a
hundred-gigabyte planet file by byte range, and downloading it in a browser in
order to upload it again in a browser is an afternoon spent moving bytes past
yourself.

So *Cut a map archive* does both ends. Six steps, and the only slow one is
waiting.

### 1. Make the bucket · *Cloudflare*

Cloudflare dashboard → **R2** → *Create bucket*. Any name; `byways-tiles` is
the one this document assumes. Location Automatic.

### 2. Make an API token that can only write to that bucket · *Cloudflare*

**R2 → API → Manage API tokens.** That page offers two kinds and the
difference matters here:

- **Account API token** — this one. It belongs to the account rather than to a
  person, and Cloudflare's own note says it stays active even when whoever made
  it leaves the organisation.
- *User API token* — goes inactive if that person leaves. Fine for poking at a
  bucket from a laptop; wrong for a credential a workflow depends on, because
  the failure arrives months later as a rebuild that suddenly cannot upload.

So: **Create Account API token**, then

- Permission: **Object Read & Write**
- Specify bucket: **the one bucket**, not "all buckets"
- TTL: whatever you are comfortable re-issuing

It shows you three things once and never again. Copy all three.

This token can write to the bucket, which makes it the only genuinely secret
value in this project — the Mapbox key is public by design and the archive URL
is a public URL. There is a test asserting that no workflow which builds the
site so much as mentions it.

### 3. Put them in the repository · *GitHub*

This is the one step that changes sites. On the repository —
`github.com/<you>/Map` — **Settings → Secrets and variables → Actions**.
That page has two tabs, and which tab a value goes in is not cosmetic.

Under **Secrets** — these three, exactly these names:

| Secret | Where it came from |
| --- | --- |
| `R2_ACCOUNT_ID` | the Account ID on the R2 overview page |
| `R2_ACCESS_KEY_ID` | the token's Access Key ID |
| `R2_SECRET_ACCESS_KEY` | the token's Secret Access Key |

Under **Variables** — not Secrets, because a workflow cannot read a secret
through the `vars` context and setting them there looks done and changes
nothing:

| Variable | Value |
| --- | --- |
| `R2_BUCKET` | `byways-tiles` |

### 4. Turn on public access and CORS · *Cloudflare*

Bucket → **Settings**.

- **Public access**: enable the `r2.dev` development URL, or attach a custom
  domain. The custom domain is the better answer — the `r2.dev` URL is rate
  limited and Cloudflare says outright it is not for production — but the
  development URL is fine for finding out whether the map is any good.
- **CORS policy**: the JSON in step 5 of the manual walkthrough below. The
  `range` header in `AllowedHeaders` is the one people leave out, and leaving
  it out fails in a way that only a browser can see.

Then add one more **Variable** so the run can check its own work:

| Variable | Value |
| --- | --- |
| `PROTOMAPS_PUBLIC_BASE` | the public URL, e.g. `https://pub-xxxx.r2.dev` |

### 5. Run it · *GitHub*

**Actions → Cut a map archive → Run workflow.**

| Field | Value |
| --- | --- |
| bbox | `-125.0,24.4,-66.9,49.4` (the lower forty-eight) |
| maxzoom | `13` |
| planet | leave empty |
| upload | **checked** |
| key | `byways.pmtiles` |

Then wait. A continental cut is hours, not minutes — the job allows five and a
half. With `upload` checked it goes straight to the bucket by multipart upload
and no artifact is produced, which is deliberate: a single PUT to R2 is capped
at 300 MB, so neither the dashboard nor `wrangler r2 object put` can take a
file this size.

When it finishes it asks your bucket whether a browser could actually read what
it just uploaded, and puts the answer in the run summary.

### 6. Point the site at it · *GitHub*

The run summary names the two **Variables** to set, filled in with the real
values:

| Variable | Value |
| --- | --- |
| `PROTOMAPS_ARCHIVE` | `https://pub-xxxx.r2.dev/byways.pmtiles` |
| `PROTOMAPS_MAXZOOM` | `13` |

Setting `PROTOMAPS_ARCHIVE` also stops the deploy cutting and publishing its
own copy alongside the site, so the next deploy gets smaller as well.

Push anything, or re-run the deploy, and then look at it:

**Actions → Check the live map → Run workflow**, with a view somewhere the new
coverage should have data. It reports which build it looked at, what the
archive answered, and how many features each style layer actually drew.

### What it costs

R2 charges for storage and for operations, and not for egress. Several
gigabytes is cents a month; the reads are byte ranges rather than whole-file
downloads, so the operation count follows how much the map is panned rather
than how big the archive is. The reason this is worth doing is not really the
money — it is that a bucket answers `Range` predictably, and Pages does not.

## Setting one up on a bucket, start to finish

### 1. Decide the coverage first

It is the only part of this that costs money, and zoom is the expensive axis —
each level holds four times as many tiles as the one below it. Cut something
small, look at the size, then decide whether more depth or more ground is worth
it. Starting with the whole country at maximum depth is an hour of waiting to
find out you did not want it.

A reasonable first cut is the ground this map was built for — Tennessee,
Kentucky, West Virginia and their neighbours:

    --bbox=-89.6,34.9,-77.7,40.7 --maxzoom=13

As an order of magnitude at maxzoom 15: a single state is tens of megabytes,
the Appalachians a few hundred, the lower forty-eight several gigabytes. Every
level below that divides those by four. The honest question is what depth the
map is actually read at, not how much ground it covers — z13 shows every road
this atlas draws; z15 is for reading house numbers.

### 2. Install the extract tool

```sh
brew install protomaps/tap/pmtiles      # macOS
# or a static binary from github.com/protomaps/go-pmtiles/releases
# or: go install github.com/protomaps/go-pmtiles@latest

pmtiles extract --help                  # confirm the flags on your version
```

### 3. Cut the extract

The source is Protomaps' daily planet build. **Check
[docs.protomaps.com](https://docs.protomaps.com) for the current URL** — the
builds are dated, and the one below will be stale by the time you read it.

```sh
pmtiles extract \
  https://build.protomaps.com/20260801.pmtiles \
  byways.pmtiles \
  --bbox=-89.6,34.9,-77.7,40.7 \
  --maxzoom=13
```

It reads the remote planet file by byte range rather than downloading it, which
is the same property that makes the result usable from a browser.

```sh
pmtiles show byways.pmtiles      # zoom range, bounds, compression, size
```

### 4. Create the bucket

**Cloudflare R2** is the one to pick, and the reason is egress: a tile archive
is read far more than it is written, and R2 does not charge for reading. S3 and
Backblaze B2 both work and both bill for it.

1. Cloudflare dashboard → **R2** → **Create bucket** (`byways-tiles`)
2. Click into the bucket and upload `byways.pmtiles` at the top level, not in a
   folder.

   **300 MB is a hard edge, and it is R2's rather than the dashboard's.** A
   single-part upload cannot exceed it, so neither the dashboard nor
   `wrangler r2 object put` — which does one PUT — will take a larger file.
   Past that the upload has to be multipart, which means an S3 client:

       # An R2 API token first: R2 → Manage API Tokens → Create,
       # with Object Read & Write. It gives an access key and a secret.
       rclone config create r2 s3 provider=Cloudflare \
         access_key_id=KEY secret_access_key=SECRET \
         endpoint=https://ACCOUNT_ID.r2.cloudflarestorage.com
       rclone copy byways.pmtiles r2:byways-tiles/

   `aws s3 cp --endpoint-url https://ACCOUNT_ID.r2.cloudflarestorage.com`
   works the same way; both split the file automatically.

   **Or do not use a bucket at all.** GitHub Pages serves ranges and CORS
   correctly, and the deploy will cut and publish an archive itself — see
   *The short way* above. Anything under about 900 MB fits, needs no upload,
   and needs no credentials. The bucket earns its place past that, or when
   re-uploading the whole site on every deploy stops being reasonable.
3. **Settings → Public access** — either enable the `r2.dev` development URL,
   which is fine for evaluating and is rate-limited and discouraged for
   production, or connect a custom domain such as `tiles.americanbyways.com`.
   **Come back and do the custom domain before this is anything but a test:**
   `r2.dev` is rate-limited, and a rate-limited basemap fails as a map with
   holes in it rather than as an error.

### 5. Add the CORS policy

Bucket → **Settings → CORS policy**:

```json
[
  {
    "AllowedOrigins": [
      "https://shermancahal.github.io",
      "capacitor://localhost",
      "https://localhost",
      "http://localhost:8000"
    ],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["range", "if-match"],
    "ExposeHeaders": ["etag", "content-range", "content-length"],
    "MaxAgeSeconds": 3600
  }
]
```

The two `localhost` origins are for the iOS and Android shell. A Capacitor
webview loads from `capacitor://localhost` or `https://localhost`, not from the
site's domain — the same reason the app needs its own unrestricted Mapbox
token. The last one is `npm start`.

### 6. Check it before wiring anything up

```sh
npm run check:archive -- https://<your-bucket>/byways.pmtiles
```

This is the step that saves the afternoon. It asks the host the three questions
in the section above — did it honour the `Range` header, what CORS did it send,
what is the archive compressed with — reads the zoom range and bounds out of
the header, and then reads a real tile from the middle of the archive's own
declared coverage, because a perfectly well-formed header can sit on a file
whose directories do not decompress. Then it prints the two config lines to
paste, with the maxzoom the file actually has rather than the one you assumed.

Every failure names itself and names the fix: no CORS, ignored ranges, the
wrong compression, a header describing a different file from the one attached
to it.

There is a local archive to try the checker against, needing no network and no
bucket:

```sh
node tools/serve-archive.mjs &
npm run check:archive -- http://127.0.0.1:8788/byways.pmtiles
```

It takes `--ignore-range` and `--no-cors` so each failure can be watched being
reported rather than taken on trust.

### 7. Wire it up

Locally, in `assets/js/token.js` — gitignored, so it is yours alone:

```js
window.ABMAP_PROTOMAPS_ARCHIVE = 'https://<bucket>/byways.pmtiles';
window.ABMAP_PROTOMAPS_MAXZOOM = '13';   // whatever check:archive printed
```

In production, on GitHub: **Settings → Secrets and variables → Actions →
Variables** — the *Variables* tab, not Secrets, because a public bucket URL is
not a secret and treating it as one only makes it harder to see what is
deployed. **New repository variable**, twice:

| Name | Value |
| --- | --- |
| `PROTOMAPS_ARCHIVE` | `https://<bucket>/byways.pmtiles` |
| `PROTOMAPS_MAXZOOM` | `13` |

Both deploy workflows already read these into `token.js` alongside the Mapbox
and Supabase values.

### 8. Deploy, and look at it

Push anything, or re-run the deploy workflow, so `token.js` is regenerated.
Then open the map. Byways Topo is drawing from the archive.

Worth looking at specifically, because these are the things that were rebuilt
rather than carried over:

- **Road weights.** Interstate down to footpath, eleven of them. If the map
  looks flat, `kind_detail` is not arriving.
- **Route shields.** The right shape for the right system, and the state's own
  marker on a state route — read from the network now rather than inferred
  from where the map is looking, so they should be right near a border.
- **Protected ground.** National forest and wilderness filled, not just
  national parks.
- **Place labels.** Towns in larger type than districts.

Open the console once. If the archive is deeper or shallower than
`ABMAP_PROTOMAPS_MAXZOOM` claims, the app says so and names the number to use.

Then switch to **Byways Topo (Mapbox)** — visible to you as an editor — and
flip between them. That comparison is what the whole two-schema seam was built
to make possible.

Two things will look like bugs and are not. The map reloads when you switch
between the two Byways Topo entries: they need different GL libraries, and the
camera lives in the URL hash so nothing is lost. And offline downloads are
offered on the Protomaps one and refused on the Mapbox one, which is the entire
point of the exercise.

## Rebuilding it later

Re-cut, re-upload to the same URL, and nothing else changes. If the new archive
has a different maximum zoom, update `PROTOMAPS_MAXZOOM` — the console warning
will tell you, but a warning nobody reads is a blank map at one zoom level.

Anyone who has downloaded regions keeps the tiles they had; they are stored by
archive URL and z/x/y, so a rebuild at the same URL leaves them holding the old
tiles until they download again. Deleting downloaded tiles from the offline
panel clears them.

## What the port gains and what it loses

Gains, all three larger than expected:

- **The road hierarchy survives intact.** Protomaps' `kind` has five values and
  would have collapsed motorway into trunk and primary into secondary. Roads
  read `kind_detail` instead, which carries the original OSM highway tag, so
  the eleven weights this map is drawn for map onto eleven.
- **The shields stop guessing.** Mapbox names a marker's *shape* and leaves who
  numbered the road to be inferred from wherever the map is looking — wrong
  within a few miles of a state line. Protomaps names the *network*: `US:I`,
  `US:US`, `US:KY`. The design is chosen from that, and `shield_text` supplies
  the number already stripped of its system.
- **More ground is distinguished.** Mapbox's landuse overlay knows one kind of
  protected land; Protomaps separates national park, protected area, nature
  reserve and forest — which on a back-roads map is most of the ground the
  roads are actually in. Its landcover also separates cropland, bare rock and
  built-up areas, none of which Mapbox distinguishes here.

Losses. Each drops a layer rather than drawing it empty, and each is confirmed
absent rather than assumed:

| Layer | Why |
| --- | --- |
| `contour`, `contour-index`, `contour-label` | No contour layer in the schema. The USGS contour overlay, already in the catalogue, is the answer |
| `hillshade` | No hillshade layer. Terrain relief is already its own overlay |
| `road-unpaved` | No surface field anywhere in the schema — confirmed, not assumed. This is the one that stings: "tracks and surfaces" is how this basemap describes itself |
| `road-shield-first`, `road-shield-second` | Nothing marks a road carrying two route numbers. Splitting on any hyphen would cut "21/2" and every hyphenated forest road in half |
| `label-summit` | `peak` is a documented kind but which layer carries it is not published in a form that says so. Null until it is read rather than guessed |

Everything else came back: the parks, the water names, the ground cover, the
place labels, the whole road network and the shields.

The probes that established all of this are in `tools/layer-candidates.json`
and run from the **Check map layers** workflow with `only: pm:`. Every gap
above is a layer that would otherwise have shipped drawing nothing, which is
the failure this seam exists to make visible.

## Still to do

- **Offline.** The per-tile cache in `assets/js/lib/offline.js` stores tile
  URLs, and an archive has none — it is one file read by byte range. Regional
  downloads want a different mechanism: either a per-region extract served as
  its own archive, or caching the byte ranges a region touches.
- **Per-feature state shields.** The network names the state exactly. Every
  size, offset and colour is computed per design, so reading the state per
  feature turns each into fifty-one arms — worth doing on its own, with a
  border crossing as its test.
- **Summit labels.** One probe away: which layer carries `peak`.
- **Place ranking.** Protomaps gives each place a `sort_key` and a `min_zoom`,
  and a `capital` flag. This map currently draws towns bigger than everything
  else and stops there; those three fields would let it thin the labels
  properly at low zoom instead.
