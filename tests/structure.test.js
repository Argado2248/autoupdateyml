/**
 * Structural tests: parse the generated YAML and assert on the resulting object.
 *
 * The regex assertions in yaml.test.js confirm text appears in the output but
 * cannot tell whether it landed at the right nesting level — a `- http:` event
 * whose keys are under-indented reads as null and would be rejected at deploy
 * time while still matching a `path: '...'` regex. These tests parse instead.
 *
 * PyYAML via the repo's existing Python toolchain keeps this dependency-free.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { applyUpdate, diffRoutes, findFunctionsBlock, readExistingFunctions } from '../src/lib/yaml.js';

const PYTHON = process.env.PYTHON ?? 'python3';

let yamlAvailable = true;
try {
  execFileSync(PYTHON, ['-c', 'import yaml'], { stdio: 'ignore' });
} catch {
  yamlAvailable = false;
}

/** Parse YAML text into a JS object by shelling out to PyYAML. */
function parseYaml(text) {
  const dir = mkdtempSync(path.join(tmpdir(), 'autoupdateyml-'));
  const file = path.join(dir, 'doc.yml');
  try {
    writeFileSync(file, text, 'utf8');
    const out = execFileSync(
      PYTHON,
      ['-c', 'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', file],
      { encoding: 'utf8' },
    );
    return JSON.parse(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BASE = [
  '# keep me',
  'service: my-api',
  '',
  'provider:',
  '  name: aws',
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

const route = (name, method, p, extra = {}) => ({
  name,
  method,
  path: p,
  handler: `src/functions/${name}.handler`,
  file: `src/functions/${name}.js`,
  ...extra,
});

function build(content, routes) {
  const lines = content.split('\n');
  const block = findFunctionsBlock(lines);
  const existing = readExistingFunctions(lines, block);
  return applyUpdate(content, routes, diffRoutes(routes, existing));
}

test('generated http events parse with keys nested under http', { skip: !yamlAvailable }, () => {
  const routes = [route('createUser', 'post', '/users')];
  const doc = parseYaml(build(BASE, routes));

  const fn = doc.functions.createUser;
  assert.equal(fn.handler, 'src/functions/createUser.handler');

  const http = fn.events[0].http;
  assert.ok(http !== null, '`http` must not be null — nested keys are mis-indented');
  assert.equal(http.path, '/users');
  assert.equal(http.method, 'post');
});

test('cors and authorizer nest under http', { skip: !yamlAvailable }, () => {
  const routes = [route('secure', 'get', '/secure', { cors: true, authorizer: 'aws_iam' })];
  const http = parseYaml(build(BASE, routes)).functions.secure.events[0].http;
  assert.equal(http.cors, true);
  assert.equal(http.authorizer, 'aws_iam');
});

test('a four-space project also produces valid nesting', { skip: !yamlAvailable }, () => {
  const wide = [
    'service: my-api',
    '',
    'functions:',
    '    getUser:',
    '        handler: src/functions/getUser.handler',
    '        events:',
    '            - http:',
    "                  path: '/users/{id}'",
    '                  method: get',
    '',
  ].join('\n');

  const routes = [route('createUser', 'post', '/users')];
  const http = parseYaml(build(wide, routes)).functions.createUser.events[0].http;
  assert.equal(http.path, '/users');
  assert.equal(http.method, 'post');
});

test('untouched sections survive a rewrite', { skip: !yamlAvailable }, () => {
  const withExtras = [
    'service: my-api',
    '',
    'custom:',
    '  tableName: ${self:service}-table',
    '',
    'functions:',
    '  legacyWebhook:',
    '    handler: src/legacy/webhook.handler',
    '    events:',
    '      - sns: legacy-topic',
    '',
    'resources:',
    '  Resources:',
    '    Table:',
    '      Type: AWS::DynamoDB::Table',
    '',
  ].join('\n');

  const routes = [route('createUser', 'post', '/users')];
  const text = build(withExtras, routes);
  const doc = parseYaml(text);

  // A non-http event that the scanner cannot see is preserved verbatim.
  assert.equal(doc.functions.legacyWebhook.events[0].sns, 'legacy-topic');
  assert.equal(doc.resources.Resources.Table.Type, 'AWS::DynamoDB::Table');
  // Variable syntax must survive as literal text, not be resolved or mangled.
  assert.equal(doc.custom.tableName, '${self:service}-table');
  assert.equal(doc.functions.createUser.events[0].http.method, 'post');
});

test('paths with braces parse as strings, not flow maps', { skip: !yamlAvailable }, () => {
  const routes = [route('getItem', 'get', '/items/{id}/sub/{sub}')];
  const http = parseYaml(build(BASE, routes)).functions.getItem.events[0].http;
  assert.equal(typeof http.path, 'string');
  assert.equal(http.path, '/items/{id}/sub/{sub}');
});
