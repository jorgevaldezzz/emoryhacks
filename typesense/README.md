# typesense — photo-spot search

Finds photogenic places near a caller: summits, viewpoints, murals, parks,
piers. The pose agent calls it mid-conversation when someone asks "anywhere good
nearby?", or when their background is a parking lot.

It also answers the other half of that question: the caller sends a **reference
photo** on the website, and `matchReferencePhoto()` compares that background to
what is behind them right now. Already alike? Stay put. Different? Here is the
nearest place that looks like the photo — a mountain reference finds summits, a
mural reference finds murals.

**This feature is optional.** The pose agent coaches a pose with no location at
all. Nothing here asks for a location, and `findNearbySpots()` never throws — a
search that fails degrades to "no spots", which the agent can talk around,
rather than breaking a live FaceTime call.

```
typesense/
├── docker-compose.yml     local Typesense server
├── schema/photo_spots.json
├── src/
│   ├── search.mjs         searchNearby() / findNearbySpots()  ← what you import
│   ├── match.mjs          matchReferencePhoto() — reference photo in, spots out
│   ├── vision.mjs         reads the background out of a photo
│   ├── scene.mjs          the scene vocabulary the photo and the index share
│   ├── client.mjs         admin and search-only connections
│   ├── osm.mjs            OSM tag rules, Overpass query, normalization
│   └── geo.mjs            distance, bearing, compass
├── scripts/               create-collection, seed-from-osm, import-curated, …
├── data/curated/          hand-picked spots (JSONL, committed)
└── test/                  81 tests, no server needed
```

> Written as `.mjs`, not the `.ts` in the original sketch, to match
> `pose-agent/` — plain Node ESM, no build step, so it imports directly.

## Set up

```sh
cp .env.example .env.local && chmod 600 .env.local   # then edit it
npm install
npm run up            # Typesense on localhost:8108 (docker)
npm run collection    # create the photo_spots collection
npm run seed:curated  # 12 hand-picked Atlanta spots
npm run seed:osm -- --city "Atlanta"
```

Then try it:

```sh
npm run query -- --at 33.7556,-84.3715 --radius 2
```

```
3 spot(s) within 2 km:

  Jackson Street Bridge
    viewpoint · right here, faces southwest · quality 97 · curated
    best: golden hour
    tip: Shoot from the north sidewalk so the skyline sits behind you
  ...
Agent would say: Jackson Street Bridge, right here, facing southwest; and
Martin Luther King Jr. National Historical Park, 170 m west.
```

No Docker? Any Typesense server works — point `TYPESENSE_URL` at it. On NixOS:

```sh
mkdir -p /tmp/ts
nix-shell -p typesense --run 'typesense-server --data-dir=/tmp/ts --api-key=dev-only-change-me'
```

## Using it from the agent

```js
import { findNearbySpots } from '../typesense/src/search.mjs';
```

`findNearbySpots({ lat, lng, ...opts })` is the shape to hand an LLM tool call.
It never throws, and always returns something the agent can say:

```js
{ ok: true,
  spots: [{ name, category, distance_text: '720 m', heading_text: 'west-northwest',
            faces: 'southwest', best_time, tips: [], maps_url, quality, source }],
  radius_km: 2,
  message: 'Jackson Street Bridge, 720 m west-northwest, facing southwest.' }
```

Failures come back as `{ ok: false, reason, spots: [], message }`, where
`reason` is `no_location`, `not_seeded`, `not_configured`, `bad_input`, or
`unavailable`. The `message` is always safe to read out; `detail` holds the real
cause for your logs, not the caller.

Register the tool only once the caller has opted into sharing a location, so the
model does not keep asking for one. A sketch for `pose-agent`:

```js
const tools = {
  find_nearby_spots: llm.tool({
    description: 'Find photogenic spots near the caller. Only call this when the caller has shared a location.',
    parameters: z.object({
      lat: z.number(), lng: z.number(),
      query: z.string().optional().describe('e.g. "mural", "skyline"'),
      radiusKm: z.number().optional(),
    }),
    execute: async args => findNearbySpots(args),
  }),
};
```

`searchNearby(lat, lng, opts)` is the lower-level call. Same results, but it
throws `SpotSearchError` (with a `code`) instead of swallowing failures. Use it
from the website or a script, where an exception is fine.

### Options

