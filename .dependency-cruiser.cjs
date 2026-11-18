/* SPEC §23: paths are resolved to source by tsconfig.depcruise.json.
 * All boundary rules include side-effect and type-only imports. Tests may reach
 * subjects/fakes, but npm placement and production-to-test rules still apply.
 */
const test = '(^|/)(test-support|__tests__)/|\\.(test|spec)\\.[cm]?[jt]sx?$';
// Package build tooling (e.g. contracts generation) runs in Node and never ships.
const tooling = '^packages/[^/]+/scripts/';
const server = 'apps/server/src/';
const contracts =
  'packages/contracts/(src|dist)/(api|events|stream|template|agent-submission)/';
const coreContracts = 'packages/contracts/(src|dist)/(events|template)/';
/** @param {string} name @param {import("dependency-cruiser").IRegularForbiddenRuleType["from"]} from @param {import("dependency-cruiser").IRegularForbiddenRuleType["to"]} to @returns {import("dependency-cruiser").IRegularForbiddenRuleType} */
const rule = (name, from, to) => ({ name, severity: 'error', from, to });
/** @param {string} name @param {string} from @param {string[]} allowed */
const boundary = (name, from, allowed) =>
  rule(name, { path: from, pathNot: [test, tooling] }, { pathNot: allowed });
/** @param {string} name */
const packagePath = (name) => `(^|/)(node_modules/)?${name}(/|$)`;
/** @param {string} name @param {string} target @param {string} allowed */
const placement = (name, target, allowed) =>
  rule(name, { path: '^(apps|packages)/', pathNot: allowed }, { path: target });
