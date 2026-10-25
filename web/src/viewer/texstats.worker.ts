// textureStats() of one texture, off the main thread (a 4096 px mask held it for about a second): { blob, opacity } ->
// TextureStats, or null when the image cannot be decoded (EXR / HDR, a broken file). Counted in strips of rows, so
// beside the decoded image only one strip's pixels are held (8 MB at 8192 px), not a full-size canvas and its copy.
import { texelSums, type OpacityRead } from '../lib/optics';

const ROWS = 256;

onmessage = async (e: MessageEvent<{ blob: Blob; opacity?: OpacityRead }>) => {
  try {
    const bitmap = await createImageBitmap(e.data.blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const { width: w, height: h } = bitmap, ctx = new OffscreenCanvas(w, Math.min(ROWS, h)).getContext('2d', { willReadFrequently: true })!, sums = texelSums(e.data.opacity);
    for (let y = 0; y < h; y += ROWS) {
      const n = Math.min(ROWS, h - y);
      ctx.clearRect(0, 0, w, n); // as the one full-size draw onto a fresh canvas: nothing of the last strip blends in
      ctx.drawImage(bitmap, 0, y, w, n, 0, 0, w, n);
      sums.add(ctx.getImageData(0, 0, w, n).data);
    }
    bitmap.close();
    postMessage(sums.stats());
  } catch {
    postMessage(null);
  }
};
