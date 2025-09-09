# Obsidian MCP Plugin — unified MCP tools, strict graph policy, fast local search

A modern Obsidian plugin that indexes your vault and exposes powerful search and graph utilities via the Model Context Protocol (MCP). Local‑first, fast, and policy‑driven.

- Unified tool surface (search, notes, graph, index, vault)
- Strict graph policy (tree‑like structure) controlled by JSON
- Fast local search with advanced operators and optional semantic mode
- Clean APIs for note authoring and graph maintenance

## What’s new

- Unified MCP tools: replaced the earlier tool “zoo” with a small set of consistent tools: `search`, `notes`, `graph`, `index`, `vault`.
- Policy‑driven graph: all rules for relations, folders, hubs, and index notes are configured in `graph/_graph_policy.json` (YAML file `.graph-policy.yml` remains a fallback).
- Safer mutations: the server validates note mutations against policy (warn or block).

## Repository layout

- `src/` — plugin sources
  - `main.ts` — bootstrap, views, commands
  - `mcp_server.ts` — MCP server entry (stdio)
  - `indexer.ts`, `indexer.worker.ts` — vault crawler → `index.json`
  - `indexing_view.ts`, `settings.ts`, `types.ts`
- `dist/` — `main.js`, `worker.js`, `mcp_server.js`
- `bin/` — helpers (`obsidian-mcp --checksum`, `install-server.sh`)
- `.github/workflows/` — `release.yml`, `pr-bench.yml`
- `bench/` — runner, config and datasets

## Install / build

```bash
npm ci
npm run build        # plugin + worker
npm run build:mcp    # TypeScript → dist/mcp_server.js
```

Enable the plugin in Obsidian. Ensure Node is on PATH (for the server process).

## Unified MCP tools (overview)

- `search` — query notes (engines: `fuse | semantic | auto`); supports filters and JSON output
- `notes` — the one tool for authoring and maintenance:
  - `write | append-under | journal | template | create-node | capture | frontmatter | link | unlink | move | clone | delete | autolink | find-unlinked-mentions`
- `graph` — graph queries and maintenance:
  - query: `relations | summary | neighborhood | snapshot | policy | path`
  - maintenance: `repair | validate | reload-policy | normalize-baseline | find-uncategorized`
- `index` — indexing and semantic helpers:
  - `reindex-full | reindex-since | embed-one | embed-build`
- `vault` — vault utilities:
  - `resolve | browse | content`

## Usage (JSON arguments)

Below are minimal examples of JSON arguments for `tools/call`:

- notes — write a note
```json
{"operation":"write","filePath":"docs/new-note","content":"Hello","writeMode":"create","frontmatter":{"title":"New","type":"note"}}
```
- notes — append under a heading with bullet+timestamp
```json
{"operation":"append-under","filePath":"docs/new-note","heading":"Updates","content":"Refined","bullet":true,"timestamp":true}
```
- notes — daily journal entry
```json
{"operation":"journal","content":"Daily log","date":"2025-09-09","heading":"Inbox","bullet":true,"timestamp":true}
```
- notes — apply a template and write
```json
{"operation":"template","template":"## {{title}} at {{datetime}}","variables":{"title":"Meeting"},"filePath":"notes/meeting","writeMode":"create"}
```
- notes — create a node
```json
{"operation":"create-node","filePath":"graph/Index/Test Hub","title":"Test Hub","type":"index","properties":{"owner":"you"},"content":"# Test Hub\nThis is an index hub."}
```
- notes — capture a quick note
```json
{"operation":"capture","name":"Idea","content":"Thought...","folder":"inbox","tags":["idea"],"relations":["Knowledge Hub"]}
```
- notes — frontmatter upsert
```json
{"operation":"frontmatter","filePath":"docs/new-note","set":{"status":"draft"}}
```
- notes — link (bidirectional, body+property)
```json
{"operation":"link","fromPath":"docs/new-note","toPath":"graph/Index/Test Hub","mode":"both","relation":"related"}
```
- notes — move/clone/delete
```json
{"operation":"move","fromPath":"docs/new-note","toPath":"archive/new-note"}
{"operation":"clone","fromPath":"docs/new-note","toPath":"docs/new-note-copy","setTitle":"New Note Copy"}
{"operation":"delete","path":"docs/new-note-copy"}
```
- notes — bulk autolink
```json
{"operation":"autolink","mappings":[{"term":"FAQ","toPath":"docs/FAQ"}],"maxPerFile":2,"limitFiles":50}
```

