#!/usr/bin/env node
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const DEFAULT_DATASET = join(__dirname, 'dataset.json');

function now() { return performance.now ? performance.now() : Date.now(); }

async function startServer() {
  const serverPath = join(ROOT, 'dist', 'mcp_server.js');
  const proc = spawn('node', [serverPath, '--transport', 'stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((resolve) => setTimeout(resolve, 1000));
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

function precisionAtK(expected, gotPaths, k) {
  const topK = gotPaths.slice(0, k);
  const hits = topK.filter(p => expected.includes(p)).length;
  return hits / Math.max(1, Math.min(k, topK.length));
}

function recallAtK(expected, gotPaths, k) {
  const topK = gotPaths.slice(0, k);
  const hits = topK.filter(p => expected.includes(p)).length;
  return hits / Math.max(1, expected.length);
}

function mrr(expected, gotPaths, k) {
  const topK = gotPaths.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    if (expected.includes(topK[i])) return 1 / (i + 1);
  }
  return 0;
}

async function main() {
  const datasetPath = process.env.MCP_BENCH_DATASET || DEFAULT_DATASET;
  const raw = await readFile(datasetPath, 'utf-8');
  const cases = JSON.parse(raw);

  const server = await startServer();
  const results = [];

  for (const c of cases) {
    const q = c.query;
    const limit = c.limit || 10;
    const mode = c.mode || 'balanced';
    const includeLinked = c.includeLinked !== false;
    const t0 = now();
    const res = await callTool(server, 'search-notes', { libraryName: q, limit, mode, includeLinked });
    const t1 = now();
    const timeMs = t1 - t0;
    const blocks = res?.content?.[0]?.text || '';
    const lines = blocks.split('\n');
    const paths = lines.filter(l => l.trim().startsWith('📁 Path:'))
      .map(l => l.split('`')[1])
      .filter(Boolean);

    results.push({
      query: q,
      p10: precisionAtK(c.expectedPaths || [], paths, 10),
      r10: recallAtK(c.expectedPaths || [], paths, 10),
      mrr10: mrr(c.expectedPaths || [], paths, 10),
      latencyMs: timeMs
    });
  }

  server.kill();

  const p50 = (arr) => arr.sort((a,b)=>a-b)[Math.floor(arr.length*0.5)] || 0;
  const p95 = (arr) => arr.sort((a,b)=>a-b)[Math.floor(arr.length*0.95)] || 0;
  const latencies = results.map(r => r.latencyMs);
  const avg = (arr) => arr.reduce((s,x)=>s+x,0)/Math.max(1,arr.length);

  const summary = {
    count: results.length,
    precision_at_10: avg(results.map(r=>r.p10)),
    recall_at_10: avg(results.map(r=>r.r10)),
    mrr_at_10: avg(results.map(r=>r.mrr10)),
    latency: { p50: p50(latencies), p95: p95(latencies) }
  };

  console.log(JSON.stringify({ summary, results }, null, 2));
}

main().catch((e)=>{ console.error(e); process.exit(1); });


