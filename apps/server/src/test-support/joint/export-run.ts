/**
 * M5-T7 export step (M5_PLAN §2.1 B4): after the flow, before the home is
 * removed. The raw log goes only to a private local directory (0700 dir,
 * 0600 file) that must lie outside the repository; the masked version comes
 * from T0's `exportJointEvents` and is the only one that may be committed
 * (T12 writes it to `fixtures/m5/joint.events.json` and
 * `fixtures/web/m5-joint.events.json` after the integrator's spot check).
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { exportJointEvents, type JointExportOptions } from './export/index.js';

/** The repository root; raw exports may never land under it. */
export const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

export const MASKED_TARGETS = [
  'fixtures/m5/joint.events.json',
  'fixtures/web/m5-joint.events.json',
] as const;

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export interface ExportResult {
  rawPath: string;
  maskedPaths: string[];
  events: number;
}

/**
 * Writes the raw export privately and the masked export to `maskedDir`
 * (default: also private; T12 points it at the repo only after review).
 */
export async function writeJointExports(
  events: readonly Record<string, unknown>[],
  options: JointExportOptions & {
    privateDir: string;
    name: string;
    maskedDir?: string;
    repoRoot?: string;
  },
): Promise<ExportResult> {
  const root = options.repoRoot ?? REPO_ROOT;
  if (!isAbsolute(options.privateDir))
    throw new Error('privateDir must be absolute');
  if (inside(root, resolve(options.privateDir)))
    throw new Error('Raw exports never go inside the repository');
  if (!/^[a-z0-9-]{1,64}$/.test(options.name))
    throw new Error('Invalid export name');
  // Mask first: invalid metadata fails before anything is written.
  const masked = exportJointEvents(events, options);
  await mkdir(options.privateDir, { recursive: true, mode: 0o700 });
  await chmod(options.privateDir, 0o700);
  const rawPath = join(options.privateDir, `${options.name}.raw.events.json`);
  await writeFile(rawPath, JSON.stringify({ events }, null, 2), {
    mode: 0o600,
  });
  await chmod(rawPath, 0o600);
  const maskedPaths: string[] = [];
  const text = JSON.stringify(masked, null, 2) + '\n';
  if (options.maskedDir === undefined) {
    const path = join(options.privateDir, `${options.name}.masked.events.json`);
    await writeFile(path, text, { mode: 0o600 });
    maskedPaths.push(path);
  } else {
    for (const target of MASKED_TARGETS) {
      const path = join(options.maskedDir, target);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, text);
      maskedPaths.push(path);
    }
  }
  return { rawPath, maskedPaths, events: events.length };
}
