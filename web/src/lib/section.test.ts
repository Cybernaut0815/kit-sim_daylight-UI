import { describe as group, expect, it } from 'vitest';
import { clean, keeps, rows } from '../../../USD_WebViewer/web/src/section';
import { defaultSettings, parseSettings, serializeSettings, type Settings } from '../store';
import { buildArgs } from './args';
import { toWorld, type Vec3 } from './frame';
import { NONE, describe, direction, fromStage, sectionOf, toStage, validate, type Section, type Up } from './section';

/** JSON: -0 and 0 alike, as the viewer compares sections. */
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
// a plan cut at 1.2 m, a tilted plane, a concave footprint showing its inside (its notch at the top left) and a box
// cutting out of it (model metres)
const CUT: Section = {
  on: true,
  planes: [{ point: [3.25, -7.5, 1.2], normal: [0, 0, -1] }, { point: [0, 0, 0.001], normal: direction([1, 2, -0.5]) }],
  boxes: [
    { keep: 'inside', footprint: [[0, 0], [10, 0], [10, 8], [4, 3]], bottom: -0.5, top: 12.25 },
    { keep: 'outside', footprint: [[6, 1], [7.5, 1], [7.5, 2.75], [6, 2.75]], bottom: 0, top: 3 },
  ],
};
/** A model point in a stage's units and axes. */
const at = (p: Vec3, mpu: number, up: Up) => (up === 'Z' ? p.map((v) => v / mpu) : toWorld(p, mpu)) as Vec3;

group('toStage / fromStage', () => {
  for (const up of ['Z', 'Y'] as const) {
    for (const mpu of [1, 0.001, 0.3048]) {
      it(`${up}-up at ${mpu} m per unit: round trips; the viewer keeps every entry as given and cuts the same points`, () => {
        const s = toStage(CUT, mpu, up);
        expect(fromStage(s, mpu, up)).toEqual(CUT);
        expect(json(clean(s, up))).toEqual(json(s)); // footprints counter-clockwise seen from above already, corner 0 first
        const r = rows(s, up), shows = (p: Vec3) => keeps(r, ...at(p, mpu, up));
        // shown; above the plan cut; shown; in the notch; in the cut-out box; under the box shown
        expect([[5, 2, 1], [5, 2, 1.3], [8, 6, 1], [1, 5, 1], [7, 2, 1], [5, 2, -0.6]].map((p) => shows(p as Vec3))).toEqual([true, false, true, false, false, false]);
      });
    }
  }
  it('a Y-up stage takes the model as three world does: x, z, -y; up is its Y', () => {
    const s = toStage({ ...NONE, planes: [CUT.planes[0]], boxes: [CUT.boxes[1]] }, 0.01, 'Y');
    expect(json(s.planes[0])).toEqual({ point: [325, 120, 750], normal: [0, -1, 0] });
    expect(json(s.boxes[0])).toEqual({ keep: 'outside', corners: [[600, 0, -100], [750, 0, -100], [750, 0, -275], [600, 0, -275]], bottom: 0, top: 300 });
  });
  it('rounds what the gizmo gives: lengths to 1 mm, normals to unit vectors of 1e-4; a clockwise footprint comes back turned', () => {
    const viewer = clean({ on: false, planes: [{ point: [1.23456, 2, 3.0004], normal: [0, 3, 4] }], boxes: [{ keep: 'inside', corners: [[0, 0, 9], [0, 2, 9], [3, 2, 9], [3, 0, 9]], bottom: 1, top: 2.0006 }] }, 'Z');
    expect(fromStage(viewer, 1, 'Z')).toEqual({
      on: false, planes: [{ point: [1.235, 2, 3], normal: [0, 0.6, 0.8] }], boxes: [{ keep: 'inside', footprint: [[0, 0], [3, 0], [3, 2], [0, 2]], bottom: 1, top: 2.001 }],
    });
  });
  it('keeps the exact numbers of a box rounding would make unusable (under 1 mm high or across), so validate() passes it', () => {
    const thin = clean({ on: true, planes: [], boxes: [
      { keep: 'inside', corners: [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]], bottom: 1.0001, top: 1.0004 },
      { keep: 'outside', corners: [[0, 0, 0], [2, 0, 0], [2, 0.0004, 0], [0, 0.0004, 0]], bottom: 0, top: 1 },
    ] }, 'Z'), s = fromStage(thin, 1, 'Z');
    expect(s.boxes).toEqual([
      { keep: 'inside', footprint: [[0, 0], [2, 0], [2, 2], [0, 2]], bottom: 1.0001, top: 1.0004 },
      { keep: 'outside', footprint: [[0, 0], [2, 0], [2, 0.0004], [0, 0.0004]], bottom: 0, top: 1 },
    ]);
    expect(validate(s, 'section')).toEqual([]);
  });
});

