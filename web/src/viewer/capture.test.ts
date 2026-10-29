import { describe, expect, it } from 'vitest';
import { unpack } from './capture';

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
