import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { loadConfig } from '../../config/load.js';
import { loadSkills } from '../../server/skills.js';
import { VERSION } from '../../version.js';
import { c, ok, warn } from '../ui.js';

export interface AddToOptions {
  config?: string;
  write?: boolean;
  name?: string;
  command?: string;
}

export const CLIENTS = ['claude-code', 'codex', 'cursor', 'vscode'] as const;
type Client = (typeof CLIENTS)[number];

interface ServerCommand {
  command: string;
  args: string[];
}

/** Default launcher: npx with the current minor version, so updates do not break configs. */
function launcher(opts: AddToOptions, configArg: string): ServerCommand {
  if (opts.command) {
    const parts = opts.command.split(' ').filter(Boolean);
    return {
      command: parts[0] as string,
      args: [...parts.slice(1), 'serve', '--config', configArg],
    };
  }
  const minor = VERSION.split('.').slice(0, 2).join('.');
  return { command: 'npx', args: ['-y', `apitame@${minor}`, 'serve', '--config', configArg] };
}

function mergeJson(file: string, key: string, name: string, value: unknown): void {
  let data: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      throw new Error(`${file} is not valid JSON. Fix it or add the snippet by hand.`);
    }
  }
  const section = (data[key] && typeof data[key] === 'object' ? data[key] : {}) as Record<
    string,
    unknown
  >;
  section[name] = value;
  data[key] = section;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function toml(name: string, cmd: ServerCommand): string {
  return [
    `[mcp_servers.${name}]`,
    `command = ${JSON.stringify(cmd.command)}`,
    `args = [${cmd.args.map((a) => JSON.stringify(a)).join(', ')}]`,
    '',
  ].join('\n');
}

function copySkills(skillsDir: string, target: string): string[] {
  const skills = loadSkills(skillsDir);
  for (const s of skills)
    cpSync(join(skillsDir, s.name), join(target, s.name), { recursive: true });
  return skills.map((s) => s.name);
}

