# autoupdateyml

**Stop hand-editing `serverless.yml` every time you add a Lambda.**

Write a handler file. Run `serverless deploy`. That's it — the function and its
route are added to `serverless.yml` automatically, before the deploy happens, so
the new endpoint goes live in that same command.

---

## The problem

Adding one endpoint to a Serverless project normally means two steps:

1. Write the handler.
2. Remember to open `serverless.yml` and hand-write the function entry, its
   handler path, its HTTP method and its route.

Step 2 is easy to forget and easy to typo. You find out when the endpoint 404s,
or when the deploy fails on a handler path that points at nothing.

## The fix

This tool does step 2 for you.

```
$ serverless deploy

auto-routes: ✓ updated serverless.yml (+1 new)
auto-routes:   + createOrder  POST /orders  ← functions/createOrder/index.mjs

✔ Service deployed to stack my-api-dev (36s)

endpoints:
  POST - https://abc123.execute-api.eu-north-1.amazonaws.com/orders
```

You wrote `functions/createOrder/index.mjs`. You ran `serverless deploy`. The
endpoint is live. Nothing else.

---

## Install

```bash
npm install --save-dev github:Argado2248/autoupdateyml
```

**That's the whole setup.** The install also registers the plugin in your
`serverless.yml` for you, adding this:

```yaml
plugins:
  - autoupdateyml/plugin
```

Your next `serverless deploy` picks it up. No config file to write, no
directories to declare.

### On another machine

The install saves it to `devDependencies`, so anyone who clones the project just
runs:

```bash
npm install
```

### If the auto-registration was skipped

npm skips install scripts when you use `--ignore-scripts`, and some CI setups do
this by default. If `plugins:` did not appear in your `serverless.yml`, run:

```bash
npx autoupdateyml-register
```

**Requirements:** Node 18+ and the Serverless Framework. No runtime dependencies.

---

## How it names your routes

You don't annotate anything. The route is read from the handler's **filename**
and the method from the **verb it starts with**.

| Your file | Becomes |
| --- | --- |
| `functions/listProducts/index.mjs` | `GET /products` |
| `functions/getOrderById/index.mjs` | `GET /orders/{id}` |
| `functions/createInvoice/index.mjs` | `POST /invoices` |
| `functions/updateBooking/index.mjs` | `PATCH /bookings/{id}` |
| `functions/removeSession/index.mjs` | `DELETE /sessions/{id}` |

The rules, in plain terms:

**The verb picks the method.**

| Name starts with | Method |
| --- | --- |
| `get` `list` `fetch` `find` `read` `show` | GET |
| `create` `add` `insert` `post` `submit` `register` | POST |
| `replace` `put` `set` | PUT |
| `update` `edit` `patch` `modify` | PATCH |
| `delete` `remove` `destroy` | DELETE |

An unrecognised verb falls back to GET.

**The rest of the name is the resource**, pluralized — `createOrder` → `/orders`.

**Folders become path prefixes** — `functions/admin/deleteAuditLog.js` →
`DELETE /admin/audit-logs/{id}`. A folder that just repeats the handler name
(`functions/listProducts/index.mjs`) is not doubled up.

**An `{id}` is added** when the name ends in `ById`, when a folder is named
`[id]` / `{id}` / `:id`, or when a PUT/PATCH/DELETE acts on a singular noun
(`removeBooking` is one booking, so `/bookings/{id}`).

Where it looks: `functions/`, `src/`, `handlers/`, `api/` or `lambdas/` —
whichever exists — plus handler files sitting next to `serverless.yml`.

---

## When you want a different route

Guessing from a filename won't always give you the URL you want. Put a comment
above the handler and it wins over everything above:

```js
/**
 * @route GET /v2/customers/{id}/invoices
 */
export const handler = async (event) => { ... };
```

Other tags, all optional:

| Tag | What it does |
| --- | --- |
| `@route GET /path` | Method and path in one line |
| `@method` + `@path` | The same, split in two |
| `@name` | Name the function something other than the filename |
| `@cors` | Add `cors: true` to the event |
| `@authorizer` | Add an authorizer to the event |

