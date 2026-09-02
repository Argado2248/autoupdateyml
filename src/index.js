import { readFile, writeFile } from 'node:fs/promises';
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

const DEFAULT_SOURCE = 'src';
const DEFAULT_CONFIG = 'serverless.yml';

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
  const sourceDir = path.resolve(cwd, options.source ?? DEFAULT_SOURCE);
  const configPath = await resolveConfig(cwd, options.config);
  const write = options.write !== false;

  const { routes, problems } = await scanDirectory(sourceDir, cwd);

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
  const plan = diffRoutes(routes, existing);
  const eventType = options.eventType ?? detectEventType(lines);

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
