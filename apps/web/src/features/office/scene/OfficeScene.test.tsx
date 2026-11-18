import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { harnessFixtures } from '../../../test-support/harness/fixtures.js';
import type { Effect, OfficeViewModel } from '../model/index.js';
import { Avatar } from './Avatar.js';
import { sceneMessagesZhTW, type SceneTranslate } from './messages.js';
import { OfficeScene, type OfficeSceneProps } from './OfficeScene.js';
import type { QueuedEffect } from './player.js';

const t: SceneTranslate = (key, params) =>
  params === undefined ? key : `${key}${JSON.stringify(params)}`;
const vms = harnessFixtures();
const noon = () => new Date(2026, 10, 18, 12, 5);

function scene(props: Partial<OfficeSceneProps> & { vm?: OfficeViewModel }) {
  return render(
    <OfficeScene
      vm={vms.implement}
      scale={2}
      t={t}
      now={noon}
      reducedMotion={false}
      {...props}
    />,
  );
}
const seatButtons = () =>
  screen
    .getAllByRole('button')
    .filter((b) => b.dataset['testid']?.startsWith('seat-'));

afterEach(cleanup);

describe('OfficeScene: buttons and labels', () => {
  test('every seat, room and prop is a real button with label and test id', () => {
    scene({});
    const vm = vms.implement;
    for (const seat of vm.seats) {
      const button = screen.getByTestId(seat.testId);
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('aria-label')).toBe(seat.ariaLabel);
      expect(button.getAttribute('aria-pressed')).toBe('false');
      expect(button.dataset['pose']).toBe(seat.pose);
    }
    for (const room of vm.rooms) {
      const plate = screen.getByTestId(room.testId);
      expect(plate.tagName).toBe('BUTTON');
      expect(plate.getAttribute('aria-label')).toBe(room.ariaLabel);
    }
    for (const id of ['office-whiteboard', 'office-your-desk'])
      expect(screen.getByTestId(id).tagName).toBe('BUTTON');
    expect(
      screen.getByRole('group', { name: 'office.scene.aria' }),
    ).toBeTruthy();
  });

  test('the selected seat is pressed and holds the roving tab stop', () => {
    const vm = vms['error-needs-you'];
    scene({ vm });
    const selected = screen.getByTestId('seat-wf1:engineer:persist');
    expect(selected.getAttribute('aria-pressed')).toBe('true');
    expect(seatButtons().filter((b) => b.tabIndex === 0)).toEqual([selected]);
  });

  test('scale multiplies world pixels; the frame is the world size', () => {
    scene({ scale: 3 });
    const frame = screen.getByTestId('office-scene');
    expect(frame.style.width).toBe('1056px');
    expect(frame.style.height).toBe('672px');
    expect(screen.getByTestId('seat-wf1:engineer:feature').style.left).toBe(
      `${20 * 3}px`,
    );
  });

  test('two desk rows stack an extra background strip and desks', () => {
    scene({ vm: vms['two-rows'] });
    expect(document.querySelectorAll('img')).toHaveLength(4);
    expect(screen.getByTestId('desk-monitor-5')).toBeTruthy();
    expect(screen.getByTestId('desk-reserved-foxtrot').tagName).toBe('BUTTON');
  });

  test('not interactive (gate thumbnail): no buttons, hidden from AT', () => {
    scene({ vm: vms['conclusion-hush'], interactive: false });
    expect(screen.queryAllByRole('button', { hidden: true })).toEqual([]);
    expect(screen.getByTestId('office-scene').getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(screen.getByTestId('office-hush')).toBeTruthy();
  });

  test('state props: hush, open door, amber lamp, parcel, poses', () => {
    scene({ vm: vms['error-needs-you'] });
    expect(screen.queryByTestId('office-hush')).toBeNull();
    expect(screen.getByTestId('office-lamp').dataset['sprite']).toBe('lamp.on');
    expect(screen.getByTestId('parcel-theme')).toBeTruthy();
    expect(screen.getByTestId('office-your-desk-bang')).toBeTruthy();
    cleanup();
    scene({ vm: vms['final-merged'] });
    expect(screen.getByTestId('office-door').dataset['open']).toBe('true');
    cleanup();
    scene({ vm: vms['conclusion-hush'] });
    expect(screen.getByTestId('office-hush').style.clipPath).toContain(
      'evenodd',
    );
  });
});

describe('OfficeScene: keyboard and callbacks', () => {
  test('arrow keys move focus between seats; Enter selects', async () => {
    const user = userEvent.setup();
    const onSelectSeat = vi.fn();
    scene({ vm: vms['two-rows'], onSelectSeat });
    const alpha = screen.getByTestId('seat-wf1:engineer:alpha');
    expect(alpha.tabIndex).toBe(0);
    alpha.focus();
    await user.keyboard('{ArrowRight}');
    const bravo = screen.getByTestId('seat-wf1:engineer:bravo');
    expect(document.activeElement).toBe(bravo);
    expect(bravo.tabIndex).toBe(0);
    expect(alpha.tabIndex).toBe(-1);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(
      screen.getByTestId('seat-wf1:engineer:echo'),
    );
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(alpha);
    await user.keyboard('{Enter}');
    expect(onSelectSeat).toHaveBeenCalledWith('wf1:engineer:alpha');
  });

  test('room plates zoom to the next multiple; again or Esc restores', async () => {
    const user = userEvent.setup();
    scene({ scale: 3 });
    const frame = screen.getByTestId('office-scene');
    const plate = screen.getByTestId('room-yours');
    await user.click(plate);
    expect(plate.getAttribute('aria-pressed')).toBe('true');
    expect(plate.getAttribute('aria-label')).toContain('office.scene.zoomOut');
    const world = frame.firstElementChild as HTMLElement;
    expect(world.style.transform).toMatch(
      /translate\(-?\d+px, -?\d+px\) scale\(2\)/,
    );
    expect(frame.dataset['zoom']).toBe('yours');
    await user.click(plate);
    expect(frame.dataset['zoom']).toBeUndefined();
    await user.click(plate);
    await user.keyboard('{Escape}');
    expect(frame.dataset['zoom']).toBeUndefined();
    expect(world.style.transform).toBe('');
  });

  test('whiteboard, your desk and reserved desks call back', async () => {
    const user = userEvent.setup();
    const onOpenBoard = vi.fn();
    const onOpenDesk = vi.fn();
    const onSelectReserved = vi.fn();
    scene({ vm: vms['two-rows'], onOpenBoard, onOpenDesk, onSelectReserved });
    await user.click(screen.getByTestId('office-whiteboard'));
    await user.click(screen.getByTestId('office-your-desk'));
    await user.click(screen.getByTestId('desk-reserved-foxtrot'));
    expect(onOpenBoard).toHaveBeenCalledOnce();
    expect(onOpenDesk).toHaveBeenCalledOnce();
    expect(onSelectReserved).toHaveBeenCalledWith('foxtrot');
  });

  test('inbox items are links to GitHub', () => {
    scene({ vm: vms['final-merged'] });
    const link = screen.getByTestId('inbox-art-final');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(
      'https://github.com/octo/demo/pull/9',
    );
  });
});

