# Curated spots

Hand-picked spots, one JSON object per line. These exist because OSM tags say
what a place *is*, not whether it photographs well — a `tourism=viewpoint` can
be a parking-lot overlook. Curated rows carry tips, a best time, and a high
`quality`, so they outrank bulk-imported OSM rows in search.

Import with `npm run seed:curated` (add `--dry-run` to validate only).

## Fields

Required: `name`, `category`, and a position as either `lat` + `lng` or
`location: [lat, lng]`.

| field | notes |
| --- | --- |
| `id` | Optional; generated from city + name when absent. Keep it stable — import upserts on it. |
| `category` | One of `viewpoint`, `mural`, `artwork`, `waterfall`, `beach`, `pier`, `garden`, `park`, `attraction`. |
| `direction` | Which way the view faces: degrees (`230`) or a compass point (`SW`). This is what matches a sunset or skyline request. |
| `best_time` | Free text, e.g. `golden hour`, `blue hour`, `overcast midday`. Faceted, so keep the wording consistent. |
| `quality` | 0–100, default 85. OSM baselines run 40–70, so curated rows win by default. Drop a mediocre spot to 60. |
| `tips` | Array of short strings. The agent reads these out, so write them as spoken advice. |
| `tags`, `description`, `city`, `indoor`, `website`, `image` | Optional. |

Lines starting with `//` are skipped, so you can comment a file.

## A warning about `atlanta.jsonl`

The coordinates in the shipped Atlanta file are approximate — good to within a
block or so, which is enough for a "what's near me" radius search, but **not
verified on the ground**. Before relying on them, check each against a map and
correct it. The tips are generic photography advice, not local knowledge.
