import path from 'node:path';

const supportsColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

const ESC = '\u001b';
const paint = (code) => (s) => (supportsColor ? `${ESC}[${code}m${s}${ESC}[0m` : s);
const dim = paint('2');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');
const bold = paint('1');

function pad(s, width) {
  return s + ' '.repeat(Math.max(0, width - s.length));
}

/**
 * Format a result from `updateServerlessConfig` as human-readable lines.
 *
 * @param {object} result
 * @param {object} [options]
 * @param {string} [options.prefix] label prefixed to each line
 * @param {boolean} [options.dryRun] describe changes as pending, not applied
 * @param {string} [options.cwd] base for relative paths
 */
export function formatReport(result, options = {}) {
  const { prefix = '', dryRun = false, cwd = process.cwd() } = options;
  const p = prefix ? `${dim(prefix)} ` : '';
  const out = [];

  if (result.error) {
    out.push(`${p}${red('error')} ${result.error}`);
    for (const problem of result.problems) {
      out.push(`${p}  ${red('·')} ${problem}`);
    }
    return out;
  }

  const { added, changed, unchanged, stale } = result.plan;

  if (added.length === 0 && changed.length === 0) {
    const n = unchanged.length;
    out.push(`${p}${green('✓')} serverless.yml up to date ${dim(`(${n} function${n === 1 ? '' : 's'})`)}`);
  } else {
    const verb = dryRun ? 'would update' : 'updated';
    const bits = [];
    if (added.length > 0) bits.push(`+${added.length} new`);
    if (changed.length > 0) bits.push(`~${changed.length} changed`);
    out.push(`${p}${green('✓')} ${verb} ${bold(path.relative(cwd, result.configPath) || 'serverless.yml')} ${dim(`(${bits.join(', ')})`)}`);
  }

  const width = Math.max(
    0,
    ...added.map((r) => r.name.length),
    ...changed.map((c) => c.route.name.length),
  );

  for (const route of added) {
    out.push(
      `${p}  ${green('+')} ${pad(route.name, width)}  ${bold(route.method.toUpperCase())} ${route.path} ${dim(`← ${route.file}`)}`,
    );
  }
  for (const item of changed) {
    out.push(
      `${p}  ${yellow('~')} ${pad(item.route.name, width)}  ${dim(item.diffs.join(', '))}`,
    );
  }

  if (stale.length > 0) {
    out.push(
      `${p}${yellow('⚠')} ${stale.length} function${stale.length === 1 ? '' : 's'} in serverless.yml not matched to a handler:`,
    );
    for (const entry of stale) {
      // A missing handler file is a real defect (the function deploys but fails
      // at runtime); an existing one is simply a route the tool does not manage.
      const note = entry.handlerMissing
        ? red('handler file not found')
        : dim('not an http route, or hand-written');
      out.push(`${p}    ${entry.name}  ${dim(entry.handler ?? '')} ${note}`);
    }
    out.push(`${p}  ${dim('Left unchanged.')}`);
  }

  for (const problem of result.problems) {
    out.push(`${p}${yellow('⚠')} ${problem}`);
  }

  return out;
}
