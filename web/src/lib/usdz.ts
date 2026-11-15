// USDZ: a zip whose files are stored (never compressed) with their data 64-byte aligned, the first file the root layer.
// Written as Blob parts: a picked model's files go in as the Files they are (never read whole into memory: a 0.4 GB
// usdc stays on disk until the download is saved), each read once in chunks for its CRC-32.

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(crc: number, b: Uint8Array): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}
const CHUNK = 16 << 20;
async function crcOf(data: Blob | Uint8Array): Promise<number> {
  if (data instanceof Uint8Array) return crc32(0, data);
  let c = 0;
  for (let at = 0; at < data.size; at += CHUNK) c = crc32(c, new Uint8Array(await data.slice(at, at + CHUNK).arrayBuffer()));
  return c;
}

/**
 * Files in order (the root layer first) -> the package. Stored entries, DOS time 1980-01-01, UTF-8 names; the padding
 * that aligns each file's data to 64 bytes sits in its local header's extra field (id 0x1986, as usdzip does).
 * ponytail: no zip64, so at most 4 GiB and 65,535 files; zip64 records if a package gets bigger
 */
export async function usdz(files: [name: string, data: Blob | Uint8Array][]): Promise<Blob> {
  const enc = new TextEncoder(), parts: BlobPart[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = enc.encode(name), size = data instanceof Uint8Array ? data.length : data.size, crc = await crcOf(data);
    const pad = (64 - ((offset + 30 + n.length + 4) % 64)) % 64, local = new Uint8Array(30 + n.length + 4 + pad), l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 10, true); l.setUint16(6, 0x0800, true); l.setUint16(8, 0, true); // stored, UTF-8 name
    l.setUint16(10, 0, true); l.setUint16(12, 0x21, true); l.setUint32(14, crc, true); l.setUint32(18, size, true); l.setUint32(22, size, true);
    l.setUint16(26, n.length, true); l.setUint16(28, 4 + pad, true); local.set(n, 30); l.setUint16(30 + n.length, 0x1986, true); l.setUint16(32 + n.length, pad, true);
    const c = new Uint8Array(46 + n.length), d = new DataView(c.buffer);
    d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 10, true); d.setUint16(8, 0x0800, true); d.setUint16(10, 0, true);
    d.setUint16(12, 0, true); d.setUint16(14, 0x21, true); d.setUint32(16, crc, true); d.setUint32(20, size, true); d.setUint32(24, size, true);
    d.setUint16(28, n.length, true); d.setUint32(42, offset, true); c.set(n, 46);
    parts.push(local, data as BlobPart);
    central.push(c);
    offset += local.length + size;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0), end = new Uint8Array(22), e = new DataView(end.buffer);
  if (offset + cdSize > 0xffffffff || files.length > 0xffff) throw new Error('the package passes 4 GiB or 65,535 files: zip64 is not written');
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end] as BlobPart[], { type: 'model/vnd.usdz+zip' });
}
