// SVG timelines: a drag-to-value strip with one keyboard slider per handle, and the year / day strips built on it.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { dateFromDoy, daysInYear, doy, fmtClock, pad } from '../lib/time';

interface StripProps {
  min: number; max: number; step: number; values: number[]; span?: boolean; label: string; height?: number;
  onChange: (index: number, value: number) => void; valueText: (v: number) => string;
  draw: (x: (v: number) => number, w: number, h: number) => ReactNode;
}

export function Strip({ min, max, step, values, span, label, height = 40, onChange, valueText, draw }: StripProps) {
  const ref = useRef<SVGSVGElement>(null);
  const [w, setW] = useState(320);
  const drag = useRef<number | null>(null);
  useEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 320));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const x = (v: number) => ((v - min) / (max - min)) * w;
  const fromEvent = (e: PointerEvent<SVGSVGElement>) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    return Math.min(max, Math.max(min, Math.round((min + (px / w) * (max - min)) / step) * step));
  };
  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    const v = fromEvent(e);
    let i = 0;
    values.forEach((h, k) => { if (Math.abs(h - v) < Math.abs(values[i] - v)) i = k; }); // nearest handle takes the drag
    drag.current = i;
    e.currentTarget.setPointerCapture(e.pointerId);
    onChange(i, v);
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => { if (drag.current !== null) onChange(drag.current, fromEvent(e)); };
  const onUp = () => { drag.current = null; };
  const onKey = (i: number) => (e: KeyboardEvent<SVGRectElement>) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? step : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -step
      : e.key === 'Home' ? min - values[i] : e.key === 'End' ? max - values[i] : 0;
    if (!d) return;
    e.preventDefault();
    onChange(i, Math.min(max, Math.max(min, values[i] + d)));
  };
  return (
    <svg ref={ref} className="strip" height={height} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} aria-label={label}>
      {draw(x, w, height)}
      {span && values.length === 2 && <rect x={Math.min(x(values[0]), x(values[1]))} y={0} width={Math.abs(x(values[1]) - x(values[0]))} height={height} fill="var(--accent-subtle)" />}
      {values.map((v, i) => (
        <rect
          key={i} role="slider" tabIndex={0} x={x(v) - 2} y={0} width={4} height={height} rx={2} fill="var(--accent)"
          aria-label={values.length > 1 ? `${label} ${i === 0 ? 'start' : 'end'}` : label}
          aria-valuemin={min} aria-valuemax={max} aria-valuenow={v} aria-valuetext={valueText(v)} onKeyDown={onKey(i)}
        />
      ))}
    </svg>
  );
}

/** 12 months; values are days of year. */
export function YearStrip({ year, values, span, onChange }: { year: number; values: number[]; span?: boolean; onChange: (i: number, v: number) => void }) {
  const n = daysInYear(year);
  const starts = Array.from({ length: 13 }, (_, m) => (m === 12 ? n : doy(`${year}-${pad(m + 1)}-01`)));
  return (
    <Strip min={0} max={n - 1} step={1} values={values} span={span} onChange={onChange} label="Day of year" valueText={(v) => dateFromDoy(v, year)} draw={(x, w, h) => (
      <>
        <rect width={w} height={h} rx={4} fill="var(--bg-surface-2)" />
        {starts.slice(0, 12).map((d0, m) => (
          <g key={m}>
            {m > 0 && <line x1={x(d0)} x2={x(d0)} y1={0} y2={h} stroke="var(--chart-grid)" />}
            <text x={x((d0 + starts[m + 1]) / 2)} y={h - 6} textAnchor="middle" fontSize={10} fill="var(--chart-text)">{'JFMAMJJASOND'[m]}</text>
          </g>
        ))}
      </>
    )} />
  );
}

/** 24 hours with the daylight band; values are minutes of day. */
export function DayStrip({ bounds, values, span, step, onChange }: { bounds: { sunrise: number; sunset: number }; values: number[]; span?: boolean; step: number; onChange: (i: number, v: number) => void }) {
  return (
    <Strip min={0} max={1440} step={step} values={values} span={span} onChange={onChange} label="Time of day" valueText={fmtClock} draw={(x, w, h) => (
      <>
        <rect width={w} height={h} rx={4} fill="var(--bg-surface-2)" />
        {bounds.sunset > bounds.sunrise && <rect x={x(bounds.sunrise)} width={x(bounds.sunset) - x(bounds.sunrise)} height={h} fill="var(--bg-surface-3)" />}
        {[6, 12, 18].map((hh) => <line key={hh} x1={x(hh * 60)} x2={x(hh * 60)} y1={0} y2={h} stroke="var(--chart-grid)" />)}
        {[0, 6, 12, 18, 24].map((hh) => (
          <text key={hh} x={x(hh * 60) + (hh === 0 ? 3 : hh === 24 ? -3 : 0)} y={h - 6} textAnchor={hh === 0 ? 'start' : hh === 24 ? 'end' : 'middle'} fontSize={10} fill="var(--chart-text)">{pad(hh)}</text>
        ))}
      </>
    )} />
  );
}
