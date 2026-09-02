# autoupdateyml

Keeps the `functions:` block in `serverless.yml` in sync with your handlers.

Annotate a handler with the route it serves, and the block is regenerated for you
— on every `serverless deploy`, before the deploy happens.

```js
/**
 * @route POST /users
 */
export const handler = async (event) => { ... };
```

```yaml
functions:
  createUser:
    handler: src/functions/createUser.handler
    events:
      - http:
          path: '/users'
          method: post
```

## Install

This package is not published to npm. Install it straight from GitHub, in the
project whose `serverless.yml` you want kept in sync:

```bash
npm install --save-dev github:Argado2248/autoupdateyml
```

That adds a `devDependencies` entry, so on any other machine a plain
`npm install` is enough — nothing else to set up.

To track a branch rather than the default one, append `#branch-name`:

```bash
npm install --save-dev "github:Argado2248/autoupdateyml#worktree-serverless-auto-routes"
```

Then register the plugin in `serverless.yml`:

```yaml
plugins:
  - autoupdateyml/plugin
```

That is the whole setup. `serverless deploy` now updates the config before it
deploys, and the functions it writes are part of that same deploy.

### Without npm

You can instead copy the `plugins/auto-routes`, `src` and `bin` directories into
your project and point at the local path. The plugin resolves `src` relative to
itself, so keep them siblings:

```yaml
plugins:
  - ./plugins/auto-routes
```

```
$ serverless deploy
auto-routes: ✓ updated serverless.yml (+2 new)
auto-routes:   + createUser   POST /users        ← src/functions/createUser.js
auto-routes:   + healthCheck  GET  /health       ← src/functions/health.js
Deploying notiscan-api to stage dev (eu-north-1)
```

## Annotations

Put a JSDoc block directly above the exported handler.

| Tag | Purpose |
| --- | --- |
| `@route <METHOD> <path>` | Method and path in one line |
| `@method` + `@path` | The same, split across two tags |
| `@name` | Override the function name (defaults to the filename) |
| `@cors` | Emit `cors: true` on the http event |
| `@authorizer` | Emit an `authorizer` on the http event |

```js
/**
 * @route GET /users/{id}
 */
export const handler = async (event) => { ... };

/**
 * @method PUT
 * @path   /users/:id/profile     // :id is rewritten to {id}
 * @name   updateProfile
 * @cors   true
 */
export async function updateProfile(event) { ... }
```

Methods: `get`, `post`, `put`, `patch`, `delete`, `head`, `options`, `any`.

**Naming.** The function name comes from the filename — `getUser.js` → `getUser`,
`get-user.js` → `getUser`, `users/index.js` → `users`. Use `@name` when that is
not what you want. Several annotated exports can live in one file; give each its
own `@name`.

## CLI

The plugin covers the normal workflow. The CLI is there for CI and for running
the sync on its own.

```bash
npx autoupdateyml              # update serverless.yml
npx autoupdateyml --check      # report only; exit 1 if out of date
npx autoupdateyml --strict     # exit non-zero on a malformed annotation
npx autoupdateyml -s api       # scan ./api instead of ./src
```

`--check` is the CI form — it fails the build when someone adds a handler and
forgets to commit the regenerated config:

```yaml
- run: npx autoupdateyml --check
```

You can also run it through the framework, which uses the same config:

```bash
serverless routes          # sync
serverless routes --check  # report only
```

## Configuration

Optional, under `custom` in `serverless.yml`:

```yaml
custom:
  autoRoutes:
    source: src      # directory to scan   (default: src)
    strict: false    # fail on a malformed annotation
    enabled: true    # set false to disable the deploy hook
```

## What it does and does not touch

The `functions:` block is rewritten as text, not parsed and re-dumped, so
everything else in the file survives byte for byte — comments, key order,
`${self:...}` and `${sls:stage}` variables, `resources:`, `provider:`.

Inside `functions:`, entries with no matching annotated handler are **left
alone** and reported:

```
⚠ 1 function in serverless.yml with no annotated source:
    legacyWebhook
  Left unchanged — remove by hand if dead.
```

This is what keeps hand-written entries safe — a function wired to SQS, SNS, or a
schedule has no `@route` to find, so it is preserved rather than deleted. The
tool never removes a function; pruning dead entries stays a manual decision.

When an annotation and the config disagree, the annotation wins and the change
is reported:

```
✓ updated serverless.yml (~1 changed)
  ~ createUser  method post -> put, path /users -> /users/{id}
```

## Notes

- Requires Node 18+. No runtime dependencies.
- Scanned: `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`. Skipped: `node_modules`,
  `dist`, `build`, `.serverless`, `*.test.*`, `*.spec.*`, `*.d.ts`.
- Duplicate routes and duplicate function names are reported as warnings; use
  `--strict` to make them fail.
- Only the first `http` event of an existing function is compared. A function
  with several events is reported as changed only if that first one drifts.
- Tested against Serverless Framework v4. The plugin also registers
  `before:package:createDeploymentArtifacts` and `before:deploy:deploy` as
  fallbacks for older versions; if the config is rewritten at that later point
  the deploy stops and asks you to re-run, rather than shipping a stale config.

## Development

```bash
npm test
```

Structural tests parse the generated YAML with PyYAML (`pip install pyyaml`) to
verify event nesting — a regex can match `path:` in output that is nested wrong
and would be rejected at deploy time. They skip if PyYAML is unavailable, so run
them with it installed before trusting a green suite.
