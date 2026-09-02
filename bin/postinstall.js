#!/usr/bin/env node
/**
 * Register the plugin in the host project's serverless.yml on install.
 *
 * Runs as an npm `postinstall`. It must never fail the install: any problem is
 * reported as a hint and exits 0, because breaking `npm install` over a
 * convenience is a far worse outcome than the user adding one line by hand.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const CONFIGS = ['serverless.yml', 'serverless.yaml'];

/**
 * Locate the project being installed into. npm sets INIT_CWD to the directory
 * where the install was invoked; without it there is no reliable way to tell a
 * host project from our own package, so we do nothing.
 */
function hostDir() {
  const initCwd = process.env.INIT_CWD;
  if (!initCwd) return null;

  const target = path.resolve(initCwd);
  const here = path.resolve(process.cwd());

  // Installing our own repo (development), not a host project.
  if (target === here) return null;

  // For a git dependency npm first clones into its cache and runs lifecycle
  // scripts there to prepare the package. That temp directory is not a user's
  // project and must never be written to; the real install follows afterwards.
  const CACHE_MARKERS = ['_cacache', 'npm-cache', `${path.sep}.npm${path.sep}`, 'AppData'];
  if (CACHE_MARKERS.some((m) => target.includes(m) || here.includes(m))) return null;
  if (/[\\/]git-clone[A-Za-z0-9]*[\\/]?/.test(here) || /[\\/]git-clone/.test(target)) return null;

  return target;
}

async function main() {
  // An explicit opt-out for anyone who would rather wire it up themselves.
  if (process.env.AUTOUPDATEYML_NO_POSTINSTALL) return;

  const dir = hostDir();
  if (!dir) return;

  let configPath = null;
  let content = null;
  for (const name of CONFIGS) {
    const full = path.join(dir, name);
    try {
      content = await readFile(full, 'utf8');
      configPath = full;
      break;
    } catch {
      /* try next */
    }
  }

  if (!configPath) {
    // Installed before the config exists, or not a Serverless project at all.
    return;
  }

  // Imported lazily: a static import that fails to resolve would crash before
  // the try/catch below and take the whole npm install down with it.
  const { addPlugin, isRegistered, PLUGIN_NAME } = await import('../src/lib/register.js');

  if (isRegistered(content)) return;

  const result = addPlugin(content);
  if (!result.changed) return;

  await writeFile(configPath, result.content, 'utf8');
  process.stdout.write(
    `\nautoupdateyml: registered "${PLUGIN_NAME}" in ${path.basename(configPath)}.\n`
      + '  Routes now sync automatically on `serverless deploy`.\n\n',
  );
}

// Belt and braces: nothing this script does is worth failing an install over.
// A non-zero exit here aborts `npm install` for the whole project, so the exit
// code is pinned to 0 no matter what happens above.
process.exitCode = 0;

try {
  await main();
} catch (err) {
  try {
    process.stdout.write(
      `\nautoupdateyml: could not update serverless.yml automatically (${err?.message ?? err}).\n`
        + '  Add this by hand to enable it:\n\n    plugins:\n      - autoupdateyml/plugin\n\n',
    );
  } catch {
    /* even reporting failed; stay silent rather than break the install */
  }
  process.exitCode = 0;
}