// IO is adapter-specific; unknown adapters receive only the shared boundary.
const adapterDependencies = {
  'runtime-fake': [],
  'scm-fake': [],
  'usage-fake': [],
  'template-fs': [
    packagePath('yaml'),
    '^(node:)?(fs(/promises)?|path)$',
    '^packages/templates/',
  ],
  'store-sqlite': [
    packagePath('better-sqlite3'),
    '^(node:)?(fs(/promises)?|path|crypto)$',
  ],
  redactor: ['^packages/redaction/'],
  'logger-pino': [packagePath('pino'), '^(node:)?(fs(/promises)?|path)$'],
  system: ['^(node:)?(crypto|fs(/promises)?|path|timers(/promises)?)$'],
  'runtime-orca': [
    packagePath('execa'),
    packagePath('zod'),
    '^(node:)?(child_process|fs(/promises)?|path|crypto|os)$',
  ],
  'scm-github': [
    packagePath('octokit'),
    '(^|/)node_modules/@octokit/',
    packagePath('zod'),
    '^(node:)?crypto$',
  ],
  'usage-sessionlog': [
    packagePath('zod'),
    '^(node:)?(fs(/promises)?|path|os)$',
  ],
};
const adapterCommon = [
  `^${server}ports/`,
  '^packages/domain/',
  `^${contracts}`,
];
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
    boundary('redaction-allowed-dependencies', '^packages/redaction/', [
      '^packages/redaction/',
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
    boundary(
      'adapters-allowed-dependencies',
      `^${server}adapters/(?!(?:${Object.keys(adapterDependencies).join('|')})/)([^/]+)/`,
      [`^${server}adapters/$1/`, ...adapterCommon],
    ),
    ...Object.entries(adapterDependencies).map(([adapter, dependencies]) =>
      boundary(
        `adapter-${adapter}-allowed-dependencies`,
        `^${server}adapters/${adapter}/`,
        [`^${server}adapters/${adapter}/`, ...adapterCommon, ...dependencies],
      ),
    ),
    rule(
      'no-adapter-to-adapter',
      { path: `^${server}adapters/([^/]+)/`, pathNot: test },
      { path: `^${server}adapters/`, pathNot: `^${server}adapters/$1/` },
    ),
    boundary('api-allowed-dependencies', `^${server}api/`, [
      `^${server}(api|application)/`,
      `^${contracts}`,
      packagePath('fastify'),
      packagePath('fastify-type-provider-zod'),
      '(^|/)node_modules/@fastify/',
    ]),
    boundary('agent-gateway-allowed-dependencies', `^${server}agent-gateway/`, [
      `^${server}(agent-gateway|application)/`,
      '^packages/contracts/(src|dist)/agent-submission/',
      packagePath('fastify'),
      packagePath('fastify-type-provider-zod'),
      '(^|/)node_modules/@fastify/',
    ]),
    boundary('config-allowed-dependencies', `^${server}config/`, [
      `^${server}config/`,
      `^${contracts}`,
      '^(node:)?(fs(/promises)?|child_process)$',
      packagePath('zod'),
      packagePath('smol-toml'),
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
      packagePath('zustand'),
    ]),
    rule(
      'no-web-to-server',
      { path: '^apps/web/' },
      { path: '^(apps/server|packages/(domain|engine))/' },
    ),
    rule(
      'no-node-in-packages-or-web',
      { path: '^(packages/|apps/web/)', pathNot: [test, tooling] },
      { dependencyTypes: ['core'] },
    ),
    placement(
      'fastify-only-in-inbound',
      '(^|/)(node_modules/)?(fastify|fastify-type-provider-zod|@fastify/[^/]+)(/|$)',
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
      `^${server}(adapters/runtime-orca/|config/)|^apps/cli/src/(commands/)?start(\\.[cm]?ts$|/)|^apps/e2e/test-support/`,
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
    // M4 frontend layers: keep data and rendering independent of transport.
    boundary(
      'scene-allowed-dependencies',
      '^apps/web/src/features/office/scene/',
      [
        '^apps/web/src/features/office/(scene|model)/',
        packagePath('react'),
        packagePath('react-dom'),
      ],
    ),
    rule(
      'scene-model-type-only',
      { path: '^apps/web/src/features/office/scene/', pathNot: test },
      {
        path: '^apps/web/src/features/office/model/',
        dependencyTypesNot: ['type-only'],
      },
    ),
    rule(
      'scene-no-runtime-sprites',
      {
        path: '^apps/web/src/features/office/scene/',
        pathNot: [test, '/scene/sprites/'],
      },
      {
        path: '^apps/web/src/features/office/scene/sprites/',
        dependencyTypesNot: ['type-only'],
      },
    ),
    boundary(
      'sprites-pure-data',
      '^apps/web/src/features/office/scene/sprites/',
      ['^apps/web/src/features/office/scene/sprites/'],
    ),
    boundary('model-pure', '^apps/web/src/features/([^/]+)/model/', [
      '^apps/web/src/features/$1/model/',
      '^' + contracts,
      '^packages/projection/',
      '^apps/web/src/shared/lib/',
    ]),
    rule(
      'ui-no-cross-feature',
      { path: '^apps/web/src/features/([^/]+)/ui/', pathNot: test },
      {
        path: '^apps/web/src/features/',
        pathNot: '^apps/web/src/features/$1/',
      },
    ),
    boundary(
      'connect-allowed-dependencies',
      '^apps/web/src/features/([^/]+)/connect/',
      [
        '^apps/web/src/(api|realtime|shared)/',
        '^apps/web/src/features/$1/(connect|model|ui|scene)/',
        '^apps/web/src/features/[^/]+/index\\.tsx?$',
        packagePath('react'),
        packagePath('zustand'),
      ],
    ),
    boundary('web-api-allowed-dependencies', '^apps/web/src/api/', [
      '^apps/web/src/api/',
      '^' + contracts,
    ]),
    boundary('realtime-allowed-dependencies', '^apps/web/src/realtime/', [
      '^apps/web/src/(realtime|api|shared/lib)/',
      '^' + contracts,
      '^packages/projection/',
      packagePath('zustand'),
    ]),
    boundary('shared-lib-allowed-dependencies', '^apps/web/src/shared/lib/', [
      '^apps/web/src/shared/lib/',
      '^' + contracts,
    ]),
    rule(
      'shared-contracts-type-only',
      { path: '^apps/web/src/shared/lib/', pathNot: test },
      { path: '^' + contracts, dependencyTypesNot: ['type-only'] },
    ),
    boundary('shared-ui-allowed-dependencies', '^apps/web/src/shared/ui/', [
      '^apps/web/src/shared/',
      packagePath('react'),
    ]),
    rule(
      'no-import-app',
      { pathNot: ['^apps/web/src/(main\\.tsx$|app/)', test] },
      { path: '^apps/web/src/app/' },
    ),
    // E2E remains a test workspace, but this boundary also applies to test files.
    rule(
      'e2e-allowed-dependencies',
      { path: '^apps/e2e/' },
      {
        dependencyTypesNot: ['core'],
        pathNot: [
          '^apps/e2e/',
          packagePath('@playwright/test'),
          packagePath('@axe-core/playwright'),
          '^' + contracts,
          '^node:',
        ],
      },
    ),
    rule(
      'e2e-contracts-type-only',
      { path: '^apps/e2e/' },
      { path: '^' + contracts, dependencyTypesNot: ['type-only'] },
    ),
    rule('no-import-e2e', { pathNot: '^apps/e2e/' }, { path: '^apps/e2e/' }),
    boundary('dev-fake-api-allowed', '^apps/server/src/api/dev-fake/', [
      '^apps/server/src/api/dev-fake/',
      packagePath('fastify'),
    ]),
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
      path: '(^|/)(dist|coverage|\\.git|\\.dev-home)/|^scripts/depcruise-selftest/samples/',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['types', 'import', 'node', 'default'],
    },
  },
};
module.exports = config;
