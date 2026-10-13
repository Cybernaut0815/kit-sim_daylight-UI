// Copied from zha-ui packages/runtime/src/cssVar.js (GitZHACODE/zha-ui, unpublished runtime package), typed.
// Read a CSS custom property off :root and normalize it to sRGB rgb()/rgba(). Canvas renderers (three.js,
// MapLibre) need literal colours, not var(); the tokens resolve to oklch() in modern browsers, which those
// renderers cannot parse. A 1px canvas getImageData round-trip forces sRGB. Browser-only (needs a <canvas>).
let ctx: CanvasRenderingContext2D | null | undefined;

// `over`: another token to composite onto first, so a translucent token (the hairlines) comes back opaque; three.js
// ignores alpha, so the viewer resolves every colour over its own background.
export function cssVar(name: string, fallback = '#000', over?: string): string {
  ctx ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const style = getComputedStyle(document.documentElement);
  const raw = style.getPropertyValue(name).trim();
  if (!raw || !ctx) return fallback;
  ctx.clearRect(0, 0, 1, 1);
  if (over) { ctx.fillStyle = style.getPropertyValue(over).trim() || fallback; ctx.fillRect(0, 0, 1, 1); }
  ctx.fillStyle = '#000'; // seed: canvas ignores an unparseable assignment, so a bad token renders black
  ctx.fillStyle = raw;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`;
}
