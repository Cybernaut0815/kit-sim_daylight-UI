import type { Dispatch } from 'react';
import { DayStrip, YearStrip } from '../charts/Strip';
import { dateFromDoy, dayBounds, doy, fmtClock, yearOf } from '../lib/time';
import type { Action, Settings } from '../store';
import { Segmented, knob } from '../ui';

interface Props { time: Settings['time']; site: Settings['site']; tz: number; errors: Record<string, string>; dispatch: Dispatch<Action> }

export function TimePanel({ time, site, tz, errors, dispatch }: Props) {
  const year = yearOf(time.date);
  const set = (patch: Partial<Settings['time']>) => dispatch({ type: 'TIME', patch });
  const step = time.mode === 'range' ? time.stepMin : 10;
  const dateField = (id: string, label: string, value: string, onChange: (date: string) => void, error?: string) => (
    <div className="field">
      <label className="field__label" htmlFor={id}>{label}</label>
      <input className="input" id={id} type="date" value={value} min={`${year}-01-01`} max={`${year}-12-31`} aria-invalid={error ? true : undefined} onChange={(e) => { if (e.target.value) onChange(e.target.value); }} />
      {error && <span className="field__error">{error}</span>}
    </div>
  );
  const hourRow = (id: string, label: string, value: number, onChange: (hour: number) => void) => (
    <label className="slider-row">
      <span>{label}</span>
      <input id={id} type="range" min={0} max={1440} step={step} value={value} onChange={(e) => onChange(e.target.valueAsNumber)} />
      <span className="slider-row__value">{fmtClock(value)}</span>
    </label>
  );

  return (
    <section className="stack" aria-labelledby="h-time">
      <h2 id="h-time">Time</h2>
      <Segmented name="time-mode" label="Time mode" value={time.mode} options={[['annual', 'Annual'], ['instant', 'Instant'], ['range', 'Range']] as const} onChange={(mode) => set({ mode })} />
      {time.mode === 'annual' && <p className="text-muted">Every hour of the weather year, sun at mid-hour. The year of the dates below is ignored by the core.</p>}
      {time.mode === 'instant' && (
        <>
          {dateField('time-date', 'Date', time.date, (date) => set({ date }), errors.timeDate)}
          <YearStrip year={year} values={[doy(time.date)]} onChange={(_, v) => set({ date: dateFromDoy(v, year) })} />
          <DayStrip bounds={dayBounds(site.lat, site.lon, tz, time.date)} values={[time.hour]} step={step} onChange={(_, v) => set({ hour: v })} />
          {hourRow('time-hour', 'Hour', time.hour, (hour) => set({ hour }))}
        </>
      )}
      {time.mode === 'range' && (
        <>
          <div className="grid" style={knob('--grid-min', '8rem')}>
            {dateField('time-from-date', 'From', time.from.date, (date) => set({ from: { ...time.from, date } }))}
            {dateField('time-to-date', 'To', time.to.date, (date) => set({ to: { ...time.to, date } }), errors.timeTo)}
          </div>
          <YearStrip year={year} span values={[doy(time.from.date), doy(time.to.date)]} onChange={(i, v) => set(i === 0 ? { from: { ...time.from, date: dateFromDoy(v, year) } } : { to: { ...time.to, date: dateFromDoy(v, year) } })} />
          <DayStrip bounds={dayBounds(site.lat, site.lon, tz, time.from.date)} span values={[time.from.hour, time.to.hour]} step={step} onChange={(i, v) => set(i === 0 ? { from: { ...time.from, hour: v } } : { to: { ...time.to, hour: v } })} />
          {hourRow('time-from-hour', 'From', time.from.hour, (hour) => set({ from: { ...time.from, hour } }))}
          {hourRow('time-to-hour', 'To', time.to.hour, (hour) => set({ to: { ...time.to, hour } }))}
          <div className="cluster">
            <div className="field">
              <label className="field__label" htmlFor="time-step">Step</label>
              <select className="select" id="time-step" value={time.stepMin} onChange={(e) => set({ stepMin: Number(e.target.value) })}>
                {[10, 15, 30, 60].map((m) => <option key={m} value={m}>{m} min</option>)}
              </select>
            </div>
            <button className="chip" type="button" onClick={() => set({ from: { ...time.from, hour: 0 }, to: { date: time.from.date, hour: 1440 } })}>Whole day</button>
          </div>
        </>
      )}
    </section>
  );
}
