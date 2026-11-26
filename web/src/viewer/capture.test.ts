import { describe, expect, it, vi } from 'vitest';
import { labelCell, unpack } from './capture';

describe('labelCell', () => {
  it('a wide value\'s chip and the room round it, its size times and its spacing times', () => {
    vi.stubGlobal('document', { documentElement: {} });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string) => (name === '--fs-label' ? '11px' : '') }));
    vi.stubGlobal('OffscreenCanvas', class { getContext() { return { font: '', measureText: (text: string) => ({ width: 6 * text.length }) }; } });
    try {
      const [w, h] = labelCell('lx');
      expect([w, h]).toEqual([6 * '-8.888 lx'.length + 22, 24]);
      expect(labelCell('lx', 2)).toEqual([2 * w, 48]);
      expect(labelCell('lx', 1, 3)).toEqual([3 * w, 72]);
      expect(labelCell('lx', 0.5, 2)).toEqual([w, 24]);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('unpack', () => {
  // 3 × 2 px as read back, premultiplied: top row opaque red, green, blue; bottom row 50 % white (128 at alpha 128),
  // 50 % red (64 at alpha 128) and clear
  const top = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255], bottom = [128, 128, 128, 128, 64, 0, 0, 128, 0, 0, 0, 0];
  const image = [...top, 255, 255, 255, 255, 191, 127, 127, 255, 255, 255, 255, 255]; // over white
  it('WebGPU: rows padded to 256 bytes but the last, top-down', () => {
    const px = new Uint8Array(256 + 12);
    px.set(top);
    px.set(bottom, 256);
    expect(Array.from(unpack(px, 3, 2, false))).toEqual(image);
  });
  it('WebGL: tight rows, bottom-up', () => {
    expect(Array.from(unpack(Uint8Array.from([...bottom, ...top]), 3, 2, true))).toEqual(image);
  });
});
