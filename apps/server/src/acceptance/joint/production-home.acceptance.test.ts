import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';
import { readSettings } from '../../config/settings.js';
import { productionHome } from '../../test-support/joint/backends.js';
import {
  INTEGRATOR_SCOPE_FALLBACK,
  mainlineTemplates,
} from '../../test-support/joint/scenario/index.js';

/*
 * M5-T12 prep, offline: the isolated production home exactly as the joint run
 * builds it (`run.ts` productionMode → `productionHome`), parsed by the
 * server's own settings reader. No backend, Orca or GitHub is touched.
 */
describe('M5-T12 production home (offline)', () => {
  it('parses with the approved orca-home, fixed port, enforcement off, preventSleep default and the reviewer-scope fallback', async () => {
    const home = join(
      await mkdtemp(join(tmpdir(), 'aio-t12-home-')),
      'production',
    );
    const orcaHome = join(process.env.HOME!, '.ai-office', 'orca-home');
    await productionHome({
      home,
      port: 41_237,
      config: {
        orcaBin: '/Applications/Orca.app/Contents/Resources/bin/orca',
        ghBin: '/opt/homebrew/bin/gh',
        orcaHome,
        expectedLogin: 'ClarkeYeh',
      },
      templates: await mainlineTemplates(),
    });
    const settings = readSettings(home);
    expect(settings.server.port).toBe(41_237);
    expect(settings.orca.homeDir).toBe(orcaHome);
    // Coordinator ruling: keep the default so #14 sees the caffeinate child.
    expect(settings.orca.preventSleep).toBe(true);
    expect(settings.budget.enforcement).toBe('off');
    expect(settings.github.expectedLogin).toBe('ClarkeYeh');
    // The built-in template with only the integrator scope extended.
    const yaml = await readFile(
      join(home, 'templates', 'feature-to-pr.yaml'),
      'utf8',
    );
    const doc = parseDocument(yaml).toJS() as {
      id: string;
      roles: Record<string, { scope: string }>;
    };
    expect(doc.id).toBe('feature-to-pr');
    expect(
      doc.roles.integrator!.scope.endsWith(INTEGRATOR_SCOPE_FALLBACK),
    ).toBe(true);
    // Never the owner's home or port.
    expect(home.startsWith(join(process.env.HOME!, '.ai-office') + '/')).toBe(
      false,
    );
    expect(settings.server.port).not.toBe(4319);
  });
});
