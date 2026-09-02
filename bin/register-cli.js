#!/usr/bin/env node
/**
 * Manually register the plugin in serverless.yml.
 *
 * The postinstall hook does this automatically, but npm skips postinstall under
 * `--ignore-scripts` and in some CI setups, so this is the explicit fallback.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { addPlugin, isRegistered, PLUGIN_NAME } from '../src/lib/register.js';

const cwd = process.cwd();
let configPath = null;
let content = null;

for (const name of ['serverless.yml', 'serverless.yaml']) {
  const full = path.join(cwd, name);
  try {
    content = await readFile(full, 'utf8');
    configPath = full;
    break;
  } catch {
    /* try next */
  }
}

if (!configPath) {
  process.stderr.write('no serverless.yml or serverless.yaml found in this directory\n');
  process.exit(1);
}

if (isRegistered(content)) {
  process.stdout.write(`already registered in ${path.basename(configPath)}\n`);
  process.exit(0);
}

const result = addPlugin(content);
await writeFile(configPath, result.content, 'utf8');
process.stdout.write(
  `registered "${PLUGIN_NAME}" in ${path.basename(configPath)} (${result.reason})\n`,
);
