// Drift check: every route registered in src/server.cpp is described in openapi.json and vice versa, and every
// operation is documented well enough for a person or an agent (operationId, summary, description, responses with a
// schema or an example). Run: node check_openapi.mjs (ctest runs it as openapi_drift). Exit 1 lists every problem.
import { readFileSync } from 'node:fs';

const here = new URL('.', import.meta.url);
const src = readFileSync(new URL('src/server.cpp', here), 'utf8');
const spec = JSON.parse(readFileSync(new URL('openapi.json', here), 'utf8'));
const problems = [];

// svr.Get("/health", ...) and svr.Put(R"(/mesh/([A-Za-z0-9-]{1,64}))", ...): a capture group becomes {id}
const routes = new Set();
for (const m of src.matchAll(/svr\.(Get|Post|Put|Delete)\(\s*(?:R"\((.*?)\)"|"([^"]*)")/g)) {
  const path = (m[2] ?? m[3]).replace(/\([^)]*\)(\{[^}]*\})?/g, '{id}');
  if (path === '/') continue; // the redirect to /docs when no web app is served
  routes.add(`${m[1].toLowerCase()} ${path}`);
}
const ops = new Set();
for (const [path, item] of Object.entries(spec.paths ?? {}))
  for (const [method, op] of Object.entries(item)) {
    if (!['get', 'put', 'post', 'delete', 'patch'].includes(method)) continue;
    const key = `${method} ${path}`;
    ops.add(key);
    for (const field of ['operationId', 'summary', 'description', 'tags']) if (!op[field]) problems.push(`${key}: no ${field}`);
    const responses = Object.entries(op.responses ?? {});
    if (!responses.length) problems.push(`${key}: no responses`);
    for (const [code, r] of responses) {
      const res = r.$ref ? spec.components.responses[r.$ref.split('/').pop()] : r;
      if (!res) { problems.push(`${key} ${code}: unresolved ${r.$ref}`); continue; }
      if (!res.description) problems.push(`${key} ${code}: no description`);
      for (const [type, c] of Object.entries(res.content ?? {}))
        if (!c.schema || (c.example === undefined && c.examples === undefined && type !== 'application/geo+json' && !(c.schema.$ref)))
          problems.push(`${key} ${code} ${type}: needs a schema and an example`);
    }
  }
for (const r of routes) if (!ops.has(r)) problems.push(`${r}: served by server.cpp but not in openapi.json`);
for (const o of ops) if (!routes.has(o)) problems.push(`${o}: in openapi.json but not served by server.cpp`);
const ids = [...ops].map((k) => { const [m, p] = k.split(' '); return spec.paths[p][m].operationId; });
for (const id of ids) if (ids.indexOf(id) !== ids.lastIndexOf(id)) problems.push(`operationId ${id} is not unique`);

if (problems.length) { console.error(`openapi drift: ${problems.length} problem(s)\n  ${[...new Set(problems)].join('\n  ')}`); process.exit(1); }
console.log(`openapi ok: ${ops.size} operations match server.cpp`);
