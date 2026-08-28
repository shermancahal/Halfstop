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

Still unresolved after three passes: Alabama, Alaska, California,
Georgia, Kansas, Louisiana, Missouri, Nevada, New Hampshire, Rhode
Island.

New Hampshire and Rhode Island returned literally nothing - `total: 0` -
which means the agency names in the query do not match theirs, not that
they publish nothing. Missouri's `gisblue.mdc.mo.gov` and California's
conservation server are both live and neither surfaced anything
recreational, which is a query problem rather than an answer. A third pass asked twelve named
hosts directly and mostly failed on the addresses rather than the data:
Georgia and Nevada were unreachable, Kansas answered with an empty
service list, and Alaska's server offers ArcGIS's own SampleWorldCities
demo. Rhode Island's server is enormous and entirely imagery. These
remain open, and the honest position is that the addresses have not been
found rather than that the data is absent.

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

## Shipping

Forty-eight layers across thirty-six states are now in `OVERLAYS`, all
switched off by default, filed under the one `State data` heading with
the state written onto each row.

Eight of them have had their fields read. The rest answered only that
they exist, which is a weaker thing to ship on, and they ship anyway on
the understanding that a layer drawing nothing is a layer to delete. The
`live:` probes in `tools/layer-candidates.json` are what will say which
ones those are - one per shipped layer, asking each service whether it
is still there.

Two rendering paths carry all of it, both already in the app before this
landed: a MapServer becomes raster tiles through `/export`, and a
FeatureServer becomes GeoJSON through a bbox query, drawn as fill and
line from one source so a trail and a boundary need no different
handling.

## What the first health run caught

Six of the forty-four shipped layers drew nothing, and every one of them
had passed the health check. ArcGIS refuses in a 200: "The requested
layer (layerId: 0) was not found" and "Token Required" both arrive with
a success status and a JSON error body, so a check reading only the
status code certifies them as healthy. `tools/check-layers.mjs` now
reads the body and fails on it.

Removed, with the reason:

| Layer | Why |
|---|---|
| Michigan ORV scramble areas | no layer 0 - the service exists at another index |
| North Carolina state trails | no layer 0 |
| Idaho recreation trails | no layer 0 |
| New York state park hunting areas | no layer 0 |
| New Mexico state parks | token required; not public |
| Minnesota state parks | token required; not public |
| Illinois trails | the records are Lake County forest preserves, not a state layer. Shipping it as Illinois would have been a lie the map told quietly |

The four that exist at some other index now have `idx:` probes asking
each service for its own layer list, so they can come back on a known
number rather than a guessed one.

Two more were shipping under names the data did not support. Colorado's
layer is CPW **facilities**, not administered land; Oklahoma's
"Recreational Areas" service holds **wildlife management areas**. Both
now say what they are. Iowa's recreation service opens on beach status,
so it asks for sublayer 11 instead of drawing everything.

The lesson is the same one this file keeps recording: the address, not
the data, is nearly always what is wrong - and a health check that
cannot tell a refusal from an answer is worse than none, because it
reports confidence it has not earned.

## The four that came back, and what Idaho was hiding

Every layer removed for having no layer zero had one somewhere else, and
the service will say where if asked. Michigan's ORV areas, North
Carolina's trails and New York's hunting boundaries are all at index 1.

Idaho was the one worth the trouble. Its service runs to index 132, and
alongside the routes at 128 it carries **Emergency Route Closures** at
127 and **Area Restrictions** at 123.

That matters because this file already recorded, as a finding, that no
state maintains a closure layer - that USFS Region 6 kept one and
everyone else spun up a throwaway service per fire. Idaho keeps one. It
was sitting in a service that came within one commit of being deleted
for having nothing at index zero, and only turned up because the removal
was done by asking rather than by assuming.

Wisconsin's park closures and Oregon's park status belong to the same
family. The conclusion that closures were unwireable was drawn from a
search, and searches have been wrong about every state they were asked
about.

## Every shipped layer, with its shape and what is wrong with it

All 48 are live at https://shermancahal.github.io/Map/ and all ship switched
off. "Verified" means the records' fields have been read, not that a human has
looked at the layer on a map. Nobody has done that yet.

