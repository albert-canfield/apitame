import { existsSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { loadDotEnv } from '../config/env.js';
import { loadConfig, type LoadedConfig } from '../config/load.js';
import type { Logger } from '../log.js';
import type { Redactor } from '../safety/redact.js';
import { isUrl } from '../sources/openapi/load.js';
import { createRuntime, type AnyRuntime } from './runtime.js';
import { loadSkills, type SkillEntry } from './skills.js';

const skipped = (logger: Logger) => (name: string, reason: string) =>
  logger.warn(`skill "${name}" skipped: ${reason}`);

export interface LiveOptions {
  redactor: Redactor;
  logger: Logger;
  /** Milliseconds to wait for a burst of file events to settle. */
  debounceMs?: number;
}

/**
 * The runtime `serve` is currently serving, rebuilt from disk on demand.
 * A reload that fails (an invalid config, a spec that no longer parses)
 * keeps the previous runtime, so a typo never takes the server down.
 */
export class LiveRuntime {
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | undefined;
  private listeners: Array<(r: { toolsChanged: boolean; skillsChanged: boolean }) => void> = [];
  private dotenvKeys: string[] = [];
  private reloading: Promise<boolean> | undefined;

  private constructor(
    private readonly configPath: string,
    public loaded: LoadedConfig,
    public runtime: AnyRuntime,
    public skills: SkillEntry[],
    private readonly opts: LiveOptions,
  ) {}

  static async start(configPath: string, opts: LiveOptions): Promise<LiveRuntime> {
    const loaded = loadConfig(configPath);
    const keys = loadDotEnv(loaded.dir);
    const runtime = await createRuntime(loaded, {
      redactor: opts.redactor,
      logger: opts.logger,
      dotenv: false,
    });
    const skills = loadSkills(resolve(loaded.dir, loaded.config.skills.dir), skipped(opts.logger));
    const live = new LiveRuntime(loaded.path, loaded, runtime, skills, opts);
    live.dotenvKeys = keys;
    return live;
  }

  /** Called after every successful reload. */
  onReload(listener: (r: { toolsChanged: boolean; skillsChanged: boolean }) => void): void {
    this.listeners.push(listener);
  }

  /** Rebuild everything from disk. Returns false (and keeps serving the old runtime) on failure. */
  reload(): Promise<boolean> {
    // Serialize reloads: a second burst of events waits for the first rebuild.
    this.reloading = (this.reloading ?? Promise.resolve(true)).then(() => this.doReload());
    return this.reloading;
  }

  private async doReload(): Promise<boolean> {
    const { redactor, logger } = this.opts;
    // Values from .env must be re-read, so drop the ones .env set last time.
    const previousKeys = this.dotenvKeys;
    const saved = Object.fromEntries(previousKeys.map((k) => [k, process.env[k]]));
    for (const k of previousKeys) delete process.env[k];
    let keys: string[] = [];
    try {
      const loaded = loadConfig(this.configPath);
      keys = loadDotEnv(loaded.dir);
      const runtime = await createRuntime(loaded, { redactor, logger, dotenv: false });
      const skills = loadSkills(resolve(loaded.dir, loaded.config.skills.dir), skipped(logger));
      // Per-caller permissions change what each OAuth caller sees, even when the server's own
      // list stays the same.
      const permissions = (l: LoadedConfig) => JSON.stringify(l.config.http.oauth?.permissions);
      const toolsChanged =
        JSON.stringify(runtime.listTools()) !== JSON.stringify(this.runtime.listTools()) ||
        permissions(loaded) !== permissions(this.loaded);
      const skillsChanged =
        JSON.stringify(skills.map((s) => [s.name, s.files.map((f) => f.bytes.length)])) !==
        JSON.stringify(this.skills.map((s) => [s.name, s.files.map((f) => f.bytes.length)]));
      const old = this.runtime;
      this.loaded = loaded;
      this.runtime = runtime;
      this.skills = skills;
      this.dotenvKeys = keys;
      await old.close().catch(() => {});
      for (const w of runtime.warnings) logger.warn(w);
      logger.info(
        `reloaded ${runtime.name}: ${runtime.listTools().length} tools, ${runtime.mode}${toolsChanged ? '' : ' (tools unchanged)'}`,
      );
      for (const l of this.listeners) l({ toolsChanged, skillsChanged });
      return true;
    } catch (err) {
      // Undo what this attempt loaded from .env, then restore the previous values, so the
      // next reload starts from a clean state (and picks up edited values).
      for (const k of keys) delete process.env[k];
      Object.assign(process.env, saved);
      logger.error(`reload failed, still serving the previous config: ${(err as Error).message}`);
      return false;
    }
  }

  /** The files and folders whose changes trigger a reload. */
  watchedPaths(): Array<{ dir: string; names?: string[]; recursive?: boolean; ignore?: string[] }> {
    const { loaded } = this;
    const configDir = dirname(loaded.path);
    const entries: Array<{
      dir: string;
      names?: string[];
      recursive?: boolean;
      ignore?: string[];
    }> = [{ dir: configDir, names: [basename(loaded.path), '.env'] }];
    const src = loaded.config.source;
    if (src.type === 'openapi' && !isUrl(src.spec)) {
      const spec = resolve(loaded.dir, src.spec);
      entries.push({ dir: dirname(spec), names: [basename(spec)] });
    }
    const skillsDir = resolve(loaded.dir, loaded.config.skills.dir);
    // The audit log grows on every call. If it lives under the skills folder, its writes must
    // not trigger reloads (each reload would also reset the rate limits).
    const audit = loaded.config.audit.file
      ? resolve(loaded.dir, loaded.config.audit.file)
      : undefined;
    if (existsSync(skillsDir)) {
      entries.push({ dir: skillsDir, recursive: true, ...(audit ? { ignore: [audit] } : {}) });
    }
    return entries;
  }

  /** Start watching. Editors often replace files on save, so folders are watched, not files. */
  watch(): void {
    const debounce = this.opts.debounceMs ?? 300;
    const trigger = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.reload(), debounce);
    };
    for (const { dir, names, recursive, ignore } of this.watchedPaths()) {
      try {
        const w = watch(dir, { recursive: recursive ?? false }, (_event, file) => {
          if (file && ignore?.includes(resolve(dir, String(file)))) return;
          if (!names || (file && names.includes(basename(String(file))))) trigger();
        });
        w.on('error', () => {});
        this.watchers.push(w);
      } catch (err) {
        this.opts.logger.warn(`cannot watch ${dir}: ${(err as Error).message}`);
      }
    }
  }

  async close(): Promise<void> {
    clearTimeout(this.timer);
    for (const w of this.watchers) w.close();
    this.watchers = [];
    await this.reloading?.catch(() => {});
    await this.runtime.close();
  }
}