export async function addToCommand(clientArg: string, opts: AddToOptions): Promise<void> {
  const client = clientArg
    .toLowerCase()
    .replace(/^claude$/, 'claude-code')
    .replace(/^code$/, 'vscode') as Client;
  if (!CLIENTS.includes(client))
    throw new Error(`Unknown client "${clientArg}". Use one of: ${CLIENTS.join(', ')}.`);

  const loaded = loadConfig(opts.config ?? process.env.APITAME_CONFIG ?? undefined);
  const name = opts.name ?? loaded.config.name;
  const cwd = process.cwd();
  const relConfig = relative(cwd, loaded.path);
  const inProject = !relConfig.startsWith('..');
  const skillsDir = resolve(loaded.dir, loaded.config.skills.dir);
  const hasSkills = loadSkills(skillsDir).length > 0;

  // Project-relative paths keep committed config files portable between machines.
  const pathFor = (variable: string | undefined) =>
    inProject && variable ? `${variable}/${relConfig}` : loaded.path;

  switch (client) {
    case 'claude-code': {
      const cmd = launcher(opts, pathFor('${CLAUDE_PROJECT_DIR:-.}'));
      const entry = { type: 'stdio', ...cmd };
      console.log(c.bold('Claude Code'));
      console.log(c.dim('Add with the CLI (project scope, writes .mcp.json):'));
      console.log(
        `  claude mcp add --transport stdio --scope project ${name} -- ${cmd.command} ${launcher(opts, loaded.path).args.join(' ')}`,
      );
      console.log(c.dim('\nOr put this in .mcp.json at the project root:'));
      console.log(JSON.stringify({ mcpServers: { [name]: entry } }, null, 2));
      if (opts.write) {
        mergeJson(join(cwd, '.mcp.json'), 'mcpServers', name, entry);
        console.log(ok('Updated .mcp.json'));
        if (hasSkills)
          console.log(
            ok(
              `Installed skills in .claude/skills: ${copySkills(skillsDir, join(cwd, '.claude', 'skills')).join(', ')}`,
            ),
          );
      } else if (hasSkills)
        console.log(
          c.dim(
            `\nSkills: copy ${relative(cwd, skillsDir) || '.'}/* into .claude/skills/ (or run with --write).`,
          ),
        );
      break;
    }
    case 'codex': {
      const cmd = launcher(opts, loaded.path);
      console.log(c.bold('Codex'));
      console.log(c.dim('Add with the CLI (writes ~/.codex/config.toml):'));
      console.log(`  codex mcp add ${name} -- ${cmd.command} ${cmd.args.join(' ')}`);
      console.log(
        c.dim(
          '\nOr add this to ~/.codex/config.toml (or .codex/config.toml in a trusted project):',
        ),
      );
      console.log(toml(name, cmd));
      if (opts.write) {
        const file = join(cwd, '.codex', 'config.toml');
        const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
        if (current.includes(`[mcp_servers.${name}]`))
          console.log(
            warn(`.codex/config.toml already has [mcp_servers.${name}]; left unchanged.`),
          );
        else {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(
            file,
            `${current}${current && !current.endsWith('\n') ? '\n' : ''}${current ? '\n' : ''}${toml(name, cmd)}`,
          );
          console.log(ok('Updated .codex/config.toml (Codex reads it for trusted projects)'));
        }
        if (hasSkills)
          console.log(
            ok(
              `Installed skills in .agents/skills: ${copySkills(skillsDir, join(cwd, '.agents', 'skills')).join(', ')}`,
            ),
          );
      } else if (hasSkills)
        console.log(
          c.dim(
            `Skills: copy ${relative(cwd, skillsDir) || '.'}/* into .agents/skills/ (or run with --write).`,
          ),
        );
      break;
    }
    case 'cursor': {
      const cmd = launcher(opts, pathFor('${workspaceFolder}'));
      const entry = { type: 'stdio', ...cmd };
      const deeplinkConfig = Buffer.from(JSON.stringify(launcher(opts, loaded.path))).toString(
        'base64',
      );
      console.log(c.bold('Cursor'));
      console.log(c.dim('Put this in .cursor/mcp.json:'));
      console.log(JSON.stringify({ mcpServers: { [name]: entry } }, null, 2));
      console.log(c.dim('\nOr open this install link:'));
      console.log(
        `  cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(deeplinkConfig)}`,
      );
      if (opts.write) {
        mergeJson(join(cwd, '.cursor', 'mcp.json'), 'mcpServers', name, entry);
        console.log(ok('Updated .cursor/mcp.json'));
        if (hasSkills)
          console.log(
            ok(
              `Installed skills in .agents/skills: ${copySkills(skillsDir, join(cwd, '.agents', 'skills')).join(', ')}`,
            ),
          );
      } else if (hasSkills)
        console.log(
          c.dim(
            `\nSkills: copy ${relative(cwd, skillsDir) || '.'}/* into .agents/skills/ (or run with --write).`,
          ),
        );
      break;
    }
    case 'vscode': {
      const cmd = launcher(opts, pathFor('${workspaceFolder}'));
      const entry = { type: 'stdio', ...cmd };
      console.log(c.bold('VS Code'));
      console.log(c.dim('Put this in .vscode/mcp.json:'));
      console.log(JSON.stringify({ servers: { [name]: entry } }, null, 2));
      if (opts.write) {
        mergeJson(join(cwd, '.vscode', 'mcp.json'), 'servers', name, entry);
        console.log(ok('Updated .vscode/mcp.json'));
        if (hasSkills)
          console.log(
            ok(
              `Installed skills in .agents/skills: ${copySkills(skillsDir, join(cwd, '.agents', 'skills')).join(', ')}`,
            ),
          );
      } else if (hasSkills)
        console.log(
          c.dim(
            `\nSkills: copy ${relative(cwd, skillsDir) || '.'}/* into .agents/skills/ (or run with --write).`,
          ),
        );
      break;
    }
  }
  console.log(
    c.dim(
      '\nSecrets are read from the environment or from .env next to apitame.config.yaml; they never go in these files.',
    ),
  );
}