```js
/**
 * @method PUT
 * @path   /users/:id/profile     ← :id becomes {id}
 * @name   updateProfile
 */
export async function updateProfile(event) { ... }
```

---

## What it will never do to your file

This edits a file you have hand-maintained, so the rules are deliberately
cautious.

**It never deletes a function.** An entry with no matching handler is left
exactly where it is and reported:

```
⚠ 2 functions in serverless.yml not matched to a handler:
    legacyWebhook  src/legacy/webhook.handler     not an http route, or hand-written
    ghost          functions/ghost/index.handler  handler file not found
  Left unchanged.
```

That keeps your SQS, SNS and scheduled functions safe — they have no route to
find, so they are preserved, not pruned. Deleting is your call, never the tool's.

**It never moves an endpoint that is already live.** If a function is already in
`serverless.yml`, its existing method and path win — even if the filename
suggests otherwise. Installing this into a working project cannot change a URL
your users are already calling. Guessing only applies to routes the file has not
seen before.

**It never touches anything outside `functions:`.** The block is rewritten as
text rather than parsed and re-dumped, so your comments, key order,
`${self:...}` variables, `provider:` and `resources:` all survive byte for byte.

**It matches your API Gateway style.** If your file uses `httpApi` (v2), you get
`httpApi` entries; if it uses `http` (REST), you get `http`. It will not quietly
stand up a second, conflicting API.

---

## Running it without deploying

The plugin covers the normal workflow. The CLI is there when you want the sync on
its own:

```bash
npx autoupdateyml           # update serverless.yml now
npx autoupdateyml --check   # just show what would change (exits 1 if out of date)
```

`--check` is useful in CI to catch a handler someone added without committing the
regenerated config:

```yaml
- run: npx autoupdateyml --check
```

Same thing through the framework:

```bash
serverless routes           # sync
serverless routes --check   # report only
```

---

## Configuration

There isn't any required. If you need it, under `custom` in `serverless.yml`:

```yaml
custom:
  autoRoutes:
    source: functions   # where to scan      (default: auto-detect)
    eventType: httpApi  # http | httpApi     (default: match your file)
    strict: false       # fail on a bad annotation
    enabled: true       # false turns the deploy hook off
```

---

## Good to know

- Scans `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`. Skips `node_modules`,
  `dist`, `build`, `.serverless`, `*.test.*`, `*.spec.*` and `*.d.ts`.
- A file exporting several named symbols is treated as a shared helper, not a
  handler, and is skipped.
- Duplicate routes and duplicate function names are reported as warnings. Use
  `--strict` to turn them into failures.
- Only the **first** `http` event of an existing function is compared, so a
  function with several events is only flagged if that first one drifts.
- An entry whose handler file is missing is called out separately — it deploys
  successfully and then fails at runtime, which is easy to miss otherwise.

---

## Contributing

```bash
npm test
```

Some tests parse the generated YAML with PyYAML (`pip install pyyaml`) to check
that events are nested correctly — a regex can happily match a `path:` that sits
at the wrong indent and would be rejected at deploy time. Those tests skip when
PyYAML is missing, so install it before trusting a green run.

---

## A word of caution

**This tool edits your `serverless.yml` and it runs as part of your deploy.**
It has been tested against Serverless Framework v4 and is used in practice, but
it is not a mature, widely-deployed package, and it has not been exercised
against every project layout in the wild.

Please:

- **Keep `serverless.yml` in version control.** Then any edit you dislike is one
  `git diff` and one `git checkout` away. This is the single thing that makes the
  tool safe to try.
- **Run `npx autoupdateyml --check` first** on an existing project, to see what it
  would do before it does anything.
- **Read the diff before your first deploy to an environment you care about.**
- Consider `custom.autoRoutes.enabled: false` on production stages if you would
  rather the deploy hook not run there.

The design is deliberately conservative — it never deletes a function, never
moves a route that already exists, and never touches anything outside the
`functions:` block. But inference is still inference: a handler name it reads
differently than you would produces a route you did not intend, and on a first
run against an unfamiliar layout it may pick up files you did not think of as
endpoints.

Provided as-is, without warranty of any kind. You are responsible for what you
deploy — check the diff, and don't point it at production without trying it
somewhere safe first.
