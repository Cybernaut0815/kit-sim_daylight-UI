// The tab's end of the agent bridge (daylight_server --mcp): one long poll always open for tool calls (GET
// /bridge/next), each call started at once and answered on POST /bridge/result/{id}, and pings that tell the server
// this tab has the focus. exclusive() runs the state-changing and rendering steps one at a time; until() waits for App's
// async work, woken by settled() after every commit. Handlers run from fetch continuations, never inside React work, so
// they may flushSync. No UI, no logs.

/** A tool's answer (MCP CallToolResult). */
export interface CallToolResult { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: true }

/** This page load's id (not App's CLIENT_ID: sessionStorage is copied into a duplicated tab). */
const TAB = crypto.randomUUID();
/** The hidden instance: the page the server starts at #headless when no app tab is open. */
export const HEADLESS = typeof location !== 'undefined' && location.hash === '#headless';
const ANSWER_MS = 45e3; // every call answers within this of receipt (the server gives up at 55 s)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const fail = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** Polls for calls and answers each with `handle` until stop(), or until the server says there is no bridge here (a
 *  4xx: a LAN tab, a server without --mcp; or a page instead of JSON: mock mode, a static host). */
export function startBridge(handle: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>): () => void {
  let stopped = false, poll: AbortController | undefined;
  const seen = new Set<string>(); // ids answered: a call is handed out once, so this only guards a repeat
  const get = (query: string, signal?: AbortSignal) => fetch(`/bridge/next?${query}${HEADLESS ? '&kind=headless' : ''}`, { headers: { 'X-Client-Id': TAB }, signal });
  const ping = () => void get('wait=0&focus=1').catch(() => {}); // the focused tab gets the calls
  const onVisible = () => { if (document.visibilityState === 'visible') ping(); };
  const stop = () => {
    stopped = true;
    poll?.abort();
    window.removeEventListener('focus', ping);
    document.removeEventListener('visibilitychange', onVisible);
  };
  const answer = async (id: string, name: string, args: Record<string, unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      Promise.resolve().then(() => handle(name, args)).catch((e: Error) => fail(`${name}: ${e.message}`)),
      new Promise<CallToolResult>((r) => { timer = setTimeout(() => r(fail(`${name}: no answer within 45 s; it may still finish in the app: call app_state`)), ANSWER_MS); }),
    ]);
    clearTimeout(timer);
    for (let tries = 0; tries < 2; tries++) {
      if (tries) await sleep(1000);
      try {
        const r = await fetch(`/bridge/result/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) });
        if (r.status < 500) return; // 404: past the server's 55 s, nobody waits for it
      } catch { /* once more */ }
    }
  };
  void (async () => {
    for (let wait = 1; !stopped;) {
      try {
        const r = await get('wait=25', (poll = new AbortController()).signal);
        if (r.status >= 500) throw new Error(`${r.status}`);
        wait = 1;
        if (r.status === 204) continue;
        if (!r.ok || !r.headers.get('Content-Type')?.startsWith('application/json')) return stop();
        const { id, params } = (await r.json()) as { id: string; params: { name: string; arguments?: Record<string, unknown> } };
        if (!seen.has(id)) { seen.add(id); void answer(id, params.name, params.arguments ?? {}); } // the next poll goes out at once
      } catch {
        if (stopped) return;
        // the server is down or restarting: 1, 2, then every 3 s, so a restarted server sees this tab within the 5 s it
        // waits before starting a hidden instance for a call
        await sleep(wait * 1000);
        wait = Math.min(2 * wait, 3);
      }
    }
  })();
  if (document.hasFocus()) ping();
  window.addEventListener('focus', ping);
  document.addEventListener('visibilitychange', onVisible);
  return stop;
}

let chain: Promise<unknown> = Promise.resolve();
/** fn once every exclusive fn before it has ended (a failure too): state-changing and rendering steps one at a time,
 *  and the reads of what is shown (app_state, results, find_critical: never a screenshot's look). Other read-only
 *  tools run at once, and until() waits outside. */
export function exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

const waiters = new Set<() => void>();
/** Resolves once pred() holds, now or after a commit (settled()); rejects after ms, naming what it waited for. */
export function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const end = (e?: unknown) => { clearTimeout(timer); waiters.delete(check); if (e) reject(e); else resolve(); };
    const check = () => { try { if (pred()) end(); } catch (e) { end(e); } };
    const timer = setTimeout(() => end(new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}`)), Math.max(ms, 0));
    waiters.add(check);
    check();
  });
}
/** Wakes the until() waiters: App calls it after every commit. */
export function settled(): void {
  for (const w of [...waiters]) w();
}
