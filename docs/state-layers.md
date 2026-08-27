# State and regional data: what has actually been probed

Everything here was answered by a live service through
`.github/workflows/check-layers.yml`, not read off a search index. A title
in a catalogue is not a layer; an endpoint that returned records with
usable fields is. Anything not in this file has not been checked.

The columns that matter are the last two. A layer that draws a line but
cannot say what may travel it is close to useless here, and several
otherwise promising sources fail on exactly that.

## Confirmed, with schema

| Source | Endpoint | Fields that matter |
|---|---|---|
| KY Scenic Byways | `kygisserver.ky.gov/…/WGS84WM_Services/Ky_Scenic_Byways_WGS84WM/MapServer` | single named layer |
| KY Recreational Trails | `…/Ky_Recreational_Trails_WGS84WM/MapServer` | split by use: Federal ATV, Federal Motorcycle, KDFWR Horse, State Park, Rails to Trails, hiking, bicycle, blue water |
| KY Public Hunting Areas | `…/Ky_Public_Hunting_Areas_WGS84WM/MapServer` | Hunting Areas, Restricted Hunting Areas, Elk Hunting Units |
| KY State Forests | `…/Ky_StateForests_WGS84WM/MapServer` | boundaries and points |
| TN TWRA Lands | `tnmap.tn.gov/…/ENVIRONMENTAL/TWRA/MapServer/3` | `NAME`, `MANAGEMENT`, `CONAME`, `ACRES`, `REGION` — wildlife management areas |
| TVA Dispersed Recreation | `services.arcgis.com/w8auYAijfGK1Mydj/…/Dispersed_Recreation_Areas/FeatureServer/0` | `REC_TYPE`, `RESTRICTED`, `RESERVOIR` |
| MI DNR Roads | `services3.arcgis.com/Jdnp1TjADvSDxMAX/…/DNR_ROADS/FeatureServer/0` | `RoadType`, `SurfaceType`, `Condition`, `Owner`, `ClosureCriteria` |
| MI State Forest Campgrounds | `…/dnrParksAndRecreation/FeatureServer/3` | `Name`, `Type`, `County`, `Division` |

Michigan's road layer is the strongest of these. Surface, condition and a
reason for closure on the same record is more than the federal MVUM
carries, and it is the difference between "there is a road here" and
"you can get up it in what you are driving".

TVA's `RESTRICTED` column is the rarest. Nearly every other source in the
sweep says where land is, not what may be done on it.

## Asked and answered no

| Source | What it actually holds |
|---|---|
| KY `ThematicServices` | NLCD land cover, 1985-2024, nothing else |
| WV GIS `Society`, `Structure` | fire hydrants, SHPO records, building footprints |
| TN `COMMUNITY` | schools, polling places, libraries, tax boundaries |
| Ohio state services | both hostnames dead - 404 and unresolvable |
| Indiana state server | county-scale odds and ends only |
| Fire closures, nationally | USFS Region 6 keeps a real one; everyone else spins up a throwaway service per fire, which nothing can be built on |

## Known flaky

`roads:mvum-attributes` and `roads:mvum-fields` passed at 19:46 and failed
at 19:51 on the same day. The USFS EDW endpoint is not reliably up, and
MVUM already ships in the app. Any national plan has to assume its
sources go down, which is the argument for baking what can be baked at
build time rather than fetching it live.
