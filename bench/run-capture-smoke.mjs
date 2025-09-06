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

  // 1) capture-note
  const name = 'Capture Smoke ' + Date.now();
  const capArgs = {
    name,
    content: 'Смоук запись для capture.',
    tags: ['smoke','autotest'],
    relations: ['graph/Dev Hub/Проекты/Obsidian MCP Plugin/Obsidian MCP Plugin.md'],
    folder: 'inbox',
    linkToHub: true
  };
  const t0 = now();
  const capRes = await callTool(server, 'capture-note', capArgs);
  const t1 = now();
  const capTxt = asText(capRes);
  const capOk = /✅ Captured: inbox\//.test(capTxt);
  results.push({ name: 'capture-note', ok: capOk, latencyMs: t1 - t0, message: capOk ? '' : capTxt });

  // 2) get-note-content on captured note
  const pathMatch = capTxt.match(/Captured: ([^\n]+)/);
  const capturedPath = pathMatch ? pathMatch[1].trim() : '';
  const gc0 = now();
  const gRes = await callTool(server, 'get-note-content', { context7CompatibleLibraryID: capturedPath, tokens: 400 });
  const gc1 = now();
  const gTxt = asText(gRes);
  const hasAutocaptured = /autocaptured/.test(gTxt);
  const hasRelations = /## Relations/.test(gTxt) && /Knowledge Hub/.test(gTxt);
  const gOk = hasAutocaptured && hasRelations;
  results.push({ name: 'get-note-content(captured)', ok: gOk, latencyMs: gc1 - gc0, message: gOk ? '' : gTxt });

  // 3) daily-journal-append
  const today = new Date().toISOString().slice(0,10);
  const dj0 = now();
  const dRes = await callTool(server, 'daily-journal-append', { content: 'Запись в дневник (smoke).', heading: 'Inbox', bullet: true, timestamp: true, date: today });
  const dj1 = now();
  const dTxt = asText(dRes);
  const dOk = new RegExp(`Appended to daily: inbox/${today}\.md`).test(dTxt);
  results.push({ name: 'daily-journal-append', ok: dOk, latencyMs: dj1 - dj0, message: dTxt });

  // 4) get-note-content of daily heading
  const dd0 = now();
  const ddRes = await callTool(server, 'get-note-content', { context7CompatibleLibraryID: `inbox/${today}.md#Inbox`, tokens: 200 });
  const dd1 = now();
  const ddTxt = asText(ddRes);
  const ddOk = /## Inbox/.test(ddTxt) && /Запись в дневник/.test(ddTxt);
  results.push({ name: 'get-note-content(daily#Inbox)', ok: ddOk, latencyMs: dd1 - dd0, message: ddTxt });

  server.kill();

  const summary = {
    total: results.length,
    passed: results.filter(r=>r.ok).length,
    failed: results.filter(r=>!r.ok).length
  };
  console.log(JSON.stringify({ summary, results }, null, 2));
  if (summary.failed > 0) process.exit(2);
}

main().catch((e)=>{ console.error(e); process.exit(1); });

