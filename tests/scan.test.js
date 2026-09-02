import assert from 'node:assert/strict';
import { test } from 'node:test';

import { functionNameFor, normalizePath, parseSource } from '../src/lib/scan.js';

test('parses a combined @route tag', () => {
  const src = [
    '/**',
    ' * Fetch one user.',
    ' * @route GET /users/{id}',
    ' */',
    'export const handler = async (event) => {};',
  ].join('\n');

  const { routes, problems } = parseSource(src, 'src/functions/getUser.js');
  assert.equal(problems.length, 0);
  assert.equal(routes.length, 1);
  assert.deepEqual(
    { name: routes[0].name, method: routes[0].method, path: routes[0].path, handler: routes[0].handler },
    {
      name: 'getUser',
      method: 'get',
      path: '/users/{id}',
      handler: 'src/functions/getUser.handler',
    },
  );
});

test('parses split @method and @path tags', () => {
  const src = [
    '/**',
    ' * @method POST',
    ' * @path   /users',
    ' */',
    'export async function createUser(event) {}',
  ].join('\n');

  const { routes } = parseSource(src, 'src/functions/createUser.js');
  assert.equal(routes[0].method, 'post');
  assert.equal(routes[0].path, '/users');
  assert.equal(routes[0].handler, 'src/functions/createUser.createUser');
});

test('rewrites :param syntax and adds a leading slash', () => {
  assert.equal(normalizePath('users/:id'), '/users/{id}');
  assert.equal(normalizePath('/orders/'), '/orders');
  assert.equal(normalizePath('/'), '/');
});

test('@name overrides the derived function name', () => {
  const src = [
    '/**',
    ' * @route GET /health',
    ' * @name healthCheck',
    ' */',
    'export const handler = async () => {};',
  ].join('\n');

  const { routes } = parseSource(src, 'src/functions/hc.js');
  assert.equal(routes[0].name, 'healthCheck');
});

test('reports a route with a missing path', () => {
  const src = ['/**', ' * @route GET', ' */', 'export const handler = () => {};'].join('\n');
  const { routes, problems } = parseSource(src, 'src/bad.js');
  assert.equal(routes.length, 0);
  assert.match(problems[0], /needs a method and a path/);
});

test('reports an unknown HTTP method', () => {
  const src = ['/**', ' * @route FETCH /x', ' */', 'export const handler = () => {};'].join('\n');
  const { problems } = parseSource(src, 'src/bad.js');
  assert.match(problems[0], /unknown HTTP method "fetch"/);
});

test('reports an annotation not attached to an export', () => {
  const src = ['/**', ' * @route GET /x', ' */', 'const notExported = () => {};'].join('\n');
  const { problems } = parseSource(src, 'src/bad.js');
  assert.match(problems[0], /not attached to an exported handler/);
});

test('ignores JSDoc blocks with no route tags', () => {
  const src = ['/**', ' * Just a helper.', ' * @param {string} a', ' */', 'export const f = () => {};'].join('\n');
  const { routes, problems } = parseSource(src, 'src/util.js');
  assert.equal(routes.length, 0);
  assert.equal(problems.length, 0);
});

test('supports several annotated handlers in one file', () => {
  const src = [
    '/**',
    ' * @route GET /items',
    ' * @name listItems',
    ' */',
    'export const list = async () => {};',
    '',
    '/**',
    ' * @route POST /items',
    ' * @name createItem',
    ' */',
    'export const create = async () => {};',
  ].join('\n');

  const { routes } = parseSource(src, 'src/functions/items.js');
  assert.equal(routes.length, 2);
  assert.equal(routes[0].handler, 'src/functions/items.list');
  assert.equal(routes[1].handler, 'src/functions/items.create');
});

test('reads cors and authorizer tags', () => {
  const src = [
    '/**',
    ' * @route GET /private',
    ' * @cors true',
    ' * @authorizer aws_iam',
    ' */',
    'export const handler = () => {};',
  ].join('\n');

  const { routes } = parseSource(src, 'src/functions/private.js');
  assert.equal(routes[0].cors, true);
  assert.equal(routes[0].authorizer, 'aws_iam');
});

test('index files take the name of their directory', () => {
  assert.equal(functionNameFor('src/functions/users/index.js'), 'users');
  assert.equal(functionNameFor('src/functions/get-user.js'), 'getUser');
});

test('handles CommonJS exports', () => {
  const src = ['/**', ' * @route GET /cjs', ' */', 'module.exports.handler = async () => {};'].join('\n');
  const { routes } = parseSource(src, 'src/functions/cjs.js');
  assert.equal(routes[0].handler, 'src/functions/cjs.handler');
});
