import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error —— .mjs 脚本没有类型声明，运行时行为由本 spec 直接断言
import { check, remove } from './fetch-engine.mjs';

const manifest = {
  engineId: 'cosyvoice2',
  version: '0.5b-test',
  repoId: 'FunAudioLLM/CosyVoice2-0.5B',
  revision: 'deadbeef',
  files: [
    { path: 'llm.pt', bytes: 4, sha256: 'x' },
    { path: 'sub/flow.pt', bytes: 3, sha256: 'y' },
  ],
};

let root: string;
let quiet: () => void;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fetch-engine-'));
  quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  quiet.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

/** 造一个"已安装"的目录：installed.json + 清单里的文件 */
function installFake(): string {
  const dir = join(root, manifest.engineId, manifest.version);
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'llm.pt'), 'abcd');
  writeFileSync(join(dir, 'sub', 'flow.pt'), 'abc');
  writeFileSync(
    join(dir, 'installed.json'),
    JSON.stringify({
      engineId: manifest.engineId,
      version: manifest.version,
      installedAt: '2026-11-26T00:00:00.000Z',
      totalBytes: 7,
      files: manifest.files.map((file) => ({ ...file, sha256: 'computed' })),
    }),
  );
  return dir;
}

describe('fetch-engine --remove 必须真的删干净（item 10 阶段 2 卸载链路实测）', () => {
  it('删完文件后不留空目录壳（历史坑：rm(recursive:false) 对目录抛 ERR_FS_EISDIR 被吞掉）', async () => {
    const dir = installFake();
    await remove({ dest: root }, manifest);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(root, manifest.engineId))).toBe(false);
  });

  it('installed.json 一并删除', async () => {
    const dir = installFake();
    await remove({ dest: root }, manifest);
    expect(existsSync(join(dir, 'installed.json'))).toBe(false);
  });

  it('重复执行是幂等的，不报错', async () => {
    installFake();
    await expect(remove({ dest: root }, manifest)).resolves.toBe(0);
    await expect(remove({ dest: root }, manifest)).resolves.toBe(0);
  });

  it('删完之后 --check 判定为未安装（退出码非 0）', async () => {
    installFake();
    await remove({ dest: root }, manifest);
    await expect(check({ dest: root }, manifest)).resolves.toBe(1);
  });

  it('清单之外的文件不删，但必须如实报告残留', async () => {
    const dir = installFake();
    writeFileSync(join(dir, 'notes.txt'), 'user data');
    await remove({ dest: root }, manifest);
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
    const printed = quiet.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('notes.txt');
  });

  it('不误删同一引擎的其它版本目录', async () => {
    installFake();
    const other = join(root, manifest.engineId, '0.5b-other');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'llm.pt'), 'other');
    await remove({ dest: root }, manifest);
    expect(existsSync(join(other, 'llm.pt'))).toBe(true);
  });
});
