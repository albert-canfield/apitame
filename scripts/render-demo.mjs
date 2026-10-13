#!/usr/bin/env node
// Renders docs/assets/demo.svg: an animated terminal recording built from the
// real output of the CLI (run `pnpm build` first). Re-run after changing output.
//
//   node scripts/render-demo.mjs
//
// To record a GIF instead, follow docs/demo-script.md.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist/cli.js');
const work = mkdtempSync(join(tmpdir(), 'apitame-demo-'));
copyFileSync(join(root, 'examples/github-subset/openapi.yaml'), join(work, 'openapi.yaml'));

function run(args) {
  const res = spawnSync(process.execPath, [cli, ...args], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', APITAME_LOG_LEVEL: 'silent', GITHUB_TOKEN: 'demo-token' },
  });
  if (res.status !== 0) throw new Error(`apitame ${args.join(' ')} failed:\n${res.stderr}`);
  return res.stdout.replace(/\n+$/, '').split('\n');
}

const init = run(['init', 'openapi.yaml', '--name', 'github']).filter((l) => l.trim() !== '');
const inspect = run(['inspect']);
const test = run(['test']);
const addTo = run(['add-to', 'claude-code', '--write']).filter((l) => /^✔/.test(l));
rmSync(work, { recursive: true, force: true });

const nextIdx = init.findIndex((l) => l.startsWith('Next:'));
const scenes = [
  [
    { cmd: 'npx apitame init ./openapi.yaml --name github' },
    ...init.slice(0, nextIdx > 0 ? nextIdx : init.length).map((t) => ({ t })),
  ],
  [{ cmd: 'npx apitame inspect' }, ...inspect.map((t) => ({ t }))],
  [
    { cmd: 'npx apitame test' },
    ...(() => {
      const rows = test.filter((l) => l.trim() !== '');
      const header = rows.findIndex((l) => l.startsWith('CHECK'));
      return [rows[header], ...rows.slice(header + 1, -1).slice(-6), '', rows[rows.length - 1]];
    })().map((t) => ({ t })),
    { t: '' },
    { cmd: 'npx apitame add-to claude-code --write' },
    ...addTo.map((t) => ({ t })),
  ],
];

const W = 980;
const LINE = 19;
const TOP = 52;
const LEFT = 22;
const rows = Math.max(...scenes.map((s) => s.length));
const H = TOP + rows * LINE + 24;

const MAX_COLS = 106;
const clip = (s) => (s.length > MAX_COLS ? `${s.slice(0, MAX_COLS - 3)}...` : s);
const esc = (s) => clip(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function colour(text) {
  let out = esc(text);
  out = out.replace(/^✔/, '<tspan class="g">✔</tspan>').replace(/^!/, '<tspan class="y">!</tspan>');
  out = out.replace(/\b(pass)\b/g, '<tspan class="g">$1</tspan>');
  out = out.replace(/(\d+% saved|apitame saves \d+%)/g, '<tspan class="g">$1</tspan>');
  out = out.replace(/\bread-only\b/g, '<tspan class="c">read-only</tspan>');
  if (/^(TOOL|CHECK)\s/.test(text)) out = `<tspan class="d">${out}</tspan>`;
  return out;
}

// Timeline: each command "types" for a moment, output lines then appear one by one.
const CMD_PAUSE = 1.1;
const LINE_STEP = 0.16;
const SCENE_HOLD = 3.2;
const timeline = [];
let t = 0.6;
for (const scene of scenes) {
  const start = t;
  const items = scene.map((item, i) => {
    const at = t;
    t += item.cmd ? CMD_PAUSE : LINE_STEP;
    return { ...item, i, at };
  });
  t += SCENE_HOLD;
  timeline.push({ start, end: t, items });
}
const TOTAL = t;
const pct = (s) => ((s / TOTAL) * 100).toFixed(3);

let css = '';
let body = '';
timeline.forEach((scene, si) => {
  scene.items.forEach((item) => {
    const id = `s${si}l${item.i}`;
    const show = pct(item.at);
    const hide = pct(scene.end - 0.05);
    css += `@keyframes ${id}{0%,${show}%{opacity:0}${(Number(show) + 0.01).toFixed(3)}%,${hide}%{opacity:1}${(Number(hide) + 0.01).toFixed(3)}%,100%{opacity:0}}#${id}{animation:${id} ${TOTAL.toFixed(2)}s linear infinite}\n`;
    const y = TOP + item.i * LINE;
    const content = item.cmd
      ? `<tspan class="p">$</tspan> <tspan class="w">${esc(item.cmd)}</tspan>`
      : colour(item.t);
    body += `<text id="${id}" x="${LEFT}" y="${y}" xml:space="preserve">${content}</text>\n`;
  });
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="apitame demo: init, inspect, test and add-to on a GitHub API subset">
<title>apitame demo</title>
<style>
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;font-size:13.5px;fill:#d4d4d8;opacity:0}
.g{fill:#4ade80}.y{fill:#facc15}.c{fill:#67e8f9}.d{fill:#8b8b94}.p{fill:#a78bfa}.w{fill:#f4f4f5;font-weight:600}
${css}@media (prefers-reduced-motion: reduce){text{animation:none!important;opacity:1}}
</style>
<rect width="${W}" height="${H}" rx="10" fill="#18181b"/>
<rect width="${W}" height="30" rx="10" fill="#27272a"/><rect y="20" width="${W}" height="10" fill="#27272a"/>
<circle cx="20" cy="15" r="6" fill="#ef4444"/><circle cx="40" cy="15" r="6" fill="#f59e0b"/><circle cx="60" cy="15" r="6" fill="#22c55e"/>
<text x="${W / 2}" y="19" text-anchor="middle" style="opacity:1;fill:#a1a1aa;font-size:12px">apitame</text>
${body}</svg>
`;

mkdirSync(join(root, 'docs/assets'), { recursive: true });
writeFileSync(join(root, 'docs/assets/demo.svg'), svg);
console.log(
  `docs/assets/demo.svg: ${scenes.length} scenes, ${TOTAL.toFixed(1)}s loop, ${(svg.length / 1024).toFixed(1)} KB`,
);
