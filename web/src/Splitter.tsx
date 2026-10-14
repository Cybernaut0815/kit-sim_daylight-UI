// Drag handle on the inner edge of a sidebar: pointer drag, arrow keys (16 px), double-click resets.
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

export function Splitter({ side, value, min, max, defaultValue, label, onChange }: {
  side: 'left' | 'right'; value: number; min: number; max: number; defaultValue: number; label: string; onChange: (px: number) => void;
}) {
  const start = useRef<{ x: number; v: number } | null>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v)));
  const sign = side === 'left' ? 1 : -1;
  const onDown = (e: PointerEvent<HTMLDivElement>) => { start.current = { x: e.clientX, v: value }; e.currentTarget.setPointerCapture(e.pointerId); };
  const onMove = (e: PointerEvent<HTMLDivElement>) => { if (start.current) onChange(clamp(start.current.v + sign * (e.clientX - start.current.x))); };
  const onUp = () => { start.current = null; };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = e.key === 'ArrowRight' ? 16 : e.key === 'ArrowLeft' ? -16 : e.key === 'Home' ? defaultValue - value : 0;
    if (!d) return;
    e.preventDefault();
    onChange(clamp(e.key === 'Home' ? defaultValue : value + sign * d));
  };
  return (
    <div
      className={`splitter splitter--${side}`} role="separator" aria-orientation="vertical" aria-label={label} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max}
      tabIndex={0} title="Drag to resize, double-click to reset"
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={() => onChange(defaultValue)} onKeyDown={onKey}
    />
  );
}
