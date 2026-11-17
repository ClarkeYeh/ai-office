import type { RuntimeScenario } from './scenario.js';
import {
  facilitator,
  participant,
  planning,
  implementation,
  integration,
  mergeQueue,
} from './mainline-actions.js';

/** Spec titles (`# AI Office spec: <purpose>`) → scenario roles. */
const SPEC_ROLES: readonly [RegExp, string][] = [
  [/meeting facilitator/, 'facilitator'],
  [/meeting participant/, 'participant'],
  [/planning lead/, 'planner'],
  [/implementation worker/, 'worker'],
  [/merge-queue integrator/, 'merge-queue'],
  [/integrator \(wrap-up\)/, 'integrator'],
  [/on-call lead/, 'oncall'],
];

/**
 * §0.1 agent behavior answering the engine's turns. With `readSpec`, the role
 * comes from the spec the agent read; otherwise from the spawn title.
 */
export const mainlineScenario: RuntimeScenario = {
  role: (request, spec) => {
    const title = /^# AI Office spec: (.*)$/m.exec(spec ?? '')?.[1];
    return (
      (title && SPEC_ROLES.find(([pattern]) => pattern.test(title))?.[1]) ||
      request.title
    );
  },
  roles: {
    facilitator,
    participant,
    pm: participant,
    architect: participant,
    engineer: participant,
    planner: { spawn: planning },
    worker: { spawn: implementation },
    'merge-queue': mergeQueue,
    integrator: { spawn: integration },
  },
};
