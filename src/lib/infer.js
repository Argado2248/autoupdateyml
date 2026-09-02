/**
 * Route inference for handlers that carry no annotation.
 *
 * The goal is that installing the tool is enough: an existing project should
 * work with no edits to its source. A `@route` annotation always wins when one
 * is present; this module is the fallback that makes the zero-config case work.
 */

/**
 * Verb prefixes mapped to HTTP methods. Order matters only in that longer
 * prefixes must be tested before shorter ones that share a start.
 */
const VERBS = [
  ['list', 'get'],
  ['getAll', 'get'],
  ['fetch', 'get'],
  ['read', 'get'],
  ['show', 'get'],
  ['find', 'get'],
  ['get', 'get'],
  ['create', 'post'],
  ['add', 'post'],
  ['insert', 'post'],
  ['post', 'post'],
  ['submit', 'post'],
  ['register', 'post'],
  ['replace', 'put'],
  ['put', 'put'],
  ['set', 'put'],
  ['update', 'patch'],
  ['edit', 'patch'],
  ['patch', 'patch'],
  ['modify', 'patch'],
  ['delete', 'delete'],
  ['remove', 'delete'],
  ['destroy', 'delete'],
];

/**
 * Suffixes that signal the route addresses a single item by id, e.g.
 * `getOrderById` -> `/orders/{id}`.
 */
const BY_ID_SUFFIX = /(ById|ByID|Byid|_by_id|-by-id)$/;

/** Split a camelCase / kebab / snake identifier into lowercase words. */
export function words(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** Naive English pluralization, good enough for resource path segments. */
export function pluralize(word) {
  if (!word) return word;
  // A trailing digit is a version or variant marker, not a noun ending, so
  // pluralizing it produces nonsense like "handler2s". Leave it as written.
  if (/\d$/.test(word)) return word;
  // Already plural — leave it alone. Checked first so "orders" does not become
  // "orderses" via the sibilant rule below.
  if (/s$/i.test(word)) return word;
  if (/(x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/**
 * Split a handler identifier into its verb and the resource it acts on.
 * Returns `{ method, rest }`, where `rest` is the remaining words. When no verb
 * prefix is recognised the method defaults to GET and every word is the resource.
 */
export function splitVerb(name) {
  const stripped = name.replace(BY_ID_SUFFIX, '');
  const parts = words(stripped);
  if (parts.length === 0) return { method: 'get', rest: [], matched: false };

  for (const [prefix, method] of VERBS) {
    const prefixWords = words(prefix);
    const head = parts.slice(0, prefixWords.length).join('');
    if (head === prefixWords.join('')) {
      return { method, rest: parts.slice(prefixWords.length), matched: true };
    }
  }
  return { method: 'get', rest: parts, matched: false };
}

/**
 * Infer a route from a handler's file path.
 *
 * The resource comes from the identifier's words after the verb; when the name
 * is only a verb (`functions/orders/get.mjs`) the containing directory names
 * the resource instead. A `ById` suffix, or a `[id]` / `{id}` / `:id` path
 * segment, appends an `{id}` parameter.
 *
 * @param {string} relPath  handler path relative to the project root
 * @param {string} baseName identifier the route is derived from
 * @returns {{ method: string, path: string, confident: boolean }}
 */
export function inferRoute(relPath, baseName) {
  const segments = relPath.split(/[\\/]/).slice(0, -1);
  const byId = BY_ID_SUFFIX.test(baseName);
  const { method, rest, matched } = splitVerb(baseName);

  // Dynamic segments already expressed in the directory layout.
  const dynamic = [];
  const staticSegments = [];
  for (const seg of segments) {
    const param = seg.match(/^[[{:]([A-Za-z0-9_]+)[\]}]?$/);
    if (param) dynamic.push(param[1]);
    else if (!['functions', 'function', 'src', 'handlers', 'api', 'lambda', 'lambdas'].includes(seg)) {
      staticSegments.push(seg);
    }
  }

  let resource;
  let ownDirConsumed = false;

  if (rest.length > 0) {
    // The identifier names the resource: listProducts -> products.
    resource = pluralize(rest.join('-'));
    // A handler in its own folder (functions/listProducts/index.mjs) has a
    // directory that merely restates the identifier — it must not also become a
    // path segment, or the route reads /list-products/products.
    const ownDir = staticSegments[staticSegments.length - 1];
    if (ownDir && words(ownDir).join('') === words(baseName).join('')) {
      ownDirConsumed = true;
    }
  } else if (staticSegments.length > 0) {
    // The identifier was only a verb; the directory names the resource.
    resource = pluralize(words(staticSegments[staticSegments.length - 1]).join('-'));
    ownDirConsumed = true;
  } else {
    resource = '';
  }

  // Remaining directories above the handler become path prefixes, minus any
  // that just repeat the resource we already derived.
  const prefixSource = ownDirConsumed ? staticSegments.slice(0, -1) : staticSegments;
  const prefix = prefixSource
    .map((seg) => words(seg).join('-'))
    .filter((seg) => seg && seg !== resource && pluralize(seg) !== resource);

  const parts = [...prefix, resource].filter(Boolean);
  let routePath = `/${parts.join('/')}`;

  for (const param of dynamic) routePath += `/{${param}}`;

  // PUT / PATCH / DELETE address a single item, so a singular resource name
  // implies an id parameter: removeBooking -> DELETE /bookings/{id}. A plural
  // name (removeBookings) is treated as a bulk operation and left alone.
  const singularResource = rest.length > 0 && !/s$/i.test(rest[rest.length - 1]);
  const itemMethod = ['put', 'patch', 'delete'].includes(method);

  if (byId && dynamic.length === 0) routePath += '/{id}';
  else if (dynamic.length === 0 && itemMethod && singularResource) routePath += '/{id}';

  if (routePath.length > 1) routePath = routePath.replace(/\/+$/, '');
  routePath = routePath.replace(/\/{2,}/g, '/');

  return { method, path: routePath || '/', confident: matched };
}
