import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { scanDirectory } from './lib/scan.js';
import {
  applyUpdate,
  detectEventType,
  diffRoutes,
  findFunctionsBlock,
  readExistingFunctions,
} from './lib/yaml.js';

export { scanDirectory } from './lib/scan.js';

// Checked in order; the first that exists is scanned. Covers the common
// Serverless layouts so an install needs no configuration.
const SOURCE_CANDIDATES = ['functions', 'src', 'handlers', 'api', 'lambdas'];
const DEFAULT_CONFIG = 'serverless.yml';

/**
 * Pick the directory to scan. Falls back to the project root so a flat layout
 * (handlers beside serverless.yml) still works; walk() skips node_modules and
 * friends, so a root scan stays cheap.
 */
async function detectSourceDir(cwd) {
  for (const name of SOURCE_CANDIDATES) {
    const full = path.resolve(cwd, name);
    try {
      const st = await stat(full);
      if (st.isDirectory()) return full;
    } catch {
      /* try next */
    }
  }
  return cwd;
}

/**
 * Check whether a serverless `handler` reference (`path/to/file.exportName`)
 * resolves to a file on disk, trying each handler extension.
 */
async function handlerFileExists(cwd, handlerRef) {
  const base = handlerRef.replace(/\.[^.]+$/, '');
  for (const ext of ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']) {
    try {
      await stat(path.resolve(cwd, base + ext));
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

async function resolveConfig(cwd, configPath) {
  // Serverless v4 reports `configurationFilename` as a bare "serverless" with no
  // extension, so only trust a hint that actually names a YAML file.
  if (configPath && /\.ya?ml$/i.test(configPath)) return path.resolve(cwd, configPath);
  for (const candidate of [DEFAULT_CONFIG, 'serverless.yaml']) {
    const full = path.resolve(cwd, candidate);
    try {
      await readFile(full, 'utf8');
      return full;
    } catch {
      /* try next */
    }
  }
  return path.resolve(cwd, DEFAULT_CONFIG);
}

/**
 * Scan handlers and reconcile them with serverless.yml.
 *
 * @param {object} options
 * @param {string} [options.cwd]      project root
 * @param {string} [options.source]   directory to scan for handlers
 * @param {string} [options.config]   path to serverless.yml
 * @param {boolean} [options.write]   persist changes (false = dry run)
 * @param {boolean} [options.strict]  treat annotation problems as fatal
 * @returns {Promise<object>} the result, including the change plan
 */
export async function updateServerlessConfig(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const sourceDir = options.source
    ? path.resolve(cwd, options.source)
    : await detectSourceDir(cwd);

  // A dedicated handler directory does not preclude handlers sitting beside
  // serverless.yml (the `handler.js` a new project starts from), so scan the
  // root's own files too. Non-recursive, so this never re-walks the tree.
  const alsoScanRoot = sourceDir !== cwd;
  const configPath = await resolveConfig(cwd, options.config);
  const write = options.write !== false;

  const { routes, problems } = await scanDirectory(sourceDir, cwd, { alsoScanRoot });

  let content;
  let configExists = true;
  try {
    content = await readFile(configPath, 'utf8');
  } catch {
    configExists = false;
    content = '';
  }

  if (!configExists) {
    return {
      ok: false,
      configPath,
      sourceDir,
      routes,
      problems,
      error: `no serverless config found at ${path.relative(cwd, configPath) || configPath}`,
      plan: { added: [], changed: [], unchanged: [], stale: [] },
      changed: false,
    };
  }

  const lines = content.split('\n');
  const block = findFunctionsBlock(lines);
  const existing = readExistingFunctions(lines, block);

  // An inferred route is a guess, so it must never move an endpoint that is
  // already deployed: where serverless.yml already has the function, keep its
  // method and path. Explicit @route annotations still win, and inference is
  // free to decide anything the config has not seen before.
  const byName = new Map(existing.map((e) => [e.name, e]));
  const reconciled = routes.map((route) => {
    if (!route.inferred) return route;
    const prev = byName.get(route.name);
    if (!prev || prev.method === null || prev.path === null) return route;
    if (prev.method === route.method && prev.path === route.path) return route;
    return { ...route, method: prev.method, path: prev.path, keptFromConfig: true };
  });
  routes.length = 0;
  routes.push(...reconciled);

  const plan = diffRoutes(routes, existing);
  const eventType = options.eventType ?? detectEventType(lines);

  // Flag preserved entries whose handler file is gone: those deploy but fail at
  // runtime, which is worth calling out separately from ordinary hand-written
  // entries the tool simply does not manage.
  for (const entry of plan.stale) {
    entry.handlerMissing = entry.handler ? !(await handlerFileExists(cwd, entry.handler)) : false;
  }

  // A preserved entry can collide with a generated one — commonly a dead
  // function that a working handler has since replaced. API Gateway rejects two
  // routes on the same method and path, so surface it rather than let the
  // deploy fail.
  const claimed = new Map(routes.map((r) => [`${r.method} ${r.path}`, r.name]));
  for (const entry of plan.stale) {
    if (entry.method === null || entry.path === null) continue;
    const key = `${entry.method} ${entry.path}`;
    const owner = claimed.get(key);
    if (owner) {
      problems.push(
        `"${entry.name}" in serverless.yml and "${owner}" both use ${key}`
          + (entry.handlerMissing ? ` — "${entry.name}" has no handler file and is likely dead` : ''),
      );
    }
  }

  const fatal = options.strict && problems.length > 0;
  const hasChanges = plan.added.length > 0 || plan.changed.length > 0;

  let written = false;
  if (hasChanges && write && !fatal) {
    const updated = applyUpdate(content, routes, plan, eventType);
    if (updated !== content) {
      await writeFile(configPath, updated, 'utf8');
      written = true;
    }
  }

  return {
    ok: !fatal,
    configPath,
    sourceDir,
    routes,
    problems,
    plan,
    eventType,
    changed: hasChanges,
    written,
    error: fatal ? 'annotation problems found (strict mode)' : null,
  };
}
