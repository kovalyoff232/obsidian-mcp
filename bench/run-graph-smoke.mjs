#!/usr/bin/env node
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

function now() { return (globalThis.performance?.now?.() ?? Date.now()); }

async function startServer() {
  const serverPath = join(ROOT, 'dist', 'mcp_server.js');
  const proc = spawn('node', [serverPath, '--transport', 'stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((resolve) => setTimeout(resolve, 800));
  return proc;
}

async function callTool(proc, name, args) {
  const req = {
    jsonrpc: '2.0',
    id: Math.random().toString(36).slice(2),
    method: 'tools/call',
    params: { name, arguments: args }
  };
  const payload = JSON.stringify(req);
  proc.stdin.write(payload + '\n');
  const res = await new Promise((resolve) => {
    let buf = '';
    const onData = (data) => {
      buf += data.toString();
      try {
        const parsed = JSON.parse(buf);
        proc.stdout.off('data', onData);
        resolve(parsed);
      } catch {}
    };
    proc.stdout.on('data', onData);
  });
  return res;
}

function asText(res) {
  return res?.result?.content?.[0]?.text || '';
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function main() {
  const server = await startServer();
  const results = [];

  const tests = [
    {
      name: 'get-graph-snapshot',
      args: {
        scope: { folderPrefix: 'graph/Dev Hub/Проекты/Obsidian MCP Plugin' },
        depth: 2,
        direction: 'both',
        include: { bodyLinks: true, fmLinks: true },
        maxNodes: 400,
        maxEdges: 1200,
        format: 'json'
      },
      validate: (text) => {
        const j = parseJson(text);
        return !!(j && Array.isArray(j.nodes) && j.nodes.length > 0);
      }
    },
    {
      name: 'get-note-neighborhood',
      args: {
        noteId: 'graph/Dev Hub/Проекты/Obsidian MCP Plugin/Obsidian MCP Plugin.md',
        depth: 2,
        direction: 'both',
        fanoutLimit: 30,
        format: 'json'
      },
      validate: (text) => {
        const j = parseJson(text);
        return !!(j && Array.isArray(j.levels));
      }
    },
    {
      name: 'find-path-between',
      args: {
        from: 'graph/Dev Hub/Проекты/Obsidian MCP Plugin/Runbooks/Релиз и проверка артефактов/Релиз и проверка артефактов.md',
        to: 'graph/Dev Hub/Проекты/Obsidian MCP Plugin/Obsidian MCP Plugin.md',
        direction: 'both',
        maxDepth: 5,
        allowedRelations: ['wikilink','frontmatter:part_of'],
        format: 'json'
      },
      validate: (text) => {
        const j = parseJson(text);
        return !!(j && Array.isArray(j.paths) && j.paths[0] && j.paths[0].length >= 2);
      }
    },
    {
      name: 'get-relations-of-note',
      args: {
        noteId: 'graph/Dev Hub/Проекты/Obsidian MCP Plugin/Решения/Поставка сервера через dist и CI/Поставка сервера через dist и CI.md',
        include: { bodyLinks: true, frontmatterLists: '*' }
      },
      validate: (text) => {
        const j = parseJson(text);
        const fm = j && j.frontmatter;
        return !!(fm && Object.values(fm).some((arr) => Array.isArray(arr) && arr.length > 0));
      }
    },
    {
      name: 'get-vault-tree',
      args: {
        root: 'graph/Dev Hub/Проекты/Obsidian MCP Plugin',
        maxDepth: 2,
        includeFiles: false,
        includeCounts: true,
        sort: 'name',
        limitPerDir: 50,
        format: 'json'
      },
      validate: (text) => {
        const j = parseJson(text);
        return !!(j && j.type === 'directory' && Array.isArray(j.children));
      }
    }
  ];

  for (const t of tests) {
    const t0 = now();
    const res = await callTool(server, t.name, t.args);
    const t1 = now();
    const txt = asText(res);
    let ok = false;
    let message = '';
    try { ok = t.validate(txt); } catch (e) { ok = false; message = String(e); }
    if (!ok && !message) message = 'validation failed or unexpected response';
    results.push({ name: t.name, ok, latencyMs: t1 - t0, message });
  }

  server.kill();

  const summary = {
    total: results.length,
    passed: results.filter(r=>r.ok).length,
    failed: results.filter(r=>!r.ok).length,
    p95_latency_ms: (()=>{
      const xs = results.map(r=>r.latencyMs).sort((a,b)=>a-b);
      return xs[Math.floor(xs.length*0.95)] || 0;
    })()
  };

  const report = { summary, results };
  console.log(JSON.stringify(report, null, 2));
  if (summary.failed > 0) process.exit(2);
}

main().catch((e)=>{ console.error(e); process.exit(1); });