| option | default | |
| --- | --- | --- |
| `radiusKm` | `3` | where to start looking |
| `expand` | `true` | widen 3× at a time while nothing is found |
| `maxRadiusKm` | `10` | ceiling for that widening — past that it is a day trip, not a spot |
| `limit` | `5` | |
| `query` | — | free text; omit to rank purely by distance |
| `categories` | all | `viewpoint`, `mural`, `artwork`, `peak`, `waterfall`, `cliff`, `beach`, `pier`, `bridge`, `garden`, `park`, `attraction` |
| `curatedOnly` | `false` | hand-picked spots only |
| `minQuality` | — | 0–100 |
| `city`, `bestTime`, `excludeIndoor` | — | |
| `signal` | — | `AbortSignal`; the read client also times out at 3 s |

The 3-second timeout is deliberate: inside a live call, a slow answer is worse
than no answer.

## Matching a reference photo

The caller sends the shot they want to recreate; the agent can grab a frame of
what is behind them now. One call does the rest:

```js
import { matchReferencePhoto } from '../typesense/src/match.mjs';

const result = await matchReferencePhoto({
  reference,          // the photo from the website: data: URL, https: URL or bytes
  current,            // a frame of the caller now; omit to skip the comparison
  lat, lng,           // omit and you still get the comparison, without spots
});
```

```js
{ ok: true, matches: false,
  reference_scene: 'mountain',   current_scene: 'interior',
  reference_background: 'a granite ridge at sunset',
  similarity: 0.05,
  spots: [ /* the same spot shape as above */ ],
  radius_km: 9,
  message: 'You are against a bedroom wall; the reference is a mountain ridge. ' +
           'Stone Mountain Summit, 8.1 km east; and Arabia Mountain, 9 km southeast.' }
```

When the backgrounds already agree, nothing is searched at all:

```js
{ ok: true, matches: true, reason: 'already_matching', spots: [], similarity: 0.86,
  message: 'Your background already looks like the reference — a mountain. Stay where you are.' }
```

`reason` is `found`, `already_matching`, `no_results`, `no_location`,
`no_reference`, `bad_image`, `not_configured` or `unavailable`. Like
`findNearbySpots`, it never throws and the `message` is always safe to read
out; `detail` holds the real cause, for your logs.

The reference photo arrives once, from the website; the live frame arrives per
call. So bind the reference when you register the tool, and let the model pass
only what changes:

```js
const tools = {
  match_my_background: llm.tool({
    description: "Compare the caller's background to the photo they want to recreate.",
    parameters: z.object({ lat: z.number().optional(), lng: z.number().optional() }),
    execute: async args => matchReferencePhoto({ ...args, reference, current: await grabFrame() }),
  }),
};
```

### How the matching works

Typesense searches text and geography, not pixels — so one vision call turns
both photos into a small shared vocabulary, and everything after that is an
ordinary search:

```
reference + current ──one vision call──▶ { scene: 'mountain', tags: ['granite ridge'] }
                                         { scene: 'interior',  tags: ['white wall'] }
                                         similarity 0.05
          similarity ≥ 0.65 ? ──yes──▶ "stay where you are", no search
                              └─no───▶ filter_by category:[peak, cliff, viewpoint]
                                       && location:(lat, lng, 3 km)
                                       q: "granite ridge summit peak ridge overlook"
```

The scenes live in [`src/scene.mjs`](src/scene.mjs) — `mountain`, `skyline`,
`water`, `beach`, `waterfall`, `forest`, `garden`, `park`, `mural`,
`architecture`, `street`, `bridge`, `interior`, `plain` — each with the
categories that photograph like it. The list is short on purpose: every extra
scene is one more thing the model can be wrong about. A scene it does not know
becomes `unknown`, which filters nothing rather than guessing, and the model's
own words (`granite ridge`) lead the query ahead of the scene's generic ones.

Two deliberate details. **The reference decides what we look for**, not the
caller's surroundings — a mural reference searches murals even if the caller is
already up a mountain. And when the categories find nothing within 10 km, there
is a second pass on the words alone, because in a thinly-mapped city
`category:[peak]` can be empty while "ridge" is not.

Try it from the shell:

```sh
npm run match -- --reference ref.jpg --current frame.jpg --at 33.7556,-84.3715
```

```
reference: mountain (a granite ridge at sunset)
current:   interior
similarity 0.05 → different enough to move

  Stone Mountain Summit
    peak · 8.1 km east · quality 75 · osm
  ...
```

