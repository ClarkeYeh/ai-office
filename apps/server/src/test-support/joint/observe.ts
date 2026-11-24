/**
 * M5-T7 live observations feeding the restart assertions: lock ownership,
 * the runtime ingest cursor, the run's inbox (Orca level A), the control
 * token (B7) and the `ai-office open --print` session.
 * Every reader fails soft to `undefined` (the assertion part becomes `n/a`);
 * nothing read here is logged — only counts, statuses and booleans leave.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import type { OrcaHarness } from '../orca/harness.js';
import { CLI_ENTRY } from '../orca/production-cli.js';
import type { Json } from '../orca/t17/checks.js';
import { bootstrapCookie, cookieSession } from './session.js';

const run = promisify(execFile);

export const GITHUB_LOCK = join(
  homedir(),
  '.ai-office/test-state/github-live.lock',
);
/** M5_PLAN §7.3 (T16): same rules as the GitHub lock. */
export const ORCA_LOCK = join(
  homedir(),
  '.ai-office/test-state/orca-live.lock',
);

/** True when `path` is a live lock held by this process. */
export async function holdsLock(path: string): Promise<boolean> {
  const text = await readFile(path, 'utf8').catch(() => undefined);
  if (!text) return false;
  try {
    return (JSON.parse(text) as { pid?: unknown }).pid === process.pid;
  } catch {
    return false;
  }
}

/** Highest runtime `lastSeq` in the backend's ingest cursors (read-only). */
export function runtimeCursorLastSeq(home: string): number | undefined {
  let db: Database.Database | undefined;
  try {
    db = new Database(join(home, 'data', 'ai-office.sqlite'), {
      readonly: true,
      fileMustExist: true,
    });
    const rows = db
      .prepare('SELECT source, value_json FROM ingest_cursors')
      .all() as { source: string; value_json: string }[];
    const seqs = rows
      .filter((r) => r.source.startsWith('runtime'))
      .map((r) => (JSON.parse(r.value_json) as Json)?.lastSeq)
      .filter((n): n is number => typeof n === 'number');
    return seqs.length ? Math.max(...seqs) : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

/** The run's inbox (`inbox --terminal run:<run>`, level A): ids and sequences. */
export async function runInbox(
  h: OrcaHarness,
  orcaRun: string,
): Promise<{ id: string; sequence: number }[] | undefined> {
  try {
    const out = (await h.command([
      'orchestration',
      'inbox',
      '--terminal',
      `run:${orcaRun}`,
      '--json',
    ])) as Json;
    const list = (
      Array.isArray(out) ? out : (out.messages ?? out.items ?? [])
    ) as Json[];
    return list
      .map((m) => ({
        id: String(m.id ?? m.messageId ?? ''),
        sequence: Number(m.sequence ?? m.seq ?? NaN),
      }))
      .filter((m) => m.id && Number.isSafeInteger(m.sequence));
  } catch {
    return undefined;
  }
}

export const readControlToken = (home: string) =>
  readFile(join(home, 'data', 'control.token'), 'utf8')
    .then((t) => t.trim() || undefined)
    .catch(() => undefined);

/** B7: the pre-restart control token must now answer 401. */
export async function oldControlTokenStatus(
  url: string,
  token: string,
): Promise<number | undefined> {
  try {
    const response = await fetch(`${url}/local/v1/bootstrap-codes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    await response.arrayBuffer();
    return response.status;
  } catch {
    return undefined;
  }
}

/**
 * `ai-office open --home <home> --no-open --print` (T6): exchanges the new
 * code for a second session and returns its API status (undefined when the
 * command is unavailable). The printed URL is never kept.
 */
export async function openSessionStatus(
  home: string,
  url: string,
  workflowId: string,
): Promise<number | undefined> {
  try {
    const { stdout } = await run(
      process.execPath,
      [CLI_ENTRY, 'open', '--home', home, '--no-open', '--print'],
      {
        env: {
          PATH: '/usr/bin:/bin',
          HOME: process.env.HOME ?? '',
          AI_OFFICE_HOME: home,
        },
        timeout: 30_000,
      },
    );
    const link = /(http:\/\/127\.0\.0\.1:\d+\/auth\/bootstrap\?code=\S+)/.exec(
      stdout,
    )?.[1];
    if (!link) return undefined;
    const api = cookieSession(url, await bootstrapCookie(link));
    return (await api.call('GET', `/api/v1/workflows/${workflowId}`)).status;
  } catch {
    return undefined;
  }
}

/** `caffeinate -w <pid>` exists (only meaningful with `preventSleep = true`). */
export async function caffeinateFor(pid: number): Promise<boolean> {
  const { stdout } = await run('/bin/ps', ['-axww', '-o', 'command='], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .some((l) => /(^|\/)caffeinate\b/.test(l) && l.includes(`-w ${pid}`));
}
