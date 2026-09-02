/**
 * Tests for the Serverless plugin, driven through a fake `serverless` object
 * shaped like the one the framework passes in.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import Plugin from '../plugins/auto-routes/index.js';

const handler = (route) => `/**\n * @route ${route}\n */\nexport const handler = async () => ({});\n`;

/** Build a throwaway project and a fake serverless instance pointed at it. */
function harness(config, files, custom = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'autoupdate-plugin-'));
  writeFileSync(path.join(dir, 'serverless.yml'), config, 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }

  const logged = [];
  const serverless = {
    config: { servicePath: dir },
    // Serverless v4 reports the config filename without an extension.
    configurationFilename: 'serverless',
    service: {
      custom: { autoRoutes: custom },
      functions: undefined,
      setFunctionNames() {
        for (const [name, fn] of Object.entries(this.functions ?? {})) {
          fn.name = `svc-dev-${name}`;
        }
      },
    },
  };

  const plugin = new Plugin(serverless, {}, { log: { notice: (m) => logged.push(m) } });
  return { dir, serverless, plugin, logged, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const WITH_BLOCK = [
  'service: svc',
  '',
  'provider:',
  '  name: aws',
  '',
  'functions:',
  '  existing:',
  '    handler: src/functions/existing.handler',
  '    events:',
  '      - http:',
  "          path: '/existing'",
  '          method: get',
  '',
].join('\n');

const WITHOUT_BLOCK = ['service: svc', '', 'provider:', '  name: aws', ''].join('\n');

test('initialize hook writes the config', async () => {
  const h = harness(WITH_BLOCK, {
    'src/functions/existing.js': handler('GET /existing'),
    'src/functions/created.js': handler('POST /created'),
  });
  try {
    await h.plugin.hooks.initialize();
    const text = readFileSync(path.join(h.dir, 'serverless.yml'), 'utf8');
    assert.match(text, /created:/);
    assert.ok(h.logged.some((l) => /created/.test(l)), 'should report the added function');
  } finally {
    h.cleanup();
  }
});

test('a config with no functions: block still deploys on the first run', async () => {
  // The framework loads the file before `initialize`, so when there is no
  // `functions:` key the in-memory service has no map to pick up the rewrite.
  // Without the in-memory sync this run would report success and deploy nothing.
  const h = harness(WITHOUT_BLOCK, {
    'src/functions/listItems.js': handler('GET /items'),
    'src/functions/createItem.js': handler('POST /items'),
  });
  try {
    await h.plugin.hooks.initialize();

    const fns = h.serverless.service.functions;
    assert.ok(fns, 'functions map must exist after sync');
    assert.deepEqual(Object.keys(fns).sort(), ['createItem', 'listItems']);
    assert.equal(fns.createItem.events[0].http.method, 'post');
    assert.equal(fns.createItem.events[0].http.path, '/items');
    assert.equal(fns.createItem.name, 'svc-dev-createItem', 'Lambda names must be assigned');

    assert.match(readFileSync(path.join(h.dir, 'serverless.yml'), 'utf8'), /listItems:/);
  } finally {
    h.cleanup();
  }
});

test('in-memory sync does not clobber entries loaded from the file', async () => {
  const h = harness(WITHOUT_BLOCK, { 'src/functions/created.js': handler('POST /created') });
  h.serverless.service.functions = {
    handWritten: { handler: 'src/legacy.handler', events: [{ sns: 'topic' }] },
  };
  try {
    await h.plugin.hooks.initialize();
    assert.equal(h.serverless.service.functions.handWritten.events[0].sns, 'topic');
    assert.ok(h.serverless.service.functions.created);
  } finally {
    h.cleanup();
  }
});

test('runs once even when several lifecycle hooks fire', async () => {
  const h = harness(WITH_BLOCK, {
    'src/functions/existing.js': handler('GET /existing'),
    'src/functions/created.js': handler('POST /created'),
  });
  try {
    await h.plugin.hooks.initialize();
    const after = h.logged.length;
    // The later hooks are fallbacks; they must not redo the work.
    await h.plugin.hooks['before:package:createDeploymentArtifacts']();
    await h.plugin.hooks['before:deploy:deploy']();
    assert.equal(h.logged.length, after);
  } finally {
    h.cleanup();
  }
});

test('a later hook that has to write stops the deploy', async () => {
  const h = harness(WITH_BLOCK, {
    'src/functions/existing.js': handler('GET /existing'),
    'src/functions/created.js': handler('POST /created'),
  });
  try {
    // Simulate initialize being unavailable (older framework versions).
    await assert.rejects(
      () => h.plugin.hooks['before:deploy:deploy'](),
      /Re-run the deploy/,
      'must refuse to deploy a config it just rewrote too late',
    );
  } finally {
    h.cleanup();
  }
});

test('enabled: false disables the hook', async () => {
  const h = harness(
    WITH_BLOCK,
    { 'src/functions/created.js': handler('POST /created') },
    { enabled: false },
  );
  try {
    await h.plugin.hooks.initialize();
    assert.doesNotMatch(readFileSync(path.join(h.dir, 'serverless.yml'), 'utf8'), /created:/);
  } finally {
    h.cleanup();
  }
});

test('a custom source directory is honoured', async () => {
  const h = harness(
    WITH_BLOCK,
    { 'api/ping.js': handler('GET /ping'), 'src/functions/existing.js': handler('GET /existing') },
    { source: 'api' },
  );
  try {
    await h.plugin.hooks.initialize();
    const text = readFileSync(path.join(h.dir, 'serverless.yml'), 'utf8');
    assert.match(text, /ping:/);
  } finally {
    h.cleanup();
  }
});
