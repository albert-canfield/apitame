import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { loadConfig } from '../../config/load.js';
import { zip } from '../../generator/zip.js';
import { loadSkills } from '../../server/skills.js';
import { DUCKDB_SPEC } from '../../sources/sql/duckdb-package.js';
import { VERSION } from '../../version.js';
import { c, ok, warn } from '../ui.js';

export interface AddToOptions {
  config?: string;
  write?: boolean;
  name?: string;
  command?: string;
}

export const CLIENTS = [
  'claude-code',
  'codex',
  'cursor',
  'vscode',
  'gemini',
  'claude-desktop',
] as const;
type Client = (typeof CLIENTS)[number];

interface ServerCommand {
  command: string;
  args: string[];
}

/**
 * Default launcher: npx with the current minor version, so updates do not break configs.
 * Optional packages (the DuckDB driver) are added with `-p`, so npx installs them next
 * to apitame: `npx -y -p apitame@0.3 -p @duckdb/node-api@1.5.6-r.1 apitame serve ...`.
 */
function launcher(opts: AddToOptions, configArg: string, extras: string[] = []): ServerCommand {
  if (opts.command) {
    const parts = opts.command.split(' ').filter(Boolean);
    return {
      command: parts[0] as string,
      args: [...parts.slice(1), 'serve', '--config', configArg],
    };
  }
  const pkg = `apitame@${VERSION.split('.').slice(0, 2).join('.')}`;
  const install =
    extras.length > 0 ? ['-p', pkg, ...extras.flatMap((e) => ['-p', e]), 'apitame'] : [pkg];
  return { command: 'npx', args: ['-y', ...install, 'serve', '--config', configArg] };
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

/** Where Claude Desktop keeps its MCP config on this platform. */
export function claudeDesktopConfigPath(): string {
  if (process.env.APITAME_CLAUDE_DESKTOP_CONFIG) return process.env.APITAME_CLAUDE_DESKTOP_CONFIG;
  if (process.platform === 'darwin') {
    return join(
      homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
  }
  if (process.platform === 'win32') {
    return join(
      process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
      'Claude',
      'claude_desktop_config.json',
    );
  }
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

/** Absolute path of a command on PATH, if any. */
function which(command: string): string | undefined {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

/** Package each skill folder as <skillsDir>/<name>.zip, ready to upload. */
function zipSkills(skillsDir: string): string[] {
  return loadSkills(skillsDir).map((s) => {
    const file = join(skillsDir, `${s.name}.zip`);
    writeFileSync(file, zip(s.files.map((f) => ({ path: `${s.name}/${f.path}`, data: f.bytes }))));
    return file;
  });
}

export async function addToCommand(clientArg: string, opts: AddToOptions): Promise<void> {
  const client = clientArg
    .toLowerCase()
    .replace(/^claude$/, 'claude-code')
    .replace(/^code$/, 'vscode')
    .replace(/^gemini-cli$/, 'gemini')
    .replace(/^(claude-app|desktop)$/, 'claude-desktop') as Client;
  if (!CLIENTS.includes(client))
    throw new Error(`Unknown client "${clientArg}". Use one of: ${CLIENTS.join(', ')}.`);

  const loaded = loadConfig(opts.config ?? process.env.APITAME_CONFIG ?? undefined);
  const name = opts.name ?? loaded.config.name;
  // The DuckDB driver is pinned to the tested release, so every start runs the same DuckDB.
  const extras = loaded.config.source.type === 'duckdb' ? [DUCKDB_SPEC] : [];
  const launch = (configArg: string) => launcher(opts, configArg, extras);
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
      const cmd = launch(pathFor('${CLAUDE_PROJECT_DIR:-.}'));
      const entry = { type: 'stdio', ...cmd };
      console.log(c.bold('Claude Code'));
      console.log(c.dim('Add with the CLI (project scope, writes .mcp.json):'));
      console.log(
        `  claude mcp add --transport stdio --scope project ${name} -- ${cmd.command} ${launch(loaded.path).args.join(' ')}`,
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
      const cmd = launch(loaded.path);
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
      const cmd = launch(pathFor('${workspaceFolder}'));
      const entry = { type: 'stdio', ...cmd };
      const deeplinkConfig = Buffer.from(JSON.stringify(launch(loaded.path))).toString('base64');
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
      const cmd = launch(pathFor('${workspaceFolder}'));
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
    case 'gemini': {
      // Gemini CLI documents no project variable for args, so the path is absolute.
      const cmd = launch(loaded.path);
      console.log(c.bold('Gemini CLI'));
      console.log(c.dim('Put this in .gemini/settings.json (or ~/.gemini/settings.json):'));
      console.log(JSON.stringify({ mcpServers: { [name]: cmd } }, null, 2));
      if (opts.write) {
        mergeJson(join(cwd, '.gemini', 'settings.json'), 'mcpServers', name, cmd);
        console.log(ok('Updated .gemini/settings.json'));
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
    case 'claude-desktop': {
      // Desktop apps start servers from an unknown folder with a minimal PATH, so everything
      // is absolute and PATH includes the folder of the npx that was found now.
      const base = launch(loaded.path);
      const npx = !opts.command ? which('npx') : undefined;
      const entry = npx
        ? {
            command: npx,
            args: base.args,
            env: { PATH: `${dirname(npx)}${delimiter}${process.env.PATH ?? ''}` },
          }
        : base;
      const file = claudeDesktopConfigPath();
      console.log(c.bold('Claude Desktop'));
      console.log(
        c.dim(
          `Add this to ${file} (Settings, Developer, Edit Config), then restart Claude Desktop:`,
        ),
      );
      console.log(JSON.stringify({ mcpServers: { [name]: entry } }, null, 2));
      if (opts.write) {
        mergeJson(file, 'mcpServers', name, entry);
        console.log(ok(`Updated ${file}. Restart Claude Desktop to load it.`));
        if (hasSkills) {
          const zips = zipSkills(skillsDir).map((z) => relative(cwd, z) || z);
          console.log(
            ok(
              `Packaged skills: ${zips.join(', ')}. Upload them in Claude Desktop settings (Capabilities, Skills).`,
            ),
          );
        }
      } else if (hasSkills) {
        console.log(c.dim('\nSkills: run with --write to package them as .zip files for upload.'));
      }
      break;
    }
  }
  console.log(
    c.dim(
      '\nSecrets are read from the environment or from .env next to apitame.config.yaml; they never go in these files.',
    ),
  );
}
