import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyUpdate,
  diffRoutes,
  findFunctionsBlock,
  readExistingFunctions,
} from '../src/lib/yaml.js';

const BASE = [
  '# Service definition — keep this comment!',
  'service: my-api',
  '',
  'provider:',
  '  name: aws',
  '  runtime: nodejs20.x',
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
  'resources:',
  '  Resources:',
  '    Table:',
  '      Type: AWS::DynamoDB::Table',
  '',
].join('\n');

const route = (name, method, p, handler) => ({
  name,
  method,
  path: p,
  handler: handler ?? `src/functions/${name}.handler`,
  file: `src/functions/${name}.js`,
});

function plan(content, routes) {
  const lines = content.split('\n');
  const block = findFunctionsBlock(lines);
  const existing = readExistingFunctions(lines, block);
  return { existing, plan: diffRoutes(routes, existing) };
}

test('locates the functions block and its indent', () => {
  const lines = BASE.split('\n');
  const block = findFunctionsBlock(lines);
  assert.equal(block.found, true);
  assert.equal(lines[block.start], 'functions:');
  assert.equal(block.indent, 2);
  assert.equal(lines[block.end - 1].trim(), 'method: get');
});

test('reads existing entries with their method and path', () => {
  const { existing } = plan(BASE, []);
  assert.equal(existing.length, 1);
  assert.deepEqual(
    {
      name: existing[0].name,
      handler: existing[0].handler,
      method: existing[0].method,
      path: existing[0].path,
    },
    {
      name: 'getUser',
      handler: 'src/functions/getUser.handler',
      method: 'get',
      path: '/users/{id}',
    },
  );
});

test('detects an added function', () => {
  const routes = [route('getUser', 'get', '/users/{id}'), route('createUser', 'post', '/users')];
  const { plan: p } = plan(BASE, routes);
  assert.equal(p.added.length, 1);
  assert.equal(p.added[0].name, 'createUser');
  assert.equal(p.unchanged.length, 1);
});

test('detects a changed method', () => {
  const routes = [route('getUser', 'post', '/users/{id}')];
  const { plan: p } = plan(BASE, routes);
  assert.equal(p.changed.length, 1);
  assert.match(p.changed[0].diffs[0], /method get -> post/);
});

test('reports stale entries without removing them', () => {
  const { plan: p } = plan(BASE, [route('other', 'get', '/other')]);
  assert.equal(p.stale.length, 1);
  assert.equal(p.stale[0].name, 'getUser');

  const routes = [route('other', 'get', '/other')];
  const out = applyUpdate(BASE, routes, p);
  assert.match(out, /getUser:/);
  assert.match(out, /other:/);
});

test('preserves comments, variables and sections outside functions', () => {
  const routes = [route('getUser', 'get', '/users/{id}'), route('createUser', 'post', '/users')];
  const { plan: p } = plan(BASE, routes);
  const out = applyUpdate(BASE, routes, p);

  assert.match(out, /# Service definition — keep this comment!/);
  assert.match(out, /TABLE: \$\{self:custom\.tableName\}/);
  assert.match(out, /Type: AWS::DynamoDB::Table/);
  assert.match(out, /createUser:/);
  assert.match(out, /method: post/);
});

test('is idempotent when nothing changed', () => {
  const routes = [route('getUser', 'get', '/users/{id}')];
  const { plan: p } = plan(BASE, routes);
  const once = applyUpdate(BASE, routes, p);
  const second = plan(once, routes);
  const twice = applyUpdate(once, routes, second.plan);
  assert.equal(once, twice);
});

test('creates a functions block when the file has none', () => {
  const noFunctions = ['service: my-api', '', 'provider:', '  name: aws', ''].join('\n');
  const routes = [route('getUser', 'get', '/users/{id}')];
  const { plan: p } = plan(noFunctions, routes);
  const out = applyUpdate(noFunctions, routes, p);

  assert.match(out, /^functions:$/m);
  assert.match(out, /getUser:/);
  assert.match(out, /service: my-api/);
});

test('respects a four-space indent style', () => {
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

  const routes = [route('getUser', 'get', '/users/{id}'), route('createUser', 'post', '/users')];
  const { plan: p } = plan(wide, routes);
  const out = applyUpdate(wide, routes, p);
  assert.match(out, /^ {4}createUser:$/m);
  assert.match(out, /^ {8}handler: src\/functions\/createUser\.handler$/m);
});

test('emits cors and authorizer when annotated', () => {
  const routes = [{ ...route('secure', 'get', '/secure'), cors: true, authorizer: 'aws_iam' }];
  const { plan: p } = plan(BASE, routes);
  const out = applyUpdate(BASE, routes, p);
  assert.match(out, /cors: true/);
  assert.match(out, /authorizer: aws_iam/);
});

test('quotes paths so braces are not read as YAML flow maps', () => {
  const routes = [route('getUser', 'get', '/users/{id}')];
  const { plan: p } = plan(BASE, routes);
  const out = applyUpdate(BASE, routes, p);
  assert.match(out, /path: '\/users\/\{id\}'/);
});