group('validate', () => {
  it('passes a section, or one with parts left out; sectionOf keeps its own fields', () => {
    expect(validate(CUT, 'section')).toEqual([]);
    expect(validate({ planes: [] }, 'section')).toEqual([]);
    expect(sectionOf({ boxes: [{ ...CUT.boxes[1], name: 'x' } as Section['boxes'][number]] })).toEqual({ on: true, planes: [], boxes: [CUT.boxes[1]] });
  });
  it('names every problem by its path', () => {
    expect(validate([], 'section')).toEqual(['section: an object {on, planes, boxes} in model metres']);
    expect(validate({ on: 1, planes: Array(9).fill(CUT.planes[0]), boxes: {}, box: [] }, 'blocks[2].section')).toEqual([
      'blocks[2].section.box: not a field of a section (on, planes, boxes)',
      'blocks[2].section.on: true or false',
      'blocks[2].section.planes: at most 8 planes, each {point, normal}',
      'blocks[2].section.boxes: at most 8 boxes, each {keep, footprint, bottom, top}',
    ]);
    expect(validate({
      planes: [{ point: [0, 0], normal: [0, 0, 0] }, 'up', { point: [0, 0, 0], normal: [0, 0, NaN], keep: 'below' }],
      boxes: [
        { keep: 'in', footprint: [[0, 0], [1, 0], [1, 1]], bottom: 2, top: 2 },
        { keep: 'inside', footprint: [[0, 0], [1, 1], [1, 0], [0, 1]], bottom: 0, top: '3' },
        { keep: 'outside', footprint: [[0, 0], [1, 0], [1, Infinity], [0, 1]], bottom: 0, top: 1 },
      ],
    }, 'section')).toEqual([
      'section.planes[0].point: [x, y, z], finite numbers in m',
      'section.planes[0].normal: not zero: it points to the side the plane keeps',
      'section.planes[1]: {point, normal}: it keeps the side its normal points to',
      'section.planes[2].keep: not a field of a plane (point, normal)',
      'section.planes[2].normal: [x, y, z], finite numbers',
      "section.boxes[0].keep: 'inside' (shows only what is in it) or 'outside' (cuts it away)",
      'section.boxes[0].footprint: 4 corners [x, y] in m, in order round the box',
      'section.boxes[0].top: above the bottom (2 m)',
      'section.boxes[1].footprint: crosses itself or has no area; give the corners in order round the box',
      'section.boxes[1].top: a height in m',
      'section.boxes[2].footprint[2]: [x, y], finite numbers in m',
    ]);
  });
  it('agrees with the viewer on footprints: a crossing or flat one is refused by both', () => {
    for (const f of [[[0, 0], [1, 1], [1, 0], [0, 1]], [[0, 0], [1, 0], [2, 0], [3, 0]], [[0, 0], [4, 0], [1, 1], [0, 4]]] as Section['boxes'][number]['footprint'][]) {
      const s = { ...NONE, boxes: [{ keep: 'inside' as const, footprint: f, bottom: 0, top: 1 }] };
      expect(validate(s, 'section').length === 0).toBe(clean(toStage(s, 1, 'Z'), 'Z').boxes.length === 1);
    }
  });
});

group('describe', () => {
  it('says it in a few words', () => {
    expect(describe(NONE)).toBe('none');
    expect(describe({ ...CUT, on: false })).toBe('off');
    expect(describe({ ...NONE, planes: [CUT.planes[0]] })).toBe('horizontal at 1.20 m, keeps below');
    expect(describe({ ...NONE, planes: [CUT.planes[0], { point: [5, 0, 0], normal: [-1, 0, 0] }] })).toBe('horizontal at 1.20 m, keeps below; vertical at x = 5.00 m, keeps the -x side');
    expect(describe(CUT)).toBe('2 planes; 1 box showing inside, 1 box cutting out');
    expect(describe({ ...NONE, boxes: [CUT.boxes[1], CUT.boxes[1]] })).toBe('2 boxes cutting out');
  });
});

group('isolation', () => {
  it('is no run input: the settings know none, their stored record and the run arguments (and so the run key) stay as they are', () => {
    const s = defaultSettings(), slipped = { ...s, section: CUT } as Settings; // as if one were put into the settings
    expect(Object.keys(s)).not.toContain('section');
    expect(buildArgs(slipped)).toEqual(buildArgs(s));
    expect(parseSettings(serializeSettings(slipped))).toEqual(parseSettings(serializeSettings(s)));
  });
});
