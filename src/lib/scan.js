import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const HANDLER_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.serverless']);
const TEST_FILE = /\.(test|spec)\.[mc]?[jt]s$/;
const DECLARATION_FILE = /\.d\.[mc]?ts$/;

export const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'any'];

const JSDOC_BLOCK = /\/\*\*([\s\S]*?)\*\//g;

/**
 * Strip the leading ` * ` decoration from each line of a JSDoc block body so the
 * tag parser sees clean text.
 */
function stripDecoration(body) {
  return body
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join('\n');
}

/**
 * Pull `@tag value` pairs out of a decoration-stripped JSDoc body. A tag's value
 * runs to the end of its line; repeated tags keep the last occurrence so a later
 * annotation overrides an earlier one.
 */
function parseTags(text) {
  const tags = {};
  const re = /^[ \t]*@(\w+)[ \t]*(.*)$/gm;
  let match;
  while ((match = re.exec(text)) !== null) {
    tags[match[1].toLowerCase()] = match[2].trim();
  }
  return tags;
}

/**
 * Normalize a route path to the API Gateway form: leading slash, no trailing
 * slash, `:param` rewritten to `{param}`.
 */
export function normalizePath(raw) {
  let p = raw.trim();
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/:([A-Za-z0-9_]+)/g, '/{$1}');
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p;
}

/**
 * Derive the serverless function name from a handler file path, e.g.
 * `src/functions/users/getUser.js` -> `getUser`. Index files take the name of
 * their containing directory so `users/index.js` -> `users`.
 */
export function functionNameFor(relPath) {
  const parsed = path.parse(relPath);
  const base = parsed.name === 'index' ? path.basename(parsed.dir) : parsed.name;
  const cleaned = base.replace(/[^A-Za-z0-9]+(.)/g, (_, c) => c.toUpperCase());
  return cleaned.replace(/[^A-Za-z0-9]/g, '');
}

/**
 * Build the serverless `handler` reference for a file: the POSIX-style path
 * without extension, joined to the exported symbol.
 */
export function handlerRefFor(relPath, exportName) {
  const withoutExt = relPath.slice(0, relPath.length - path.extname(relPath).length);
  return `${withoutExt.split(path.sep).join('/')}.${exportName}`;
}

/**
 * Find the name of the handler export that a JSDoc block documents, by looking
 * at the code immediately following the block.
 */
function exportNameAfter(source, blockEnd) {
  const tail = source.slice(blockEnd, blockEnd + 400);
  const patterns = [
    /^\s*export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/,
    /^\s*export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/,
    /^\s*(?:module\.)?exports\.([A-Za-z0-9_$]+)\s*=/,
    /^\s*export\s+default\b/,
  ];
  for (const re of patterns) {
    const m = tail.match(re);
    if (m) return m[1] ?? 'default';
  }
  return null;
}

/**
 * Parse one source file into route descriptors. Returns `{ routes, problems }`
 * so a malformed annotation surfaces as a diagnostic rather than being dropped.
 */
export function parseSource(source, relPath) {
  const routes = [];
  const problems = [];
  let match;

  JSDOC_BLOCK.lastIndex = 0;
  while ((match = JSDOC_BLOCK.exec(source)) !== null) {
    const tags = parseTags(stripDecoration(match[1]));
    const hasRoute = 'route' in tags;
    const hasSplit = 'method' in tags || 'path' in tags;
    if (!hasRoute && !hasSplit) continue;

    let method;
    let routePath;

    if (hasRoute) {
      const parts = tags.route.split(/\s+/).filter(Boolean);
      if (parts.length < 2) {
        problems.push(`${relPath}: @route needs a method and a path, got "${tags.route}"`);
        continue;
      }
      [method, routePath] = parts;
    } else {
      if (!tags.method || !tags.path) {
        problems.push(`${relPath}: @method and @path must be used together`);
        continue;
      }
      method = tags.method;
      routePath = tags.path;
    }

    method = method.toLowerCase();
    if (!METHODS.includes(method)) {
      problems.push(`${relPath}: unknown HTTP method "${method}"`);
      continue;
    }

    const exportName = exportNameAfter(source, match.index + match[0].length);
    if (!exportName) {
      problems.push(`${relPath}: @route block is not attached to an exported handler`);
      continue;
    }

    const name = tags.name && tags.name.length > 0
      ? tags.name
      : functionNameFor(relPath);

    routes.push({
      name,
      method,
      path: normalizePath(routePath),
      handler: handlerRefFor(relPath, exportName),
      file: relPath,
      cors: tags.cors ? tags.cors !== 'false' : undefined,
      authorizer: tags.authorizer || undefined,
    });
  }

  return { routes, problems };
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/**
 * Scan a directory tree for annotated handlers.
 *
 * @param {string} root  directory to walk
 * @param {string} cwd   base the emitted handler paths are relative to
 */
export async function scanDirectory(root, cwd = process.cwd()) {
  const routes = [];
  const problems = [];

  for await (const file of walk(root)) {
    const ext = path.extname(file);
    if (!HANDLER_EXT.has(ext)) continue;
    if (TEST_FILE.test(file) || DECLARATION_FILE.test(file)) continue;

    const source = await readFile(file, 'utf8');
    if (!source.includes('@route') && !source.includes('@path')) continue;

    const rel = path.relative(cwd, file);
    const result = parseSource(source, rel);
    routes.push(...result.routes);
    problems.push(...result.problems);
  }

  routes.sort((a, b) => a.name.localeCompare(b.name));

  const seen = new Map();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) {
      problems.push(
        `duplicate route "${key}" declared in ${seen.get(key)} and ${route.file}`,
      );
    } else {
      seen.set(key, route.file);
    }
  }

  const names = new Map();
  for (const route of routes) {
    if (names.has(route.name)) {
      problems.push(
        `duplicate function name "${route.name}" in ${names.get(route.name)} and ${route.file}`,
      );
    } else {
      names.set(route.name, route.file);
    }
  }

  return { routes, problems };
}
