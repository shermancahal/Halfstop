#!/bin/sh
#
# Cut a Protomaps extract, and say what came out.
#
#   BBOX=-85.0,35.0,-82.0,37.0 ZOOM=12 OUT=byways.pmtiles sh tools/cut-archive.sh
#
# Shared by two workflows, which is the reason it is a file rather than forty
# lines of YAML: the deploy publishes the result with the site, and
# cut-archive.yml hands it back as a download for somebody putting it on a
# bucket. Copying this between them would mean fixing the next thing twice.
#
# Three values are discovered rather than written down, and each is something
# that has already been guessed wrong once:
#
#   the pmtiles binary   asked for by which release assets exist, because their
#                        names carry the version, so /latest/download/<name>
#                        cannot be composed in advance
#   the planet build     walked back from today until one answers, because
#                        today's may not have finished and any date written
#                        into this file is wrong by tomorrow
#   the archive's depth  read back from the file, because an extract can come
#                        back shallower than it was asked for, and overstating
#                        it draws blank ground
#
# Writes DEPTH and BYTES to $GITHUB_OUTPUT when running under Actions.

set -eu

: "${BBOX:?BBOX is required: minlon,minlat,maxlon,maxlat}"
ZOOM="${ZOOM:-13}"
OUT="${OUT:-byways.pmtiles}"
PLANET="${PLANET:-}"
LIMIT="${LIMIT:-800000000}"

note() { printf '%s\n' "$*" >&2; }
fail() { printf '::error::%s\n' "$*" >&2; exit 1; }

if [ ! -s "$OUT" ]; then
  if [ ! -x ./pmtiles ]; then
    ASSET=$(curl -fsSL https://api.github.com/repos/protomaps/go-pmtiles/releases/latest \
      | jq -r '.assets[] | select(.name | test("[Ll]inux_x86_64\\.tar\\.gz$")) | .browser_download_url' \
      | head -1)
    if [ -z "$ASSET" ]; then
      note "Assets in the latest go-pmtiles release:"
      curl -fsSL https://api.github.com/repos/protomaps/go-pmtiles/releases/latest | jq -r '.assets[].name' >&2
      fail "No Linux x86_64 asset in the latest go-pmtiles release."
    fi
    note "pmtiles: $ASSET"
    curl -fsSL "$ASSET" | tar xz pmtiles
  fi

  if [ -z "$PLANET" ]; then
    back=0
    while [ "$back" -le 14 ]; do
      DAY=$(date -u -d "-${back} day" +%Y%m%d)
      TRY="https://build.protomaps.com/${DAY}.pmtiles"
      if curl -fsI --max-time 30 "$TRY" >/dev/null 2>&1; then PLANET="$TRY"; break; fi
      back=$((back + 1))
    done
  fi
  [ -n "$PLANET" ] || fail "No daily build answered under https://build.protomaps.com/ for the last 15 days. Set PLANET to the archive to cut from."
  note "planet: $PLANET"

  mkdir -p "$(dirname "$OUT")"
  # Reads the planet by byte range rather than downloading it, which is the
  # same property that makes the result usable from a browser.
  #
  # Retried, because what it hits at continental size is not a failure of this
  # command. The cut pulls gigabytes of byte ranges from one host, and
  # Cloudflare answers 524 when the origin stops keeping up: measured at 99% of
  # an 8.6 GB fetch, after throughput fell 24 -> 13 -> 5.7 -> 1.6 MB/s over the
  # final minute. Losing the whole transfer to the last few seconds of it is
  # worth a second go. A bad bbox or an unreachable planet fails the same way
  # on every attempt and costs only the time it already took, so this cannot
  # turn a real error into a long one.
  attempt=1
  until ./pmtiles extract "$PLANET" "$OUT" --bbox="$BBOX" --maxzoom="$ZOOM"; do
    if [ "$attempt" -ge 3 ]; then
      fail "pmtiles extract failed $attempt times. The error is above; an HTTP 5xx there is the planet host rather than this bbox."
    fi
    attempt=$((attempt + 1))
    note "extract failed - attempt $attempt of 3"
    # A part-written archive is worse than none: it has a valid header and
    # stops partway through the ground it claims.
    rm -f "$OUT"
    sleep 15
  done
else
  note "Reusing the extract already at $OUT."
fi

BYTES=$(wc -c < "$OUT" | tr -d ' ')
note "archive: $((BYTES / 1024 / 1024)) MB"
if [ "$BYTES" -gt "$LIMIT" ]; then
  fail "The extract is $((BYTES / 1024 / 1024)) MB, over the $((LIMIT / 1024 / 1024)) MB limit for this destination. Narrow the bbox, lower the zoom, or host it on a bucket."
fi

DEPTH=$(./pmtiles show "$OUT" 2>/dev/null | grep -oiE 'max[ _]?zoom:? *[0-9]+' | grep -oE '[0-9]+' | head -1 || true)
DEPTH="${DEPTH:-$ZOOM}"
note "depth: $DEPTH"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "maxzoom=$DEPTH"
    echo "bytes=$BYTES"
    echo "planet=$PLANET"
  } >> "$GITHUB_OUTPUT"
fi
