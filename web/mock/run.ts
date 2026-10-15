// Vite dev plugin (VITE_MOCK=1): fakes daylight_server so the UI runs offline without the GPU box.
// PUT /mesh/:id stores the dmesh header counts; POST /jobs and POST /run answer 404 {missing} for unknown ids, else random
// values shaped by the args (a job is queued behind a fake job for 0.5 s, then runs for 0.7 s); GET /proxy serves a 20-station index in the NREL master.geojson shape and a zero-filled EPW.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const S3 = 'https://energyplus-weather.s3.amazonaws.com/';
const PVGIS = 'https://re.jrc.ec.europa.eu/api/v5_3/tmy?';

// title, lat, lon, tz, S3 path (shape of real EnergyPlus entries; the files do not exist, the mock serves them)
const STATIONS: [string, number, number, number, string][] = [
  ['Berlin Tegel 103820 (IWEC)', 52.57, 13.32, 1, 'europe_wmo_region_6/DEU/DEU_Berlin.103840_IWEC/DEU_Berlin.103840_IWEC.epw'],
  ['London Gatwick 037760 (IWEC)', 51.15, -0.18, 0, 'europe_wmo_region_6/GBR/GBR_London.Gatwick.037760_IWEC/GBR_London.Gatwick.037760_IWEC.epw'],
  ['Paris Orly 071490 (IWEC)', 48.73, 2.4, 1, 'europe_wmo_region_6/FRA/FRA_Paris.Orly.071490_IWEC/FRA_Paris.Orly.071490_IWEC.epw'],
  ['Madrid Barajas 082210 (IWEC)', 40.45, -3.55, 1, 'europe_wmo_region_6/ESP/ESP_Madrid.082210_IWEC/ESP_Madrid.082210_IWEC.epw'],
  ['Roma Fiumicino 162420 (IWEC)', 41.8, 12.23, 1, 'europe_wmo_region_6/ITA/ITA_Roma.162420_IWEC/ITA_Roma.162420_IWEC.epw'],
  ['Wien Schwechat 110360 (IWEC)', 48.12, 16.57, 1, 'europe_wmo_region_6/AUT/AUT_Vienna.Schwechat.110360_IWEC/AUT_Vienna.Schwechat.110360_IWEC.epw'],
  ['Zurich Kloten 066700 (IWEC)', 47.48, 8.53, 1, 'europe_wmo_region_6/CHE/CHE_Zurich.066700_IWEC/CHE_Zurich.066700_IWEC.epw'],
  ['Amsterdam Schiphol 062400 (IWEC)', 52.3, 4.77, 1, 'europe_wmo_region_6/NLD/NLD_Amsterdam.062400_IWEC/NLD_Amsterdam.062400_IWEC.epw'],
  ['Copenhagen Kastrup 061800 (IWEC)', 55.63, 12.67, 1, 'europe_wmo_region_6/DNK/DNK_Copenhagen.061800_IWEC/DNK_Copenhagen.061800_IWEC.epw'],
  ['Stockholm Arlanda 024600 (IWEC)', 59.65, 17.95, 1, 'europe_wmo_region_6/SWE/SWE_Stockholm.Arlanda.024600_IWEC/SWE_Stockholm.Arlanda.024600_IWEC.epw'],
  ['Oslo Fornebu 014880 (IWEC)', 59.9, 10.62, 1, 'europe_wmo_region_6/NOR/NOR_Oslo.Fornebu.014880_IWEC/NOR_Oslo.Fornebu.014880_IWEC.epw'],
  ['Warsaw Okecie 123750 (IWEC)', 52.17, 20.97, 1, 'europe_wmo_region_6/POL/POL_Warsaw.123750_IWEC/POL_Warsaw.123750_IWEC.epw'],
  ['Praha Ruzyne 115180 (IWEC)', 50.1, 14.28, 1, 'europe_wmo_region_6/CZE/CZE_Prague.115180_IWEC/CZE_Prague.115180_IWEC.epw'],
  ['Athens Hellenikon 167160 (IWEC)', 37.9, 23.73, 2, 'europe_wmo_region_6/GRC/GRC_Athens.167160_IWEC/GRC_Athens.167160_IWEC.epw'],
  ['Istanbul 170600 (IWEC)', 40.97, 28.82, 2, 'europe_wmo_region_6/TUR/TUR_Istanbul.170600_IWEC/TUR_Istanbul.170600_IWEC.epw'],
  ['Dubai Intl 411940 (IWEC)', 25.25, 55.33, 4, 'asia_wmo_region_2/ARE/ARE_Dubai.411940_IWEC/ARE_Dubai.411940_IWEC.epw'],
  ['New York J F Kennedy Intl 744860 (TMY3)', 40.65, -73.8, -5, 'north_and_central_america_wmo_region_4/USA/NY/USA_NY_New.York-J.F.Kennedy.Intl.AP.744860_TMY3/USA_NY_New.York-J.F.Kennedy.Intl.AP.744860_TMY3.epw'],
  ['Los Angeles Intl 722950 (TMY3)', 33.93, -118.4, -8, 'north_and_central_america_wmo_region_4/USA/CA/USA_CA_Los.Angeles.Intl.AP.722950_TMY3/USA_CA_Los.Angeles.Intl.AP.722950_TMY3.epw'],
  ['Tokyo Hyakuri 477150 (IWEC)', 36.18, 140.42, 9, 'asia_wmo_region_2/JPN/JPN_Tokyo.Hyakuri.477150_IWEC/JPN_Tokyo.Hyakuri.477150_IWEC.epw'],
  ['Sydney Intl 947670 (IWEC)', -33.95, 151.18, 10, 'southwest_pacific_wmo_region_5/AUS/AUS_NSW.Sydney.947670_IWEC/AUS_NSW.Sydney.947670_IWEC.epw'],
];

