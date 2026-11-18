/** M2-T3 foundation. T5/T10 compose the RuntimePort; no fake production fallback. */
export { DefaultOrcaCli } from './cli/index.js';
export type * from './cli/types.js';
export { CwdGuard } from './cli/cwd.js';
export { CliScheduler, CliMetrics } from './cli/scheduler.js';
export {
  SpawnExec,
  ProcessGroups,
  cleanupOrphanProcesses,
} from './cli/process.js';
export { VersionMonitor } from './cli/version.js';
export { DefaultGitCli, type GitCli } from './git/index.js';
export { DispatchLedger } from './ledger.js';
export * from './refs.js';
export * from './env-allowlist.js';
export type * from './coordinator-identity/index.js';
export type * from './observe/index.js';
export type { AdapterState } from './state.js';
