/**
 * Zero-config route inference.
 *
 * The tool must work on an existing project with no annotations and no
 * configuration. These tests deliberately draw their fixtures from several
 * unrelated domains and directory layouts: inference that only satisfies one
 * project's vocabulary is overfitted, and the point here is the general rule.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { updateServerlessConfig } from '../src/index.js';
import { inferRoute, pluralize, splitVerb } from '../src/lib/infer.js';

const plain = 'export const handler = async () => ({});\n';

function project(config, files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'autoupdate-infer-'));
  if (config !== null) writeFileSync(path.join(dir, 'serverless.yml'), config, 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

const EMPTY_CONFIG = ['service: svc', '', 'provider:', '  name: aws', ''].join('\n');

test('maps verb prefixes to methods', () => {
  const expected = {
    get: ['getProduct', 'listProducts', 'fetchReport', 'findCustomer', 'readSetting', 'showInvoice'],
    post: ['createOrder', 'addComment', 'insertRow', 'registerUser', 'submitForm'],
    put: ['replaceDocument', 'putRecord', 'setConfig'],
    patch: ['updateProfile', 'editArticle', 'patchTicket', 'modifyBooking'],
    delete: ['deleteSession', 'removeTag', 'destroyCache'],
  };
  for (const [method, names] of Object.entries(expected)) {
    for (const name of names) {
      assert.equal(splitVerb(name).method, method, `${name} should be ${method}`);
    }
  }
});

test('an unrecognised prefix falls back to GET, flagged as unmatched', () => {
  const r = splitVerb('processPayment');
  assert.equal(r.method, 'get');
  assert.equal(r.matched, false);
});

test('pluralizes resource names without mangling them', () => {
  assert.equal(pluralize('order'), 'orders');
  assert.equal(pluralize('orders'), 'orders', 'already plural');
  assert.equal(pluralize('box'), 'boxes');
  assert.equal(pluralize('category'), 'categories');
  assert.equal(pluralize('match'), 'matches');
  // A trailing digit is a version/variant marker, not a noun ending.
  assert.equal(pluralize('handler2'), 'handler2');
});

test('infers routes across unrelated domains and layouts', () => {
  const cases = [
    // resource-per-directory
    ['functions/listProducts/index.mjs', 'listProducts', 'get /products'],
    ['functions/getOrderById/index.mjs', 'getOrderById', 'get /orders/{id}'],
    ['functions/createInvoice/index.mjs', 'createInvoice', 'post /invoices'],
    // flat files under src/
    ['src/functions/registerUser.ts', 'registerUser', 'post /users'],
    ['src/functions/deleteSession.ts', 'deleteSession', 'delete /sessions/{id}'],
    // verb-named file, resource from the directory
    ['api/bookings/post.js', 'post', 'post /bookings'],
    // nested prefix is preserved
    ['src/functions/admin/deleteAuditLog.js', 'deleteAuditLog', 'delete /admin/audit-logs/{id}'],
  ];
  for (const [file, name, expected] of cases) {
    const r = inferRoute(file, name);
    assert.equal(`${r.method} ${r.path}`, expected, `for ${file}`);
  }
});

test('item methods on a singular resource get an id parameter', () => {
  assert.equal(inferRoute('functions/updateProfile/index.js', 'updateProfile').path, '/profiles/{id}');
  // A plural name reads as a bulk operation, so no id.
  assert.equal(inferRoute('functions/removeSessions/index.js', 'removeSessions').path, '/sessions');
  // GET is a collection read unless the name says otherwise.
  assert.equal(inferRoute('functions/getCustomers/index.js', 'getCustomers').path, '/customers');
});

test('dynamic directory segments become path parameters', () => {
  assert.equal(inferRoute('functions/tickets/[id]/get.js', 'get').path, '/tickets/{id}');
  assert.equal(inferRoute('functions/tickets/{ticketId}/get.js', 'get').path, '/tickets/{ticketId}');
});

test('a handler folder does not duplicate the resource in the path', () => {
  // functions/listProducts/index.mjs must not become /list-products/products
  assert.equal(inferRoute('functions/listProducts/index.mjs', 'listProducts').path, '/products');
});

test('an unannotated project is wired up with no configuration', async () => {
  const dir = project(EMPTY_CONFIG, {
    'functions/listProducts/index.mjs': plain,
    'functions/createProduct/index.mjs': plain,
    'functions/removeProduct/index.mjs': plain,
  });
  try {
    const result = await updateServerlessConfig({ cwd: dir });
    const byName = Object.fromEntries(result.routes.map((r) => [r.name, `${r.method} ${r.path}`]));
    assert.deepEqual(byName, {
      listProducts: 'get /products',
      createProduct: 'post /products',
      removeProduct: 'delete /products/{id}',
    });
    assert.match(readFileSync(path.join(dir, 'serverless.yml'), 'utf8'), /listProducts:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an existing route in serverless.yml is never moved by inference', async () => {
  // The deployed path is deliberately not what inference would guess.
  const config = [
    'service: svc',
    '',
    'functions:',
    '  listProducts:',
    '    handler: functions/listProducts/index.handler',
    '    events:',
    '      - httpApi:',
    '          path: /legacy/product-list',
    '          method: get',
    '',
  ].join('\n');

  const dir = project(config, { 'functions/listProducts/index.mjs': plain });
  try {
    const result = await updateServerlessConfig({ cwd: dir });
    assert.equal(result.changed, false, 'must not rewrite a live route');
    assert.match(readFileSync(path.join(dir, 'serverless.yml'), 'utf8'), /\/legacy\/product-list/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicit @route still overrides inference', async () => {
  const dir = project(EMPTY_CONFIG, {
    'functions/listProducts/index.mjs':
      '/**\n * @route GET /custom/path\n */\nexport const handler = async () => ({});\n',
  });
  try {
    const result = await updateServerlessConfig({ cwd: dir, write: false });
    assert.equal(result.routes[0].path, '/custom/path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared helper modules are not treated as handlers', async () => {
  const dir = project(EMPTY_CONFIG, {
    'functions/listProducts/index.mjs': plain,
    // Several named exports: a utility module, not an entrypoint.
    'functions/shared/util.mjs': 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n',
  });
  try {
    const result = await updateServerlessConfig({ cwd: dir, write: false });
    assert.deepEqual(result.routes.map((r) => r.name), ['listProducts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handlers in the project root are picked up alongside a functions dir', async () => {
  const dir = project(EMPTY_CONFIG, {
    'functions/listProducts/index.mjs': plain,
    'handler.mjs': 'export const hello = async () => ({});\n',
  });
  try {
    const result = await updateServerlessConfig({ cwd: dir, write: false });
    assert.deepEqual(result.routes.map((r) => r.name).sort(), ['handler', 'listProducts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each supported source directory is auto-detected', async () => {
  for (const dirName of ['functions', 'src', 'handlers', 'api', 'lambdas']) {
    const dir = project(EMPTY_CONFIG, { [`${dirName}/getCustomers.js`]: plain });
    try {
      const result = await updateServerlessConfig({ cwd: dir, write: false });
      assert.equal(result.routes.length, 1, `${dirName}/ should be scanned`);
      assert.equal(result.routes[0].path, '/customers');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('reports a stale entry whose handler file is gone', async () => {
  const config = [
    'service: svc',
    '',
    'functions:',
    '  ghost:',
    '    handler: functions/ghost/index.handler',
    '    events:',
    '      - httpApi:',
    '          path: /ghost',
    '          method: get',
    '',
  ].join('\n');

  const dir = project(config, { 'functions/listProducts/index.mjs': plain });
  try {
    const result = await updateServerlessConfig({ cwd: dir, write: false });
    const ghost = result.plan.stale.find((e) => e.name === 'ghost');
    assert.ok(ghost, 'ghost must be reported as stale');
    assert.equal(ghost.handlerMissing, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flags a preserved entry that collides with a generated route', async () => {
  // A dead function that a renamed handler has since replaced: API Gateway
  // rejects two routes on the same method and path.
  const config = [
    'service: svc',
    '',
    'functions:',
    '  deleteBooking:',
    '    handler: functions/deleteBooking/index.handler',
    '    events:',
    '      - httpApi:',
    '          path: /bookings/{id}',
    '          method: delete',
    '',
  ].join('\n');

  const dir = project(config, { 'functions/removeBooking/index.mjs': plain });
  try {
    const result = await updateServerlessConfig({ cwd: dir, write: false });
    assert.ok(
      result.problems.some((p) => /both use delete \/bookings\/\{id\}/.test(p)),
      `expected a collision warning, got: ${result.problems.join(' | ')}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
