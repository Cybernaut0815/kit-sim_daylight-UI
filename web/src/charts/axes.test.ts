import { describe, expect, it } from 'vitest';
import { fmtTick, niceStep, niceTicks } from './axes';

describe('axes', () => {
  it('steps on a 1-2-5 grid', () => {
    expect(niceStep(100, 5)).toBe(20);
    expect(niceStep(7, 5)).toBe(2);
    expect(niceStep(0.3, 5)).toBeCloseTo(0.1);
    expect(niceStep(1004 - 523, 5)).toBe(100);
  });
  it('places ticks inside the range', () => {
    expect(niceTicks(523, 1004, 5)).toEqual([600, 700, 800, 900, 1000]);
    expect(niceTicks(0, 1, 4)).toEqual([0, 0.5, 1]); // 0.25 rounds up to the 0.5 step
    expect(niceTicks(0, 1, 6)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(0, 0)).toEqual([0]);
    expect(niceTicks(0.146, 0.592, 5)).toEqual([0.2, 0.3, 0.4, 0.5]);
  });
  it('formats ticks', () => {
    expect(fmtTick(1004)).toBe('1,004');
    expect(fmtTick(0.4)).toBe('0.4');
    expect(fmtTick(523.456)).toBe('523');
  });
});
