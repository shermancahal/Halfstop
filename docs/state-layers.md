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
| Fire closures, nationally | USFS Region 6 keeps a real one; everyone else spins up a throwaway service per fire, which nothing can be built on |

## Known flaky

`roads:mvum-attributes` and `roads:mvum-fields` passed at 19:46 and failed
at 19:51 on the same day. The USFS EDW endpoint is not reliably up, and
MVUM already ships in the app. Any national plan has to assume its
sources go down, which is the argument for baking what can be baked at
build time rather than fetching it live.

## Found, not yet schema-probed

Two passes over all fifty states. These answered with a state agency's
own host or organisation, which is the only signal that has correlated
with the data being real. None of them are wired.

| State | What it published | Where |
|---|---|---|
| Michigan | Forest roads with surface, condition and closure reason; state forest campgrounds; ORV scramble areas | MI DNR orgs |
| Kentucky | Scenic byways, recreational trails by use, state forests, public hunting areas | `kygisserver.ky.gov` |
| Pennsylvania | State park boundaries and **State Park Amenities** | `gis.dcnr.pa.gov` |
| Vermont | **Roads (ANR Travel Routes)**, Wildlife Management Units | `anrmaps.vermont.gov` |
| Maryland | State Park, Forest, Recreation **Maintained Roads** | MD DNR org |
| Montana | State Parks polygons, **Parks Activities**, FWP Lands sites and points | MT FWP org |
| New Jersey | Parks and Forests Trail System, State Park Points of Interest, generalised trails | `mapsdep.nj.gov` |
| Oregon | State Parks, **State Park Status**, State Parks Hunting Areas | `gis.prd.state.or.us` |
| Texas | State Parks Public Areas, **WMA Boundaries for Public Distribution**, Public Hunting Regions | TPWD org |
| Washington | Park Boundaries, Trails, Winter Rec Motorized Trails, ADA Information Points | WA State Parks org |
| Wisconsin | State parks and **Park Closures** | WI DNR org |
| Ohio | ODNR Lands, DNR/Federal Lands navigation basemap | `gis.ohiodnr.gov` |
| Iowa | State Parks, Recreation Lands - an entire Recreation folder | `programs.iowadnr.gov` |
| Florida | FFS Recreation Points, Recreation Trails, State Forests | FL Forest Service org |
| Connecticut | DEEP Property, DEEP Property Access Locations | CT DEEP org |
| Massachusetts | Protected and Recreational OpenSpace, MassWildlifeLands | `gis.eea.mass.gov` |
| Hawaii | Na Ala Hele Trails, Reserves, DOFAW Managed Lands | `geodata.hawaii.gov` |
| Indiana | DNR Recreation Sites, Trails Inventory | `gisdata.in.gov` |
| Delaware | DNREC Facilities and Planning, consolidated State Park boundaries | `enterprise.firstmap.delaware.gov` |
| Colorado | CPW admin and species data, state basemap | `gis.colorado.gov`, CPW org |
| Utah | State Park Management Areas, snowmobile routes and trailheads | Utah DNR org |
| North Carolina | State Trails, State Parks Points | NC org |
| Virginia | State Park trails and districts | VA org |
| Oklahoma | Recreational Areas, State Parks | OK orgs |
| South Carolina | State Parks; `arcweb.dnr.sc.gov` is live | SC orgs |
| Idaho | Idaho Recreation Trails | Idaho org |
| Illinois | Trails, Trails Public, Overlooks | organisation unverified |
| New Mexico | State Parks | NM org |
| North Dakota | State Forest | NDGISHUB |
| Wyoming | State Park Boundaries | WY org |
| South Dakota | State Parks, Campground and Recreation Areas | org looks personal, needs checking |
| Mississippi | **State Parks and WMAs** in one layer | MS org |
| Arkansas | State Parks, State Park Recreation Points | AR orgs |
| Minnesota | State Parks | MN org |
| Nebraska | Park Areas and Locations; `gis.ne.gov` is live | NE orgs |
| Maine | Bureau of Parks and Lands property points | Maine Forest Service org |

Still unresolved after two passes: Alabama, Alaska, California, Georgia,
Kansas, Louisiana, Missouri, Nevada, New Hampshire, Rhode Island.

New Hampshire and Rhode Island returned literally nothing - `total: 0` -
which means the agency names in the query do not match theirs, not that
they publish nothing. Missouri's `gisblue.mdc.mo.gov` and California's
conservation server are both live and neither surfaced anything
recreational, which is a query problem rather than an answer. These ten
need a third pass by hostname.

Two states appear here having been recorded as refusals earlier in this
file. Both were wrong, and for the same reason - the probe asked the
wrong server. Indiana publishes DNR recreation sites and a trails
inventory on `gisdata.in.gov`. Ohio publishes ODNR Lands on
`gis.ohiodnr.gov`; the hostnames recorded as dead were simply not
Ohio's.

The pattern is worth naming: every wrong answer in this file so far has
come from asking the wrong address, and none from a state that genuinely
had nothing.

## A caution about absence

The first pass searched by topic - recreation, trails, campground - and
fourteen states came back with nothing usable. That is a statement about
the search, not about the states. Minnesota and California both publish
extensively and neither surfaced; Delaware's results were mostly New
Jersey and Mississippi's were mostly Minnesota.

Nothing found by a failed search is recorded as a refusal. Only a
service that was actually asked and actually answered goes in the table
above.
