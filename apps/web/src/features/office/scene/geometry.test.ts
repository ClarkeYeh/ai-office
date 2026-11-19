import { describe, expect, test } from 'vitest';
import { harnessFixtures } from '../../../test-support/harness/fixtures.js';
import type { OfficeSeat } from '../model/index.js';
import {
  anchorKey,
  characterSprite,
  envelopeDuration,
  figureOf,
  plants,
  resolveAnchor,
  sceneScale,
  seatOfAnchor,
  skyAt,
  steppedPoints,
  walkPath,
  walkSteps,
} from './geometry.js';
import { spriteOf } from './atlas.js';

const vms = harnessFixtures();
const seat = (over: Partial<OfficeSeat>): OfficeSeat => ({
  ...vms.implement.seats[0]!,
  ...over,
});

describe('scale', () => {
  test('integer multiple of 352, at least 2×', () => {
    expect(sceneScale(1056)).toBe(3);
    expect(sceneScale(1100)).toBe(3);
    expect(sceneScale(1055)).toBe(2);
    expect(sceneScale(300)).toBe(2);
    expect(sceneScale(1408)).toBe(4);
  });
});

describe('anchors', () => {
  test('every effect anchor kind maps to a view-model key', () => {
    expect(anchorKey({ kind: 'inbox' })).toBe('inbox');
    expect(anchorKey({ kind: 'main-door' })).toBe('main-door');
    expect(anchorKey({ kind: 'seat', seatId: 's' })).toBe('seat:s');
    expect(anchorKey({ kind: 'meeting', seatId: 's' })).toBe('meeting:s');
    expect(anchorKey({ kind: 'workitem', itemKey: 'k' })).toBe('workitem:k');
  });

  test('fixed anchors resolve; unknown seats do not', () => {
    const vm = vms.implement;
    for (const kind of [
      'entrance',
      'inbox',
      'your-desk',
      'printer',
      'counter',
      'conveyor',
      'integration-cart',
      'main-door',
    ] as const)
      expect(resolveAnchor(vm, { kind })).toBeDefined();
    expect(resolveAnchor(vm, { kind: 'workitem', itemKey: 'persist' })).toEqual(
      { x: 76, y: 124 },
    );
    expect(resolveAnchor(vm, { kind: 'seat', seatId: 'nobody' })).toBe(
      undefined,
    );
  });

  test('anchors name seats directly or through their item', () => {
    const vm = vms.implement;
    expect(
      seatOfAnchor(vm, { kind: 'workitem', itemKey: 'theme' })?.seatId,
    ).toBe('wf1:engineer:theme');
    expect(seatOfAnchor(vm, { kind: 'seat', seatId: 'wf1:lead' })?.role).toBe(
      'lead',
    );
    expect(seatOfAnchor(vm, { kind: 'inbox' })).toBeUndefined();
  });

  test('extra desk rows move the bottom-band props down', () => {
    expect(plants(1).at(-1)).toEqual({ x: 118, y: 196 });
    expect(plants(2).at(-1)).toEqual({ x: 118, y: 260 });
    expect(plants(2)[0]).toEqual({ x: 94, y: 78 });
  });
});

describe('figures (§2.6)', () => {
  test('desk poses: typing loop, slump, idle, standing, empty chair', () => {
    expect(figureOf(seat({ pose: 'working' }))).toMatchObject({
      frame: 'type',
      animated: true,
    });
    expect(figureOf(seat({ pose: 'error' }))).toMatchObject({
      frame: 'slump',
      smoke: true,
      animated: false,
    });
    expect(figureOf(seat({ pose: 'idle' }))).toMatchObject({ frame: 'idle' });
    expect(figureOf(seat({ pose: 'needs-you' }))).toMatchObject({
      frame: 'front',
      dy: -8,
      bang: true,
    });
    expect(figureOf(seat({ pose: 'away' }))).toBeNull();
  });

  test('behind a desk, the figure faces the camera; standing for the host', () => {
    expect(figureOf(seat({ place: 'lead', pose: 'working' }))?.frame).toBe(
      'upper',
    );
    expect(figureOf(seat({ place: 'counter', pose: 'idle' }))?.frame).toBe(
      'idle',
    );
    expect(
      figureOf(seat({ place: 'meeting', chair: 1, pose: 'working' })),
    ).toMatchObject({ frame: 'upper', animated: false });
    expect(
      figureOf(seat({ place: 'meeting', chair: 2, pose: 'working' })),
    ).toMatchObject({ frame: 'type', animated: false });
    expect(
      figureOf(seat({ place: 'meeting', chair: 'facilitator' }))?.frame,
    ).toBe('front');
    expect(figureOf(seat({ place: 'lounge' }))?.frame).toBe('front');
  });

  test('every seat in the fixtures has an atlas sprite', () => {
    for (const vm of Object.values(vms))
      for (const s of vm.seats) {
        const figure = figureOf(s);
        if (figure)
          expect(spriteOf(characterSprite(s, figure.frame))).toBeDefined();
        expect(spriteOf(characterSprite(s, 'walk'))?.frames).toBe(4);
      }
  });

  test('unknown roles fall back to the engineer outline', () => {
    expect(
      characterSprite(
        { role: 'reviewer', vendor: null, accessory: 'cyan' },
        'upper',
      ),
    ).toBe('char.engineer.claude-code.cyan.upper');
  });
});

describe('motion', () => {
  test('stepped points are integers along the path, ending on the target', () => {
    const points = steppedPoints(
      [
        { x: 0, y: 0 },
        { x: 0, y: 10 },
        { x: 7, y: 10 },
      ],
      3,
    );
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points.at(-1)).toEqual({ x: 7, y: 10 });
    for (const p of points) {
      expect(Number.isInteger(p.x)).toBe(true);
      expect(Number.isInteger(p.y)).toBe(true);
    }
  });

  test('walks go up the corridor first and take at most 4 s at 8 fps', () => {
    const path = walkPath({ x: 148, y: 500 }, { x: 8, y: 30 }, true);
    expect(path[1]).toEqual({ x: 148, y: 30 });
    expect(walkPath({ x: 0, y: 0 }, { x: 5, y: 9 }, false)[1]).toEqual({
      x: 5,
      y: 0,
    });
    expect(walkSteps(path).length - 1).toBeLessThanOrEqual(32);
  });

  test('envelopes take 600–900 ms', () => {
    expect(envelopeDuration(1)).toBe(600);
    expect(envelopeDuration(2)).toBe(600);
    expect(envelopeDuration(3)).toBe(900);
    expect(envelopeDuration(5)).toBe(900);
  });

  test('sky follows the local hour', () => {
    expect(skyAt(10)).toBe('day');
    expect(skyAt(17)).toBe('evening');
    expect(skyAt(22)).toBe('night');
    expect(skyAt(3)).toBe('night');
  });
});
