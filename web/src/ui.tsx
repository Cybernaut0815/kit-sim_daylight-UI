// Shared bits: knob helper, stroke icons, empty-state illustrations, alert, swatch, number field, segmented control,
// collapsible panel section.
import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';

/** The only inline style the design system allows: one of its nine knobs. */
export const knob = (name: string, value: string): CSSProperties => ({ [name]: value }) as CSSProperties;

// Stroke icons on a 24 grid in currentColor (icons-stroke-only), drawn at 16 px.
const ICONS = {
  contrast: <><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" /></>,
  alert: <><circle cx="12" cy="12" r="9.5" /><path d="M12 7.5v5.5M12 16.25v.25" /></>,
  undo: <><path d="M4 10h9a5 5 0 0 1 0 10h-3" /><path d="M8 6l-4 4 4 4" /></>,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
};

export function Icon({ name, size = 16 }: { name: keyof typeof ICONS; size?: 16 | 20 | 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

/**
 * A button opening a zha-ui menu above it (the run bar sits at the bottom of the view): a native popover, so Esc and a
 * click elsewhere close it; JS owns its place, as the menu primitive asks. `children` get `close`.
 */
export function MenuButton({ id, label, title, disabled, busy, children }: { id: string; label: string; title?: string; disabled?: boolean; busy?: boolean; children: (close: () => void) => ReactNode }) {
  const menu = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const m = menu.current, b = button.current;
    if (!m || !b) return;
    const place = () => {
      const r = b.getBoundingClientRect();
      m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8))}px`;
      m.style.bottom = `${innerHeight - r.top + 4}px`;
    };
    const onToggle = (e: Event) => { if ((e as ToggleEvent).newState === 'open') place(); };
    m.addEventListener('beforetoggle', onToggle); // before it shows: no frame at the old place
    m.addEventListener('toggle', onToggle); // shown: its width is known, keep it inside the window
    window.addEventListener('resize', place);
    return () => { m.removeEventListener('beforetoggle', onToggle); m.removeEventListener('toggle', onToggle); window.removeEventListener('resize', place); };
  }, []);
  const close = () => { if (menu.current?.matches(':popover-open')) menu.current.hidePopover(); };
  return (
    <>
      <button ref={button} className="btn btn--secondary" type="button" popoverTarget={id} disabled={disabled} aria-busy={busy} title={title}>{label}<Icon name="chevronDown" /></button>
      <div ref={menu} id={id} className="menu" popover="auto" data-density="compact">{children(close)}</div>
    </>
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

/** Colour key square for chart legends; `outline`: a hairline round it (a material's colour may be the page's), hollow
 *  without a colour. */
export function Swatch({ color, outline }: { color?: string; outline?: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      {outline ? <rect className="swatch__outline" x="0.5" y="0.5" width="11" height="11" fill={color ?? 'none'} /> : <rect width="12" height="12" fill={color} />}
    </svg>
  );
}

/** The models' letters by slot. */
export const LETTERS = 'ABCD';
/** A model's series colour: the chart category token of its slot, fixed for its life. */
export const cat = (slot: number) => `var(--chart-cat-${slot + 1})`;
/** A model's mark: its colour always beside its letter (never colour alone), its name after it when given. */
export const Tag = ({ slot, name }: { slot: number; name?: string }) => <><Swatch color={cat(slot)} outline /> <span className="line">{LETTERS[slot]}{name ? ` ${name}` : ''}</span></>;

/** Small reset-to-default icon button, placed beside the setting it resets; `label` when "Reset <what> to default" is not
 *  what it does. */
export function ResetButton({ what, label = `Reset ${what} to default`, onClick }: { what: string; label?: string; onClick: () => void }) {
  return (
    <button className="icon-btn icon-btn--ghost" type="button" aria-label={label} title={label} onClick={onClick}>
      <Icon name="undo" />
    </button>
  );
}

/** Native colour picker shown as a small square, for a data colour next to the text it belongs to. */
export function ColorQuad({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (hex: string) => void }) {
  return <input className="color-quad" id={id} type="color" value={value} aria-label={label} title={label} onChange={(e) => onChange(e.target.value)} />;
}

/** Numeric input committed on blur or Enter (typing "51." must not snap). `key` remounts it when the value changes elsewhere. */
export function NumberField({ id, label, value, onCommit, step = 'any', min, max, help, error, adorn, placeholder }: {
  id: string; label: string; value: number; onCommit: (v: number) => void; step?: number | 'any'; min?: number; max?: number; help?: string; error?: string; placeholder?: string;
  adorn?: ReactNode; // e.g. a ColorQuad in front of the label
}) {
  const lab = <label className="field__label" htmlFor={id}>{label}</label>;
  return (
    <div className="field">
      {adorn ? <div className="cluster">{adorn}{lab}</div> : lab}
      <input
        key={value} className="input" id={id} type="number" inputMode="decimal" step={step} min={min} max={max}
        defaultValue={Number.isFinite(value) ? value : ''} placeholder={placeholder} aria-invalid={error ? true : undefined}
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
export function Segmented<T extends string>({ name, label, title, value, options, onChange }: {
  name: string; label: string; title?: string; value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label} title={title}>
      {options.map(([v, text]) => (
        <label key={v}><input type="radio" name={name} id={`${name}-${v}`} value={v} checked={value === v} onChange={() => onChange(v)} /> {text}</label>
      ))}
    </div>
  );
}

/** Enter / Space activate a focusable table row like a click. */
export const rowKeys = (fn: () => void) => (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };

export const pct = (x: number): string => `${(100 * x).toFixed(x > 0 && x < 0.1 ? 1 : 0)} %`;

// Which panel sections are open, per section id (collapsed ones are remembered; storage may be blocked).
const OPEN_KEY = 'daylight.open';
const readOpen = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') ?? {}; } catch { return {}; } };

/** A panel section whose heading folds it away (zha .accordion); open unless the user closed it before. */
export function Section({ id, title, children, busy }: { id: string; title: string; children: ReactNode; busy?: boolean }) {
  return (
    <details className="accordion" open={readOpen()[id] ?? true} onToggle={(e) => { const open = e.currentTarget.open; try { localStorage.setItem(OPEN_KEY, JSON.stringify({ ...readOpen(), [id]: open })); } catch { /* not remembered */ } }}>
      <summary><h2 id={`h-${id}`}>{title}</h2></summary>
      <section className="accordion__body stack" aria-labelledby={`h-${id}`} aria-busy={busy}>{children}</section>
    </details>
  );
}
