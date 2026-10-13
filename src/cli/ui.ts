const enabled = () =>
  Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const wrap = (open: number, close: number) => (s: string) =>
  enabled() ? `\u001b[${open}m${s}\u001b[${close}m` : s;

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
  magenta: wrap(35, 39),
};

export const ok = (s: string) => `${c.green('✔')} ${s}`;
export const warn = (s: string) => `${c.yellow('!')} ${s}`;
export const fail = (s: string) => `${c.red('✖')} ${s}`;

export function n(value: number): string {
  return value.toLocaleString('en-US');
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const visible = (s: string) => s.replace(ANSI, '').length;

/** Render rows as an aligned table. Numeric-looking cells are right aligned. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(visible(h), ...rows.map((r) => visible(r[i] ?? ''))),
  );
  const pad = (s: string, i: number) => {
    const gap = ' '.repeat(Math.max(0, (widths[i] ?? 0) - visible(s)));
    return /^[\d,.~%-]+$/.test(s.replace(ANSI, '')) ? gap + s : s + gap;
  };
  const line = (r: string[]) => r.map(pad).join('  ').trimEnd();
  return [c.dim(line(headers)), ...rows.map(line)].join('\n');
}

export function accessLabel(access: string): string {
  if (access === 'read') return c.green('read');
  if (access === 'write') return c.yellow('write');
  return c.red('destructive');
}
