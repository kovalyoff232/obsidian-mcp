# Obsidian MCP Plugin — strict tree graph, MCP tools, and fast local search

Modern Obsidian plugin that indexes your vault and exposes powerful search and graph utilities via the Model Context Protocol (MCP). Local‑first, fast, and now with an enforced “strict tree” policy (ёлка) to keep graphs clean and readable.

## What’s new (strict tree policy)

We enforce a minimal, hierarchical graph by default:
- Frontmatter: only hierarchical edges via `part_of`. Keys `related`, `depends_on`, `blocks` are rejected.
- Exactly one parent per note (features → “Фичи”, solutions → “Решения”).
- Body: at most one wikilink, and it must point to the parent. Headings like “Связи/Relations” are forbidden.
- Enforcement: `mode: block` (server rejects invalid mutations) for note write/append/frontmatter/link tools.

Policy file (in your vault): `graph/.graph-policy.yml`.
After editing policy or many notes, run reindex to refresh caches.

## Key Features

- Vault indexing via Web Worker; writes `index.json` into plugin data folder
- Embedded MCP server (Node 20) launched by the plugin (stdio transport)
- High‑signal search with advanced operators and modes:
  - Modes: `balanced`, `taxonomy`, `semantic`
  - Operators: `"exact phrase"`, `+required`, `-excluded`, `title:`, `path:`, `tags:`, `content:`, `aliases:`, `type:`, `fm.<key>`
  - RU/EN normalization + synonyms, highlighting, lightweight expansion
- Graph tooling (MCP): read/write notes, safe frontmatter updates, normalize, repair tree
- Bench harness with CI thresholds; release artifacts with checksums and SLSA provenance

## Repository layout

- `src/` — plugin sources
  - `main.ts` — bootstrap, views, commands
  - `mcp_server.ts` — spawns `dist/mcp_server.js` (stdio)
  - `indexer.ts`, `indexer.worker.ts` — vault crawler → `index.json`
  - `indexing_view.ts`, `settings.ts`, `types.ts`
- `dist/` — `main.js`, `worker.js`, `mcp_server.js`
- `bin/` — helpers (`obsidian-mcp --checksum`, `install-server.sh`)
- `.github/workflows/` — `release.yml`, `pr-bench.yml`
- `bench/` — runner, config and dataset

## Install / build

```bash
npm ci
npm run build        # plugin + worker
npm run build:mcp    # TypeScript → dist/mcp_server.js
```

Then enable the plugin in Obsidian. Ensure Node is on PATH (for the server process).

## Usage

- Open the ribbon action “Activate MCP Indexing View” to see logs and controls
- Commands:
  - “Start Indexing” — crawl Markdown and write `index.json`
  - “Restart MCP Server” — restart embedded server
- Common scripts:
  - `npm run dev` — dev watch (plugin + worker)
  - `npm run start:mcp` — run server (stdio)
  - `npm run start:mcp-http` — experimental HTTP mode
  - `npm run bench` — run benchmarks (set `MCP_BENCH_ENFORCE=true` to enforce thresholds)

### Quick examples (MCP JSON args)

- notes — Write note:
```json
{"operation":"write","filePath":"docs/new-note","content":"Hello","writeMode":"create","frontmatter":{"title":"New","type":"note"}}
```
- notes — Append under heading with bullet+timestamp:
```json
{"operation":"append-under","filePath":"docs/new-note","heading":"Updates","content":"Refined","bullet":true,"timestamp":true}
```
- notes — Journal entry for a day:
```json
{"operation":"journal","content":"Daily log","date":"2025-09-09","heading":"Inbox","bullet":true,"timestamp":true}
```
- notes — Apply template and write:
```json
{"operation":"template","template":"## {{title}} at {{datetime}}","variables":{"title":"Meeting"},"filePath":"notes/meeting","writeMode":"create"}
```
- notes — Create node:
```json
{"operation":"create-node","filePath":"graph/Index/Test Hub","title":"Test Hub","type":"index","properties":{"owner":"you"},"content":"# Test Hub\nThis is an index hub."}
```
- notes — Capture quick note:
```json
{"operation":"capture","name":"Idea","content":"Thought...","folder":"inbox","tags":["idea"],"relations":["Knowledge Hub"]}
```
- notes — Frontmatter upsert:
```json
{"operation":"frontmatter","filePath":"docs/new-note","set":{"status":"draft"}}
```
- notes — Link notes (bidirectional, body+property):
```json
{"operation":"link","fromPath":"docs/new-note","toPath":"graph/Index/Test Hub","mode":"both","relation":"related"}
```
- notes — Move/Clone/Delete:
```json
{"operation":"move","fromPath":"docs/new-note","toPath":"archive/new-note"}
{"operation":"clone","fromPath":"docs/new-note","toPath":"docs/new-note-copy","setTitle":"New Note Copy"}
{"operation":"delete","path":"docs/new-note-copy"}
```
- notes — Bulk autolink:
```json
{"operation":"autolink","mappings":[{"term":"FAQ","toPath":"docs/FAQ"}],"maxPerFile":2,"limitFiles":50}
```