const meshes = new Map<string, { name: string; points: number; faces: number }>();

const body = (req: IncomingMessage) => new Promise<Buffer>((res, rej) => { const c: Buffer[] = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c))); req.on('error', rej); });

/** Minimal multipart/form-data split: name, optional filename, raw bytes per part. */
function parts(buf: Buffer, contentType: string): { name: string; filename?: string; data: Buffer }[] {
  const m = /boundary="?([^";]+)"?/.exec(contentType);
  if (!m) return [];
  const b = Buffer.from(`--${m[1]}`), out: { name: string; filename?: string; data: Buffer }[] = [];
  for (let i = buf.indexOf(b); i >= 0; ) {
    const start = i + b.length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break; // closing "--"
    const hEnd = buf.indexOf('\r\n\r\n', start), next = hEnd < 0 ? -1 : buf.indexOf(b, hEnd);
    if (next < 0) break;
    const headers = buf.toString('utf8', start, hEnd);
    out.push({ name: /name="([^"]*)"/.exec(headers)?.[1] ?? '', filename: /filename="([^"]*)"/.exec(headers)?.[1], data: buf.subarray(hEnd + 4, next - 2) });
    i = next;
  }
  return out;
}

function epw(lat: number, lon: number, tz: number, city: string, country: string): string {
  const head = [`LOCATION,${city},-,${country},MOCK,000000,${lat},${lon},${tz},0`, 'DESIGN CONDITIONS,0', 'TYPICAL/EXTREME PERIODS,0', 'GROUND TEMPERATURES,0',
    'HOLIDAYS/DAYLIGHT SAVINGS,No,0,0,0', 'COMMENTS 1,mock weather: every value zero', 'COMMENTS 2,', 'DATA PERIODS,1,1,Data,Sunday, 1/ 1,12/31'];
  const zeros = ',0'.repeat(29), d = new Date(Date.UTC(2005, 0, 1)), rows: string[] = [];
  for (let h = 0; h < 8760; h++) {
    rows.push(`2005,${d.getUTCMonth() + 1},${d.getUTCDate()},${(h % 24) + 1},0,?${zeros}`);
    if (h % 24 === 23) d.setUTCDate(d.getUTCDate() + 1);
  }
  return `${head.concat(rows).join('\n')}\n`;
}

const index = () => JSON.stringify({
  type: 'FeatureCollection',
  features: STATIONS.map(([title, lat, lon, , path]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { title, epw: `<a href=${S3}${path}>Download Weather File</a>` } })),
});

/** 'MM-DDTHH:MM' -> hours since Jan 1 (non-leap). */
const hours = (t: string) => { const m = /^(?:\d+-)?(\d+)-(\d+)T(\d+):(\d+)$/.exec(t); return m ? (Date.UTC(2001, +m[1] - 1, +m[2], +m[3], +m[4]) - Date.UTC(2001, 0, 1)) / 36e5 : 0; };

async function compute(req: IncomingMessage): Promise<{ status: number; text: string }> {
  const fields = parts(await body(req), req.headers['content-type'] ?? '');
  const get = (n: string) => fields.filter((f) => f.name === n && f.filename === undefined).map((f) => f.data.toString());
  const sensors = get('sensors'), context = get('context'), args = get('args');
  const missing = [...sensors, ...context].filter((id) => !meshes.has(id));
  if (missing.length) return { status: 404, text: JSON.stringify({ missing }) };
  const arg = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const sides = arg('--sides', 'front'), on = arg('--on', 'faces');
  const columns = arg('--quantity', 'radiation').split(',').flatMap((q) => (sides === 'both' ? ['front', 'back'] : [sides]).map((s) => `${q}_${s}`));
  const from = hours(arg('--from', '')), to = hours(arg('--to', '')), win = /^(\d+):(\d+)-(\d+):(\d+)$/.exec(arg('--hours', ''));
  const duration_h = args.includes('--time') ? 1 : !args.includes('--from') ? 8760
    : win ? (Math.floor((to - 1e-9) / 24) - Math.floor(from / 24) + 1) * (+win[3] + +win[4] / 60 - +win[1] - +win[2] / 60) // --hours: the window every day
    : to - from;
  let first = 0;
  const mm = sensors.map((id) => { const m = meshes.get(id)!, count = on === 'vertices' ? m.points : m.faces, r = { name: m.name, first, count }; first += count; return r; });
  const scale = (col: string) => { const q = col.split('_')[0]; return q === 'sunhours' ? Math.min(duration_h, 4380) : q === 'irradiance' ? 900 : q === 'illuminance' ? 90000 : (1100 * duration_h) / 8760; };
  const vals = new Float64Array(first * columns.length);
  for (let r = 0; r < first; r++) for (let c = 0; c < columns.length; c++) vals[r * columns.length + c] = Math.random() * scale(columns[c]);
  return { status: 200, text: JSON.stringify({
    columns, duration_h, dirs: { sky: 145, ground: 145, sun: Math.round(duration_h / 2) }, meshes: mm,
    values_b64: Buffer.from(vals.buffer).toString('base64'), run_s: 0.42,
    cache: { response: 'miss', scene: 'built', weather: args.includes('--clear-sky') ? 'none' : 'miss' },
  }) };
}

