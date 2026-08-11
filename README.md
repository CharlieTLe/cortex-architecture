# Cortex architecture — interactive diagram

**[charlietle.github.io/cortex-architecture](https://charlietle.github.io/cortex-architecture/)**

An interactive diagram of [Cortex](https://github.com/cortexproject/cortex): the
write path, read path, blocks lifecycle and optional services, with the protocol,
endpoint and hash ring behind every hop.

> Unofficial and personally maintained. This is not part of the Cortex project's
> documentation — for that, see [cortexmetrics.io](https://cortexmetrics.io/docs/architecture/).

## Why

Cortex documents its architecture with a single static PNG plus 2,700 words of
prose. The facts a reader actually wants — which ring each component uses, what
protocol each hop speaks, which endpoint, stateful or stateless — live in the
prose, disconnected from the picture. This puts them in the picture.

It also shows a few things the upstream diagram doesn't: the **query-scheduler**,
the **OTLP ingest** endpoint, the **HA tracker**, and the **parquet-converter**
(marked experimental, since the docs don't cover it yet).

## What's in it

- **Hover a connector** for its protocol and endpoint.
- **Select a component** for its role, statefulness, ring prefix + key, endpoints,
  `-target` value, and source file.
- **Toggle the two query-queue topologies** — query-scheduler vs. the frontend's
  own queue. These are genuinely different graphs, not a cosmetic variant.
- **Toggle the ruler's two evaluation modes** — its own querier stack, or via the
  query-frontend with `-ruler.frontend-address`.
- **Toggle the parquet queryable** — off by default. Turning it on wires up the
  two parquet caches and the parquet-converter, which have no purpose without it.
- **Walk a flow** — write, read, rule evaluation, blocks lifecycle, one hop at a time.
- **Table view** — every component and connection as text.
- **Light and dark**, following the OS with an override.

All seven caches are drawn separately, because no two have the same consumers:

| Cache | Used by |
|---|---|
| Results cache | query-frontend |
| Metadata cache | querier, store-gateway, **compactor** |
| Chunks cache | querier, store-gateway |
| Index cache | store-gateway only |
| Parquet labels / rows | querier, store-gateway's parquet stores (parquet queryable only) |
| Expanded postings | ingester — **in-process**, no memcached behind it |

The expanded postings cache sits beside the ingester rather than in the cache
column precisely because it is in-process: drawing it on the right would imply a
network hop that does not exist. It is also configured apart from the others,
under `blocks-storage.tsdb.*` rather than `bucket-store.*`.

## Running it locally

It's one self-contained file with no build step:

```sh
open index.html
```

D3 comes from a pinned CDN URL with a subresource-integrity hash, so the first
load needs network access.

## Editing it

Components and connections live in the `NODES` and `EDGES` arrays near the top of
the single `<script>` in `index.html`. Positions are hand-placed rather than
force-directed, so the reading order survives a reload.

```sh
npm install
npm test         # layout audit + interaction tests
npm run snapshot # writes build/snap-{light,dark}.svg to eyeball the layout
```

Two things to know before changing it:

- **The three path colours are not free choices.** They are documented categorical
  palette slots, validated for colour-vision deficiency on the *all-pairs*
  pairlist in both light and dark mode. A node-link diagram lets any two marks sit
  adjacent, and only three-hue subsets clear that gate — adding a fourth hued
  category fails it. The aqua slot sits below 3:1 on the light surface, which is
  why the table view ships as part of the page: it's the relief channel, not an
  extra.
- **The metadata is hand-maintained.** The `src` path in each panel is the
  authority. If you change a ring key, prefix or endpoint, check it against the
  Cortex source first.

### What the tests cover

`tests/audit.mjs` re-uses the page's own geometry functions, so it can't drift
from what the browser renders. It checks overlapping boxes, labels wider than
their box, connectors cutting through unrelated components, edges stacked on one
anchor, dangling references, every flow step under every mode combination, and
that the d3 SRI hash matches the pinned version.

`tests/smoke.mjs` loads the real page in jsdom and drives every control, asserting
the DOM changed: filters dim without recolouring, both mode toggles swap the right
connectors, every panel and hover renders, and every flow steps through.

Neither catches how it actually *looks* in a browser — `npm run snapshot` plus a
real page load is still the last step before shipping a layout change.

## Deployment

`.github/workflows/pages.yml` runs the tests and deploys to GitHub Pages on every
push to `main`. A failing test blocks the deploy. `verify.yml` runs the same suite
on pull requests and uploads the layout snapshots as an artifact.

## License

[Apache-2.0](LICENSE), matching Cortex, from whose source and documentation the
diagram's content is derived.