- graph — validate subtree
```json
{"action":"validate","pathPrefix":"graph/Index/"}
```
- graph — repair tree
```json
{"action":"repair"}
```
- graph — reload policy
```json
{"action":"reload-policy"}
```
- graph — normalize baseline (dry run)
```json
{"action":"normalize-baseline","filePath":"docs/new-note","dryRun":true}
```
- graph — find uncategorized notes
```json
{"action":"find-uncategorized","limit":10}
```

- index — reindex
```json
{"action":"reindex-full"}
```
- index — reindex since a timestamp
```json
{"action":"reindex-since","since":"2025-09-01T00:00:00Z"}
```

- vault — resolve/browse/content
```json
{"operation":"resolve","input":"Test Hub"}
{"operation":"browse","mode":"tree","root":"graph/Index","maxDepth":2,"includeFiles":false}
{"operation":"content","context7CompatibleLibraryID":"graph/Index/Test Hub.md","tokens":1200}
```

## Graph policy (JSON first)

The server reads policy from `graph/_graph_policy.json`. If it’s missing, it falls back to `graph/.graph-policy.yml`. JSON has priority and is recommended.

Key fields:
- `mode`: `warn | block` — reject invalid mutations when `block`
- `links.parentKey`: name of the hierarchical relation in frontmatter (e.g. `part_of`)
- `links.relationsHeading`: heading in body for relation sections (e.g. `Relations`)
- `links.defaultRelation`: default frontmatter relation list name (e.g. `related`)
- `folders.canonicalPrefix`: canonical graph root (e.g. `graph/Knowledge Hub/`)
- `folders.hubs.defaultPath`: canonical Hub note (e.g. `graph/Knowledge Hub/Knowledge Hub.md`)
- `folders.index.*`: auto‑index settings for folder index notes
- `global.frontmatter.disallow_keys`: keys that must not appear in frontmatter
- `types.*`: optional per‑type requirements and parent constraints

Example `graph/_graph_policy.json`:
```json
{
  "version": 1,
  "mode": "block",
  "links": {
    "parentKey": "part_of",
    "relationsHeading": "Relations",
    "defaultRelation": "related"
  },
  "folders": {
    "canonicalPrefix": "graph/Knowledge Hub/",
    "hubs": { "defaultPath": "graph/Knowledge Hub/Knowledge Hub.md" },
    "index": { "autoCreate": true, "noteType": "class", "summaryHeading": "Summary", "relationsHeading": "Relations" }
  },
  "global": {
    "frontmatter": { "disallow_keys": ["related", "depends_on", "blocks"] },
    "body": { "banned_headings": ["Relations", "Related"] }
  },
  "types": {
    "feature": { "required": ["title", "type", "part_of"], "mustHaveParent": true },
    "solution": { "required": ["title", "type", "part_of"], "mustHaveParent": true }
  }
}
```

After updating the policy or performing bulk edits, reindex:
```bash
# via the MCP tool
index {"action":"reindex-full"}
```

## Scripts

- `npm run dev` — dev watch (plugin + worker)
- `npm run start:mcp` — run the MCP server (stdio)
- `npm run start:mcp-http` — experimental HTTP mode
- `npm run bench` — run benchmarks (set `MCP_BENCH_ENFORCE=true` to enforce thresholds)

## Benchmarks & CI

```bash
npm run bench
# Enforce thresholds
MCP_BENCH_ENFORCE=true npm run bench
```

- PR: `.github/workflows/pr-bench.yml` uploads the bench report
- Release: `.github/workflows/release.yml` builds, enforces bench, publishes artifacts (`dist/`, `SHA256SUMS.txt`), SLSA provenance; optional Cosign signing

## Troubleshooting

- The plugin launches a Node process from PATH. If the server fails to start, ensure `node -v` is available inside Obsidian’s environment.
- If `dist/mcp_server.js` is missing, run `npm run build:mcp`.
- If the policy file is invalid, the server falls back to safe defaults and logs a warning.

## License

MIT
