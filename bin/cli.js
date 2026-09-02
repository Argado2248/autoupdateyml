#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { updateServerlessConfig } from '../src/index.js';
import { isRegistered, PLUGIN_NAME } from '../src/lib/register.js';
import { formatReport } from '../src/lib/report.js';

const USAGE = `
autoupdateyml — sync serverless.yml functions with annotated handlers

Usage
  autoupdateyml [options]

Options
  -s, --source <dir>   directory to scan for handlers   (default: src)
  -c, --config <file>  path to serverless config        (default: serverless.yml)
      --check          report changes, write nothing; exit 1 if out of date
      --strict         exit non-zero when an annotation problem is found
  -q, --quiet          only print on changes or problems
  -h, --help           show this message

Annotate a handler with a JSDoc tag:

  /**
   * @route GET /users/{id}
   */
  export const handler = async (event) => { ... };

Supported tags: @route, @method + @path, @name, @cors, @authorizer
`.trim();

function parseArgs(argv) {
  const opts = { check: false, strict: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--check':
      case '--dry-run':
        opts.check = true;
        break;
      case '--strict':
        opts.strict = true;
        break;
      case '-q':
      case '--quiet':
        opts.quiet = true;
        break;
      case '-s':
      case '--source':
        opts.source = argv[++i];
        break;
      case '-c':
      case '--config':
        opts.config = argv[++i];
        break;
      default:
        if (arg.startsWith('-')) {
          opts.unknown = arg;
        }
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

if (opts.unknown) {
  process.stderr.write(`unknown option: ${opts.unknown}\n\n${USAGE}\n`);
  process.exit(2);
}

const result = await updateServerlessConfig({
  source: opts.source,
  config: opts.config,
  write: !opts.check,
  strict: opts.strict,
});

const noise = result.changed || result.problems.length > 0 || result.error;
if (!opts.quiet || noise) {
  const lines = formatReport(result, { dryRun: opts.check });
  process.stdout.write(`${lines.join('\n')}\n`);
}

// The CLI works standalone, but the deploy hook only fires when the plugin is
// listed in serverless.yml. Say so rather than leaving the user to wonder why
// `serverless deploy` changes nothing.
if (!result.error) {
  try {
    const cfg = await readFile(result.configPath, 'utf8');
    if (!isRegistered(cfg)) {
      process.stdout.write(
        `\nNote: ${PLUGIN_NAME} is not listed in serverless.yml, so routes will not\n`
          + '      sync on `serverless deploy`. Run `npx autoupdateyml-register` to add it.\n',
      );
    }
  } catch { /* reported elsewhere */ }
}

if (result.error) process.exit(1);
if (opts.check && result.changed) process.exit(1);
process.exit(0);