| State | Layer | Shape | Verified | Comments |
|---|---|---|---|---|
| Arkansas | State parks | polygon | exists only |  |
| Colorado | CPW facilities | point | exists only | Facilities, not administered land. Renamed to match. |
| Connecticut | DEEP property | polygon | exists only |  |
| Delaware | State park boundaries | polygon | exists only |  |
| Florida | State forests | polygon | exists only |  |
| Hawaii | Na Ala Hele trails | raster | exists only | Renders sublayer 34 of a 40-layer Terrestrial service. |
| Idaho | Area restrictions | polygon | exists only |  |
| Idaho | Emergency route closures | line | exists only | A maintained closure layer — the thing I wrongly said no state keeps. |
| Idaho | Recreation routes | line | exists only |  |
| Indiana | Trails inventory | ? | exists only | **Polygons, not lines.** Trail corridors; not useful alone (your report). |
| Iowa | Recreation lands | raster | exists only | Service opens on *Beach Status*; show:11 set but unverified. |
| Kentucky | Aerial (3 in) | raster | exists only |  |
| Kentucky | Lidar hillshade (5 ft) | raster | exists only |  |
| Kentucky | Public hunting areas | raster | fields read |  |
| Kentucky | Recreational trails | raster | fields read |  |
| Kentucky | Scenic byways | raster | fields read |  |
| Kentucky | State forests | raster | fields read |  |
| Maine | Bureau of Parks & Lands sites | point | exists only | From the foliage map dataset; park sites as points. |
| Maryland | Park & forest maintained roads | line | exists only | Layer is *MDOT Know Your Roads* — may be the DOT inventory, not park roads. |
| Massachusetts | Protected & recreational open space | polygon | exists only |  |
| Michigan | Forest roads | line | fields read |  |
| Michigan | ORV scramble areas | polygon | exists only |  |
| Michigan | State forest campgrounds | point | fields read |  |
| Mississippi | State parks & WMAs | polygon | exists only |  |
| Montana | State parks | polygon | exists only |  |
| Nebraska | Park areas | polygon | exists only |  |
| New Jersey | State park trails | raster | index confirmed | Correct: show:0 is *NJ State Park Service Trails (Generalized)*. |
| New York | State park hunting areas | polygon | exists only |  |
| North Carolina | State trails | line | exists only |  |
| North Dakota | State forest | polygon | exists only |  |
| Ohio | ODNR lands | raster | exists only |  |
| Oklahoma | Wildlife management areas | polygon | exists only | Service holds WMAs despite its name. Renamed to match. |
| Oregon | State parks & status | point | exists only | Park *status* as points, not boundaries. |
| Pennsylvania | State parks & amenities | raster | exists only | Service layer 0 is *Placeholder1*; show:3,9 set but unverified. |
| South Carolina | State parks | polygon | exists only |  |
| South Dakota | State parks | point | exists only | Publisher org looks personal rather than institutional. |
| Tennessee | Aerial | raster | exists only |  |
| Tennessee | TVA dispersed recreation | polygon | fields read |  |
| Tennessee | Wildlife management areas | raster | fields read | Renders sublayer 3 (Lands = WMAs); service root opens on Hatcheries. |
| Texas | Wildlife management areas | polygon | exists only |  |
| Utah | State park management areas | polygon | exists only |  |
| Vermont | ANR travel routes | raster | index confirmed | Correct: show:10 is *Roads (ANR Travel Routes)*. |

| Washington | State park trails | line | exists only |  |
| West Virginia | Aerial, leaf-off | raster | exists only |  |
| West Virginia | Lidar hillshade (1 m) | raster | exists only |  |
| Wisconsin | State parks | polygon | index confirmed | The service is named for closures and holds one layer, WIParks. Renamed. |
| Wyoming | State park boundaries | polygon | exists only |  |

Fifteen of forty-eight carry a comment, which is a poor hit rate and worth
saying plainly. Every one was found by asking the service what shape its
records are - a question none of the first sixty probes asked, because they
were all built to ask whether a thing exists. Existence was never the
interesting question.

## Two rows in that table were wrong, and the probe was why

New Jersey and Vermont were both written up as pointing at the wrong
sublayer. Both were correct. New Jersey's `show:0` is *NJ State Park
Service Trails (Generalized)* and Vermont's `show:10` is *Roads (ANR
Travel Routes)*, and each service says so when asked for its layer list.

The health probe reads a MapServer's **root**, which reports layer zero
- not the sublayer the app draws. So for every raster state layer it was
describing something other than what ships, and two of those descriptions
were confident and wrong. The probes now read the sublayer.

That is the third time in this file the answer has been "the address was
wrong", and the second time the wrong address was in the checking rather
than in the app.

Asking Vermont properly also paid: beside the roads at 10 sit **Primitive
Camping Areas at 22**, State Park Campsites at 175, Recreation Sites at
2 and Trails at 3. Primitive camping is the rarest thing in this whole
sweep - only TVA and Michigan publish anything comparable - and it was
sitting behind a layer this file had already declared broken.

Idaho's routes deserve the same note. They carry `Season_Auto`,
`Season_Jeep`, `Season_UTV`, `Season_ATV` and `Season_Motorcycle`, and a
symbol class for `High-Clearance`. That is MVUM-grade detail published by
a state.

BLM's layer 0 is named IDENTIFY and refuses every query form tried, which
is how a group layer behaves; a probe now asks for the sublayer list.
PAD-US moved and listing its organisation returned four hundred kilobytes
of unrelated services, so that is a targeted search now.

