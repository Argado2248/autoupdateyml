# autoupdateyml

Keeps the `functions:` block in `serverless.yml` in sync with your handlers.

Install it and deploy — new handlers are wired up automatically, with no
annotations and no configuration:

```
$ serverless deploy
auto-routes: ✓ updated serverless.yml (+2 new)
auto-routes:   + createOrder  POST /orders          ← functions/createOrder/index.mjs
auto-routes:   + getOrderById GET  /orders/{id}     ← functions/getOrderById/index.mjs
Deploying my-api to stage dev (eu-north-1)
```

The route comes from the handler's name and location; the method from its verb
prefix. Add a `@route` comment only when you want something different.

## Install

This package is not published to npm. Install it straight from GitHub, in the
project whose `serverless.yml` you want kept in sync:

```bash
npm install --save-dev github:Argado2248/autoupdateyml
```

The install registers the plugin in your `serverless.yml` for you, so there is
nothing else to set up. It also adds a `devDependencies` entry, so on any other
machine a plain `npm install` is enough.

If you install with `--ignore-scripts` (or your CI does), run the registration
step yourself:

```bash
npx autoupdateyml-register
```

To track a branch rather than the default one, append `#branch-name`:

```bash
npm install --save-dev "github:Argado2248/autoupdateyml#worktree-serverless-auto-routes"
```

This is the line it adds:

```yaml
plugins:
  - autoupdateyml/plugin
```

`serverless deploy` now updates the config before it deploys, and the functions
it writes are part of that same deploy.

### Without npm

You can instead copy the `plugins/auto-routes`, `src` and `bin` directories into
your project and point at the local path. The plugin resolves `src` relative to
itself, so keep them siblings:

```yaml
plugins:
  - ./plugins/auto-routes
```


## How routes are inferred

For a handler with no annotation:

- **Method** comes from the verb the name starts with.
  `get`/`list`/`fetch`/`find`/`read`/`show` → GET, `create`/`add`/`insert`/`post`/`submit`/`register` → POST,
  `replace`/`put`/`set` → PUT, `update`/`edit`/`patch`/`modify` → PATCH,
  `delete`/`remove`/`destroy` → DELETE. An unrecognised verb falls back to GET.
- **Resource** is the rest of the name, pluralized: `createOrder` → `/orders`.
- **Directories** above the handler become path prefixes, so
  `functions/admin/deleteAuditLog.js` → `/admin/audit-logs/{id}`. A folder that
  merely repeats the handler name (`functions/listProducts/index.mjs`) does not.
- **Id parameters** are added for a `ById` suffix, for a `[id]` / `{id}` / `:id`
  directory segment, and for PUT/PATCH/DELETE on a singular resource name.

| File | Route |
| --- | --- |
| `functions/listProducts/index.mjs` | `GET /products` |
| `functions/getOrderById/index.mjs` | `GET /orders/{id}` |
| `src/functions/createInvoice.ts` | `POST /invoices` |
| `src/functions/removeBooking.ts` | `DELETE /bookings/{id}` |
| `api/bookings/post.js` | `POST /bookings` |
| `functions/tickets/[id]/get.js` | `GET /tickets/{id}` |

A route already present in `serverless.yml` is never moved by inference — the
deployed path wins, so installing this into an existing project cannot change
a live endpoint. Inference only decides routes the config has not seen before.

Files that export several named symbols are treated as helper modules, not
handlers, and are skipped.
## Overriding a route

Inference covers the common cases. When you need an exact route — a path that
does not follow from the name, or a method the verb does not imply — put a
JSDoc block directly above the exported handler. An annotation always wins.

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
npx autoupdateyml -s api       # scan ./api instead of auto-detecting
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
    source: functions  # directory to scan  (default: auto-detect)
    eventType: httpApi # http | httpApi     (default: match the file)
    strict: false    # fail on a malformed annotation
    enabled: true    # set false to disable the deploy hook
```

## What it does and does not touch

The `functions:` block is rewritten as text, not parsed and re-dumped, so
everything else in the file survives byte for byte — comments, key order,
`${self:...}` and `${sls:stage}` variables, `resources:`, `provider:`.

Inside `functions:`, entries with no matching handler are **left alone** and
reported:

```
⚠ 2 functions in serverless.yml not matched to a handler:
    legacyWebhook  src/legacy/webhook.handler     not an http route, or hand-written
    ghost          functions/ghost/index.handler  handler file not found
  Left unchanged.
```

This keeps hand-written entries safe — a function wired to SQS, SNS or a schedule
is preserved rather than deleted. The tool never removes a function; pruning dead
entries stays a manual decision. An entry whose handler file is missing is called
out separately, since it deploys but fails at runtime.

When an annotation and the config disagree, the annotation wins and the change
is reported:

```
✓ updated serverless.yml (~1 changed)
  ~ createUser  method post -> put, path /users -> /users/{id}
```

## Notes

- Requires Node 18+. No runtime dependencies.
- Generated events match the style the config already uses — `httpApi`
  (API Gateway v2) or `http` (REST) — so the tool never introduces a second,
  conflicting API. `custom.autoRoutes.eventType` overrides the detection.
- Scanned: `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`. Skipped: `node_modules`,
  `dist`, `build`, `.serverless`, `*.test.*`, `*.spec.*`, `*.d.ts`.
- Duplicate routes and duplicate function names are reported as warnings; use
  `--strict` to make them fail.
- Only the first `http` event of an existing function is compared. A function
  with several events is reported as changed only if that first one drifts.
- A `serverless.yml` with no `functions:` key at all is handled: the framework
  loads the file before the plugin runs, so the generated functions are also
  injected into the in-memory service to keep that first deploy correct.
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
