// Part-to-whole: one stroked circle per receiver (share of the area-weighted total), 2 px surface gaps, total in the centre.
import type { Dispatch } from 'react';
import { fmtNum } from '../lib/result';
import { slotVar, type Action } from '../store';
import { pct } from '../ui';

export interface Slice { id: string; name: string; slot?: number; share: number }

const R = 40, C = 2 * Math.PI * R, GAP = 2, S = 120;

export function Donut({ slices, total, unit, hovered, dispatch }: { slices: Slice[]; total: number; unit: string; hovered: string | null; dispatch: Dispatch<Action> }) {
  let offset = 0;
  return (
    <svg viewBox={`0 0 ${S} ${S}`} width={S} height={S} role="img" aria-label={`Share of the total per mesh: ${slices.map((s) => `${s.name} ${pct(s.share)}`).join(', ')}`}>
      <circle cx={S / 2} cy={S / 2} r={R} fill="none" stroke="var(--bg-surface-2)" strokeWidth={12} />
      {slices.filter((s) => s.share > 0).map((s) => {
        const len = C * s.share, dash = Math.max(len - GAP, 0.1), start = offset;
        offset += len;
        return (
          <circle
            key={s.id} cx={S / 2} cy={S / 2} r={R} fill="none" stroke={`var(${slotVar(s.slot)})`} strokeWidth={hovered === s.id ? 14 : 12}
            strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={-(start + GAP / 2)} transform={`rotate(-90 ${S / 2} ${S / 2})`}
            opacity={hovered && hovered !== s.id ? 0.45 : 1} tabIndex={0} aria-label={`${s.name}: ${pct(s.share)}`}
            onPointerEnter={() => dispatch({ type: 'HOVER', id: s.id })} onPointerLeave={() => dispatch({ type: 'HOVER', id: null })}
            onFocus={() => dispatch({ type: 'HOVER', id: s.id })} onBlur={() => dispatch({ type: 'HOVER', id: null })}
            onClick={(e) => dispatch({ type: 'SELECT', ids: [s.id], additive: e.shiftKey || e.ctrlKey })}
          />
        );
      })}
      <text x={S / 2} y={S / 2 + 2} textAnchor="middle" fontSize={15} fill="var(--chart-text-strong)">{fmtNum(total)}</text>
      <text x={S / 2} y={S / 2 + 14} textAnchor="middle" fontSize={8} fill="var(--chart-text)">{unit}</text>
    </svg>
  );
}
