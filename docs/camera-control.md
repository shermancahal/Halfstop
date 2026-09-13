# Camera control

Tethering to a camera — a Nikon Z5 first — over USB or Wi-Fi, to control it from
something better than the camera's own menus.

Two principles decide almost every design question that follows, so they come
first.

**The camera is the source of truth.** Every physical dial, switch and button
on the body is reflected in the app within a fraction of a second, and the app
never shows a value the camera has not confirmed. A camera app that disagrees
with the camera is worse than no app.

**Ask what the photographer wants, not what the camera should be set to.** The
app takes "I want to shoot the Milky Way over the lake tonight" and works out
the settings from the lens that is actually mounted, the sky at that place and
hour, and the light that will be there. It does not store recipes.

---

## The camera is the source of truth

Underneath, this is the Picture Transfer Protocol: a standard operation set plus
about seventy Nikon vendor operations and several hundred vendor properties.
Reading a value is a request; being *told* a value changed is the hard part.

### The event stream is necessary and not sufficient

Nikon bodies offer `GetEvent` (0x90C7) and `GetEventEx` (0x941C), which report
device property changes. In practice they do not fire for everything a hand on
the camera can do, so an app built on events alone drifts out of sync and an app
built on polling alone feels slow. Both, then:

- **Events** are the primary signal, drained continuously.
- **A hot poll**, several times a second, covers what hands actually touch:
  shutter, aperture, ISO, exposure compensation, exposure mode, white balance,
  focus mode, the meter, battery.
- **A warm poll**, about once a second, covers whatever the current plan depends
  on — during a timelapse that includes remaining card space and frame count.
- **A full re-read** on connect, and on any change that reshapes the rest.

### A descriptor is not a value

The most common way a camera app lies is subtler than a stale number. Each
property carries a descriptor: its current value, its legal values, and whether
it can be written at all. **The descriptor changes with camera state, not just
the value.** Move the mode dial from M to A and shutter speed stops being
writable and its legal range changes. Mount a different lens and the aperture
range changes underneath you.

So a mode change invalidates descriptors, not merely values, and the app
re-reads them. A control whose legal values came from a different exposure mode
is a control that will be rejected on the next write.

### Telling your own echo from a human hand

Every write the app makes is ticketed: property, value, time. When the change
comes back on the event stream:

- It **matches a pending ticket** — that is the camera confirming the app's own
  write. Settle the control, say nothing.
- It **matches nothing pending** — a human turned a dial. Adopt it and surface
  it quietly: *ISO 1600, from the camera.*
- The ticket **expires, or comes back with a different value** — the camera
  refused. Show what the camera says, never what was asked for.

Writes are queued and serialised, one in flight at a time, with Nikon's
`DeviceReady` (0x90C8) poll built into the transport. Firing a write at a busy
body is how commands get silently dropped.

### Every control is in one of three states, and says which

- **App-writable.** Ordinary.
- **Body-only.** A physical control owns it. On the Z5 that is the mode dial,
  the photo/video switch, and on some lenses the focus-mode switch. Show the
  value, offer no edit, and say why in a sentence: *Set by the mode dial.*
- **Conditionally writable.** Writable in principle, not right now, for a
  reason the app can name — *shutter speed is chosen by the camera in A mode* —
  and paired with the fix: *turn the mode dial to M to set it here.*

The third state is where other apps grey out a box and explain nothing. The
reason is derived from the property's writability flag and the current exposure
mode, not from a hardcoded table, so it stays true on a body we have never seen.

### A dial turned mid-plan is information

Mirroring is not only about drawing the right number. When the app is running a
plan and the photographer changes something on the body, the plan re-solves
against the new reality and says what it notices:

> You moved to f/8. At ISO 3200 that is four stops under for this sky — raise
> ISO to 12800, or was that deliberate?

It asks rather than corrects. The hand on the camera outranks the plan.

---

## Intent, not recipes

A recipe is a stored tuple of settings: *Milky Way — ISO 3200, f/2.8, 20s.* It
is wrong for a different lens, a different latitude, a brighter sky or a moon,
and it cannot say which. It is also exactly what every "camera settings" app and
article already gives away for free.

