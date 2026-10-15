import { memo, useMemo, type Dispatch } from 'react';
import { DayStrip, YearStrip } from '../charts/Strip';
import { dayBounds, stepHoys } from '../lib/sun';
import { dateFromDoy, doy, fmtClock, fmtDay, timeStep, yearOf } from '../lib/time';
import { fmtOffset, type Zone } from '../lib/zone';
import type { Action, Settings } from '../store';
import { ResetButton, Segmented, knob } from '../ui';

interface Props {
  time: Settings['time']; site: Settings['site']; tz: number; zone: Zone; leap: boolean; errors: Record<string, string>; dispatch: Dispatch<Action>; // zone: the site's civil zone; leap: the core's weather year
  sunPath: boolean; sunScale: number; onSunPath: (on: boolean) => void; onSunScale: (scale: number) => void; // the 3D sun path: shown, size x the fitted radius
}

export const TimePanel = memo(function TimePanel({ time, site, tz, zone, leap, errors, dispatch, sunPath, sunScale, onSunPath, onSunScale }: Props) {
  const year = yearOf(time.date);
  const set = (patch: Partial<Settings['time']>) => dispatch({ type: 'TIME', patch });
  const step = timeStep(time);
  // Every time here is local standard time (as weather files and Ladybug use); say which, and what summer clocks show.
  const dst = zone.dst ? ` With daylight saving, clocks are ${zone.dst % 1 ? `${Math.round(zone.dst * 60)} min` : `${zone.dst} h`} ahead.` : '';
  const clock = site.tz !== null ? `Times in standard time ${fmtOffset(tz)}, set by hand.` : `Times in local standard time, ${fmtOffset(tz)}${zone.name ? ` (${zone.name})` : ''}.${dst}`;
  const sunSite = { lat: site.lat, lon: site.lon, tz, leap };
  // A range is an analysis period: every day from the start date to the end date, from the start time to the end time.
  const days = doy(time.to.date) - doy(time.from.date) + 1, perDay = Math.ceil((time.to.hour - time.from.hour) / step);
  const hours = `${fmtClock(time.from.hour)} to ${fmtClock(time.to.hour)}`;
  const steps = useMemo(() => (time.mode === 'range' ? stepHoys(time, leap).length : 0), [time, leap]); // as the core counts them, in its own calendar
  // The range controls keep start before end, as the 3D handles do, so no drag can make the range invalid.
  const fromHour = (v: number) => ({ from: { ...time.from, hour: Math.max(0, Math.min(v, time.to.hour - step)) } });
  const toHour = (v: number) => ({ to: { ...time.to, hour: Math.min(1440, Math.max(v, time.from.hour + step)) } });
  const summary = days < 1 || perDay < 1 ? 'Pick an end after the start.'
    : `${days === 1 ? `One day, ${fmtDay(time.from.date)}, ${hours}` : `Every day from ${fmtDay(time.from.date)} to ${fmtDay(time.to.date)}, ${hours}`}: ${steps.toLocaleString('en-GB')} step${steps === 1 ? '' : 's'}.`;
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
      <Segmented name="time-mode" label="Time mode" value={time.mode} options={[['annual', 'Annual'], ['instant', 'Single date'], ['range', 'Date range']] as const} onChange={(mode) => set({ mode })} />
      <p className="text-muted lines-2">{clock}</p>
      {time.mode === 'annual' && <p className="text-muted">Every hour of the weather year, sun at mid-hour. The year of the dates below is ignored by the core.</p>}
      {time.mode === 'instant' && (
        <>
          {dateField('time-date', 'Date', time.date, (date) => set({ date }), errors.timeDate)}
          <YearStrip year={year} values={[doy(time.date)]} onChange={(_, v) => set({ date: dateFromDoy(v, year) })} />
          <DayStrip bounds={dayBounds(sunSite, time.date)} values={[time.hour]} step={step} onChange={(_, v) => set({ hour: v })} />
          {hourRow('time-hour', 'Hour', time.hour, (hour) => set({ hour }))}
        </>
      )}
      {time.mode === 'range' && (
        <>
          <div className="grid" style={knob('--grid-min', '8rem')}>
            {dateField('time-from-date', 'From', time.from.date, (date) => set({ from: { ...time.from, date } }))}
            {dateField('time-to-date', 'To', time.to.date, (date) => set({ to: { ...time.to, date } }), errors.timeTo)}
          </div>
          <YearStrip year={year} span values={[doy(time.from.date), doy(time.to.date)]} onChange={(i, v) => set(i === 0 ? { from: { ...time.from, date: dateFromDoy(Math.min(v, doy(time.to.date)), year) } } : { to: { ...time.to, date: dateFromDoy(Math.max(v, doy(time.from.date)), year) } })} />
          <DayStrip bounds={dayBounds(sunSite, time.from.date)} span values={[time.from.hour, time.to.hour]} step={step} onChange={(i, v) => set(i === 0 ? fromHour(v) : toHour(v))} />
          {hourRow('time-from-hour', 'From', time.from.hour, (hour) => set(fromHour(hour)))}
          {hourRow('time-to-hour', 'To', time.to.hour, (hour) => set(toHour(hour)))}
          <p className="text-muted lines-2">{summary}</p>
          <div className="cluster">
            <div className="field">
              <label className="field__label" htmlFor="time-step">Step</label>
              <select className="select" id="time-step" value={time.stepMin} onChange={(e) => set({ stepMin: Number(e.target.value) })}>
                {[10, 15, 30, 60].map((m) => <option key={m} value={m}>{m} min</option>)}
              </select>
            </div>
            <button className="chip" type="button" onClick={() => set({ from: { ...time.from, hour: 0 }, to: { ...time.to, hour: 1440 } })}>Whole day</button>
          </div>
        </>
      )}
      <fieldset className="field" aria-labelledby="lg-sunpath">
        <div className="cluster cluster--between"><legend id="lg-sunpath">Sun path</legend><ResetButton what="the sun path size" onClick={() => onSunScale(1)} /></div>
        <label><input type="checkbox" id="sunpath-show" checked={sunPath} onChange={(e) => onSunPath(e.target.checked)} /> Show around the model</label>
        <label className="slider-row">
          <span>Size</span>
          <input id="sunpath-size" type="range" min={-2} max={2} step={0.1} value={Math.log2(sunScale)} aria-valuetext={`${Math.round(sunScale * 100)} %`} disabled={!sunPath} onChange={(e) => onSunScale(2 ** e.target.valueAsNumber)} />
          <span className="slider-row__value">{Math.round(sunScale * 100)} %</span>
        </label>
        <p className="text-muted lines-2">{time.mode === 'annual' ? 'Annual: the arcs of every month (the 21st) and the loop of every hour span the whole year.' : 'Drag the sun or a handle along its arc to change the time, an arc across the sky to change the date.'}</p>
      </fieldset>
    </section>
  );
});
