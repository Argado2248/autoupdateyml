/**
 * API Gateway v2 (`httpApi`) support.
 *
 * A project using `httpApi` that got `http` entries generated into it would end
 * up with a second, conflicting REST API alongside its HTTP API, so the event
 * style has to follow the file rather than a fixed default.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { updateServerlessConfig } from '../src/index.js';
import { detectEventType } from '../src/lib/yaml.js';

const handler = (route) => `/**\n * @route ${route}\n */\nexport const handler = async () => ({});\n`;

const HTTP_API = [
  'service: svc',
  '',
  'provider:',
  '  name: aws',
  '',
  'functions:',
  '  hello:',
  '    handler: handler.hello',
  '    events:',
  '      - httpApi:',
  '          path: /',
  '          method: get',
  '',
].join('\n');

const REST_API = HTTP_API.replace('- httpApi:', '- http:');

function project(config, files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'autoupdate-httpapi-'));
  writeFileSync(path.join(dir, 'serverless.yml'), config, 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

test('detects the event style already used by a config', () => {
  assert.equal(detectEventType(HTTP_API.split('\n')), 'httpApi');
  assert.equal(detectEventType(REST_API.split('\n')), 'http');
  // Nothing to learn from: fall back to the REST default.
  assert.equal(detectEventType(['service: svc']), 'http');
});

test('generates httpApi events in an httpApi project', async () => {
  const dir = project(HTTP_API, {
    'src/hello.js': handler('GET /'),
    'src/getProducts.js': handler('GET /products'),
  });
  try {
    const result = await updateServerlessConfig({ cwd: dir });
    assert.equal(result.eventType, 'httpApi');

    const text = readFileSync(path.join(dir, 'serverless.yml'), 'utf8');
    assert.match(text, /- httpApi:/);
    assert.doesNotMatch(text, /^\s+- http:$/m, 'must not introduce a REST event');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps generating http events in a REST project', async () => {
  const dir = project(REST_API, {
    'src/hello.js': handler('GET /'),
    'src/getProducts.js': handler('GET /products'),
  });
  try {
    const result = await updateServerlessConfig({ cwd: dir });
    assert.equal(result.eventType, 'http');
    assert.match(readFileSync(path.join(dir, 'serverless.yml'), 'utf8'), /- http:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('omits per-event cors under httpApi', async () => {
  // httpApi configures CORS once on the provider; a per-event key is rejected.
  const dir = project(HTTP_API, {
    'src/create.js': '/**\n * @route POST /items\n * @cors true\n */\nexport const handler = async () => ({});\n',
  });
  try {
    await updateServerlessConfig({ cwd: dir });
    const text = readFileSync(path.join(dir, 'serverless.yml'), 'utf8');
    assert.match(text, /- httpApi:/);
    assert.doesNotMatch(text, /cors:/, 'cors must not be emitted per httpApi event');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicit eventType overrides detection', async () => {
  const dir = project(REST_API, { 'src/create.js': handler('POST /items') });
  try {
    const result = await updateServerlessConfig({ cwd: dir, eventType: 'httpApi' });
    assert.equal(result.eventType, 'httpApi');
    assert.match(readFileSync(path.join(dir, 'serverless.yml'), 'utf8'), /- httpApi:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drift is detected against existing httpApi events', async () => {
  const dir = project(HTTP_API, { 'src/hello.js': handler('POST /') });
  try {
    const result = await updateServerlessConfig({ cwd: dir, write: false });
    assert.equal(result.plan.changed.length, 1);
    assert.ok(
      result.plan.changed[0].diffs.some((d) => /method get -> post/.test(d)),
      `expected a method diff, got: ${result.plan.changed[0].diffs.join(', ')}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