- graph — Validate policy on subtree:
```json
{"action":"validate","pathPrefix":"graph/Index/"}
```
- graph — Repair tree:
```json
{"action":"repair"}
```
- graph — Reload policy:
```json
{"action":"reload-policy"}
```
- graph — Normalize a single note baseline (dry run):
```json
{"action":"normalize-baseline","filePath":"docs/new-note","dryRun":true}
```
- graph — Find uncategorized notes (limit 10):
```json
{"action":"find-uncategorized","limit":10}
```

- index — Reindex all:
```json
{"action":"reindex-full"}
```
- index — Reindex since ISO timestamp:
```json
{"action":"reindex-since","since":"2025-09-01T00:00:00Z"}
```

- vault — Resolve/browse/content:
```json
{"operation":"resolve","input":"Test Hub"}
{"operation":"browse","mode":"tree","root":"graph/Index","maxDepth":2,"includeFiles":false}
{"operation":"content","context7CompatibleLibraryID":"graph/Index/Test Hub.md","tokens":1200}
```

## Unified MCP tools

- search — поиск по заметкам Obsidian
  - engine: `fuse|semantic|auto`, поддержка фильтров и форматов (`text|json`)
- notes — все операции с заметками и нодами (единый инструмент)
  - operations: `write | append-under | journal | template | create-node | capture | frontmatter | link | unlink | move | clone | delete | autolink | find-unlinked-mentions`
- graph — запросы и обслуживание графа/политики (единый инструмент)
  - query mode: `view: relations|summary|neighborhood|snapshot|policy|path`
  - maintenance mode: `action: repair|validate|reload-policy|normalize-baseline|find-uncategorized`
- index — индексация и семантика
  - actions: `reindex-full | reindex-since | embed-one | embed-build`
- vault — утилиты хранилища
  - operations: `resolve | browse | content`

Notes:
- RU/EN normalization is lightweight; synonyms can be extended from your vault.
- Semantic mode can be enabled gradually; text search remains primary.

## Graph policy (details)

- File: `graph/.graph-policy.yml`
- Mode: `warn|block` — при `block` нарушения политики вызывают ошибки в мутирующих инструментах
- Defaults (server):
  - `links.parentKey: "part_of"`, `links.relationsHeading: "Relations"`
  - Типы по умолчанию требуют базовые поля (например, `feature|solution|project|index` → `title,type,part_of`), некоторые типы помечены `mustHaveParent: true`
- Validated operations (policy enforcement):
  - Единый инструмент `notes` маппится на операции: `write-note`, `append-under-heading`, `upsert-frontmatter`, `link-notes`, `unlink-notes`, `note-move`, `note-clone` (эти идентификаторы используются в policy)

Reindex after bulk edits:

```bash
# via MCP unified tool:
# reindex all
index {"action":"reindex-full"}

# reindex since ISO timestamp
index {"action":"reindex-since","since":"2025-09-01T00:00:00Z"}

npm run bench   # optional quality check
```

### Create the policy file

The server does not generate the policy automatically. To enable the strict tree policy:

1) Create `graph/.graph-policy.yml` with a template like below (start with `mode: warn` if you prefer a soft rollout, then switch to `block`):

```yaml
version: 1
mode: block  # warn|block|off

global:
  frontmatter:
    disallow_keys: [related, depends_on, blocks]
  body:
    wikilinks:
      max_total: 1
      only_to_parent: true
    banned_headings: ["Связи", "Relations", "Связанное", "Related"]

types:
  feature:
    required_keys: [title, type, part_of]
    part_of:
      required: true
      exactly_one: true
      parent:
        title_in: ["Фичи"]
  solution:
    required_keys: [title, type, part_of]
    part_of:
      required: true
      exactly_one: true
      parent:
        title_in: ["Решения"]

enforcement:
  tools: [write-note, append-under-heading, upsert-frontmatter, link-notes, unlink-notes, note-move, note-clone]
```

2) Reload:
- Obsidian → Command Palette → “Restart MCP Server”; or
- Reindex via MCP (`reindex-vault`) to refresh caches.

3) Sanity check (optional): try to add a non-parent wikilink or a `related` key — in `block` mode the server should reject the mutation.

## Benchmarks

```bash
npm run bench
# Enforce thresholds:
MCP_BENCH_ENFORCE=true npm run bench
```

Artifacts: report JSON; metrics include p50/p95 latency, precision/recall@10, MRR@10.

## CI/CD

- PR: `.github/workflows/pr-bench.yml` uploads bench report
- Release: `.github/workflows/release.yml` builds, enforces bench, publishes artifacts (`dist/`, `SHA256SUMS.txt`), SLSA provenance; optional Cosign signing

## License

MIT
