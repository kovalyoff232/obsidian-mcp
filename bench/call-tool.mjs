#!/usr/bin/env node
import { spawn } from 'child_process';

function parseArgs() {
  const out = { name: '', args: {}, timeoutMs: 3000 };
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--name') out.name = String(argv[++i] || '');
    else if (k === '--args') {
      const s = String(argv[++i] || '{}');
      try { out.args = JSON.parse(s); } catch { console.error('Invalid JSON for --args'); process.exit(1); }
    } else if (k === '--timeout') {
      out.timeoutMs = Number(argv[++i] || 3000);
    }
  }
  if (!out.name) { console.error('Usage: node bench/call-tool.mjs --name <toolName> --args "{...}"'); process.exit(2); }
  return out;
}

async function main() {
  const { name, args, timeoutMs } = parseArgs();
  const proc = spawn('node', ['dist/mcp_server.js', '--transport', 'stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });

  let killed = false;
  const timer = setTimeout(() => {
    if (!killed) {
      console.error('Timeout waiting for response');
      proc.kill();
    }
  }, timeoutMs);

  // Give server a moment to start
  await new Promise((r) => setTimeout(r, 600));

  const req = {
    jsonrpc: '2.0',
    id: Math.random().toString(36).slice(2),
    method: 'tools/call',
    params: { name, arguments: args }
  };

  const payload = JSON.stringify(req);
  proc.stdin.write(payload + '\n');

  let buf = '';
  proc.stdout.on('data', (data) => {
    buf += data.toString();
    try {
      const parsed = JSON.parse(buf);
      clearTimeout(timer);
      killed = true;
      proc.kill();
      console.log(JSON.stringify(parsed, null, 2));
    } catch {
      // keep buffering
    }
  });

  proc.stderr.on('data', (data) => {
    // server logs to stderr; print for visibility
    process.stderr.write(data);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });

