import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Effect } from '../../features/office/model/index.js';
import {
  OfficeScene,
  sceneMessagesZhTW,
  type QueuedEffect,
  type SceneTranslate,
} from '../../features/office/scene/index.js';
import {
  HARNESS_STATES,
  harnessFixtures,
  perfFloor,
  type HarnessState,
} from './fixtures.js';
import { measureFrames } from './perf.js';

// Scene harness (M4_PLAN §7.1): a second Vite entry, never in the production
// bundle. Query: ?state=<name>&scale=2&reduced=1, ?play=1 (sample effects), or
// ?perf=40&seconds=10 (frame-time smoke; result on window.__scenePerf).

const params = new URLSearchParams(location.search);
const scale = Number(params.get('scale') ?? '2');
const reduced = params.has('reduced')
  ? params.get('reduced') === '1'
  : undefined;
const perf = params.has('perf') ? Number(params.get('perf')) : null;
const state = (params.get('state') ?? 'implement') as HarnessState;
/** Fixed local time so the sky does not change between screenshots. */
const fixedNow = () => new Date(2026, 10, 18, 10, 30);

const t: SceneTranslate = (key, values) =>
  sceneMessagesZhTW[key].replace(/\{(\w+)\}/g, (_, name: string) =>
    String(values?.[name] ?? `{${name}}`),
  );

const SAMPLE: Effect[] = [
  {
    kind: 'walk-in',
    attemptId: 'f-1',
    from: { kind: 'entrance' },
    to: { kind: 'seat', seatId: 'wf1:engineer:feature' },
  },
  {
    kind: 'envelope',
    route: [{ kind: 'inbox' }, { kind: 'workitem', itemKey: 'persist' }],
    reducedMotion: {
      kind: 'flash-nameplate',
      at: { kind: 'workitem', itemKey: 'persist' },
    },
  },
  { kind: 'print', artifactId: 'art-pr', at: { kind: 'printer' } },
  {
    kind: 'conveyor',
    itemKey: 'theme',
    from: { kind: 'workitem', itemKey: 'theme' },
    to: { kind: 'conveyor' },
  },
  {
    kind: 'merge',
    itemKey: 'theme',
    from: { kind: 'counter' },
    to: { kind: 'integration-cart' },
    confetti: true,
  },
  { kind: 'door-open', at: { kind: 'main-door' }, confetti: true },
];

function Harness() {
  const vm = perf === null ? harnessFixtures()[state] : perfFloor(perf);
  const [effects, setEffects] = useState<QueuedEffect[]>([]);
  useEffect(() => {
    if (!params.has('play')) return;
    let id = 0;
    const play = () =>
      setEffects((list) => [
        ...list,
        ...SAMPLE.map((effect) => ({ id: id++, effect })),
      ]);
    play();
    const timer = setInterval(play, 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (perf === null) return;
    void measureFrames(Number(params.get('seconds') ?? '10') * 1000).then(
      (result) => {
        (window as unknown as { __scenePerf: unknown }).__scenePerf = {
          sprites: document.querySelectorAll('[data-animated="true"]').length,
          ...result,
        };
      },
    );
  }, []);
  return (
    <>
      {perf === null ? (
        <nav style={{ marginBottom: 12, display: 'flex', gap: 12 }}>
          {HARNESS_STATES.map((name) => (
            <a key={name} href={`?state=${name}&scale=${scale}`}>
              {name}
            </a>
          ))}
        </nav>
      ) : null}
      <OfficeScene
        vm={vm}
        scale={scale}
        t={t}
        effects={effects}
        now={fixedNow}
        {...(reduced === undefined ? {} : { reducedMotion: reduced })}
      />
    </>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
createRoot(root).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
