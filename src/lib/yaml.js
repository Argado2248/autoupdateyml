/**
 * Minimal, surgical handling of the `functions:` block in a serverless.yml.
 *
 * We deliberately do not parse-and-redump the whole document: that would drop
 * comments, rewrite `${self:...}` variables and reorder keys. Instead we locate
 * the byte range of the `functions:` block, read just enough structure out of it
 * to compare against the scanned routes, and splice a regenerated block back in.
 */

const MANAGED_MARK = '# managed by autoupdateyml';

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function isBlank(line) {
  return line.trim() === '';
}

function isComment(line) {
  return line.trimStart().startsWith('#');
}

/**
 * Locate the top-level `functions:` block.
 *
 * @returns {{ found: boolean, start: number, end: number, indent: number }}
 *   `start` is the index of the `functions:` line and `end` is the index one
 *   past the block's last line. When absent, `found` is false and `start` marks
 *   where the block should be inserted.
 */
export function findFunctionsBlock(lines) {
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isBlank(line) || isComment(line)) continue;
    if (indentOf(line) === 0 && /^functions:\s*(#.*)?$/.test(line)) {
      start = i;
      break;
    }
  }

  if (start === -1) {
    return { found: false, start: lines.length, end: lines.length, indent: 2 };
  }

  let end = start + 1;
  let lastContent = start;
  let indent = null;

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (isBlank(line)) {
      end = i + 1;
      continue;
    }
    if (indentOf(line) === 0) break;
    if (indent === null && !isComment(line)) indent = indentOf(line);
    lastContent = i;
    end = i + 1;
  }

  return { found: true, start, end: lastContent + 1, indent: indent ?? 2 };
}

/**
 * Read the existing function entries well enough to diff against scanned routes.
 * Captures each entry's name, handler, and its first http event's method/path.
 * Entries we cannot interpret are still recorded (with `parsed: false`) so they
 * are preserved verbatim rather than silently rewritten.
 */
export function readExistingFunctions(lines, block) {
  if (!block.found) return [];

  const entries = [];
  const body = lines.slice(block.start + 1, block.end);
  const baseIndent = block.indent;

  let current = null;
  for (const line of body) {
    if (isBlank(line) || isComment(line)) {
      if (current) current.raw.push(line);
      continue;
    }
    const ind = indentOf(line);
    const nameMatch = line.match(/^\s*([A-Za-z0-9_$-]+):\s*(#.*)?$/);

    if (ind === baseIndent && nameMatch) {
      if (current) entries.push(current);
      current = {
        name: nameMatch[1],
        handler: null,
        method: null,
        path: null,
        managed: line.includes(MANAGED_MARK),
        raw: [line],
      };
      continue;
    }

    if (!current) continue;
    current.raw.push(line);

    const handlerMatch = line.match(/^\s*handler:\s*(.+?)\s*(#.*)?$/);
    if (handlerMatch && current.handler === null) {
      current.handler = handlerMatch[1].trim();
      continue;
    }
    const methodMatch = line.match(/^\s*method:\s*(.+?)\s*(#.*)?$/);
    if (methodMatch && current.method === null) {
      current.method = methodMatch[1].trim().toLowerCase().replace(/^['"]|['"]$/g, '');
      continue;
    }
    const pathMatch = line.match(/^\s*path:\s*(.+?)\s*(#.*)?$/);
    if (pathMatch && current.path === null) {
      current.path = pathMatch[1].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  if (current) entries.push(current);

  return entries;
}

function quotePath(p) {
  return `'${p.replace(/'/g, "''")}'`;
}

/**
 * Render one function entry. `indent` is the block's base indent; nested levels
 * step by the same amount so the output matches the file's existing style.
 */
export function renderFunction(route, indent) {
  const pad = ' '.repeat(indent);
  const step = ' '.repeat(indent);
  const lines = [];

  lines.push(`${pad}${route.name}:`);
  lines.push(`${pad}${step}handler: ${route.handler}`);
  lines.push(`${pad}${step}events:`);
  lines.push(`${pad}${step}${step}- http:`);
  // Keys under `- http:` must sit deeper than the `http` key itself, which the
  // two-character "- " bullet already pushes right; otherwise they parse as
  // siblings of `http` and the event resolves to null.
  const ev = `${pad}${step}${step}  ${step}`;
  lines.push(`${ev}path: ${quotePath(route.path)}`);
  lines.push(`${ev}method: ${route.method}`);
  if (route.cors !== undefined) lines.push(`${ev}cors: ${route.cors}`);
  if (route.authorizer) lines.push(`${ev}authorizer: ${route.authorizer}`);

  return lines;
}

/**
 * Compute the change set between scanned routes and the existing YAML entries.
 * Nothing is written here; the caller decides what to do with the plan.
 */
export function diffRoutes(routes, existing) {
  const byName = new Map(existing.map((e) => [e.name, e]));
  const added = [];
  const changed = [];
  const unchanged = [];

  for (const route of routes) {
    const prev = byName.get(route.name);
    if (!prev) {
      added.push(route);
      continue;
    }
    const diffs = [];
    if (prev.handler !== null && prev.handler !== route.handler) {
      diffs.push(`handler ${prev.handler} -> ${route.handler}`);
    }
    if (prev.method !== null && prev.method !== route.method) {
      diffs.push(`method ${prev.method} -> ${route.method}`);
    }
    if (prev.path !== null && prev.path !== route.path) {
      diffs.push(`path ${prev.path} -> ${route.path}`);
    }
    if (diffs.length > 0) changed.push({ route, previous: prev, diffs });
    else unchanged.push(route);
  }

  const scannedNames = new Set(routes.map((r) => r.name));
  const stale = existing.filter((e) => !scannedNames.has(e.name));

  return { added, changed, unchanged, stale };
}

/**
 * Produce the updated file content. Stale entries are preserved verbatim, in
 * their original position relative to the managed ones.
 */
export function applyUpdate(content, routes, plan) {
  const lines = content.split('\n');
  const block = findFunctionsBlock(lines);
  const indent = block.indent;

  const managedNames = new Set(routes.map((r) => r.name));
  const rendered = [];

  // Preserve stale (hand-written) entries first, exactly as they were.
  for (const entry of plan.stale) {
    let raw = [...entry.raw];
    while (raw.length > 0 && isBlank(raw[raw.length - 1])) raw.pop();
    rendered.push(...raw);
  }

  for (const route of routes) {
    if (!managedNames.has(route.name)) continue;
    rendered.push(...renderFunction(route, indent));
  }

  const head = lines.slice(0, block.found ? block.start : block.start);
  const tail = lines.slice(block.end);

  const out = [...head];
  if (!block.found) {
    while (out.length > 0 && isBlank(out[out.length - 1])) out.pop();
    if (out.length > 0) out.push('');
  }
  out.push('functions:');
  out.push(...rendered);
  out.push(...tail);

  let text = out.join('\n');
  if (!text.endsWith('\n')) text += '\n';
  return text;
}
