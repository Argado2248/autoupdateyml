import { updateServerlessConfig } from '../../src/index.js';
import { formatReport } from '../../src/lib/report.js';

const PREFIX = 'auto-routes:';

/**
 * Serverless plugin that reconciles `functions:` with annotated handlers before
 * the framework reads them for a deploy.
 *
 * The `initialize` hook is what makes a plain `serverless deploy` pick up new
 * routes: it runs before the service definition is resolved, so the functions we
 * write are part of the very deploy that triggered us. The `before:deploy:deploy`
 * hook is kept as a safety net for older framework versions where `initialize`
 * is unavailable — by then the config is already loaded, so it can only report
 * that a re-run is needed rather than silently deploying a stale config.
 */
class ServerlessAutoRoutes {
  constructor(serverless, options, { log } = {}) {
    this.serverless = serverless;
    this.options = options ?? {};
    this.log = log;
    this.ran = false;

    this.commands = {
      routes: {
        usage: 'Sync serverless.yml functions with annotated handlers',
        lifecycleEvents: ['sync'],
        options: {
          check: {
            usage: 'Report what would change without writing',
            type: 'boolean',
          },
        },
      },
    };

    this.hooks = {
      initialize: () => this.sync({ phase: 'initialize' }),
      'before:package:createDeploymentArtifacts': () => this.sync({ phase: 'package' }),
      'before:deploy:deploy': () => this.sync({ phase: 'deploy' }),
      'routes:sync': () => this.sync({ phase: 'command', force: true }),
    };
  }

  config() {
    const custom = this.serverless?.service?.custom?.autoRoutes ?? {};
    return {
      source: custom.source ?? 'src',
      strict: custom.strict ?? false,
      enabled: custom.enabled !== false,
    };
  }

  write(lines) {
    for (const line of lines) {
      if (this.log?.notice) this.log.notice(line);
      else if (this.serverless?.cli?.log) this.serverless.cli.log(line);
      else process.stdout.write(`${line}\n`);
    }
  }

  /**
   * Mirror freshly written routes into the already-loaded service object.
   *
   * The framework reads `serverless.yml` into memory before `initialize` runs.
   * Rewriting the file at that point is normally enough, because the loaded
   * object still holds the `functions` map we are editing — but when the file
   * had no `functions:` key at all there is no map to edit, and the first run
   * would deploy nothing while reporting success. Adding the entries here keeps
   * that first run correct.
   *
   * Only missing entries are added; anything already present was loaded from
   * the file and is left as the framework parsed it.
   */
  syncInMemory(routes) {
    const service = this.serverless?.service;
    if (!service) return;
    if (!service.functions) service.functions = {};

    for (const route of routes) {
      if (service.functions[route.name]) continue;
      const http = { path: route.path, method: route.method };
      if (route.cors !== undefined) http.cors = route.cors;
      if (route.authorizer) http.authorizer = route.authorizer;
      service.functions[route.name] = {
        handler: route.handler,
        events: [{ http }],
      };
    }

    // setFunctionNames() assigns the `service-stage-name` Lambda names that the
    // framework would otherwise have derived during its own load.
    if (typeof service.setFunctionNames === 'function') {
      service.setFunctionNames(this.options);
    }
  }

  async sync({ phase, force = false }) {
    // Each lifecycle hook is a fallback for the one before it; only the first
    // to fire in a given invocation should do the work.
    if (this.ran && !force) return;
    this.ran = true;

    const cfg = this.config();
    if (!cfg.enabled && !force) return;

    const check = phase === 'command' && this.options.check === true;
    const cwd = this.serverless?.config?.servicePath ?? process.cwd();

    const result = await updateServerlessConfig({
      cwd,
      source: cfg.source,
      config: this.serverless?.configurationFilename,
      write: !check,
      strict: cfg.strict,
    });

    const quiet = !result.changed && result.problems.length === 0 && !result.error;
    if (!quiet || phase === 'command') {
      this.write(formatReport(result, { prefix: PREFIX, dryRun: check, cwd }));
    }

    if (result.error) {
      throw new Error(`${PREFIX} ${result.error}`);
    }

    if (result.written && phase === 'initialize') {
      this.syncInMemory(result.routes);
    }

    if (result.written && phase !== 'initialize' && phase !== 'command') {
      // The framework already parsed the config, so the freshly written
      // functions will not be part of this run. Fail loudly instead of
      // deploying a config that does not match the source.
      throw new Error(
        `${PREFIX} serverless.yml was updated after the service was loaded. `
          + 'Re-run the deploy so the new functions are included.',
      );
    }
  }
}

export default ServerlessAutoRoutes;