describe('OfficeScene: motion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const walkIn = (seatId: string): Effect => ({
    kind: 'walk-in',
    attemptId: 'x',
    from: { kind: 'entrance' },
    to: { kind: 'seat', seatId },
  });
  const envelopeTo = (itemKey: string): Effect => ({
    kind: 'envelope',
    route: [{ kind: 'inbox' }, { kind: 'workitem', itemKey }],
    reducedMotion: {
      kind: 'flash-nameplate',
      at: { kind: 'workitem', itemKey },
    },
  });
  const queue = (effects: Effect[]): QueuedEffect[] =>
    effects.map((effect, id) => ({ id, effect }));

  test('typing and "!" loop as transform strips; reduced motion stops them', () => {
    scene({ vm: vms['error-needs-you'] });
    expect(
      screen.getByTestId('seat-wf1:engineer:persist-bang').dataset['animated'],
    ).toBe('true');
    cleanup();
    scene({ vm: vms['two-rows'] });
    const typing = document.querySelectorAll('[data-animated="true"]');
    expect(typing).toHaveLength(5);
    const strip = typing[0]!.firstElementChild as HTMLElement;
    expect(strip.style.getPropertyValue('--frames')).toBe('2');
    expect(strip.style.getPropertyValue('--strip')).toBe('-32px');
    cleanup();
    scene({ vm: vms['two-rows'], reducedMotion: true });
    expect(document.querySelectorAll('[data-animated="true"]')).toHaveLength(0);
    expect(screen.getByTestId('office-scene').dataset['reduced']).toBe('true');
  });

  test('walk-in hides the seated figure while the walker plays', () => {
    const onEffectDone = vi.fn();
    scene({
      effects: queue([walkIn('wf1:engineer:feature')]),
      onEffectDone,
    });
    expect(screen.getByTestId('effect-walk-in')).toBeTruthy();
    const seat = screen.getByTestId('seat-wf1:engineer:feature');
    expect(seat.querySelector('[data-hidden="true"]')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByTestId('effect-walk-in')).toBeNull();
    expect(seat.querySelector('[data-hidden="true"]')).toBeNull();
    expect(onEffectDone).toHaveBeenCalledWith(0);
  });

  test('at most 8 effects play at once; the queue drains', () => {
    const onEffectDone = vi.fn();
    scene({
      effects: queue(Array.from({ length: 12 }, () => envelopeTo('persist'))),
      onEffectDone,
    });
    expect(screen.getAllByTestId('effect-envelope')).toHaveLength(8);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getAllByTestId('effect-envelope')).toHaveLength(4);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryAllByTestId('effect-envelope')).toHaveLength(0);
    expect(onEffectDone).toHaveBeenCalledTimes(12);
  });

  test('more than 20 waiting: the extra effects never play', () => {
    const onEffectDone = vi.fn();
    scene({
      effects: queue(Array.from({ length: 40 }, () => envelopeTo('persist'))),
      onEffectDone,
    });
    for (let i = 0; i < 10; i++)
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    expect(onEffectDone).toHaveBeenCalledTimes(28);
  });

  test('reduced motion: the envelope flashes the destination nameplate', () => {
    scene({
      reducedMotion: true,
      effects: queue([envelopeTo('persist'), walkIn('wf1:engineer:feature')]),
    });
    expect(screen.queryByTestId('effect-envelope')).toBeNull();
    expect(screen.queryByTestId('effect-walk-in')).toBeNull();
    const plate = screen
      .getByTestId('seat-wf1:engineer:persist')
      .querySelector('[data-flash="true"]');
    expect(plate).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(document.querySelector('[data-flash="true"]')).toBeNull();
  });

  test('effects whose anchors are off the floor finish at once', () => {
    const onEffectDone = vi.fn();
    scene({
      effects: queue([walkIn('nobody'), envelopeTo('nothing')]),
      onEffectDone,
    });
    expect(onEffectDone).toHaveBeenCalledTimes(2);
  });

  test('door, merge, print, paper and parcel effects play and finish', () => {
    const onEffectDone = vi.fn();
    scene({
      vm: vms['error-needs-you'],
      onEffectDone,
      effects: queue([
        { kind: 'door-open', at: { kind: 'main-door' }, confetti: true },
        {
          kind: 'merge',
          itemKey: 'theme',
          from: { kind: 'counter' },
          to: { kind: 'integration-cart' },
          confetti: true,
        },
        { kind: 'print', artifactId: 'a', at: { kind: 'printer' } },
        {
          kind: 'conveyor',
          itemKey: 'theme',
          from: { kind: 'workitem', itemKey: 'theme' },
          to: { kind: 'conveyor' },
        },
        {
          kind: 'walk-out',
          attemptId: 't-1',
          from: { kind: 'seat', seatId: 'wf1:engineer:theme' },
          to: { kind: 'entrance' },
        },
      ]),
    });
    expect(screen.queryByTestId('office-door')).toBeNull();
    expect(screen.getByTestId('effect-door').dataset['sprite']).toBe(
      'door.closed',
    );
    expect(screen.queryByTestId('parcel-theme')).toBeNull();
    expect(screen.getByTestId('effect-print')).toBeTruthy();
    expect(screen.getByTestId('effect-conveyor-belt')).toBeTruthy();
    expect(screen.getByTestId('effect-walk-out')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByTestId('effect-door').dataset['sprite']).toBe(
      'door.open',
    );
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onEffectDone).toHaveBeenCalledTimes(5);
    expect(screen.getByTestId('office-door')).toBeTruthy();
    expect(screen.getByTestId('parcel-theme')).toBeTruthy();
  });

  test('paper grows sheet by sheet up to the new count', () => {
    const vm = vms.implement;
    scene({
      vm,
      effects: queue([
        {
          kind: 'paper-grow',
          at: { kind: 'seat', seatId: 'wf1:engineer:feature' },
          fromSheets: 3,
          toSheets: 5,
        },
      ]),
    });
    expect(screen.queryByTestId('paper-stack-0')).toBeNull();
    expect(screen.getByTestId('effect-paper-grow').dataset['frame']).toBe('2');
    act(() => {
      vi.advanceTimersByTime(130);
    });
    expect(screen.getByTestId('effect-paper-grow').dataset['frame']).toBe('3');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId('paper-stack-0')).toBeTruthy();
  });
});

