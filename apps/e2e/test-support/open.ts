import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './office.js';

/** Invoke the installed entry point without retaining its URL in diagnostic logs. */
export function openOffice(home: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [join(ROOT, 'apps/cli/dist/main.js'), 'open', '--home', home, '--print'],
      {
        cwd: ROOT,
        env: { ...process.env, AI_OFFICE_HOME: home },
        timeout: 10_000,
      },
      (error, stdout) => {
        if (
          error ||
          !/^http:\/\/127\.0\.0\.1:\d+\/auth\/bootstrap\?code=\S+$/.test(
            stdout.trim(),
          )
        )
          reject(new Error('ai-office open did not return a login URL'));
        else resolve(stdout.trim());
      },
    );
  });
}
