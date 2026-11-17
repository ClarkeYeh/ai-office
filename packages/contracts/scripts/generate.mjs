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
/** @typedef {Record<string, unknown>} Json */

// Each exported schema instance is registered once under its shortest export
// name (e.g. RepoSnapshot over RepoRegisteredPayload); the other names for the
// same instance (re-exports, `const B = A`) become `$ref` aliases.
/** @type {Map<z.ZodType, Set<string>>} */
const names = new Map();
for (const module of [events, template, api, stream, submission])
  for (const [name, schema] of Object.entries(module))
    if (schema instanceof z.ZodType)
      (names.get(schema) ?? names.set(schema, new Set()).get(schema))?.add(
        name.replace(/Schema$/, ''),
      );
/** @type {Map<z.ZodType, string>} */
const ids = new Map();
/** @type {Record<string, string>} alias id → canonical id */
const aliases = {};
for (const [schema, set] of names) {
  const [canonical = '', ...others] = [...set].sort(
    (a, b) => a.length - b.length || a.localeCompare(b),
  );
  ids.set(schema, canonical);
  for (const alias of others) aliases[alias] = canonical;
}
if (!ids.has(template.WorkflowTemplateSchema))
  throw new Error('Missing workflow template schema');

/**
 * Converts every registered schema at once so shared definitions are emitted a
 * single time and referenced through `uri`.
 * @param {Map<z.ZodType, string>} entries
 * @param {(id: string) => string} uri
 * @param {boolean} standalone keep `$schema` (files) or drop it (OpenAPI components)
 * @returns {Record<string, Json>}
 */
const convert = (entries, uri, standalone) => {
  /** @type {z.core.$ZodRegistry<{ id: string }>} */
  const registry = z.registry();
  for (const [schema, id] of entries) registry.add(schema, { id });
  const { schemas } = z.toJSONSchema(registry, {
    target: 'draft-2020-12',
    io: 'input',
    uri,
  });
  /** @type {Record<string, Json>} */
  const out = {};
  for (const [id, schema] of Object.entries(schemas).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (id === '__shared') throw new Error('Unexpected shared definitions');
    const copy = /** @type {Json} */ ({ ...schema });
    delete copy.$id;
    if (!standalone) delete copy.$schema;
    out[id] = copy;
  }
  // Cross-field Zod refinements cannot be represented by standard JSON Schema.
  const templateSchema = out['WorkflowTemplate'];
  if (!templateSchema) throw new Error('Missing workflow template schema');
  templateSchema.$comment =
    'Also validate references, unique stage/gate IDs, kind order, and mandatory final-pr using WorkflowTemplateSchema in Zod; JSON Schema validates structure only.';
  for (const [alias, target] of Object.entries(aliases))
    out[alias] = {
      ...(standalone
        ? { $schema: 'https://json-schema.org/draft/2020-12/schema' }
        : {}),
      $ref: uri(target),
    };
  return out;
};

// Per-file schemas reference each other with relative URIs.
const fileSchemas = convert(ids, (id) => `./${id}.schema.json`, true);

// OpenAPI: endpoint-local schemas are converted alongside the named ones and then
// inlined into `paths`, so they can still `$ref` shared components.
const componentRef = (/** @type {string} */ id) => `#/components/schemas/${id}`;
/** @type {Map<z.ZodType, string>} */
const openapiIds = new Map(ids);
/** @type {readonly api.EndpointContract[]} */
const endpoints = api.apiEndpoints;
for (const endpoint of endpoints)
  for (const [role, schema] of [
    ['Body', endpoint.body],
    ['Response', endpoint.response],
  ])
    if (schema instanceof z.ZodType && !openapiIds.has(schema))
      openapiIds.set(schema, `__${endpoint.operationId}${role}`);
const converted = convert(openapiIds, componentRef, false);
/** @type {Record<string, Json>} */
const components = {};
for (const [id, schema] of Object.entries(converted))
  if (!id.startsWith('__')) components[id] = schema;
/** @param {z.ZodType} schema */
const schemaRef = (schema) => {
  const id = openapiIds.get(schema);
  if (id === undefined) throw new Error('Unregistered endpoint schema');
  return id.startsWith('__') ? converted[id] : { $ref: componentRef(id) };
};
/** Parameters are flattened into properties, so they stay standalone. @param {z.ZodType} schema */
const inlineSchema = (schema) =>
  z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });

/** @typedef {{ required: boolean, content: Record<string, { schema: unknown }> }} RequestBody */
/** @type {Record<string, Record<string, unknown>>} */
const paths = {};
for (const endpoint of endpoints) {
  const parameters = [];
  /** @type {['params' | 'query' | 'headers', string][]} */
  const locations = [
    ['params', 'path'],
    ['query', 'query'],
    ['headers', 'header'],
  ];
  for (const [key, location] of locations) {
    const endpointSchema = endpoint[key];
    if (!endpointSchema) continue;
    const schema = inlineSchema(endpointSchema);
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      parameters.push({
        name,
        in: location,
        required: location === 'path' || (schema.required ?? []).includes(name),
        schema: property,
      });
    }
  }
  const operation = {
    .../** @type {{ requestBody?: RequestBody }} */ ({}),
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
                  schema: schemaRef(endpoint.response),
                },
              },
            }),
      },
      default: {
        description: 'Error',
        content: {
          'application/json': {
            schema: { $ref: componentRef('ErrorResponse') },
          },
        },
      },
    },
  };
  if (endpoint.body)
    operation.requestBody = {
      required: true,
      content: { 'application/json': { schema: schemaRef(endpoint.body) } },
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
    schemas: components,
  },
};
/** @type {Record<string, unknown>} */
const files = {
  'openapi.json': openapi,
  ...Object.fromEntries(
    Object.entries(fileSchemas).map(([id, schema]) => [
      id + '.schema.json',
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
        (await readFile(
          new URL(
            name,
            typeof output === 'string' ? pathToFileURL(output + '/') : output,
          ),
          'utf8',
        ))
      )
        throw new Error(`${name} differs; run pnpm contracts:gen`);
    }
  }
} finally {
  if (check) await rm(output, { recursive: true, force: true });
}
