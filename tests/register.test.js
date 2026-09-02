/**
 * Registering the plugin in serverless.yml.
 *
 * Serverless only loads a plugin listed under `plugins:`, so an install that
 * stops at node_modules leaves the tool inert. These cover both the detection
 * and the edit, including the layouts a real project is likely to have.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addPlugin, isRegistered, PLUGIN_NAME } from '../src/lib/register.js';

const L = (...lines) => lines.join('\n');

const NO_PLUGINS = L('service: svc', '', 'provider:', '  name: aws', '', 'functions:', '  a:', '    handler: a.h', '');

test('detects an existing block-sequence registration', () => {
  const yml = L('service: svc', '', 'plugins:', '  - autoupdateyml/plugin', '', 'provider:', '  name: aws', '');
  assert.equal(isRegistered(yml), true);
});

test('detects a quoted entry', () => {
  const yml = L('service: svc', '', 'plugins:', "  - 'autoupdateyml/plugin'", '');
  assert.equal(isRegistered(yml), true);
});

test('detects a vendored path registration', () => {
  const yml = L('service: svc', '', 'plugins:', '  - ./plugins/auto-routes', '');
  assert.equal(isRegistered(yml), true);
});

test('detects an inline flow-sequence registration', () => {
  const yml = L('service: svc', '', 'plugins: [serverless-offline, autoupdateyml/plugin]', '');
  assert.equal(isRegistered(yml), true);
});

test('reports absence correctly', () => {
  assert.equal(isRegistered(NO_PLUGINS), false);
  assert.equal(isRegistered(L('service: svc', '', 'plugins:', '  - serverless-offline', '')), false);
});

test('a plugins block elsewhere in the file is not confused for ours', () => {
  const yml = L('service: svc', '', 'custom:', '  somePlugins:', '    - autoupdateyml/plugin', '');
  // Nested under custom:, not the top-level plugins key.
  assert.equal(isRegistered(yml), false);
});

test('creates a plugins block above provider', () => {
  const result = addPlugin(NO_PLUGINS);
  assert.equal(result.changed, true);
  assert.equal(isRegistered(result.content), true);

  const lines = result.content.split('\n');
  const pluginsAt = lines.findIndex((l) => l === 'plugins:');
  const providerAt = lines.findIndex((l) => l === 'provider:');
  assert.ok(pluginsAt > -1 && pluginsAt < providerAt, 'plugins: should precede provider:');
});

test('appends to an existing block, keeping its indent', () => {
  const yml = L('service: svc', '', 'plugins:', '    - serverless-offline', '', 'provider:', '  name: aws', '');
  const result = addPlugin(yml);
  assert.equal(isRegistered(result.content), true);
  assert.match(result.content, /^ {4}- autoupdateyml\/plugin$/m, 'should match the 4-space indent');
  assert.match(result.content, /serverless-offline/, 'existing plugin must survive');
});

test('appends to an inline list', () => {
  const yml = L('service: svc', '', 'plugins: [serverless-offline]', '', 'provider:', '  name: aws', '');
  const result = addPlugin(yml);
  assert.equal(isRegistered(result.content), true);
  assert.match(result.content, /plugins: \[serverless-offline, autoupdateyml\/plugin\]/);
});

test('fills an empty inline list', () => {
  const result = addPlugin(L('service: svc', '', 'plugins: []', '', 'provider:', '  name: aws', ''));
  assert.match(result.content, /plugins: \[autoupdateyml\/plugin\]/);
});

test('is a no-op when already registered', () => {
  const yml = L('service: svc', '', 'plugins:', '  - autoupdateyml/plugin', '');
  const result = addPlugin(yml);
  assert.equal(result.changed, false);
  assert.equal(result.content, yml, 'content must be untouched');
});

test('preserves comments and variables', () => {
  const yml = L(
    '# keep this header',
    'org: someorg',
    'service: svc',
    '',
    'provider:',
    '  name: aws',
    '  environment:',
    '    TABLE: ${self:custom.tableName}',
    '',
  );
  const result = addPlugin(yml);
  assert.match(result.content, /# keep this header/);
  assert.match(result.content, /org: someorg/);
  assert.match(result.content, /\$\{self:custom\.tableName\}/);
  assert.equal(isRegistered(result.content), true);
});

test('appends when there is no recognisable anchor', () => {
  const result = addPlugin(L('service: svc', ''));
  assert.equal(isRegistered(result.content), true);
  assert.match(result.content, /service: svc/);
});

test('the registered name is the package plugin entrypoint', () => {
  // package.json exports "./plugin"; a mismatch here would register a path
  // Serverless cannot resolve.
  assert.equal(PLUGIN_NAME, 'autoupdateyml/plugin');
});
