import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pino } from 'pino';
import type { Clock, Logger, Redactor } from '../../ports/services.js';

export interface PinoLoggerOptions {
  dataDir: string;
  redactor: Pick<Redactor, 'maskSecrets'>;
  clock?: Clock;
}

// Logging is metadata-only, even when a caller accidentally supplies raw content.
function omitContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitContent);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        /^(transcript|body|content|text|input|output|stdout|stderr|agentText|toolInput|toolOutput)$/i.test(
          key,
        )
          ? '<omitted>'
          : omitContent(child),
      ]),
    );
  return value;
}

/** UTC daily files; keeps today and the preceding 13 calendar days.
 * Rotation happens on writes; synchronous appends leave no open file to flush on shutdown.
 */
export function createPinoLogger({
  dataDir,
  redactor,
  clock = { now: () => new Date() },
}: PinoLoggerOptions): Logger {
  const directory = join(dataDir, 'logs');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let currentDay = '';
  return pino(
    {
      base: {
        workflowId: null,
        commandId: null,
        attemptId: null,
        seatId: null,
        correlationId: null,
      },
      timestamp: () => `,"time":${clock.now().getTime()}`,
      hooks: {
        // Run after Pino serialization so Error objects, child bindings and messages
        // all pass through the same redactor before any bytes reach disk.
        streamWrite(line) {
          return (
            JSON.stringify(
              redactor.maskSecrets(omitContent(JSON.parse(line))),
            ) + '\n'
          );
        },
      },
    },
    {
      write(line: string) {
        const now = clock.now();
        const day = now.toISOString().slice(0, 10).replaceAll('-', '');
        if (day !== currentDay) {
          const cutoff = new Date(
            Date.UTC(
              now.getUTCFullYear(),
              now.getUTCMonth(),
              now.getUTCDate(),
            ) -
              13 * 86400000,
          )
            .toISOString()
            .slice(0, 10)
            .replaceAll('-', '');
          for (const name of readdirSync(directory)) {
            const match = /^server-(\d{8})\.log$/.exec(name);
            if (match && match[1]! < cutoff) unlinkSync(join(directory, name));
          }
          currentDay = day;
        }
        appendFileSync(join(directory, `server-${day}.log`), line, {
          encoding: 'utf8',
          mode: 0o600,
        });
      },
    },
  );
}
