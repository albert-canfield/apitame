import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crc32, zip } from '../../src/generator/zip.js';
import { tempDir } from '../helpers.js';

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('writes archives that standard tools can read', () => {
    const t = tempDir();
    try {
      const file = join(t.dir, 'skill.zip');
      writeFileSync(
        file,
        zip([
          { path: 'demo-api/SKILL.md', data: Buffer.from('---\nname: demo-api\n---\n# Démo\n') },
          { path: 'demo-api/references/ops.md', data: Buffer.from('ops') },
        ]),
      );
      const py = spawnSync(
        'python3',
        [
          '-c',
          'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("\\n".join(z.namelist())); print(z.read("demo-api/SKILL.md").decode())',
          file,
        ],
        { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
      );
      if (py.error) return; // python3 not available: nothing to check against
      expect(py.status, py.stderr).toBe(0);
      expect(py.stdout).toContain('demo-api/references/ops.md');
      expect(py.stdout).toContain('# Démo');
    } finally {
      t.cleanup();
    }
  });
});
