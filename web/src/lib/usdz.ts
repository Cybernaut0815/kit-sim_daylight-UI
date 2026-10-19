// USDZ: a zip whose files are stored (never compressed) with their data 64-byte aligned, the first file the root layer.
// fflate's zipSync (shipped with three) writes it; the padding goes into each local header's extra field.
import { zipSync } from 'three/addons/libs/fflate.module.js';

/** Files in order (the root layer first) -> the package bytes. */
export function usdz(files: [name: string, data: Uint8Array][]): Uint8Array {
  const enc = new TextEncoder(), out: Record<string, [Uint8Array, { extra: Record<number, Uint8Array> }]> = {};
  let offset = 0;
  for (const [name, data] of files) {
    const header = 30 + enc.encode(name).length; // the local header before the data, without an extra field
    const pad = (64 - ((offset + header + 4) % 64)) % 64; // + 4: the extra field's own id and length
    out[name] = [data, { extra: { 0x1986: new Uint8Array(pad) } }];
    offset += header + 4 + pad + data.length;
  }
  return zipSync(out, { level: 0, mtime: new Date(1980, 0, 1) });
}
