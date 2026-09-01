# Routing

The trip planner draws the drive. It does not give directions, and it does not
work offline. Both of those are deliberate and this page says why, because both
look like gaps until you know the reason.

---

## What it does

Press **Draw the road route** on a folder's trip plan and the app asks a
Valhalla server for the whole trip in one request, then draws what comes back:

- **The drive**, as a casing and a line — the way a road is drawn, because a
  single stroke over a topo basemap disappears into the contours exactly where
  the road is hardest to follow.
- **The walk**, dashed and thinner, wherever a stop is not on the road network.
- **Measured miles and hours**, beside the winding-factor estimate rather than
  instead of it.

## What it deliberately does not do

**No turn-by-turn directions.** The response contains them — Valhalla returns a
full `maneuvers` array with instructions and street names — and the app throws
them away. Navigation is Apple's and Google's ground, fought with their traffic
data and their voice guidance, and losing it slowly is the only available
outcome. GaiaGPS makes the same call: a map on CarPlay, no driving instructions.
The interesting question here is not *how do I get there*, it is *what is around
this drive and what is the ground like when I arrive*.

**No offline routing.** A Valhalla routing graph is hundreds of megabytes for a
single state and gigabytes for a region, and the engine is a C++ service rather
than something that runs in a page. It cannot ship to a phone. This is why the
straight-line estimate in `lib/trip-plan.js` was never replaced: it needs no
network, it is right about the shape of a trip, and it is what you get at a
trailhead with no signal. The drawn route is the online improvement on it, not
its replacement.

---

## Which server

`ROUTING.url` in `assets/js/config.js`, overridable by `ABMAP_ROUTING_URL` in
`token.js`, which the deploy workflows write from a `ROUTING_URL` repository
variable. Leave it empty and you get FOSSGIS's public Valhalla.

### Reachability, measured

FOSSGIS did not answer from GitHub's runners on 1 September 2026 — two
consecutive full `check-layers` runs twelve minutes apart, both failing at the
connect level (`fetch failed`) rather than with an HTTP status.

That is worth writing down and worth not over-reading. A service outage and a
block on datacenter IP ranges look identical from a CI runner, and the app may
reach the same host perfectly well from a home connection or a phone. So a red
`route:valhalla-*` line in the weekly report is a prompt to check from a
browser, not evidence that the trip planner is broken for anybody real.

It is also the argument for `ROUTING_URL` being a repository variable: if this
server does become unusable, the fix is a variable and a redeploy rather than a
code change.

**That default is right for a quiet site and wrong for a product**, and the
reason is their terms of use, not a judgement call:

> Commercial use is only permitted if the use of the services does not
> constitute a substantial part of an online offering.

> Websites with high traffic volumes are generally not permitted to use our
> services.

> **Additional Conditions for Use of the Routing Servers** … Maximum one request
> per second.

> Please note that each service is backed by only a single server. We do not
> guarantee availability.

A trip planner's routing is a substantial part of the offering. So: fine now,
free for everyone, no ads, no tiers. The day any of that changes, the routing
has to move first.

The app already holds up its end — one request per trip rather than one per leg,
a client-side throttle at 1.1 seconds, no custom headers (so no CORS preflight
can fail), and the required attribution with the `fixthemap` link shown wherever
a route is drawn.

## Moving off it

The switch is the `ROUTING_URL` variable. What it points at is the decision, and
"run your own server" is only one answer:

- **A small VPS running Valhalla.** The most control and a fixed monthly cost
  that does not grow with success. It is also real work: build a routing graph
  from a Geofabrik extract, rebuild it periodically, and keep the thing up.
- **A hosted Valhalla or OSRM provider.** Several exist and some have free
  tiers. Check the terms yourself against what you are building — this project
  has now twice found that the interesting clause was not the one expected.
  Mapbox in particular is out: its terms require a separate negotiated licence
  for applications "primarily intended for use within vehicles", which a
  road-trip planner is.
- **Nothing yet.** Staying on FOSSGIS while the site is quiet and free is within
  what they ask. It is only the tiers that force the question.

### Could it run on Cloudflare, beside the R2 bucket?

The obvious question, since the map archive already lives in R2. Two answers:

**Workers: no.** Memory is capped at 128 MB per isolate on both the free and
paid plans, and there is no Linux toolchain — Workers run V8 isolates, not
native binaries. Valhalla is a C++ service that memory-maps a routing graph
running to gigabytes for a region. It is not close.

Nor does putting the graph in R2 and range-requesting it help, the way the
PMTiles archive does. A tile read is one range request and one answer; a route
is a graph traversal that touches many tiles in sequence, each one a round trip
before the next can be chosen. The access pattern is the opposite of the one
range requests are good at.

**Containers: technically yes**, and worth pricing when the day comes. They went
generally available in April 2026 and need the Workers Paid plan at $5/month,
which includes an allowance of memory, vCPU-minutes and disk-hours, with idle
containers billed for memory and storage rather than CPU. That is the same
ballpark as a small VPS, on the account this project already uses.

Two things to check before believing it, neither of which has been checked here:
whether a regional graph fits the included disk and memory allowances or runs
into overage, and how a container that scales to zero behaves when the first
request has to start a service that memory-maps gigabytes. A cold start measured
in tens of seconds would be worse than the shared server it replaced.

**None of this is a cost today.** FOSSGIS is free, and free is what this is.
The point of `ROUTING_URL` is that the question can be answered later, once
there is traffic worth sizing against, without touching code.

## If you do self-host

Cut the routing graph and the basemap from **the same OSM extract, on the same
schedule**, and show the date in the app. Two vintages is a bug class that
presents as "the routing is wrong" and costs a day to trace: the router will
happily send somebody down a forest road the basemap does not draw. "Roads as of
15 Aug 2026" is also real field information for a back-roads app, in a way it is
not for a city one.

Self-hosting is also what makes **RV routing** cheap. Valhalla takes
`costing: "truck"` with height, weight, width, length and axle load. Treat it as
an advisory rather than a clearance: OSM's `maxheight` coverage is patchy and
often inferred, a bridge can be re-signed, and what is on the road wins over
what is on the screen. That sentence belongs on the result, not in a help page.
