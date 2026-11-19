import { spawnSync } from 'node:child_process';
export const gitVersion = () => spawnSync('git', ['--version']);
