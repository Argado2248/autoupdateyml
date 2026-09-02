/**
 * The postinstall hook.
 *
 * This script runs inside other people's `npm install`. A non-zero exit here
 * aborts the install for their whole project, so the overriding requirement is
 * that it cannot fail — every case below asserts exit 0, including ones where
 * the package itself is broken.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const CONFIG = ['service: svc', '', 'provider:', '  name: aws', ''].join('\n');

/**
 * Run the postinstall script with INIT_CWD pointed at `initCwd`.
 * Copies the package into a temp dir so a test can break parts of it without
 * touching the real tree.
 */
async function runPostinstall(initCwd, { breakModule = false, removeModule = false } = {}) {
  const pkg = mkdtempSync(path.join(tmpdir(), 'autoupdate-pkg-'));
  mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  mkdirSync(path.join(pkg, 'src', 'lib'), { recursive: true });
  cpSync(path.join(REPO, 'bin', 'postinstall.js'), path.join(pkg, 'bin', 'postinstall.js'));

  if (!removeModule) {
    const dest = path.join(pkg, 'src', 'lib', 'register.js');
    if (breakModule) writeFileSync(dest, 'this is not valid javascript ((((\n', 'utf8');
    else cpSync(path.join(REPO, 'src', 'lib', 'register.js'), dest);
  }

  try {
    const { stdout } = await run('node', [path.join(pkg, 'bin', 'postinstall.js')], {
      env: { ...process.env, INIT_CWD: initCwd },
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '' };
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
}

function projectDir(content = CONFIG) {
  const dir = mkdtempSync(path.join(tmpdir(), 'autoupdate-host-'));
  if (content !== null) writeFileSync(path.join(dir, 'serverless.yml'), content, 'utf8');
  return dir;
}

test('registers the plugin in a host project', async () => {
  const dir = projectDir();
  try {
    const { code } = await runPostinstall(dir);
    assert.equal(code, 0);
    const text = readFileSync(path.join(dir, 'serverless.yml'), 'utf8');
    assert.match(text, /plugins:/);
    assert.match(text, /- autoupdateyml\/plugin/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('is a no-op when already registered', async () => {
  const registered = ['service: svc', '', 'plugins:', '  - autoupdateyml/plugin', '', 'provider:', '  name: aws', ''].join('\n');
  const dir = projectDir(registered);
  try {
    const { code } = await runPostinstall(dir);
    assert.equal(code, 0);
    assert.equal(readFileSync(path.join(dir, 'serverless.yml'), 'utf8'), registered);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does nothing when the project has no serverless config', async () => {
  const dir = projectDir(null);
  try {
    const { code } = await runPostinstall(dir);
    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exits 0 when its own module is missing', async () => {
  // This is what broke a real install: bin/ was gitignored, so the script
  // shipped without the module it imported and npm aborted the whole install.
  const dir = projectDir();
  try {
    const { code, stdout } = await runPostinstall(dir, { removeModule: true });
    assert.equal(code, 0, 'must never fail the install');
    assert.match(stdout, /plugins:/, 'should tell the user how to do it by hand');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exits 0 when its own module is corrupt', async () => {
  const dir = projectDir();
  try {
    const { code } = await runPostinstall(dir, { breakModule: true });
    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exits 0 with no INIT_CWD', async () => {
  const { code } = await runPostinstall('');
  assert.equal(code, 0);
});

test('does not write into npm cache directories', async () => {
  // For a git dependency npm clones into its cache and runs lifecycle scripts
  // there before the real install; that directory is not a user's project.
  const base = mkdtempSync(path.join(tmpdir(), 'autoupdate-cache-'));
  const cacheLike = path.join(base, '_cacache', 'tmp', 'prep-abc');
  mkdirSync(cacheLike, { recursive: true });
  writeFileSync(path.join(cacheLike, 'serverless.yml'), CONFIG, 'utf8');
  try {
    const { code } = await runPostinstall(cacheLike);
    assert.equal(code, 0);
    assert.equal(
      readFileSync(path.join(cacheLike, 'serverless.yml'), 'utf8'),
      CONFIG,
      'the cache copy must be left untouched',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('honours the opt-out env var', async () => {
  const dir = projectDir();
  try {
    const { stdout } = await run('node', [path.join(REPO, 'bin', 'postinstall.js')], {
      env: { ...process.env, INIT_CWD: dir, AUTOUPDATEYML_NO_POSTINSTALL: '1' },
    });
    assert.equal(stdout.trim(), '');
    assert.doesNotMatch(readFileSync(path.join(dir, 'serverless.yml'), 'utf8'), /plugins:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every executable named in package.json is committed to git', async () => {
  // Regression: bin/ was gitignored, so bin/postinstall.js and
  // bin/register-cli.js were never committed. The local tree looked fine while
  // the installable package was broken — checking the filesystem would not have
  // caught it, so this asks git what it actually tracks.
  const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));

  const entrypoints = [...Object.values(pkg.bin ?? {})];
  const postinstall = pkg.scripts?.postinstall;
  if (postinstall) entrypoints.push(postinstall.replace(/^node\s+/, '').trim());

  let tracked;
  try {
    const { stdout } = await run('git', ['ls-files'], { cwd: REPO, maxBuffer: 8 * 1024 * 1024 });
    tracked = new Set(stdout.split('\n').filter(Boolean));
  } catch {
    return; // not a git checkout (e.g. running from an installed tarball)
  }

  for (const rel of entrypoints) {
    const normalized = rel.replace(/^\.\//, '');
    assert.ok(
      tracked.has(normalized),
      `${normalized} is referenced by package.json but is not committed — `
        + 'it would be missing from the installed package',
    );
  }
});
