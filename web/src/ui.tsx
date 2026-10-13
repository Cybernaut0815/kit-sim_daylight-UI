// Shared bits: knob helper, stroke icons, empty-state illustrations, alert, swatch, number field, segmented control.
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { slotVar } from './store';

/** The only inline style the design system allows: one of its nine knobs. */
export const knob = (name: string, value: string): CSSProperties => ({ [name]: value }) as CSSProperties;

// Stroke icons on a 24 grid in currentColor (icons-stroke-only), drawn at 16 px.
const ICONS = {
  contrast: <><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" /></>,
  alert: <><circle cx="12" cy="12" r="9.5" /><path d="M12 7.5v5.5M12 16.25v.25" /></>,
};

export function Icon({ name, size = 16 }: { name: keyof typeof ICONS; size?: 16 | 20 | 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

/** 48 px empty-state drawings (inset, hairline stroke) for the viewport and the results panel. */
export function Illustration({ kind }: { kind: 'model' | 'results' }) {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      {kind === 'model'
        ? <><path d="M24 10 36 17v14l-12 7-12-7V17l12-7Z" /><path d="M12 17l12 7 12-7M24 24v14" /></>
        : <><path d="M10 36h28M14 32V22M22 32V14M30 32V26M38 32V18" /></>}
    </svg>
  );
}

export function Alert({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="alert alert--error" role="alert">
      <span className="alert__icon"><Icon name="alert" /></span>
      <div><span className="alert__title">{title}</span>{children}</div>
    </div>
  );
}

/** Colour key: a mesh's --chart-cat-N token (the viewer and the model table) or any CSS colour (the range legend). */
export function Swatch({ slot, color }: { slot?: number; color?: string }) {
  return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect width="12" height="12" rx="2" fill={color ?? `var(${slotVar(slot)})`} /></svg>;
}

/** Numeric input committed on blur or Enter (typing "51." must not snap). `key` remounts it when the value changes elsewhere. */
export function NumberField({ id, label, value, onCommit, step = 'any', min, max, help, error }: {
  id: string; label: string; value: number; onCommit: (v: number) => void; step?: number | 'any'; min?: number; max?: number; help?: string; error?: string;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>{label}</label>
      <input
        key={value} className="input" id={id} type="number" inputMode="decimal" step={step} min={min} max={max}
        defaultValue={Number.isFinite(value) ? value : ''} aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : help ? `${id}-help` : undefined}
        onBlur={(e) => onCommit(e.currentTarget.valueAsNumber)}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
      {help && !error && <span className="field__help" id={`${id}-help`}>{help}</span>}
      {error && <span className="field__error" id={`${id}-error`}>{error}</span>}
    </div>
  );
}

/** The .segmented radio track; option ids are `${name}-${value}` so validation can focus one. */
export function Segmented<T extends string>({ name, label, value, options, onChange }: {
  name: string; label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <label key={v}><input type="radio" name={name} id={`${name}-${v}`} value={v} checked={value === v} onChange={() => onChange(v)} /> {text}</label>
      ))}
    </div>
  );
}

/** Enter / Space activate a focusable table row like a click. */
export const rowKeys = (fn: () => void) => (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };

export const pct = (x: number): string => `${(100 * x).toFixed(x > 0 && x < 0.1 ? 1 : 0)} %`;
