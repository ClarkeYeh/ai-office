import { expect, it } from 'vitest';
import { countOrcaCli, listBound } from './scenario.js';

const BIN = '/Applications/Orca.app/Contents/Resources/bin/orca';
const APP = '/Applications/Orca.app/Contents';

it('counts the Electron/node children of the orca launcher, not the launcher or the GUI', () => {
  const ps = [
    `${APP}/MacOS/Orca`,
    `${APP}/Frameworks/Orca Helper (Renderer).app/Contents/MacOS/Orca Helper (Renderer) --type=renderer`,
    `${APP}/MacOS/Orca ${APP}/Resources/app/out/cli/index.js orchestration worker-list --full --json`,
    `${APP}/MacOS/Orca ${APP}/Resources/app/out/cli/index.js orchestration check --wait --timeout-ms 30000`,
    `${APP}/MacOS/Orca ${APP}/Resources/app/out/cli/index.js terminal list --json`,
    'node /usr/local/bin/something orchestration worker-list',
  ].join('\n');
  // The launcher `exec`s Electron, so a call is one process: the child.
  expect(countOrcaCli(ps, BIN)).toBe(3);
});

it('bounds list-derived transitions by the measured list interval', () => {
  expect(listBound({ calls: 30 })?.worstCaseListIntervalMs).toBe(2_000);
  expect(listBound(undefined)).toBeNull();
});
