// Part-to-whole ring: stroked arcs with 2 px surface gaps and a label in the centre.
import { pct } from '../ui';

export interface Slice { key: string; name: string; color: string; share: number }

const R = 40, C = 2 * Math.PI * R, GAP = 2, S = 120;

export function Donut({ slices, label, sub }: { slices: Slice[]; label: string; sub: string }) {
  let offset = 0;
  return (
    <svg viewBox={`0 0 ${S} ${S}`} width={S} height={S} role="img" aria-label={slices.map((s) => `${s.name} ${pct(s.share)}`).join(', ')}>
      <circle cx={S / 2} cy={S / 2} r={R} fill="none" stroke="var(--bg-surface-2)" strokeWidth={12} />
      {slices.filter((s) => s.share > 0).map((s) => {
        const len = C * s.share, dash = Math.max(len - GAP, 0.1), start = offset;
        offset += len;
        return (
          <circle key={s.key} cx={S / 2} cy={S / 2} r={R} fill="none" stroke={s.color} strokeWidth={12} strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={-(start + GAP / 2)} transform={`rotate(-90 ${S / 2} ${S / 2})`}>
            <title>{`${s.name}: ${pct(s.share)}`}</title>
          </circle>
        );
      })}
      <text x={S / 2} y={S / 2 + 2} textAnchor="middle" fontSize={15} fill="var(--chart-text-strong)">{label}</text>
      <text x={S / 2} y={S / 2 + 14} textAnchor="middle" fontSize={8} fill="var(--chart-text)">{sub}</text>
    </svg>
  );
}
