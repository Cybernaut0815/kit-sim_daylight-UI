// Claude Desktop's local MCP config takes stdio commands only: this relays each stdin line (one JSON-RPC message) to
// daylight_server's POST /mcp and writes each answer as one stdout line, requests in parallel. Node >= 18, no packages.
// Run: node mcp-stdio.mjs [http://127.0.0.1:8080/mcp] (the server started with --mcp).
import { createInterface } from 'node:readline';

const url = process.argv[2] ?? 'http://127.0.0.1:8080/mcp'; // 127.0.0.1, not localhost: the server listens on IPv4 only
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n'); // re-serialised: stdio forbids newlines in a message
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32603, message } });

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let id; // undefined: a notification, which gets no answer
  try { id = JSON.parse(line).id; } catch { /* the server answers what it cannot read */ }
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: line });
  } catch {
    if (id !== undefined) fail(id, `daylight_server not reachable at ${url}: start it first (with --mcp)`);
    return;
  }
  const text = await res.text().catch(() => '');
  if (res.status === 202 || id === undefined) return;
  try {
    if (res.headers.get('content-type')?.startsWith('application/json')) return send(JSON.parse(text));
  } catch { /* not JSON after all: reported below */ }
  fail(id, `daylight_server ${res.status}: ${text.trim()}`);
});
