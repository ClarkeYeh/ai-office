import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentSubmissionSchema,
  CLI_EXIT_CODES,
  RuntimeInfoSchema,
  SUBMISSION_HEADER_NAMES,
  SubmissionHeadersSchema,
  exitCodeForHttpStatus,
} from '@ai-office/contracts/agent-submission';

export interface CliResult {
  exitCode: number;
  message: string;
}

export interface SubmitOptions {
  env?: NodeJS.ProcessEnv;
  readStdin?: () => Promise<string>;
}

const error = (exitCode: number, message: string): CliResult => ({
  exitCode,
  message: JSON.stringify(
    exitCode === CLI_EXIT_CODES.SCHEMA_ERROR
      ? { issues: [{ path: [], code: 'custom', message }] }
      : { error: message },
  ),
});

interface Issue {
  path: PropertyKey[];
  code: string;
  message: string;
}

function schemaError(issues: readonly Issue[], token: string): CliResult {
  return {
    exitCode: CLI_EXIT_CODES.SCHEMA_ERROR,
    message: safeJson(
      {
        issues: issues.map(({ path, code, message }) => ({
          path,
          code,
          message,
        })),
      },
      token,
    ),
  };
}

/** Redact even when a backend response or a record key echoes the credential. */
function safeJson(value: unknown, token: string): string {
  return JSON.stringify(value)
    .split(JSON.stringify(token).slice(1, -1))
    .join('[REDACTED]');
}

function responseIssues(body: unknown): Issue[] | undefined {
  if (!body || typeof body !== 'object') return;
  if ('issues' in body && Array.isArray(body.issues)) {
    const issues = body.issues;
    if (
      issues.length > 0 &&
      issues.every(
        (issue): issue is Issue =>
          issue !== null &&
          typeof issue === 'object' &&
          Array.isArray(issue.path) &&
          issue.path.every(
            (part: unknown) =>
              typeof part === 'string' || typeof part === 'number',
          ) &&
          typeof issue.code === 'string' &&
          typeof issue.message === 'string',
      )
    )
      return issues;
  }
  // API ErrorResponse places validation details inside error.details.
  if (
    'error' in body &&
    body.error &&
    typeof body.error === 'object' &&
    'details' in body.error
  ) {
    return responseIssues(body.error.details);
  }
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}

/** Input is the kind's payload; the positional kind supplies the envelope. */
export async function submit(
  args: readonly string[],
  options: SubmitOptions = {},
): Promise<CliResult> {
  const env = options.env ?? process.env;
  const kind = args[0];
  let token: string | undefined;
  let file: string | undefined;
  let stdin = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--seat-token' && token === undefined && args[i + 1]) {
      token = args[++i];
    } else if (arg === '--file' && file === undefined && args[i + 1]) {
      file = args[++i];
    } else if (arg === '-' && !stdin) {
      stdin = true;
    } else {
      return error(CLI_EXIT_CODES.SCHEMA_ERROR, 'Invalid submit arguments.');
    }
  }
  if (!token || (file !== undefined) === stdin) {
    return error(
      CLI_EXIT_CODES.SCHEMA_ERROR,
      'Usage: ai-office submit <kind> --seat-token <token> (--file <path> | -)',
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(
      stdin
        ? await (options.readStdin ?? readStdin)()
        : readFileSync(file!, 'utf8'),
    );
  } catch {
    return error(CLI_EXIT_CODES.SCHEMA_ERROR, 'Cannot read input as JSON.');
  }
  const submission = AgentSubmissionSchema.safeParse({ kind, payload });
  if (!submission.success) {
    return schemaError(submission.error.issues, token);
  }

  const names = SUBMISSION_HEADER_NAMES;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [names.authorization]: `Bearer ${token}`,
  };
  const identity = [
    [names.terminalHandle, env.ORCA_TERMINAL_HANDLE],
    [names.paneKey, env.ORCA_PANE_KEY],
    [names.agentSession, env.CLAUDE_CODE_SESSION_ID || env.CODEX_THREAD_ID],
  ] as const;
  for (const [name, value] of identity) if (value) headers[name] = value;
  if (!SubmissionHeadersSchema.safeParse(headers).success) {
    return error(
      CLI_EXIT_CODES.IDENTITY_OR_STATE_ERROR,
      'Invalid submission identity.',
    );
  }

  const timeout = Number(env.AI_OFFICE_SUBMIT_TIMEOUT_MS ?? 130_000);
  if (
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > 2_147_483_647
  ) {
    return error(
      CLI_EXIT_CODES.SCHEMA_ERROR,
      'Invalid AI_OFFICE_SUBMIT_TIMEOUT_MS.',
    );
  }
  try {
    const home =
      env.AI_OFFICE_HOME ||
      (env.HOME ? join(env.HOME, '.ai-office') : undefined);
    if (!home)
      return error(
        CLI_EXIT_CODES.BACKEND_UNREACHABLE,
        'Cannot locate runtime.json.',
      );
    const runtime = RuntimeInfoSchema.parse(
      JSON.parse(readFileSync(join(home, 'runtime.json'), 'utf8')),
    );
    const response = await fetch(
      `http://127.0.0.1:${runtime.port}/agent/v1/submissions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(submission.data),
        signal: AbortSignal.timeout(timeout),
        redirect: 'error',
      },
    );
    const body: unknown = await response.json();
    const exitCode = exitCodeForHttpStatus(response.status);
    if (exitCode === CLI_EXIT_CODES.SCHEMA_ERROR) {
      return schemaError(
        responseIssues(body) ?? [
          {
            path: [],
            code: 'custom',
            message: 'Backend rejected submission validation.',
          },
        ],
        token,
      );
    }
    return {
      exitCode,
      message: safeJson(body, token),
    };
  } catch {
    // Never echo input, tokens, filesystem paths, or transport exception details.
    return error(
      CLI_EXIT_CODES.BACKEND_UNREACHABLE,
      'Backend unavailable or invalid response.',
    );
  }
}
