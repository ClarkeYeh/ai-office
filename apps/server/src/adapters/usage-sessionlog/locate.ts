import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { UsageLocateRef, UsageRef } from '../../ports/usage.js';
import { object } from './parsers.js';

export type SessionDirectories = {
  claudeConfigDirs?: readonly string[];
  codexHomes?: readonly string[];
  /** Injectable home for tests and installations with a relocated user profile. */
  homeDir?: string;
};
async function* files(directory: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    // Do not follow symlinks out of the provider's session directories.
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path;
  }
}
async function roots(
  options: SessionDirectories,
  agent: UsageLocateRef['agent'],
) {
  const home = options.homeDir ?? homedir();
  const orca = join(home, 'Library', 'Application Support', 'orca');
  if (agent === 'codex')
    return [
      ...new Set(
        [
          ...(options.codexHomes ?? []),
          join(orca, 'codex-runtime-home', 'home'),
          join(orca, 'codex-runtime-home'),
          join(home, '.codex'),
        ].map((path) => join(resolve(path), 'sessions')),
      ),
    ];
  let observed: string[] = [];
  try {
    const value: unknown = JSON.parse(
      await readFile(join(orca, 'claude-observed-config-dirs.json'), 'utf8'),
    );
    if (Array.isArray(value))
      observed = value.filter((v): v is string => typeof v === 'string');
  } catch {
    /* Optional discovery hint; explicit directories still work. */
  }
  return [
    ...new Set(
      [
        ...(options.claudeConfigDirs ?? []),
        ...observed,
        join(home, '.claude'),
      ].map((path) => join(resolve(path), 'projects')),
    ),
  ];
}

/** No transcript content escapes this function; only the selected path and id do. */
export async function locateSession(
  options: SessionDirectories,
  query: UsageLocateRef,
  now: number,
): Promise<UsageRef | null> {
  const candidates: string[] = [];
  for (const root of await roots(options, query.agent))
    for await (const path of files(root)) candidates.push(path);
  const ref = (file: string, sessionId: string): UsageRef => ({
    attemptId: query.attemptId,
    agent: query.agent,
    sessionId,
    file,
  });
  const id = query.reportedSessionId;
  if (id && /^[a-zA-Z0-9_-]+$/.test(id)) {
    const found = candidates.find((path) =>
      query.agent === 'claude-code'
        ? basename(path) === `${id}.jsonl`
        : basename(path).startsWith('rollout-') &&
          basename(path).endsWith(`-${id}.jsonl`),
    );
    if (found) return ref(found, id);
  }
  // Compatibility for old callers: only search the preceding 24 hours, never all history.
  const since =
    query.startedAt === undefined
      ? now - 86_400_000
      : Date.parse(query.startedAt);
  if (!Number.isFinite(since)) return null;
  const marker = query.dispatchId
    ? new RegExp(
        `(?<![a-zA-Z0-9_-])${query.dispatchId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zA-Z0-9_-])`,
      )
    : undefined;
  let promptMatch: UsageRef | null = null;
  let messageMatch: UsageRef | null = null;
  for (const file of candidates) {
    try {
      if ((await stat(file)).mtimeMs < since) continue;
      let sessionId =
        query.agent === 'claude-code' ? basename(file, '.jsonl') : undefined;
      let preambleMatch = false,
        laterMatch = false,
        transcriptMatch = false,
        prompts = 0;
      const contents = await readFile(file, 'utf8');
      for (const line of contents.split('\n')) {
        if (!line.trim()) continue;
        let row;
        try {
          row = object(JSON.parse(line));
        } catch {
          continue;
        }
        if (!row) continue;
        if (query.agent === 'codex' && row.type === 'session_meta') {
          const candidate = object(row.payload)?.id;
          if (
            typeof candidate === 'string' &&
            /^[a-zA-Z0-9_-]+$/.test(candidate)
          )
            sessionId = candidate;
        }
        // The dispatch must be in the worker's own prompt (the Orca preamble or a
        // follow-up), never in tool output or replies: a coordinator mentions it there.
        const texts = promptTexts(row, query.agent);
        if (texts) {
          if (marker && texts.some((text) => marker.test(text))) {
            if (prompts === 0) preambleMatch = true;
            else laterMatch = true;
          }
          prompts++;
        }
        if (
          query.transcriptMessageIds?.some(
            (messageId) =>
              row.uuid === messageId ||
              row.id === messageId ||
              object(row.message)?.id === messageId,
          )
        )
          transcriptMatch = true;
      }
      if (!sessionId) continue;
      if (preambleMatch) return ref(file, sessionId);
      if (laterMatch && !promptMatch) promptMatch = ref(file, sessionId);
      if (transcriptMatch && !messageMatch) messageMatch = ref(file, sessionId);
    } catch {
      /* A disappearing or unreadable candidate is not a match. */
    }
  }
  return promptMatch ?? messageMatch;
}

/** Text the provider recorded as user input; null for every other record. */
function promptTexts(
  row: Record<string, unknown>,
  agent: UsageLocateRef['agent'],
): string[] | null {
  if (agent === 'claude-code') {
    // Subagent (sidechain) and injected meta records are not the session's prompt.
    if (row.type !== 'user' || row.isSidechain === true || row.isMeta === true)
      return null;
    const message = object(row.message);
    if (!message || (message.role !== undefined && message.role !== 'user'))
      return null;
    if (typeof message.content === 'string') return [message.content];
    if (!Array.isArray(message.content)) return null;
    const texts = message.content.flatMap((block) => {
      const entry = object(block);
      return entry?.type === 'text' && typeof entry.text === 'string'
        ? [entry.text]
        : [];
    });
    return texts.length ? texts : null;
  }
  const payload = object(row.payload);
  if (
    row.type === 'event_msg' &&
    payload?.type === 'user_message' &&
    typeof payload.message === 'string'
  )
    return [payload.message];
  if (
    row.type !== 'response_item' ||
    payload?.type !== 'message' ||
    payload.role !== 'user' ||
    !Array.isArray(payload.content)
  )
    return null;
  const texts = payload.content.flatMap((block) => {
    const entry = object(block);
    return entry?.type === 'input_text' && typeof entry.text === 'string'
      ? [entry.text]
      : [];
  });
  return texts.length ? texts : null;
}
