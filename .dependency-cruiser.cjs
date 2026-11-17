/* SPEC §23: paths are resolved to source by tsconfig.depcruise.json.
 * All boundary rules include side-effect and type-only imports. Tests may reach
 * subjects/fakes, but npm placement and production-to-test rules still apply.
 */
const test = '(^|/)(test-support|__tests__)/|\\.(test|spec)\\.[cm]?[jt]sx?$';
const server = 'apps/server/src/';
const contracts =
  'packages/contracts/(src|dist)/(api|events|stream|template|agent-submission)/';
const coreContracts = 'packages/contracts/(src|dist)/(events|template)/';
const npm = '(^|/)node_modules/';
const rule = (name, from, to) => ({ name, severity: 'error', from, to });
const boundary = (name, from, allowed) =>
  rule(name, { path: from, pathNot: test }, { pathNot: allowed });
const packagePath = (name) => `(^|/)(node_modules/)?${name}(/|$)`;
const placement = (name, target, allowed) =>
  rule(name, { path: '^(apps|packages)/', pathNot: allowed }, { path: target });
const config = {
  forbidden: [
    rule('no-circular', {}, { circular: true }),
    rule(
      'no-orphans',
      {
        orphan: true,
        pathNot: [
          test,
          '(^|/)[^/]*config\\.[^/]+$',
          '^\\.dependency-cruiser\\.cjs$',
        ],
      },
      {},
    ),
    rule('not-to-unresolvable', {}, { couldNotResolve: true }),
    rule('no-production-to-tests', { pathNot: test }, { path: test }),
    rule(
      'contracts-subpaths-only',
      { path: '^(apps|packages)/', pathNot: '^packages/contracts/' },
      {
        path: '(^@ai-office/contracts$|^packages/contracts/(src|dist)/index\\.[cm]?[jt]s$)',
      },
    ),
    boundary('contracts-allowed-dependencies', '^packages/contracts/', [
      '^packages/contracts/',
      packagePath('zod'),
    ]),
    boundary('projection-allowed-dependencies', '^packages/projection/', [
      '^packages/projection/',
      `^${contracts}`,
    ]),
    boundary('domain-allowed-dependencies', '^packages/domain/', [
      '^packages/domain/',
      `^${coreContracts}`,
    ]),
    boundary('engine-allowed-dependencies', '^packages/engine/', [
      '^packages/(engine|domain)/',
      `^${coreContracts}`,
    ]),
    boundary('ports-allowed-dependencies', `^${server}ports/`, [
      `^${server}ports/`,
      '^packages/domain/',
      `^${coreContracts}`,
      packagePath('zod'),
    ]),
    boundary('application-allowed-dependencies', `^${server}application/`, [
      `^${server}(application|ports)/`,
      '^packages/(engine|domain|projection)/',
      `^${coreContracts}`,
      '^packages/contracts/(src|dist)/agent-submission/',
      '^(node:)?events$',
    ]),
    boundary('adapters-allowed-dependencies', `^${server}adapters/([^/]+)/`, [
      `^${server}adapters/$1/`,
      `^${server}ports/`,
      '^packages/domain/',
      `^${contracts}`,
      '^packages/templates/',
      npm,
      '^(node:)?[a-z_]+(/promises)?$',
    ]),
    rule(
      'no-adapter-to-adapter',
      { path: `^${server}adapters/([^/]+)/`, pathNot: test },
      { path: `^${server}adapters/`, pathNot: `^${server}adapters/$1/` },
    ),
    boundary('api-allowed-dependencies', `^${server}api/`, [
      `^${server}(api|application)/`,
      `^${contracts}`,
      packagePath('fastify'),
      '(^|/)node_modules/@fastify/',
    ]),
    boundary('agent-gateway-allowed-dependencies', `^${server}agent-gateway/`, [
      `^${server}(agent-gateway|application)/`,
      '^packages/contracts/(src|dist)/agent-submission/',
      packagePath('fastify'),
      '(^|/)node_modules/@fastify/',
    ]),
    boundary('config-allowed-dependencies', `^${server}config/`, [
      `^${server}config/`,
      `^${contracts}`,
      '^(node:)?(fs(/promises)?|child_process)$',
      packagePath('execa'),
    ]),
    boundary('cli-allowed-dependencies', '^apps/cli/', [
      '^apps/cli/',
      '^packages/contracts/(src|dist)/agent-submission/',
      '^(node:)?(fs(/promises)?|path|child_process)$',
      packagePath('execa'),
    ]),
    boundary('web-allowed-dependencies', '^apps/web/src/', [
      '^apps/web/',
      `^${contracts}`,
      '^packages/projection/',
      packagePath('react'),
      packagePath('react-dom'),
    ]),
    rule(
      'no-web-to-server',
      { path: '^apps/web/' },
      { path: '^(apps/server|packages/(domain|engine))/' },
    ),
    rule(
      'no-node-in-packages-or-web',
      { path: '^(packages/|apps/web/)' },
      { dependencyTypes: ['core'] },
    ),
    placement(
      'fastify-only-in-inbound',
      '(^|/)(node_modules/)?(fastify|@fastify/[^/]+)(/|$)',
      `^${server}(api/|agent-gateway/|main\\.ts$)`,
    ),
    placement(
      'octokit-only-in-scm-github',
      '(^|/)(node_modules/)?(octokit|@octokit/[^/]+)(/|$)',
      `^${server}adapters/scm-github/`,
    ),
    placement(
      'sqlite-only-in-store-sqlite',
      packagePath('better-sqlite3'),
      `^${server}adapters/store-sqlite/`,
    ),
    placement(
      'process-only-in-runtime-config-cli-start',
      `^(node:)?child_process$|${packagePath('execa')}`,
      `^${server}(adapters/runtime-orca/|config/)|^apps/cli/src/(commands/)?start(\\.[cm]?ts$|/)`,
    ),
    placement(
      'pino-only-in-logger-or-main',
      packagePath('pino'),
      `^${server}(adapters/logger-pino/|main\\.ts$)`,
    ),
    placement(
      'templates-only-in-template-fs-or-main',
      '^packages/templates/|^@ai-office/templates(/|$)',
      `^${server}(adapters/template-fs/|main\\.ts$)|^packages/templates/`,
    ),
    rule(
      'ui-no-api-or-realtime',
      { path: '^apps/web/src/features/[^/]+/ui/', pathNot: test },
      { path: '^apps/web/src/(api|realtime)/' },
    ),
    boundary(
      'scene-only-own-view-model',
      '^apps/web/src/features/office/scene/',
      ['^apps/web/src/features/office/model/'],
    ),
    rule(
      'scene-only-type-imports',
      { path: '^apps/web/src/features/office/scene/', pathNot: test },
      { dependencyTypesNot: ['type-only'] },
    ),
    rule(
      'cross-feature-through-index',
      { path: '^apps/web/src/features/([^/]+)/', pathNot: test },
      {
        path: '^apps/web/src/features/[^/]+/',
        pathNot: [
          '^apps/web/src/features/$1/',
          '^apps/web/src/features/[^/]+/index\\.tsx?$',
        ],
      },
    ),
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    tsPreCompilationDeps: 'specify',
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: '(^|/)(dist|coverage|\\.git)/|^scripts/depcruise-selftest/samples/',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['types', 'import', 'node', 'default'],
    },
  },
};
module.exports = config;