The vision call needs `OPENAI_API_KEY` (or `VISION_API_KEY`) — the same key
`pose-agent` already has. Any OpenAI-compatible endpoint works: set
`VISION_MODEL` and `VISION_BASE_URL`. Plain spot search needs no key at all, so
nothing else here stops working if that one is missing.

## Where the data comes from

Two sources, deliberately. **OSM** gives breadth; **curated** gives judgement.

OSM tags say what a place *is*, not whether it photographs well — a
`tourism=viewpoint` can be a parking-lot overlook, and `tourism=attraction` is
broad enough to include a historic marker on a pole. So each category carries a
baseline `quality` (viewpoint 70 … attraction 40), bumped for signals that
someone cared (`wikidata`, `image`, a name) and docked for `access=private`.
Curated spots default to 85 and outrank all of it.

| category | OSM selector |
| --- | --- |
| `viewpoint` | `tourism=viewpoint` (carries `direction`: which way the view faces) |
| `mural` | `tourism=artwork` + `artwork_type` in mural/graffiti/street_art |
| `artwork` | `tourism=artwork` + sculpture/statue/installation/mosaic/relief |
| `peak` | `natural=peak` — the literal top of a mountain |
| `waterfall` | `waterway=waterfall` |
| `cliff` | `natural=cliff` |
| `beach` | `natural=beach` |
| `pier` | `man_made=pier` |
| `bridge` | `man_made=bridge` (the structure, not every road that crosses something) |
| `garden` | `leisure=garden` (excluding residential) |
| `park` | `leisure=park` |
| `attraction` | `tourism=attraction` — the noisy catch-all, so it ranks last |

`peak`, `cliff` and `bridge` were added for the photo match — re-run
`npm run seed:osm` for a city you seeded before that, or those three stay empty
and a mountain reference falls through to the relaxed word search.

**Check coverage before you trust a city.** OSM is volunteer-mapped: dense
cities are well covered, smaller ones can be nearly empty.

```sh
npm run seed:osm -- --city "Savannah" --dry-run
```

That fetches and reports per-category counts without importing. Under ~20 spots,
the script says so — curate that city by hand instead.

Other ways to scope a seed:

```sh
npm run seed:osm -- --bbox 33.64,-84.55,33.89,-84.29
npm run seed:osm -- --around 33.7490,-84.3880 --radius 10
npm run seed:osm -- --city "Atlanta" --categories mural,viewpoint
```

Normalized output is written to `data/osm/` (gitignored — regenerate it) and
upserted on a stable `osm-<type>-<id>`, so re-seeding updates rather than
duplicates. Places mapped twice (a node inside its own way) collapse to the
higher-quality row.

Overpass's public instance is rate-limited and a city-wide query takes ~40 s. Be
gentle with it, or point `OVERPASS_URL` at your own.

### Curated spots

`data/curated/*.jsonl`, one spot per line, with tips written as spoken advice —
the agent reads them out. See [`data/curated/README.md`](data/curated/README.md)
for the fields.

The shipped `atlanta.jsonl` has 12 spots whose **coordinates are approximate**
(good to within a block, not verified on the ground) and whose tips are generic
photography advice. Check them against a map before relying on them.

## Keys

Two of them. `TYPESENSE_ADMIN_KEY` creates collections and imports documents;
it must stay server-side. The website gets a search-only key, because anything
in a browser bundle is public:

```sh
npm run search-key
```

Typesense shows the full value once. It can search `photo_spots` and nothing
else — writes come back 401.

A third, only for `matchReferencePhoto()`: `OPENAI_API_KEY` (or
`VISION_API_KEY`), server-side like the admin key. Without it the photo match
returns `reason: 'not_configured'` and everything else carries on.

## Tests

```sh
npm test     # 81 tests: geo maths, OSM normalization, query building, search and match behaviour
npm run check  # syntax only
```

They run against a fake client and a fake vision endpoint, so no server, no key
and no network are needed. They cover the things that are easy to get quietly
wrong: radius expansion, filter construction, the degradation paths, whether a
scene maps to categories that actually exist, and whether
`schema/photo_spots.json` and the curated JSONL still agree with the code.

## Licensing

OSM data is **ODbL**. Attribute "© OpenStreetMap contributors" anywhere the
spots are shown — `searchNearby` returns that string in `attribution`, and only
when an OSM row is actually in the results. Read the share-alike terms before
publishing a derived database.
