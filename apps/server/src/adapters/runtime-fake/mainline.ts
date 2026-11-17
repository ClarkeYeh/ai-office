import type { RuntimeScenario } from './scenario.js';
import {
  facilitator,
  participant,
  planning,
  implementation,
  integration,
} from './mainline-actions.js';

/** §0.1 agent behavior; application drives rounds, gates, workspace and PR mapping. */
export const mainlineScenario: RuntimeScenario = {
  roles: {
    facilitator,
    pm: participant,
    architect: participant,
    engineer: participant,
    planner: { spawn: planning },
    worker: { spawn: implementation },
    integrator: { spawn: integration },
  },
};
