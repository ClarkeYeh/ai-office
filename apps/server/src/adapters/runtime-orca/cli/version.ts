import { StatusSchema } from '../schemas/index.js';
import { contractMismatch, guard } from '../errors.js';
import type { OrcaCli } from './types.js';
function tuple(version: string): number[] {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw contractMismatch();
  return version.split('.').map(Number);
}
function compare(a: string, b: string): number {
  const left = tuple(a),
    right = tuple(b);
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  return 0;
}
export interface VersionStatus {
  version: string;
  verified: boolean;
  warnings: 'version_changed'[];
}
export class VersionMonitor {
  private last: VersionStatus | undefined;
  private at = -Infinity;
  constructor(
    private readonly cli: OrcaCli,
    readonly supportedRange: { min: string; max: string },
    private readonly now: () => number = Date.now,
  ) {
    if (compare(supportedRange.min, supportedRange.max) > 0)
      throw guard('invalid_version_range');
  }
  /** force=true for every health probe; otherwise at most five minutes old. */
  async check(force = false): Promise<VersionStatus> {
    if (!force && this.last && this.now() - this.at < 300_000)
      return structuredClone(this.last);
    const { result } = await this.cli.run(
      ['status'],
      { kind: 'read', priority: 'identity' },
      StatusSchema,
    );
    const version = result.runtime.appVersion;
    if (compare(version, this.supportedRange.min) < 0)
      throw guard('orca_version_unsupported');
    const changed = this.last !== undefined && this.last.version !== version;
    const warnings: VersionStatus['warnings'] =
      changed || this.last?.warnings.includes('version_changed')
        ? ['version_changed']
        : [];
    this.last = {
      version,
      verified:
        compare(version, this.supportedRange.max) <= 0 && warnings.length === 0,
      warnings,
    };
    this.at = this.now();
    return structuredClone(this.last);
  }
}
