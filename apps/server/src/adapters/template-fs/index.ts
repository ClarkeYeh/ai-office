import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseDocument } from 'yaml';
import { builtinTemplateUrls } from '@ai-office/templates';
import { WorkflowTemplateSchema } from '@ai-office/contracts/template';
import type { WorkflowTemplate } from '@ai-office/contracts/template';
import type {
  TemplateInvalid,
  TemplateRepository,
} from '../../ports/template.js';

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === code;

/** Initialize built-ins once at startup; every repository operation reads fresh files. */
export async function createTemplateFsRepository(
  dataDir: string,
): Promise<TemplateRepository> {
  const directory = join(dataDir, 'templates');
  await mkdir(directory, { recursive: true });
  for (const source of builtinTemplateUrls) {
    const file = decodeURIComponent(basename(source.pathname));
    try {
      await copyFile(source, join(directory, file), constants.COPYFILE_EXCL);
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
  }

  async function load(
    file: string,
  ): Promise<WorkflowTemplate | TemplateInvalid | null> {
    let contents: string;
    try {
      contents = await readFile(join(directory, file), 'utf8');
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return null;
      throw error;
    }
    // Do not include YAML source snippets in diagnostics (they may contain secrets).
    const document = parseDocument(contents, { prettyErrors: false });
    if (document.errors.length > 0) {
      return {
        file,
        issues: document.errors.map((error) => ({
          path: '',
          message: error.message,
        })),
      };
    }
    let value: unknown;
    try {
      value = document.toJS();
    } catch {
      return {
        file,
        issues: [{ path: '', message: 'Unable to resolve YAML aliases' }],
      };
    }
    const parsed = WorkflowTemplateSchema.safeParse(value);
    const issues = parsed.success
      ? []
      : parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        }));
    if (
      typeof value === 'object' &&
      value !== null &&
      'id' in value &&
      value.id !== basename(file, '.yaml')
    ) {
      issues.push({
        path: 'id',
        message: 'Template id must match the filename without .yaml',
      });
    }
    if (!parsed.success || issues.length > 0) return { file, issues };
    return parsed.data;
  }

  return {
    async list() {
      const valid: WorkflowTemplate[] = [];
      const invalid: TemplateInvalid[] = [];
      const entries = await readdir(directory, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
        .map((entry) => entry.name)
        .sort();
      for (const file of files) {
        const result = await load(file);
        if (result === null) continue; // A user may delete a file between listing and reading.
        if ('issues' in result) invalid.push(result);
        else valid.push(result);
      }
      return { valid, invalid };
    },
    async get(id) {
      // An id is a filename stem, never an arbitrary filesystem path.
      if (!id || id.includes('/') || id.includes('\\') || id.includes('\0'))
        return null;
      return load(`${id}.yaml`);
    },
  };
}
