import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from '@playwright/test';

export const ROOT = resolve(import.meta.dirname, '../../..');
const CLI = join(ROOT, 'apps/cli/dist/main.js');
const RESERVED_PORT = 4319;
const BOOTSTRAP =
  /^Open (http:\/\/127\.0\.0\.1:(\d+)\/auth\/bootstrap\?code=\S+)$/;

export type Scenario =
  'mainline' | 'demo' | 'parallel' | 'trouble' | 'load-10' | 'stall';

export interface OfficeOptions {
  scenario: Scenario;
  startupTimeoutMs?: number;
}

export interface ApiResponse<T> {
  status: number;
  body: T;
}

export interface StopResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when the backend removed runtime.json (graceful shutdown). */
  runtimeRemoved: boolean;
}

/** Never echo bootstrap codes or session tokens into reports. */
const redact = (text: string) =>
  text.replace(/code=\S+/g, 'code=<redacted>').replace(/aio_session=\S+/g, '');

/** Fresh AI_OFFICE_HOME with the scenario's template fixture (as dev:office does). */
async function prepareHome(scenario: Scenario): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), `aio-e2e-${scenario}-`));
  const template = join(ROOT, 'fixtures/web/templates', `${scenario}.yaml`);
  if (existsSync(template)) {
    await mkdir(join(home, 'templates'), { recursive: true });
    await copyFile(template, join(home, 'templates', `${scenario}.yaml`));
  }
  if (scenario === 'load-10')
    await writeFile(join(home, 'config.toml'), '[limits]\nglobalAgents = 12\n');
  return home;
}

/** True while any process of the group still exists. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The built `ai-office start --dev --fake <scenario>` in its own process group,
 * isolated home and an OS-selected port. Driven only through HTTP and /dev/fake/*.
 */
export class Office {
  readonly scenario: Scenario;
  readonly home: string;
  readonly url: string;
  readonly port: number;
  private readonly child: ChildProcess;
  private readonly output: string[];
  private bootstrap: string | undefined;
  private token: string | undefined;
  private stopped: Promise<StopResult> | undefined;
  private key = 0;

  private constructor(
    scenario: Scenario,
    home: string,
    child: ChildProcess,
    bootstrapUrl: string,
    output: string[],
  ) {
    this.scenario = scenario;
    this.home = home;
    this.child = child;
    this.output = output;
    this.bootstrap = bootstrapUrl;
    const url = new URL(bootstrapUrl);
    this.url = url.origin;
    this.port = Number(url.port);
  }

  static async start(options: OfficeOptions): Promise<Office> {
    const home = await prepareHome(options.scenario);
    try {
      for (;;) {
        const office = await Office.spawn(home, options);
        if (office.port !== RESERVED_PORT) return office;
        await office.stop({ keepHome: true });
      }
    } catch (error) {
      await rm(home, { recursive: true, force: true });
      throw error;
    }
  }

