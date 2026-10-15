import { Command, Option } from 'commander';
import { addToCommand, CLIENTS } from './cli/commands/add-to.js';
import { diffCommand, parseFailOn } from './cli/commands/diff.js';
import { doctorCommand } from './cli/commands/doctor.js';
import { initCommand } from './cli/commands/init.js';
import { inspectCommand } from './cli/commands/inspect.js';
import { serveCommand } from './cli/commands/serve.js';
import { testCommand } from './cli/commands/test.js';
import { c } from './cli/ui.js';
import { FAIL_ON_VALUES } from './diff/compare.js';
import { VERSION } from './version.js';

const program = new Command();

program
  .name('apitame')
  .description('Turn an OpenAPI spec or a SQL database into a safe MCP server plus agent skills.')
  .version(VERSION, '-v, --version')
  .showHelpAfterError();

program
  .command('init')
  .description('Introspect a source and generate apitame.config.yaml and skills')
  .argument(
    '[source]',
    'OpenAPI or Swagger file or URL, postgres:// or mysql:// URL, or SQLite or DuckDB file',
  )
  .option('-o, --out <dir>', 'output folder', '.')
  .option('-n, --name <name>', 'server name (default: from the spec title or database name)')
  .option('--base-url <url>', 'API base URL, overrides the servers in the spec')
  .option('--max-tools <n>', 'maximum number of tools, including search and call', '12')
  .option('--env-var <name>', 'environment variable for the database URL', undefined)
  .option('--schema <names...>', 'PostgreSQL schemas to expose (default: public)')
  .option('-f, --force', 'overwrite an existing config')
  .option('--skills-only', 'regenerate skills from the existing config')
  .option('-c, --config <path>', 'config file for --skills-only')
  .action(initCommand);

program
  .command('serve')
  .description('Run the MCP server')
  .option('-c, --config <path>', 'config file (default: $APITAME_CONFIG or apitame.config.yaml)')
  .addOption(
    new Option('-t, --transport <transport>', 'transport')
      .choices(['stdio', 'http'])
      .default('stdio'),
  )
  .option('-p, --port <port>', 'port for --transport http', '3333')
  .option('--host <host>', 'host for --transport http', '127.0.0.1')
  .option('-w, --watch', 'reload when the config, spec, skills or .env change')
  .option(
    '--sessions',
    'HTTP: keep a session per client, so destructive actions are confirmed through the client (elicitation)',
  )
  .addOption(
    new Option('--log-level <level>', 'log level (stderr)').choices([
      'debug',
      'info',
      'warn',
      'error',
      'silent',
    ]),
  )
  .action(serveCommand);

program
  .command('inspect')
  .description('List tools, modes and estimated token cost')
  .option('-c, --config <path>', 'config file (default: $APITAME_CONFIG or apitame.config.yaml)')
  .option('--json', 'machine readable output')
  .option('--verbose', 'list the operations in each tool')
  .option('--max-tokens <n>', 'exit with code 1 if the tool list costs more (for CI)')
  .action(inspectCommand);

program
  .command('diff')
  .description(
    'Show what a new version of the OpenAPI spec changes for the agent (never calls the API)',
  )
  .argument('<old-spec>', 'the spec before the change: file or URL')
  .argument('[new-spec]', 'the spec after the change (default: the spec the config points to)')
  .option('-c, --config <path>', 'config file (default: $APITAME_CONFIG or apitame.config.yaml)')
  .option('--json', 'machine readable output')
  .addOption(
    new Option(
      '--fail-on [categories]',
      `exit with code 1 when a category has findings, comma separated: ${FAIL_ON_VALUES.join(', ')}`,
    )
      .preset('new-writes')
      .argParser(parseFailOn),
  )
  .action(diffCommand);

program
  .command('test')
  .description('Call every read tool against a mock (or --live) and run safety checks')
  .option('-c, --config <path>', 'config file (default: $APITAME_CONFIG or apitame.config.yaml)')
  .option('--live', 'call the real API instead of a local mock (read operations only)')
  .option('--json', 'machine readable output')
  .action(testCommand);

program
  .command('doctor')
  .description(
    'Check the setup: config, environment, connectivity, credentials, skills and clients',
  )
  .option('-c, --config <path>', 'config file (default: $APITAME_CONFIG or apitame.config.yaml)')
  .option('--offline', 'skip checks that contact the API or database')
  .option('--json', 'machine readable output')
  .action(doctorCommand);

program
  .command('add-to')
  .description(`Print or write the MCP client config (${CLIENTS.join(', ')})`)
  .argument('<client>', CLIENTS.join(' | '))
  .option('-c, --config <path>', 'config file (default: $APITAME_CONFIG or apitame.config.yaml)')
  .option('-w, --write', 'write the config file and install skills in this project')
  .option('-n, --name <name>', 'server name in the client (default: config name)')
  .option('--command <cmd>', 'how to launch apitame (default: npx -y apitame@<version>)')
  .action(addToCommand);

program.parseAsync(process.argv).catch((err: unknown) => {
  const e = err as Error;
  console.error(`${c.red('error')} ${e.message}`);
  if (process.env.APITAME_DEBUG && e.stack) console.error(c.dim(e.stack));
  process.exit(1);
});