describe('OfficeScene: easter eggs (D11)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('a plant drops a leaf for 600 ms', () => {
    scene({});
    fireEvent.click(screen.getByTestId('egg-plant-0'));
    expect(screen.getByTestId('egg-leaf')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.queryByTestId('egg-leaf')).toBeNull();
  });

  test('the coffee machine fills the mug (last frame when reduced)', () => {
    scene({ reducedMotion: true });
    expect(screen.queryByTestId('egg-coffee-mug')).toBeNull();
    fireEvent.click(screen.getByTestId('egg-coffee'));
    const mug = screen.getByTestId('egg-coffee-mug');
    expect(mug.dataset['frame']).toBe('2');
  });

  test('the clock re-reads the local time for the sky and shows it', () => {
    let now = new Date(2026, 10, 18, 12, 5);
    scene({ now: () => now });
    expect(screen.getByTestId('office-sky').dataset['sky']).toBe('day');
    now = new Date(2026, 10, 18, 21, 7);
    fireEvent.click(screen.getByTestId('egg-clock'));
    expect(screen.getByTestId('office-sky').dataset['sky']).toBe('night');
    expect(screen.getByTestId('egg-clock-time').textContent).toBe(
      'office.scene.clockTime{"time":"21:07"}',
    );
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByTestId('egg-clock-time')).toBeNull();
  });
});

test('Avatar shows the front upper body', () => {
  render(
    <Avatar
      seat={{ role: 'architect', vendor: 'codex', accessory: 'leaf' }}
      label="architect"
    />,
  );
  const avatar = screen.getByRole('img', { name: 'architect' });
  expect(
    avatar.querySelector('[data-sprite]')?.getAttribute('data-sprite'),
  ).toBe('char.architect.codex.leaf.upper');
  cleanup();
});

test('scene messages are zh-TW defaults for every key the scene uses', () => {
  expect(Object.keys(sceneMessagesZhTW).sort()).toEqual(
    [
      'office.scene.aria',
      'office.scene.clock',
      'office.scene.clockTime',
      'office.scene.coffee',
      'office.scene.plant',
      'office.scene.zoomOut',
    ].sort(),
  );
});
