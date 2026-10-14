import { describe, expect, it } from 'vitest';
import { epwMonthly, sum } from './epw';

// synthetic EPW: 8 header lines, then one row per hour; noon rows carry 1000 GHI, 800 DNI, 200 DHI; one noon row missing (9999)
function epw(rows: number): string {
  const head: string[] = Array.from({ length: 8 }, (_, i) => (i === 0 ? 'LOCATION,Test,-,X,src,0,52.5,13.4,1,50' : 'HEADER'));
  const body: string[] = [];
  for (let r = 0; r < rows; r++) {
    const noon = r % 24 === 11, miss = r === 11;
    const vals = new Array(35).fill('0');
    vals[13] = miss ? '9999' : noon ? '1000' : '0';
    vals[14] = noon ? '800' : '0';
    vals[15] = noon ? '200' : '0';
    body.push(vals.join(','));
  }
  return head.concat(body).join('\n') + '\n';
}

describe('epwMonthly', () => {
  it('sums per month, counts sunshine hours, skips missing values', () => {
    const m = epwMonthly(epw(8760), 52.5, 13.4, 1);
    expect(m.sunshine[0]).toBe(31);
    expect(m.sunshine[1]).toBe(28);
    expect(sum(m.sunshine)).toBe(365);
    expect(m.ghi[0]).toBeCloseTo(30); // 31 noons, one missing
    expect(m.dni[1]).toBeCloseTo(28 * 0.8);
    expect(m.dhi[11]).toBeCloseTo(31 * 0.2);
    expect(m.daylight[5]).toBeGreaterThan(m.daylight[11]); // June longer than December at 52.5 N
    expect(m.daylight[5] / 30).toBeGreaterThan(16);
    expect(m.daylight[11] / 31).toBeLessThan(8.5);
  });
  it('handles a leap year by the row count', () => {
    const m = epwMonthly(epw(8784), 52.5, 13.4, 1);
    expect(m.sunshine[1]).toBe(29);
    expect(sum(m.sunshine)).toBe(366);
  });
});
