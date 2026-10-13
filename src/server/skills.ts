import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface SkillFile {
  /** Path inside the skill folder, with forward slashes. */
  path: string;
  bytes: Buffer;
}

export interface SkillEntry {
  name: string;
  frontmatter: Record<string, unknown>;
  files: SkillFile[];
}

const MAX_FILES = 512;
const MAX_BYTES = 16 * 1024 * 1024;

/** Split a SKILL.md into its YAML frontmatter and body. */
export function parseFrontmatter(text: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { frontmatter: {}, body: text };
  const parsed: unknown = parseYaml(m[1] ?? '');
  return {
    frontmatter: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {},
    body: text.slice(m[0].length),
  };
}

function walk(dir: string, root: string, out: SkillFile[]): void {
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, root, out);
    else if (st.isFile())
      out.push({ path: relative(root, full).split(sep).join('/'), bytes: readFileSync(full) });
  }
}

/** Load every `<dir>/<name>/SKILL.md` skill folder. Invalid folders are skipped. */
export function loadSkills(dir: string): SkillEntry[] {
  if (!existsSync(dir)) return [];
  const skills: SkillEntry[] = [];
  for (const name of readdirSync(dir).sort()) {
    const folder = join(dir, name);
    const skillMd = join(folder, 'SKILL.md');
    if (!statSync(folder).isDirectory() || !existsSync(skillMd)) continue;
    const { frontmatter } = parseFrontmatter(readFileSync(skillMd, 'utf8'));
    if (frontmatter.name !== name || typeof frontmatter.description !== 'string') continue;
    const files: SkillFile[] = [];
    walk(folder, folder, files);
    const total = files.reduce((n, f) => n + f.bytes.length, 0);
    if (files.length > MAX_FILES || total > MAX_BYTES) continue;
    skills.push({ name, frontmatter, files });
  }
  return skills;
}

export function skillUri(name: string, path = 'SKILL.md'): string {
  return `skill://${name}/${path}`;
}

/** A skills/list entry as defined by the MCP Skills extension (io.modelcontextprotocol/skills). */
export function skillListEntry(skill: SkillEntry) {
  return {
    uri: skillUri(skill.name),
    frontmatter: skill.frontmatter,
    resources: skill.files.map((f) => ({
      uri: skillUri(skill.name, f.path),
      digest: `sha256:${createHash('sha256').update(f.bytes).digest('hex')}`,
      size: f.bytes.length,
    })),
  };
}

export function findSkillFile(
  skills: SkillEntry[],
  uri: string,
): { skill: SkillEntry; file: SkillFile } | undefined {
  const m = /^skill:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) return undefined;
  const skill = skills.find((s) => s.name === m[1]);
  const file = skill?.files.find((f) => f.path === m[2]);
  return skill && file ? { skill, file } : undefined;
}

export function mimeTypeFor(path: string): string {
  if (path.endsWith('.md')) return 'text/markdown';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.yaml') || path.endsWith('.yml')) return 'application/yaml';
  return 'text/plain';
}