// jobs: queued for 0.5 s (one fake job ahead), running for 0.7 s, then done; the result is computed at submission
const jobs = new Map<string, { t0: number; result: string; cancelled: boolean }>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function view(id: string): string {
  const j = jobs.get(id)!, dt = Date.now() - j.t0;
  const head = { id, created: new Date(j.t0).toISOString(), started: null, finished: null };
  if (j.cancelled) return JSON.stringify({ ...head, state: 'cancelled', position: 0, status: 409, error: 'error: cancelled' });
  if (dt < 500) return JSON.stringify({ ...head, state: 'queued', position: 1 });
  if (dt < 1200) return JSON.stringify({ ...head, state: 'running', position: 0 });
  return JSON.stringify({ ...head, state: 'done', position: 0, ...JSON.parse(j.result) });
}

function send(res: ServerResponse, status: number, text: string, type = 'application/json') {
  res.statusCode = status;
  res.setHeader('content-type', type);
  res.end(text);
}

export function mock(): Plugin {
  return {
    name: 'daylight-mock',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://mock');
        try {
          if (url.pathname === '/health') return send(res, 200, 'ok', 'text/plain');
          if (url.pathname.startsWith('/mesh/')) {
            const id = decodeURIComponent(url.pathname.slice(6));
            if (req.method === 'PUT') {
              const buf = await body(req);
              if (buf.length < 32 || buf.toString('latin1', 0, 4) !== 'DLM1') return send(res, 400, 'not a .dmesh image', 'text/plain');
              meshes.set(id, { name: url.searchParams.get('name') ?? id, points: Number(buf.readBigUInt64LE(8)), faces: Number(buf.readBigUInt64LE(16)) });
              res.statusCode = 204;
              return res.end();
            }
            res.statusCode = meshes.has(id) ? 204 : 404;
            return res.end();
          }
          if (url.pathname === '/run' && req.method === 'POST') { const r = await compute(req); if (r.status === 200) await sleep(700); return send(res, r.status, r.text); }
          if (url.pathname === '/jobs' && req.method === 'POST') {
            const r = await compute(req);
            if (r.status !== 200) return send(res, r.status, r.text);
            const id = crypto.randomUUID();
            jobs.set(id, { t0: Date.now(), result: r.text, cancelled: false });
            return send(res, 202, view(id));
          }
          if (url.pathname.startsWith('/jobs/')) {
            const id = url.pathname.slice(6), j = jobs.get(id);
            if (!j) return send(res, 404, 'error: no such job', 'text/plain');
            if (req.method === 'DELETE') { j.cancelled = true; return send(res, 200, view(id)); }
            const wait = Math.min(30, Number(url.searchParams.get('wait') ?? 0)) * 1000, before = view(id);
            for (const t = Date.now(); Date.now() - t < wait && view(id) === before; ) await sleep(50); // long poll
            return send(res, 200, view(id));
          }
          if (url.pathname === '/proxy') {
            const u = url.searchParams.get('url') ?? '';
            res.setHeader('x-daylight-cache', 'miss');
            if (u.includes('master.geojson')) return send(res, 200, index());
            if (u.startsWith(PVGIS)) { const q = new URL(u).searchParams; return send(res, 200, epw(+q.get('lat')!, +q.get('lon')!, Math.round(+q.get('lon')! / 15), 'unknown', 'unknown'), 'text/plain'); }
            const st = STATIONS.find(([, , , , p]) => u === S3 + p);
            if (st) return send(res, 200, epw(st[1], st[2], st[3], st[0].split(' ')[0], '-'), 'text/plain');
            return send(res, u.startsWith(S3) ? 502 : 400, u.startsWith(S3) ? 'curl exit 22 (mock: station not in the fixture index)' : 'url outside the allowlist', 'text/plain');
          }
        } catch (e) {
          return send(res, 500, `mock error: ${(e as Error).message}`, 'text/plain');
        }
        next();
      });
    },
  };
}
