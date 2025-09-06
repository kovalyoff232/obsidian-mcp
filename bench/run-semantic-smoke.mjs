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

function asText(res) { return res?.result?.content?.[0]?.text || ''; }

async function main() {
  const server = await startServer();
  const results = [];

  // Build semantic index (works both when enabled/disabled)
  const b0 = now();
  const bRes = await callTool(server, 'semantic-build-index', { limit: 10 });
  const b1 = now();
  const bTxt = asText(bRes);
  const bOk = /\"ok\": true/.test(bTxt);
  results.push({ name: 'semantic-build-index', ok: bOk, latencyMs: b1 - b0, message: bTxt });

  // Embed specific note
  const e0 = now();
  const eRes = await callTool(server, 'embed-and-upsert', { noteId: 'Obsidian MCP Plugin' });
  const e1 = now();
  const eTxt = asText(eRes);
  const eOk = /\"ok\": true/.test(eTxt) && /\"dims\": 32/.test(eTxt);
  results.push({ name: 'embed-and-upsert', ok: eOk, latencyMs: e1 - e0, message: eTxt });

  // semantic-query (fallback or real depending on env)
  const q0 = now();
  const qRes = await callTool(server, 'semantic-query', { query: 'Obsidian MCP Plugin', topK: 3, filters: { pathPrefix: 'graph/Dev Hub/Проекты/Obsidian MCP Plugin' } });
  const q1 = now();
  const qTxt = asText(qRes);
  const qOk = /^\[/.test(qTxt.trim()) || /\"path\"/.test(qTxt); // array-like or objects
  results.push({ name: 'semantic-query', ok: qOk, latencyMs: q1 - q0, message: qTxt });

  server.kill();

  const summary = { total: results.length, passed: results.filter(r=>r.ok).length, failed: results.filter(r=>!r.ok).length };
  console.log(JSON.stringify({ summary, results }, null, 2));
  if (summary.failed > 0) process.exit(2);
}

main().catch((e)=>{ console.error(e); process.exit(1); });

