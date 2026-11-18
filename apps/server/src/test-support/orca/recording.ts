import { basename, dirname } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { FixtureNormalizer as Normalizer } from '@ai-office/redaction';
export { FixtureNormalizer as Normalizer } from '@ai-office/redaction';
import { assertOutside } from './safety.js';
import type {
  Exec,
  ExecRequest,
  ExecResult,
} from '../../adapters/runtime-orca/cli/types.js';

export interface Recording {
  orcaVersion: string;
  recordedAt: string;
  argv: string[];
  exitCode: number | null;
  response: unknown;
  responseEncoding?: 'text';
  stderrLines: unknown;
}
/** Records sanitized data only; raw command output never touches disk. */
export class RecordingExec implements Exec {
  readonly recordings: Recording[] = [];
  constructor(
    private readonly exec: Exec,
    private version: string,
    readonly normalizer = new Normalizer(),
  ) {}
  setVersion(version: string): void {
    this.version = version;
    for (const recording of this.recordings) recording.orcaVersion = version;
  }
  async run(request: ExecRequest): Promise<ExecResult> {
    const result = await this.exec.run(request);
    let response: unknown;
    let responseEncoding: 'text' | undefined;
    try {
      response = JSON.parse(result.stdout);
    } catch {
      response = this.normalizer.text(result.stdout);
      responseEncoding = 'text';
    }
    this.recordings.push({
      orcaVersion: this.version,
      recordedAt: new Date().toISOString(),
      argv: this.normalizer.argv([basename(request.bin), ...request.args]),
      exitCode: result.exitCode,
      response: this.normalizer.value(response),
      ...(responseEncoding ? { responseEncoding } : {}),
      stderrLines: [],
    });
    return result;
  }
  async save(path: string): Promise<void> {
    await assertOutside(dirname(path), [process.cwd()]);
    await writeFile(path, JSON.stringify(this.recordings, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
  }
}
/** Rehydrate summaries deterministically without reconstructing private text. */
export function rehydrate(value: unknown): unknown {
  if (
    typeof value === 'string' &&
    /^<redacted length=\d+ sha256=[a-f0-9]{64}>$/.test(value)
  )
    return `[recorded body ${value.slice(-17, -1)}]`;
  if (Array.isArray(value)) return value.map(rehydrate);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, rehydrate(child)]),
    );
  return value;
}
export class ReplayExec implements Exec {
  private offset = 0;
  private segment: readonly Recording[];
  private readonly normalizer = new Normalizer();
  constructor(
    private readonly segments: Readonly<Record<string, readonly Recording[]>>,
    initial = 'default',
  ) {
    this.segment = segments[initial] ?? [];
  }
  stimulus(name: string): void {
    this.assertConsumed();
    const segment = this.segments[name];
    if (!segment) throw new Error('Unknown replay segment');
    this.segment = segment;
    this.offset = 0;
  }
  assertConsumed(): void {
    if (this.offset !== this.segment.length)
      throw new Error('Unconsumed replay calls');
  }
  async run(request: ExecRequest): Promise<ExecResult> {
    const next = this.segment[this.offset];
    if (next)
      [basename(request.bin), ...request.args].forEach((arg, i) =>
        this.normalizer.bind(arg, next.argv[i] ?? ''),
      );
    const actual = this.normalizer.argv([
      basename(request.bin),
      ...request.args,
    ]);
    if (!next || JSON.stringify(actual) !== JSON.stringify(next.argv))
      throw new Error('Replay command mismatch');
    this.offset++;
    return {
      stdout:
        next.responseEncoding === 'text'
          ? String(next.response)
          : JSON.stringify(rehydrate(next.response)),
      exitCode: next.exitCode,
    };
  }
}