## The identify feature, fixed

The land lookup behind "what is there" was querying layer 0 of BLM's
surface-management service. Layer 0 is a group called IDENTIFY, and a
group layer answers every query with a 200 carrying "Invalid or missing
input parameters" - a response indistinguishable from a malformed
request, which is how it was read for a long time, including once by me
in this session when I declared the feature healthy.

Layer 1 is the Surface Management Agency itself. Probed with the exact
request `lookup.js` builds, layers 0, 2 and 3 all refuse and layer 1
answers with `ADMIN_DEPT_CODE: USDA`, `ADMIN_AGENCY_CODE: USFS`. It now
points at 1.

PAD-US was removed rather than repaired. `PADUS4_0Fee` answers "Invalid
URL", the service has moved at least twice, and a search of its
publisher's organisation returns several hundred kilobytes of unrelated
layers without it. A fallback that never answers costs a round trip on
every click and tells the reader nothing. Esri's federal lands layer is
being probed as a replacement and ships only if it answers first.

So the chain is two services where it was three, and two of them work
where one did.

## Removed after looking at the map

Indiana's trail inventory and Virginia's state park trails both draw
polygons and scattered dots where they promise trails. Neither is useful
on its own and both are gone. Virginia's service reports its geometry as
polyline, which is what made it look sound here; on the map it is not.

That is the second and third layer removed for a reason no probe could
have produced. The probes can now say a service is alive, what shape its
records are and which sublayer is drawn. None of that distinguishes a
trail network from a scatter of corridor polygons, and nothing except
looking will.

## Keys

Every queried state layer now carries a one-line key naming its colour
and whether it draws a route, an area or a site - taken from the geometry
the service reports rather than from the layer's title, which has been
wrong often enough.

The agency-drawn raster layers cannot have one: they arrive as finished
pictures in somebody else's palette, so they carry a note saying so and
pointing at tap-to-identify instead. Imagery and hillshade get neither,
being pictures of the ground rather than thematic layers.

## Notes parked for a README or FAQ

The identify card carried a standing caveat on every result: that the
agency's current map is the legal authority for what is open, and that a
published layer lags seasonal closures. True, and worth saying once
somewhere - not on every card a person opens. Removed from the card and
recorded here until there is a README or FAQ to hold it.

## Why the agency-drawn layers cannot be styled

Ohio's ODNR lands, Kentucky's byways, trails and state forests and
Tennessee's WMAs arrive as raster tiles: the agency renders them into a
finished picture in its own palette, with its own labels, and we receive
pixels. That means no hatching, no soft fill, no control of labels, no
line between a state forest and a nature preserve, and nothing under a
tap - a click falls through to the basemap road beneath, which is why a
scenic byway reported itself as Nada Tunnel Rd.

All of it becomes possible the moment the same services are queried for
features instead, which is what TVA, Michigan and Maryland already do.
The `vec:` probes ask whether these services will do that and which
fields carry the names and the designations.

## Proposed descriptions

Current text against proposed. The proposals state what the layer is and
nothing else - no reasoning, no caveats, no history of how it got here - with
the agency named in one consistent form.

