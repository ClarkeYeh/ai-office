import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { URL, pathToFileURL } from 'node:url';
import { z } from 'zod';
import * as events from '../dist/events/index.js';
import * as template from '../dist/template/index.js';
import * as api from '../dist/api/index.js';
import * as stream from '../dist/stream/index.js';
import * as submission from '../dist/agent-submission/index.js';

const generated = new URL('../generated/', import.meta.url);
const schemas = {};
const jsonSchema = (schema) =>
  z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
for (const module of [events, template, api, stream, submission]) {
  for (const [name, schema] of Object.entries(module)) {
    if (schema instanceof z.ZodType) schemas[name] = jsonSchema(schema);
  }
}
// Cross-field Zod refinements cannot be represented by standard JSON Schema.
schemas.WorkflowTemplateSchema.$comment =
  'Also validate references, unique stage/gate IDs, kind order, and mandatory final-pr using WorkflowTemplateSchema in Zod; JSON Schema validates structure only.';
const paths = {};
for (const endpoint of api.apiEndpoints) {
  const parameters = [];
  for (const [key, location] of [
    ['params', 'path'],
    ['query', 'query'],
    ['headers', 'header'],
  ]) {
    if (!endpoint[key]) continue;
    const schema = jsonSchema(endpoint[key]);
    for (const [name, property] of Object.entries(schema.properties)) {
      parameters.push({
        name,
        in: location,
        required: location === 'path' || (schema.required ?? []).includes(name),
        schema: property,
      });
    }
  }
  const operation = {
    operationId: endpoint.operationId,
    security: endpoint.path.startsWith('/api/')
      ? [{ session: [] }]
      : endpoint.path.startsWith('/agent/')
        ? [{ seatToken: [] }]
        : [],
    parameters,
    responses: {
      [endpoint.status ?? 200]: {
        description: 'Success',
        ...(endpoint.status === 302
          ? {
              headers: {
                Location: { schema: { type: 'string' } },
                'Set-Cookie': { schema: { type: 'string' } },
              },
            }
          : {
              content: {
                [endpoint.contentType ?? 'application/json']: {
                  schema: jsonSchema(endpoint.response),
                },
              },
            }),
      },
      default: {
        description: 'Error',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorResponseSchema' },
          },
        },
      },
    },
  };
  if (endpoint.body)
    operation.requestBody = {
      required: true,
      content: { 'application/json': { schema: jsonSchema(endpoint.body) } },
    };
  (paths[endpoint.path] ??= {})[endpoint.method] = operation;
}
const openapi = {
  openapi: '3.1.0',
  info: { title: 'AI Office API', version: '0.1.0' },
  paths,
  components: {
    securitySchemes: {
      session: { type: 'apiKey', in: 'cookie', name: 'aio_session' },
      seatToken: { type: 'http', scheme: 'bearer' },
    },
    schemas,
  },
};
const files = {
  'openapi.json': openapi,
  ...Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [
      name.replace(/Schema$/, '') + '.schema.json',
      schema,
    ]),
  ),
};
const check = process.argv.includes('--check');
const output = check
  ? await mkdtemp(join(tmpdir(), 'ai-office-contracts-'))
  : generated;
try {
  await mkdir(output, { recursive: true });
  for (const name of Object.keys(files).sort())
    await writeFile(
      new URL(
        name,
        typeof output === 'string' ? pathToFileURL(output + '/') : output,
      ),
      JSON.stringify(files[name], null, 2) + '\n',
    );
  if (check) {
    const committed = (await readdir(generated))
      .filter((name) => name.endsWith('.json'))
      .sort();
    if (JSON.stringify(committed) !== JSON.stringify(Object.keys(files).sort()))
      throw new Error('Generated file list differs; run pnpm contracts:gen');
    for (const name of committed) {
      if (
        (await readFile(new URL(name, generated), 'utf8')) !==
        (await readFile(join(output, name), 'utf8'))
      )
        throw new Error(`${name} differs; run pnpm contracts:gen`);
    }
  }
} finally {
  if (check) await rm(output, { recursive: true, force: true });
}
