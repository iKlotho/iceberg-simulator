# Iceberg Lineage Simulator

An interactive, fully client-side simulator for learning how Apache Iceberg's
table format works: schemas, snapshots, manifest lists, manifest files, and
data files — and how each mutation (append, delete, schema evolution,
compaction, snapshot expiration) changes that graph.

**[Open the live simulator](https://iklotho.github.io/iceberg-simulator/)**

There is no backend and no real Iceberg table anywhere: `index.html` is a
single self-contained page that simulates the metadata model in memory
(snapshot ids, manifest paths, per-column min/max stats, everything) and
persists it to the browser's `localStorage`. Row data you add is real and
really gets queried; the "files" it lives in are just JS objects shaped like
the real thing.

## What you can do

- Add / delete rows, add / delete columns, and watch new snapshots and
  manifest files appear in the graph.
- Click any node (table, snapshot, manifest file, data file) to inspect its
  metadata; click a data file to preview its actual rows.
- Run `SELECT ... FROM ... [WHERE ...] [ORDER BY ...] [LIMIT n]` in the SQL
  pane and watch the graph highlight exactly which manifests were opened and
  which data files were actually scanned vs. pruned by column stats.
- Compact all live data files into one, and expire old snapshots — both
  animate the resulting graph change.

## Repo layout

- `index.html` — the whole app. This is what gets deployed.
- `src/sim-engine.js`, `src/build-graph.js`, `src/sql-engine.js` — the same
  logic, kept as separate files so it's testable in Node. **These are not
  loaded by the page** — their contents are inlined into `index.html`. If you
  change one, copy the change into `index.html`'s `<script>` block too (or
  regenerate it — see below).
- `test/smoke-test.js` — a Playwright script that drives every button in a
  headless browser and fails on any console error.

## Regenerating index.html from src/

```
cat src/sim-engine.js src/build-graph.js src/sql-engine.js > /tmp/engine.js
# then splice /tmp/engine.js into index.html's <script> block, right after
# the opening <script> tag and before the rendering code.
```

## Testing

```
npm install
npm test
```
