import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCANNER = join(fileURLToPath(new URL('.', import.meta.url)), 'license-scanner.mjs');
const REPO_ROOT = join(fileURLToPath(new URL('../../..', import.meta.url)));

function runScanner(root: string): { status: number; output: string } {
  try {
    const output = execFileSync('node', [SCANNER, root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function makeFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'license-scan-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'THIRD_PARTY_NOTICES.md'), '# 台账\n\n'.padEnd(220, 'x') + '\n');
  return root;
}

describe('[SIMULATION] license-scanner（T-M0-04）', () => {
  it('干净仓库全绿（exit 0）', () => {
    const root = makeFixtureRoot();
    try {
      const { status, output } = runScanner(root);
      expect(status).toBe(0);
      expect(output).toContain('PASS');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('硬编码密钥 → exit 1 并给出定位', () => {
    const root = makeFixtureRoot();
    try {
      mkdirSync(join(root, 'packages', 'evil'), { recursive: true });
      writeFileSync(join(root, 'packages', 'evil', 'leak.ts'), "const key = 'sk-abcDEF1234567890abcdef';\n");
      const { status, output } = runScanner(root);
      expect(status).toBe(1);
      expect(output).toContain('疑似 OpenAI 风格密钥');
      expect(output).toContain('leak.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('UNLICENSED 源码痕迹与 GPL 传染源标记 → exit 1', () => {
    const root = makeFixtureRoot();
    try {
      mkdirSync(join(root, 'tools', 'bad'), { recursive: true });
      writeFileSync(join(root, 'tools', 'bad', 'stolen.js'), "// copied from https://github.com/newbeejmc/Dsh_douyin\nexport {};\n");
      writeFileSync(join(root, 'tools', 'bad', 'vendor.js'), "// cortico-world-douyin-live protocol impl\nexport {};\n");
      const { status, output } = runScanner(root);
      expect(status).toBe(1);
      expect(output).toContain('newbeejmc/Dsh_douyin');
      expect(output).toContain('GPL-3.0 传染源');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('台账缺失 → exit 1', () => {
    const root = mkdtempSync(join(tmpdir(), 'license-scan-empty-'));
    try {
      const { status, output } = runScanner(root);
      expect(status).toBe(1);
      expect(output).toContain('台账缺失');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('对当前真实仓库全绿（与 verify:gate Gate 2 同源）', () => {
    const { status, output } = runScanner(REPO_ROOT);
    expect(status).toBe(0);
    expect(output).toContain('PASS');
  });
});
