// The saved sets and combined views on the server (GET /sets, PUT and DELETE /sets/{id}): every browser and the agent
// see the same ones.
import { parseSets, type Saved } from './model';

const said = async (r: Response) => (await r.text()).replace(/^error: /, '').trim();
const json = (r: Response) => r.headers.get('Content-Type')?.startsWith('application/json') ?? false;

/** The stored sets and combined views, each spec parsed (one the app cannot read is left out). */
export async function listSets(): Promise<Saved[]> {
  const r = await fetch('/sets').catch(() => null);
  if (!r?.ok || !json(r)) throw new Error(`sets: ${r ? await said(r) : 'the server cannot be reached'}`);
  return parseSets(await r.json());
}

/** `x` stored under its id (a new one, or replacing the one there). */
export async function putSet(x: Saved): Promise<void> {
  const r = await fetch(`/sets/${encodeURIComponent(x.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(x) }).catch(() => null);
  if (!r?.ok) throw new Error(`not saved (${r ? (r.status === 409 ? 'the server keeps at most 500 sets and combined views; delete some first' : await said(r)) : 'the server cannot be reached'})`);
}

/** Set or combined view `id` deleted (gone already: done too). */
export async function deleteSet(id: string): Promise<void> {
  const r = await fetch(`/sets/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
  if (!r?.ok && r?.status !== 404) throw new Error(`not deleted (${r ? await said(r) : 'the server cannot be reached'})`);
}
