import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { CONTROL_TOKEN_PREFIX } from '@ai-office/contracts/agent-submission';

const hash = (value: string) => createHash('sha256').update(value).digest();
// A separate closure scope cannot retain the generation function's plaintext.
const verifier = (digest: Buffer) => (candidate: string) =>
  timingSafeEqual(digest, hash(candidate));
/** Called only by the instance lock holder; no plaintext survives this call. */
export function rotateControlToken(
  dataDir: string,
): (candidate: string) => boolean {
  const directory = `${dataDir}/data`;
  chmodSync(directory, 0o700);
  const token = CONTROL_TOKEN_PREFIX + randomBytes(32).toString('hex');
  const digest = hash(token);
  const temporary = `${directory}/.control-${randomBytes(16).toString('hex')}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, token);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, `${directory}/control.token`);
  } finally {
    rmSync(temporary, { force: true });
  }
  return verifier(digest);
}