  private static async spawn(
    home: string,
    options: OfficeOptions,
  ): Promise<Office> {
    if (!existsSync(CLI))
      throw new Error(`Missing ${CLI}; run pnpm -r build first.`);
    const child = spawn(
      process.execPath,
      [
        CLI,
        'start',
        '--dev',
        '--fake',
        options.scenario,
        '--no-open',
        '--port',
        '0',
      ],
      {
        cwd: ROOT,
        env: { ...process.env, AI_OFFICE_HOME: home },
        // Own process group: teardown signals the CLI and backend together.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const output: string[] = [];
    let buffered = '';
    const bootstrapUrl = new Promise<string>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error('ai-office start did not print a bootstrap URL')),
        options.startupTimeoutMs ?? 60_000,
      );
      child.once('error', fail);
      child.once('exit', (code, signal) =>
        fail(new Error(`ai-office start exited early (${code ?? signal})`)),
      );
      child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split('\n');
        buffered = lines.pop()!;
        for (const line of lines) {
          const match = BOOTSTRAP.exec(line);
          output.push(redact(line));
          if (match) {
            clearTimeout(timer);
            done(match[1]!);
          }
        }
      });
      child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
        output.push(redact(chunk));
      });
    });
    try {
      return new Office(
        options.scenario,
        home,
        child,
        await bootstrapUrl,
        output,
      );
    } catch (error) {
      if (child.pid !== undefined && groupAlive(child.pid))
        process.kill(-child.pid, 'SIGKILL');
      throw new Error(
        `${(error as Error).message}\n${output.slice(-40).join('\n')}`,
        { cause: error },
      );
    }
  }

  /** Redacted process output, for failure messages. */
  get log(): string {
    return this.output.join('\n');
  }

  get pid(): number {
    return this.child.pid!;
  }

  /** The unused one-time bootstrap URL; the browser login suite consumes it. */
  takeBootstrapUrl(): string {
    const url = this.bootstrap;
    if (url === undefined) throw new Error('Bootstrap URL already used');
    this.bootstrap = undefined;
    return url;
  }

  /** Session token for API calls: exchanges the printed code once, if unused. */
  async session(): Promise<string> {
    if (this.token !== undefined) return this.token;
    const response = await fetch(this.takeBootstrapUrl(), {
      redirect: 'manual',
    });
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    const token = cookie?.startsWith('aio_session=')
      ? cookie.slice('aio_session='.length)
      : undefined;
    if (response.status !== 302 || !token)
      throw new Error(`Bootstrap exchange failed: ${response.status}`);
    this.token = token;
    return token;
  }

  /** Reuse a session the browser obtained through the bootstrap URL. */
  adoptSession(token: string): void {
    this.token = token;
  }

  /** Logs the page's context in with this office's session and opens `path`. */
  async login(page: Page, path = '/'): Promise<void> {
    await page.context().addCookies([
      {
        name: 'aio_session',
        value: await this.session(),
        url: this.url,
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);
    await page.goto(this.url + path);
  }

  /** Authenticated same-origin REST call (cookie, Origin, Idempotency-Key). */
  async api<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      cookie: `aio_session=${await this.session()}`,
      origin: this.url,
    };
    if (method === 'POST') {
      headers['content-type'] = 'application/json';
      headers['idempotency-key'] = `e2e-${randomUUID()}-${++this.key}`;
    }
    const response = await fetch(this.url + path, {
      method,
      headers,
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : null) as T,
    };
  }

  private async control(path: string, body: unknown): Promise<unknown> {
    const response = await this.api('POST', `/dev/fake/${path}`, body);
    if (response.status !== 200)
      throw new Error(
        `/dev/fake/${path} failed: ${response.status} ${JSON.stringify(response.body)}`,
      );
    return response.body;
  }

  /** Fake-world controls (§6.2); final PRs only ever merge through mergeFinalPr. */
  readonly fake = {
    mergeFinalPr: (number: number) =>
      this.control('scm/merge-final-pr', { number }) as Promise<{
        mergeCommitSha: string;
      }>,
    editIssueBody: (number: number, body: string) =>
      this.control('scm/edit-issue-body', { number, body }),
    prStatus: (
      number: number,
      status: {
        mergeable?: boolean | null;
        checks?: 'none' | 'pending' | 'success' | 'failure';
      },
    ) => this.control('scm/pr-status', { number, ...status }),
    setConnected: (connected: boolean) =>
      this.control('runtime/connected', { connected }),
    /** Another coordinator takes over every open run (M2 runtime-fake stimulus). */
    hijack: () =>
      this.control('runtime/hijack', {}) as Promise<{ hijacked: number }>,
  };

  /**
   * SIGTERM, then SIGKILL to the whole process group after a grace period;
   * verifies nothing of the group survived and removes the home.
   */
  async stop(options: { keepHome?: boolean } = {}): Promise<StopResult> {
    const result = await (this.stopped ??= this.terminate());
    if (!options.keepHome)
      await rm(this.home, { recursive: true, force: true });
    return result;
  }

  private async terminate(): Promise<StopResult> {
    const exited =
      this.child.exitCode !== null || this.child.signalCode !== null
        ? Promise.resolve()
        : once(this.child, 'exit').then(() => undefined);
    // SIGTERM goes to the CLI only; it forwards one SIGTERM to the backend.
    // The backend handles SIGTERM once, so a group-wide SIGTERM (CLI
    // forward + direct) would kill it before it removes runtime.json.
    if (this.child.exitCode === null && this.child.signalCode === null)
      this.child.kill('SIGTERM');
    const graceful = await Promise.race([
      exited.then(() => true),
      delay(10_000).then(() => false),
    ]);
    if (!graceful || groupAlive(this.pid)) {
      // The CLI exits after the backend; give stragglers a moment first.
      await delay(500);
      if (groupAlive(this.pid)) process.kill(-this.pid, 'SIGKILL');
      await exited;
    }
    for (let tries = 0; groupAlive(this.pid); tries++) {
      if (tries > 50)
        throw new Error(`Process group ${this.pid} survived teardown`);
      await delay(100);
    }
    return {
      code: this.child.exitCode,
      signal: this.child.signalCode,
      runtimeRemoved: !existsSync(join(this.home, 'runtime.json')),
    };
  }
}
