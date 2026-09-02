/**
 * Registering the plugin in `serverless.yml`.
 *
 * Serverless only loads a plugin listed under `plugins:`, so an install that
 * stops at `node_modules` leaves the tool inert — it never runs, and says
 * nothing about why. This module adds the entry, and is also used by the plugin
 * itself to detect the un-registered state.
 *
 * As with the functions block, the file is edited as text so comments, key
 * order and `${...}` variables survive untouched.
 */

export const PLUGIN_NAME = 'autoupdateyml/plugin';

// A vendored copy registers by path instead; treat either as "already there".
const PLUGIN_PATTERNS = [
  /^\s*-\s*['"]?autoupdateyml\/plugin['"]?\s*(#.*)?$/,
  /^\s*-\s*['"]?\.\/plugins\/auto-routes['"]?\s*(#.*)?$/,
];

function isBlank(line) {
  return line.trim() === '';
}

function isComment(line) {
  return line.trimStart().startsWith('#');
}

/**
 * Is the plugin already listed?
 *
 * Handles both block sequences and the inline flow form
 * (`plugins: [a, b]`), since either is valid YAML.
 */
export function isRegistered(content) {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => /^plugins:/.test(l));
  if (start === -1) return false;

  const inline = lines[start].slice('plugins:'.length).trim();
  if (inline.startsWith('[')) {
    return /autoupdateyml\/plugin|\.\/plugins\/auto-routes/.test(inline);
  }

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (isBlank(line) || isComment(line)) continue;
    // A non-indented line ends the block.
    if (!/^\s/.test(line)) break;
    if (PLUGIN_PATTERNS.some((re) => re.test(line))) return true;
  }
  return false;
}

/**
 * Add the plugin to `serverless.yml`, creating the `plugins:` block if needed.
 *
 * @returns {{ content: string, changed: boolean, reason: string }}
 *   `content` is the updated document (unchanged when `changed` is false).
 */
export function addPlugin(content) {
  if (isRegistered(content)) {
    return { content, changed: false, reason: 'already registered' };
  }

  const lines = content.split('\n');
  const start = lines.findIndex((l) => /^plugins:/.test(l));

  // An existing block: append to it, matching the indent already in use.
  if (start !== -1) {
    const inline = lines[start].slice('plugins:'.length).trim();
    if (inline.startsWith('[')) {
      // Flow sequence: splice into the brackets.
      const updated = lines[start].replace(
        /\[(.*)\]/,
        (_, inner) => (inner.trim() === '' ? `[${PLUGIN_NAME}]` : `[${inner.trim()}, ${PLUGIN_NAME}]`),
      );
      lines[start] = updated;
      return { content: lines.join('\n'), changed: true, reason: 'added to inline list' };
    }

    let end = start + 1;
    let indent = '  ';
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (isBlank(line) || isComment(line)) continue;
      if (!/^\s/.test(line)) break;
      const m = line.match(/^(\s*)-/);
      if (m) indent = m[1];
      end = i + 1;
    }
    lines.splice(end, 0, `${indent}- ${PLUGIN_NAME}`);
    return { content: lines.join('\n'), changed: true, reason: 'added to existing plugins block' };
  }

  // No block at all: insert one above the first top-level key that is not part
  // of the service header, so it reads naturally rather than landing at the end.
  const anchors = ['provider:', 'functions:', 'custom:', 'resources:', 'package:'];
  let insertAt = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (anchors.some((a) => lines[i].startsWith(a))) {
      insertAt = i;
      break;
    }
  }

  const block = ['plugins:', `  - ${PLUGIN_NAME}`, ''];
  if (insertAt === -1) {
    // Nothing recognisable to anchor to: append, keeping one blank separator.
    while (lines.length > 0 && isBlank(lines[lines.length - 1])) lines.pop();
    lines.push('', ...block.slice(0, 2), '');
  } else {
    lines.splice(insertAt, 0, ...block);
  }

  return { content: lines.join('\n'), changed: true, reason: 'created plugins block' };
}
