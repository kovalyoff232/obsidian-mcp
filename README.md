# Obsidian MCP Plugin (Context7-style)

Modern Obsidian plugin that indexes your vault and exposes powerful search and knowledge-graph tools through the Model Context Protocol (MCP). Designed for local-first workflows with strict folder-first taxonomy.

## Key Features

- Vault indexing via Web Worker; writes `index.json` into plugin data folder
- Integrated MCP server (Node.js) launched by the plugin
- High-signal search with advanced operators and modes:
  - Modes: `balanced`, `taxonomy`, `semantic`
  - RU/EN normalization (suffix-based stem/lemmatization) and synonyms expansion (user-extendable)
  - Query expansion, snippet highlighting, and relevance boosting by taxonomy/class
  - Operators: `"exact phrase"`, `+required`, `-excluded`, `title:`, `path:`, `tags:`, `content:`, `aliases:`, `type:`, `fm.<key>`
  - Presets: configurable complex queries (e.g. `preset:obsidian:plugins`)
- Obsidian settings for search defaults:
  - `Search default mode` (`balanced` | `taxonomy` | `semantic`)
  - `Include linked notes by default`
  - `Default search limit`
- Graph tools (MCP): create/link/unlink nodes, repair tree, bulk autolink, etc.
- Benchmarks (precision@10, recall@10, MRR@10, latency) with PR and Release CI
- Release supply-chain hardening: checksums, optional Cosign signatures, SLSA provenance
- Installer helper to fetch and verify MCP server binary

## Repository Layout

- `src/` — TypeScript sources for the Obsidian plugin
  - `main.ts` — plugin bootstrap, views, commands
  - `mcp_server.ts` — child-process manager for the bundled MCP server
  - `indexer.ts` + `indexer.worker.ts` — vault crawler (worker-based), saves `index.json`
  - `settings.ts` — UI settings (search defaults, excludes, ports, etc.)
  - `indexing_view.ts` — UI: logs, progress, control buttons
  - `types.ts` — `MCPSettings`, `IndexedFile`, defaults
- `dist/` — bundled JS (`main.js`, `worker.js`, `mcp_server.js`)
- `bin/` — helpers
  - `obsidian-mcp` — Node loader for `dist/mcp_server.js` (+ `--checksum`)
  - `install-server.sh` — downloads release assets and verifies SHA256
- `.github/workflows/` — `release.yml` and `pr-bench.yml`
- `bench/` — benchmark runner, config and dataset
- `plugin_architecture.md` — detailed design notes

## Installation

1) Install dependencies and build

```bash
npm ci
npm run build
```

2) Ensure `dist/mcp_server.js` exists (built by the project). If you prefer release artifacts:

```bash
bin/install-server.sh  # or bin/install-server.sh vX.Y.Z
```

3) Copy/symlink this folder to your Obsidian vault’s plugins dir or load it via a dev vault. Enable the plugin in Obsidian.

## Usage

- Open the ribbon action “Activate MCP Indexing View” to see logs and controls
- Commands:
  - “Start Indexing” — crawls Markdown files and writes `index.json`
  - “Restart MCP Server” — restarts the embedded Node MCP server
- Settings (Settings → Community Plugins → MCP Plugin):
  - MCP Server Port (currently Node stdio transport is used by the plugin)
  - Python Path (reserved; not required for current flow)
  - Embedding Model (reserved; current indexing stores previews only)
  - Excluded Folders
  - Search defaults: default mode, include linked, default limit

## MCP Tools (server)

Server is bundled in `dist/mcp_server.js` and started with stdio transport. Available tools include:

- `search-notes` — semantic/fuzzy/taxonomy-aware search
  - Args: `libraryName` (query string), `mode` (`balanced|taxonomy|semantic`), `limit` (number), `includeLinked` (boolean)
- `get-note-content` — fetch full content by id/title/path
- Graph and maintenance:
  - `find-uncategorized-notes`, `normalize-note-baseline`
  - `write-note`, `append-under-heading`, `create-node`
  - `link-notes`, `unlink-notes`, `upsert-frontmatter`, `repair-graph`
  - `apply-template`, `bulk-autolink`, `note-move`, `note-clone`, `note-delete`
  - `reindex-vault`, `reindex-changed-since`, `get-graph-summary`, `find-unlinked-mentions`

Notes:
- RU/EN normalization uses lightweight suffix rules. The code is ready for lazy external stemmers when added.
- Synonyms: built-in dictionary + user-provided from vault notes (json or `key: a, b, c`).

## Search Modes

- `balanced` — general-purpose weights across title/path/content
- `taxonomy` — boosts folder/class and taxonomy signals
- `semantic` — normalization-heavy matching with heuristic score adjustment

## Benchmarks

Run locally:

```bash
npm run bench
```

- Config: `bench/config.json` (thresholds); environment `MCP_BENCH_ENFORCE=true` enforces failure on regressions
- Dataset: `bench/dataset.json` (queries and expected paths)
- Metrics: `precision_at_10`, `recall_at_10`, `mrr_at_10`, `latency.p50/p95`

## CI/CD

- PRs: `.github/workflows/pr-bench.yml` produces a report artifact
- Releases: `.github/workflows/release.yml`
  - Build + enforced bench
  - Produce `artifacts/dist`, `SHA256SUMS.txt`
  - Generate SLSA provenance; optionally Cosign-sign checksums (if secrets provided)

## Installer

```bash
# Download and verify server from GitHub Releases
bin/install-server.sh [vX.Y.Z|latest]

# Verify checksum of local server
bin/obsidian-mcp --checksum
```

## Development

- Build: `npm run build` (plugin and worker), `npm run build:mcp` (ensure server permissions)
- Dev: `npm run dev` (esbuild watch) in another shell
- Code style: TypeScript, explicit types on public APIs; keep functions small and readable

## Configuration Surface (Settings)

- `mcp_port`: number (currently unused for stdio mode)
- `python_path`: string (reserved)
- `embedding_model`: string (reserved)
- `excluded_folders`: string[]
- `search_default_mode`: `'balanced' | 'taxonomy' | 'semantic'`
- `search_include_linked_default`: boolean
- `search_limit_default`: number

## License

MIT