An intent is a goal, solved against the gear that is actually mounted and the
sky that will actually be there. **A plan is a function, not a saved value.**
Change the lens and the numbers recompute rather than going stale.

### What the app already knows, and must not ask

From the camera, over PTP: body, firmware, lens identity, focal range, maximum
aperture at the current focal length, card space, battery, every current
setting.

From Halfstop's existing `assets/js/lib/sky.js`, which was written for the map
and turns out to be exactly the scene-fact layer this needs: sun and moon
position and times, twilight phases, moon illumination, the galactic centre's
altitude and azimuth, the shootable Milky Way window for a night, the moonless
sub-window inside it, a quality score against cloud cover, and the best nights
in the next thirty. `aurora.js`, `eclipse.js` and the storm layers cover more of
the same ground.

What is left to ask is the part no sensor knows: what you want, and taste.
Two or three questions, not twenty.

### A worked example

*"I want to shoot the Milky Way over the lake tonight."*

The app answers the schedule question before the settings question, because
tonight may be the wrong night and no exposure triangle fixes that:

> Tonight is poor. The core is above 10° from 21:40, but the moon is up until
> 01:15 and sets after the core does. Thursday is the first clean window —
> 22:10 to 01:55, no moon, and the forecast is 15% cloud.

Then, for the window it recommends, every number derived rather than recalled:

- **Shutter** from the NPF limit for the lens actually mounted and the Z5's
  24 MP full-frame pixel pitch — not the 500 rule, which was written for film
  and trails visibly on a 24 MP sensor.
- **Aperture** wide open, or a stop down where the lens profile says wide open
  is soft enough to matter.
- **ISO** solved from the exposure equation against sky brightness at that
  location — a map app can know how dark the site is.
- **Frames** for stacking, and the foreground exposure as a separate blend.

And then the reality check against the physical state, which is where the two
principles meet:

> Your mode dial is on A; this needs M. Long-exposure noise reduction is on,
> which will double every frame — I can turn that off from here.

One it can fix, one only a hand can. It says which is which.

### The numbers do not come from a language model

The split is the spine of the whole thing:

- **A language model reads intent and explains the plan.** Free text becomes a
  typed intent object; the finished plan becomes plain English. It never emits
  a setting.
- **A deterministic solver produces every number.** Pure functions over intent,
  camera state and scene facts. No network, no model, fully testable — the same
  way the parsers and geometry in this repo are tested.

A model that computes exposure is confidently wrong often enough to matter, and
the cost of that lands at two in the morning in the dark, an hour from the car.
Arithmetic is not what a model is for.

### Provenance on every number

Each derived setting carries the one-line reason it holds: *20s — NPF limit at
20mm, f/1.8, 24MP full frame.* This is what makes it an intent rather than a
recipe with better manners: the reason is inspectable, arguable, and recomputed
when its inputs change.

---

## What this deliberately does not do

**No preset library.** Saving a plan's numbers would reintroduce the recipe
through the back door. What can be saved is the intent, which re-solves.

**No settings the camera does not expose.** The Z5 reports a subset of Nikon's
property set; the app offers what the body actually has, discovered at runtime
via `GetVendorPropCodes` (0x90CA), rather than a menu of things that will fail.

**No fighting the physical controls.** The app never asks the body for something
a dial forbids. It asks the photographer to move the dial.

---

## Still to settle

These need the camera on the desk, not more reading:

1. **Does the Z5 serve live view over PTP?** Nikon's own NX Tether lists the Z5
   without live view while the Z6 and up have it, which reads as a product tier
   rather than a hardware limit — the body speaks the same `StartLiveView`
   (0x9201) and `GetLiveViewImg` (0x9203) opcodes. If it does, click-to-focus
   and a live histogram are in reach and are most of what a tethering app is.
2. **Does the Z5 accept a Wi-Fi control session, or only image transfer?**
   Sources disagree. The camera's own network menu is the authority.
3. **Which properties does this body actually expose,** and which of them are
   writable in which modes. One probe run answers it.
4. **libgphoto2 or Nikon's SDK.** LGPL and broad model coverage against a
   registration-gated SDK with narrower coverage. This shapes everything.