| State | Layer | Current description | Proposed |
|---|---|---|---|
| Arkansas | State parks | Arkansas state parks. | State park boundaries. *Source: Arkansas State Parks* |
| Colorado | CPW facilities | Colorado Parks and Wildlife facilities — the service publishes sites, not the land around them. | Campgrounds, trailheads and other facilities on CPW land. *Source: Colorado Parks and Wildlife* |
| Connecticut | DEEP property | State land held by the Department of Energy and Environmental Protection. | State forests, parks and wildlife areas. *Source: Connecticut DEEP* |
| Delaware | State park boundaries | Consolidated state park boundaries. | State park boundaries. *Source: Delaware DNREC* |
| Florida | State forests | Florida Forest Service state forests. | State forest boundaries. *Source: Florida Forest Service* |
| Hawaii | Na Ala Hele trails | The state trail and access programme. | State trails and public access points. *Source: Hawaii DLNR* |
| Idaho | Area restrictions | Areas under a restriction rather than a full closure. | Areas under a travel restriction. *Source: Idaho Parks and Recreation* |
| Idaho | Recreation routes | Statewide recreation routes. | Motorised and non-motorised routes, with seasons of use. *Source: Idaho Parks and Recreation* |
| Iowa | Recreation lands | Iowa DNR recreation lands. | State recreation lands. *Source: Iowa DNR* |
| Kentucky | Aerial (3 in) | KyFromAbove orthoimagery. Three-inch resolution — close enough to count fence posts. | Three-inch aerial imagery. *Source: KyFromAbove* |
| Kentucky | Lidar hillshade (5 ft) | Terrain from five-foot lidar. Old roadbeds, quarry benches and hollows the national hillshade misses. | Terrain relief from five-foot lidar. *Source: KyFromAbove* |
| Kentucky | Recreational trails | Trails coloured by what may travel them. | Trails by permitted use: foot, horse, bicycle, ATV, motorcycle, water. *Source: Kentucky DGI* |
| Kentucky | Scenic byways | The Commonwealth's designated scenic routes. | Designated scenic byways. *Source: Kentucky DGI* |
| Kentucky | State forests | State forest boundaries, named. | State forest boundaries. *Source: Kentucky DGI* |
| Maine | Bureau of Parks & Lands sites | Public reserved land and state park sites. | State park and public reserved land sites. *Source: Maine Bureau of Parks and Lands* |
| Maryland | Park & forest maintained roads | Roads the state maintains inside its parks and forests. | Roads maintained inside state parks and forests. *Source: Maryland DNR* |
| Massachusetts | Protected & recreational open space | Open space, protected and recreational. | Protected and recreational open space. *Source: MassGIS* |
| Michigan | Forest roads | State forest roads with surface, condition and why a closed one is closed. | State forest roads, with surface and condition. *Source: Michigan DNR* |
| Michigan | State forest campgrounds | Campgrounds on state forest land. | Campgrounds on state forest land. *Source: Michigan DNR* |
| Mississippi | State parks & WMAs | State parks and wildlife management areas in one layer. | State parks and wildlife management areas. *Source: Mississippi Wildlife, Fisheries and Parks* |
| Montana | State parks | Montana FWP state park boundaries. | State park boundaries. *Source: Montana Fish, Wildlife & Parks* |
| Nebraska | Park areas | Nebraska park areas. | State park and recreation areas. *Source: Nebraska Game and Parks* |
| North Carolina | State trails | State trails maintained by North Carolina. | State trails, named. *Source: North Carolina State Parks* |
| North Dakota | State forest | North Dakota state forest. | State forest boundaries. *Source: North Dakota GIS Hub* |
| Ohio | ODNR lands | Land the Ohio DNR manages, coloured by division. | State land by managing division: parks, forestry, wildlife, nature preserves. *Source: Ohio DNR* |
| Oklahoma | Wildlife management areas | Oklahoma wildlife management areas, which is what this service holds despite its name. | Wildlife management areas. *Source: Oklahoma Department of Wildlife Conservation* |
| Pennsylvania | State parks & amenities | Park boundaries with the amenities inside them. | State park boundaries and amenities. *Source: Pennsylvania DCNR* |
| South Carolina | State parks | South Carolina state parks. | State park boundaries. *Source: South Carolina State Parks* |
| South Dakota | State parks | South Dakota state parks. | State park locations. *Source: South Dakota Game, Fish and Parks* |
| Tennessee | Aerial | The state's own base mapping imagery, flown on a rolling cycle and sharper than the national mosaic. | State aerial imagery. *Source: Tennessee STS GIS* |
| Tennessee | TVA dispersed recreation | Where TVA sanctions dispersed use, and where it is restricted. | TVA dispersed recreation areas, with restrictions. *Source: Tennessee Valley Authority* |
| Tennessee | Wildlife management areas | TWRA-managed land, named and with its managing agency. | Wildlife management areas. *Source: Tennessee Wildlife Resources Agency* |
| Texas | Wildlife management areas | TPWD wildlife management areas released for public distribution. | Wildlife management areas. *Source: Texas Parks and Wildlife* |
| Utah | State park management areas | Utah state park management areas. | State park management areas. *Source: Utah State Parks* |
| Vermont | ANR travel routes | Agency of Natural Resources roads — the state's own forest and park access. | Forest and park access roads. *Source: Vermont ANR* |
| Vermont | Primitive camping areas | Where Vermont sanctions primitive camping. | Designated primitive camping areas. *Source: Vermont ANR* |
| Vermont | Recreation sites | ANR recreation sites. | State recreation sites. *Source: Vermont ANR* |
| Vermont | Trails | ANR travel-route trails, the walking half of the network. | State trails. *Source: Vermont ANR* |
| West Virginia | Aerial, leaf-off | Flown with the leaves down, so old grades, benches and roadbeds show through the canopy. | Leaf-off aerial imagery. *Source: WV GIS Technical Center* |
| West Virginia | Lidar hillshade (1 m) | Terrain from one-metre lidar — ten times the detail of the national relief. | Terrain relief from one-metre lidar. *Source: WV GIS Technical Center* |
| Wisconsin | State parks | Wisconsin state parks. The service is named for closures and contains only a parks layer. | State park boundaries. *Source: Wisconsin DNR* |
| Wyoming | State park boundaries | Wyoming state park boundaries. | State park boundaries. *Source: Wyoming State Parks* |
