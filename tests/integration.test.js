/**
 * End-to-end tests over a temporary project directory: real files on disk,
 * scanned and rewritten through the public entry point.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { updateServerlessConfig } from '../src/index.js';

const CONFIG = [
  '# keep this comment',
  'service: demo',
  '',
  'provider:',
  '  name: aws',
  '  environment:',
  '    TABLE: ${self:custom.tableName}',
  '',
  'functions:',
  '  getUser:',
  '    handler: src/functions/getUser.handler',
  '    events:',
  '      - http:',
  "          path: '/users/{id}'",
  '          method: get',
  '',
].join('\n');

/** Build a throwaway project; `files` maps relative paths to contents. */
function project(files, config = CONFIG) {
  const dir = mkdtempSync(path.join(tmpdir(), 'autoupdate-int-'));
  if (config !== null) writeFileSync(path.join(dir, 'serverless.yml'), config, 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

const handler = (route) => `/**\n * @route ${route}\n */\nexport const handler = async () => ({});\n`;

test('adds a newly created handler to serverless.yml', async () => {
  const dir = project({
    'src/functions/getUser.js': handler('GET /users/{id}'),
    'src/functions/createUser.js': handler('POST /users'),
  });
  try {
    const result = await updateServerlessConfig({ cwd: dir });
    assert.equal(result.ok, true);
    assert.equal(result.written, true);
    assert.deepEqual(result.plan.added.map((r) => r.name), ['createUser']);

    const text = readFileSync(path.join(dir, 'serverless.yml'), 'utf8');
    assert.match(text, /createUser:/);
    assert.match(text, /# keep this comment/);
    assert.match(text, /\$\{self:custom\.tableName\}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second run is a no-op', async () => {
  const dir = project({ 'src/functions/getUser.js': handler('GET /users/{id}') });
  try {
    await updateServerlessConfig({ cwd: dir });
    const before = readFileSync(path.join(dir, 'serverless.yml'), 'utf8');
    const result = await updateServerlessConfig({ cwd: dir });
    assert.equal(result.changed, false);
    assert.equal(result.written, false);
    assert.equal(readFileSync(path.join(dir, 'serverless.yml'), 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check mode reports without writing', async () => {
  const dir = project({
    'src/functions/getUser.js': handler('GET /users/{id}'),
    'src/functions/createUser.js': handler('POST /users'),
  });
  try {
    const before = readFileSync(path.join(dir, 'serverless.yml'), 'utf8');
    const result = await updateServerlessConfig({ cwd: dir, write: false });
    assert.equal(result.changed, true);
    assert.equal(result.written, false);
    assert.equal(readFileSync(path.join(dir, 'serverless.yml'), 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ignores node_modules and test files', async () => {
  const dir = project({
    'src/functions/getUser.js': handler('GET /users/{id}'),
    'src/functions/getUser.test.js': handler('GET /should-be-ignored'),
    'node_modules/pkg/index.js': handler('GET /also-ignored'),
  });
  try {
    const result = await updateServerlessConfig({ cwd: dir, write: false });
    assert.deepEqual(result.routes.map((r) => r.path), ['/users/{id}']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bare "serverless" config hint still resolves (Serverless v4)', async () => {
  // v4 reports `configurationFilename` without an extension; the hint must not
  // be taken literally or the tool looks for a file named "serverless".
  const dir = project({ 'src/functions/createUser.js': handler('POST /users') });
  try {
    const result = await updateServerlessConfig({ cwd: dir, config: 'serverless' });
    assert.equal(result.error, null);
    assert.equal(path.basename(result.configPath), 'serverless.yml');
    assert.equal(result.written, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finds a .yaml config when there is no .yml', async () => {
  const dir = project({ 'src/functions/createUser.js': handler('POST /users') }, null);
  writeFileSync(path.join(dir, 'serverless.yaml'), CONFIG, 'utf8');
  try {
    const result = await updateServerlessConfig({ cwd: dir });
    assert.equal(path.basename(result.configPath), 'serverless.yaml');
    assert.match(readFileSync(path.join(dir, 'serverless.yaml'), 'utf8'), /createUser:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reports a missing config instead of throwing', async () => {
  const dir = project({ 'src/functions/createUser.js': handler('POST /users') }, null);
  try {
    const result = await updateServerlessConfig({ cwd: dir });
    assert.equal(result.ok, false);
    assert.match(result.error, /no serverless config/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('strict mode refuses to write when an annotation is malformed', async () => {
  const dir = project({
    'src/functions/getUser.js': handler('GET /users/{id}'),
    'src/functions/broken.js': '/**\n * @route NOPE /x\n */\nexport const handler = () => {};\n',
  });
  try {
    const before = readFileSync(path.join(dir, 'serverless.yml'), 'utf8');
    const result = await updateServerlessConfig({ cwd: dir, strict: true });
    assert.equal(result.ok, false);
    assert.equal(readFileSync(path.join(dir, 'serverless.yml'), 'utf8'), before);
    assert.match(result.problems[0], /unknown HTTP method/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flags duplicate routes across files', async () => {
  const dir = project({
    'src/functions/a.js': handler('GET /same'),
    'src/functions/b.js': handler('GET /same'),
  });
  try {
    const result = await updateServerlessConfig({ cwd: dir, write: false });
    assert.ok(result.problems.some((p) => /duplicate route "get \/same"/.test(p)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('honours a custom source directory', async () => {
  const dir = project({
    'api/handlers/ping.js': handler('GET /ping'),
    'src/functions/getUser.js': handler('GET /users/{id}'),
  });
  try {
    const result = await updateServerlessConfig({ cwd: dir, source: 'api', write: false });
    assert.deepEqual(result.routes.map((r) => r.path), ['/ping']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
