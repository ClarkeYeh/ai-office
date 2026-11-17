import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { SpecStore } from '../../ports/stores.js';

const hash = (content: string | Buffer) =>
  createHash('sha256').update(content).digest('hex');
export class FsSpecStore implements SpecStore {
  private readonly directory: string;
  constructor(dataDir: string) {
    this.directory = resolve(dataDir, 'specs');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  write(attemptId: string, content: string): { path: string; sha256: string } {
    if (!/^[A-Za-z0-9_-]+$/.test(attemptId))
      throw new TypeError('Invalid attempt ID');
    const path = join(this.directory, `${attemptId}.md`);
    const sha256 = hash(content);
    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!this.verify(path, sha256))
        throw new Error('Spec already exists with different content', {
          cause: error,
        });
      return { path, sha256 };
    }
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, content, 'utf8');
      fsyncSync(fd);
    } catch (error) {
      unlinkSync(path);
      throw error;
    } finally {
      closeSync(fd);
    }
    return { path, sha256 };
  }
  removeUnissued(attemptId: string): void {
    if (!/^[A-Za-z0-9_-]+$/.test(attemptId))
      throw new TypeError('Invalid attempt ID');
    this.remove(join(this.directory, attemptId + '.md'));
  }
  read(path: string, sha256: string): string | null {
    this.checkPath(path);
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const content = readFileSync(fd);
      return hash(content) === sha256 ? content.toString('utf8') : null;
    } catch (error) {
      if (
        ['ENOENT', 'ELOOP'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        return null;
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  private checkPath(path: string): void {
    if (
      dirname(resolve(path)) !== this.directory ||
      !/^[A-Za-z0-9_-]+\.md$/.test(path.slice(path.lastIndexOf('/') + 1))
    )
      throw new TypeError('Invalid spec path');
  }
  verify(path: string, sha256: string): boolean {
    this.checkPath(path);
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      return hash(readFileSync(fd)) === sha256;
    } catch (error) {
      if (
        ['ENOENT', 'ELOOP'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        return false;
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  remove(path: string): void {
    this.checkPath(path);
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
