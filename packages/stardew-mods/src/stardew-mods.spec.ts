/**
 * T-M6-06 门禁：SMAPI manifest 宽容解析 / Mods 目录扫描 / 启停改名 / 解压目录安装 /
 * 平台默认路径猜测。全部为确定性单测，只操作 mkdtemp 临时目录、不触网；
 * 真实 SMAPI 装载与游戏内效果留给宿主真机验收（docs/VERIFY.md 区分记录）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  errorMessage,
  guessModsDirs,
  installModFromDirectory,
  isSafeModFolderName,
  parseSmapiManifest,
  pathExists,
  renameManifestFile,
  sanitizeModFolderName,
  scanModsDir,
  setModEnabled,
  stripSmapiJsonComments,
  stripSmapiJsonTrailingCommas,
} from './index';

/** 本用例创建的全部临时根目录，afterEach 统一清理 */
const tempRoots: string[] = [];

const makeTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'sdvmods-'));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  const roots = tempRoots.splice(0);
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** 写文本文件并自动创建父目录 */
const writeText = async (filePath: string, content: string): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
};

/** 生成合法 manifest 文本（可按 SMAPI 的 PascalCase 字段覆盖） */
const manifestText = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify(
    {
      Name: '测试 Mod',
      Author: '作者',
      Version: '1.0.0',
      Description: '描述',
      UniqueID: 'Test.Mod',
      ...overrides,
    },
    null,
    2,
  );

/** 在 modsDir 下写一个带 manifest.json 的 Mod 目录 */
const addMod = async (modsDir: string, folder: string, content = manifestText()): Promise<void> => {
  await writeText(join(modsDir, folder, 'manifest.json'), content);
};

/** 一次性建出若干同级候选 Mod（用于多候选安装测试） */
const addCandidateMods = async (root: string, names: readonly string[]): Promise<void> => {
  for (const name of names) {
    await writeText(join(root, name, 'manifest.json'), manifestText({ Name: `名字 ${name}` }));
  }
};

describe('parseSmapiManifest：SMAPI manifest 宽容解析', () => {
  it('正常解析并映射 SMAPI PascalCase 字段', () => {
    const { manifest, error } = parseSmapiManifest(
      manifestText({ MinimumApiVersion: '4.0.0' }),
    );
    expect(error).toBe('');
    expect(manifest).toEqual({
      folderName: '',
      uniqueId: 'Test.Mod',
      name: '测试 Mod',
      author: '作者',
      version: '1.0.0',
      description: '描述',
      enabled: true,
      contentType: '',
      minimumApiVersion: '4.0.0',
      parseError: '',
    });
  });

  it('ContentPackFor 存在时标记 contentType 为 content-pack', () => {
    const { manifest, error } = parseSmapiManifest(
      manifestText({ ContentPackFor: { UniqueID: 'Pathoschild.ContentPatcher' } }),
    );
    expect(error).toBe('');
    expect(manifest?.contentType).toBe('content-pack');
  });

  it('剥离 // 行注释与 /* */ 块注释', () => {
    const text = `{
      // 这一行是注释
      "Name": "带注释的 Mod", /* 行尾块注释 */
      "Version": "1.2.3", // 版本号
      /* 多行
         块注释 */
      "Author": "注释作者"
    }`;
    const { manifest, error } = parseSmapiManifest(text);
    expect(error).toBe('');
    expect(manifest?.name).toBe('带注释的 Mod');
    expect(manifest?.version).toBe('1.2.3');
    expect(manifest?.author).toBe('注释作者');
  });

  it('剥离对象与数组的尾逗号', () => {
    const text = `{
      "Name": "尾逗号 Mod",
      "UpdateKeys": ["Nexus:1", "GitHub:a/b",],
      "Description": "x",
    }`;
    const { manifest, error } = parseSmapiManifest(text);
    expect(error).toBe('');
    expect(manifest?.name).toBe('尾逗号 Mod');
    expect(manifest?.description).toBe('x');
  });

  it('引号内的 // 与 /* */ 不误删', () => {
    const text = `{
      "Name": "引号 // 安全",
      "Description": "URL https://example.com/a // 不是注释 /* 也不是 */",
    }`;
    const { manifest, error } = parseSmapiManifest(text);
    expect(error).toBe('');
    expect(manifest?.description).toBe('URL https://example.com/a // 不是注释 /* 也不是 */');
  });

  it('正确处理字符串里的转义引号', () => {
    const text = '{"Name":"转义","Description":"他说 \\"你好\\" // 保留"}';
    const { manifest, error } = parseSmapiManifest(text);
    expect(error).toBe('');
    expect(manifest?.description).toBe('他说 "你好" // 保留');
  });

  it('缺 Name 时返回中文错误且不返回 manifest', () => {
    const { manifest, error } = parseSmapiManifest(JSON.stringify({ Version: '1.0.0' }));
    expect(manifest).toBeNull();
    expect(error).toBe('manifest 缺 Name');
  });

  it('非法 JSON 返回解析失败错误', () => {
    const { manifest, error } = parseSmapiManifest('{"Name": "x",');
    expect(manifest).toBeNull();
    expect(error).toMatch(/^manifest JSON 解析失败: /);
  });

  it('顶层是数组时拒绝解析', () => {
    const { manifest, error } = parseSmapiManifest('[1, 2]');
    expect(manifest).toBeNull();
    expect(error).toBe('manifest 必须是 JSON 对象');
  });

  it('Version 为数字时转字符串，缺省字段给空串', () => {
    const { manifest, error } = parseSmapiManifest('{"Name":"最小","Version":2}');
    expect(error).toBe('');
    expect(manifest?.version).toBe('2');
    expect(manifest?.author).toBe('');
    expect(manifest?.description).toBe('');
    expect(manifest?.uniqueId).toBe('');
    expect(manifest?.minimumApiVersion).toBe('');
  });

  it('容忍 UTF-8 BOM', () => {
    const { manifest, error } = parseSmapiManifest(`\uFEFF${manifestText({ Name: '带 BOM' })}`);
    expect(error).toBe('');
    expect(manifest?.name).toBe('带 BOM');
  });

  it('注释 / 尾逗号辅助函数独立可用且字符串安全', () => {
    expect(stripSmapiJsonComments('{"a":"http://x","b":1}')).toBe('{"a":"http://x","b":1}');
    expect(stripSmapiJsonComments('{/* hi */"a":1}')).toBe('{ "a":1}');
    expect(stripSmapiJsonComments('// 只有注释\n{"a":1}')).toBe('\n{"a":1}');
    expect(stripSmapiJsonComments('{} // 末尾无换行')).toBe('{} ');
    expect(stripSmapiJsonComments('{"a":1} /* 未闭合')).toBe('{"a":1}  ');
    expect(stripSmapiJsonComments('"a\\')).toBe('"a\\');
    expect(stripSmapiJsonTrailingCommas('{"a":[1,2,],}')).toBe('{"a":[1,2]}');
    expect(stripSmapiJsonTrailingCommas('{"a":"x,}"}')).toBe('{"a":"x,}"}');
    expect(stripSmapiJsonTrailingCommas('[1,2,')).toBe('[1,2,');
    expect(stripSmapiJsonTrailingCommas('{"a":1,,"b":2}')).toBe('{"a":1,,"b":2}');
  });
});

describe('scanModsDir：Mods 目录扫描', () => {
  it('目录不存在时返回 exists:false 且不抛错', async () => {
    const root = await makeTempRoot();
    const missing = join(root, 'missing');
    const snapshot = await scanModsDir(missing);
    expect(snapshot.exists).toBe(false);
    expect(snapshot.mods).toEqual([]);
    expect(snapshot.smapiVersion).toBe('');
    expect(snapshot.modsDir).toBe(missing);
    expect(typeof snapshot.scannedAt).toBe('number');
  });

  it('modsDir 是普通文件时也视为不存在', async () => {
    const root = await makeTempRoot();
    const filePath = join(root, 'Mods');
    await writeText(filePath, 'not a dir');
    const snapshot = await scanModsDir(filePath);
    expect(snapshot.exists).toBe(false);
  });

  it('只列出一层子目录中的 Mod，跳过隐藏目录、node_modules 与普通文件', async () => {
    const root = await makeTempRoot();
    const modsDir = join(root, 'Mods');
    await addMod(modsDir, 'RealMod');
    await mkdir(join(modsDir, 'NoManifest'), { recursive: true });
    await addMod(modsDir, '.hidden');
    await addMod(modsDir, 'node_modules');
    await writeText(join(modsDir, 'loose.txt'), 'x');
    const snapshot = await scanModsDir(modsDir);
    expect(snapshot.exists).toBe(true);
    expect(snapshot.mods.map((mod) => mod.folderName)).toEqual(['RealMod']);
    expect(snapshot.mods[0]?.enabled).toBe(true);
  });

  it('manifest.json.disabled 视为已禁用但保留解析结果', async () => {
    const root = await makeTempRoot();
    const modsDir = join(root, 'Mods');
    await writeText(
      join(modsDir, 'DisabledMod', 'manifest.json.disabled'),
      manifestText({ Name: '禁用 Mod', Version: '2.0.0' }),
    );
    const snapshot = await scanModsDir(modsDir);
    expect(snapshot.mods).toHaveLength(1);
    const mod = snapshot.mods[0];
    expect(mod?.name).toBe('禁用 Mod');
    expect(mod?.version).toBe('2.0.0');
    expect(mod?.enabled).toBe(false);
    expect(mod?.parseError).toBe('');
  });

  it('两个 manifest 形态并存时取 enabled 内容、标注 parseError 并禁用', async () => {
    const root = await makeTempRoot();
    const modsDir = join(root, 'Mods');
    const folder = join(modsDir, 'BothMod');
    await writeText(join(folder, 'manifest.json'), manifestText({ Name: '启用那份' }));
    await writeText(join(folder, 'manifest.json.disabled'), manifestText({ Name: '禁用那份' }));
    const snapshot = await scanModsDir(modsDir);
    const mod = snapshot.mods[0];
    expect(mod?.name).toBe('启用那份');
    expect(mod?.enabled).toBe(false);
    expect(mod?.parseError).toBe('manifest.json 与 manifest.json.disabled 同时存在，请手动处理');
  });

  it('从 UniqueID 为 Pathoschild.SMAPI 的 Mod 提取 SMAPI 版本', async () => {
    const root = await makeTempRoot();
    const modsDir = join(root, 'Mods');
    await addMod(
      modsDir,
      'SMAPI 4.0.8',
      manifestText({ Name: 'SMAPI', UniqueID: 'Pathoschild.SMAPI', Version: '4.0.8' }),
    );
    await addMod(modsDir, 'OtherMod');
    const snapshot = await scanModsDir(modsDir);
    expect(snapshot.smapiVersion).toBe('4.0.8');
  });

  it('旧安装 name 为 smapi（忽略大小写）时也能识别版本', async () => {
    const root = await makeTempRoot();
    const modsDir = join(root, 'Mods');
    await addMod(modsDir, 'SMAPI', manifestText({ Name: 'smapi', Version: '3.18.0' }));
    const snapshot = await scanModsDir(modsDir);
    expect(snapshot.smapiVersion).toBe('3.18.0');
  });

  it('按 name 排序，同名再按 folderName', async () => {
    const root = await makeTempRoot();
    const modsDir = join(root, 'Mods');
    await addMod(modsDir, 'zeta', manifestText({ Name: 'A Mod' }));
    await addMod(modsDir, 'alpha', manifestText({ Name: 'B Mod' }));
    await addMod(modsDir, 'beta', manifestText({ Name: 'A Mod' }));
    const snapshot = await scanModsDir(modsDir);
    expect(snapshot.mods.map((mod) => `${mod.name}@${mod.folderName}`)).toEqual([
      'A Mod@beta',
      'A Mod@zeta',
      'B Mod@alpha',
    ]);
  });

  it('损坏的 manifest 仍列出（目录名兜底）并禁用', async () => {
    const root = await makeTempRoot();
    const modsDir = join(root, 'Mods');
    await addMod(modsDir, 'Broken', '{"Name":');
    await addMod(modsDir, 'Empty', '');
    const snapshot = await scanModsDir(modsDir);
    expect(snapshot.mods.map((mod) => mod.folderName)).toEqual(['Broken', 'Empty']);
    const broken = snapshot.mods[0];
    expect(broken?.name).toBe('Broken');
    expect(broken?.enabled).toBe(false);
    expect(broken?.parseError).toMatch(/^manifest JSON 解析失败: /);
    expect(snapshot.mods[1]?.parseError).toMatch(/^manifest JSON 解析失败: /);
  });
});

describe('setModEnabled：改名启停', () => {
  it('禁用 = manifest.json 改名为 manifest.json.disabled 并回写快照', async () => {
    const root = await makeTempRoot();
    const modsDir = join(root, 'Mods');
    await addMod(modsDir, 'ModA');
    const result = await setModEnabled(modsDir, 'ModA', false);
    expect(result.ok).toBe(true);
    expect(await pathExists(join(modsDir, 'ModA', 'manifest.json.disabled'))).toBe(true);
    expect(await pathExists(join(modsDir, 'ModA', 'manifest.json'))).toBe(false);
    expect(result.snapshot?.mods[0]?.enabled).toBe(false);
  });

  it('启用 = .disabled 改回 manifest.json', async () => {
    const root = await makeTempRoot();
    const modsDir = join(root, 'Mods');
    await writeText(join(modsDir, 'ModA', 'manifest.json.disabled'), manifestText());
    const result = await setModEnabled(modsDir, 'ModA', true);
    expect(result.ok).toBe(true);
    expect(await pathExists(join(modsDir, 'ModA', 'manifest.json'))).toBe(true);
    expect(await pathExists(join(modsDir, 'ModA', 'manifest.json.disabled'))).toBe(false);
    expect(result.snapshot?.mods[0]?.enabled).toBe(true);
  });

  it('已处于目标状态时幂等返回 ok', async () => {
    const root = await makeTempRoot();
    const modsDir = join(root, 'Mods');
    await addMod(modsDir, 'ModA');
    const enableAgain = await setModEnabled(modsDir, 'ModA', true);
    expect(enableAgain.ok).toBe(true);
    expect(enableAgain.snapshot?.mods[0]?.enabled).toBe(true);

    await setModEnabled(modsDir, 'ModA', false);
    const disableAgain = await setModEnabled(modsDir, 'ModA', false);
    expect(disableAgain.ok).toBe(true);
    expect(disableAgain.snapshot?.mods[0]?.enabled).toBe(false);
  });

  it.each(['', '.', '..', 'a/b', 'a\\b', 'a\u0000b'])('拒绝非法目录名 %j', async (name) => {
    const root = await makeTempRoot();
    const result = await setModEnabled(join(root, 'Mods'), name, true);
    expect(result).toEqual({ ok: false, error: '非法目录名' });
  });

  it('两个 manifest 形态并存时拒绝操作', async () => {
    const root = await makeTempRoot();
    const modsDir = join(root, 'Mods');
    const folder = join(modsDir, 'BothMod');
    await writeText(join(folder, 'manifest.json'), manifestText());
    await writeText(join(folder, 'manifest.json.disabled'), manifestText());
    const result = await setModEnabled(modsDir, 'BothMod', false);
    expect(result).toEqual({
      ok: false,
      error: 'manifest.json 与 manifest.json.disabled 同时存在，请手动处理',
    });
  });

  it('目录里没有任何 manifest 时返回中文错误', async () => {
    const root = await makeTempRoot();
    const result = await setModEnabled(join(root, 'Mods'), 'Ghost', true);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('未找到 manifest.json 或 manifest.json.disabled');
  });

  it('rename 失败时返回中文错误而不是抛出', async () => {
    const root = await makeTempRoot();
    const failure = await renameManifestFile(
      join(root, '不存在.json'),
      join(root, '不存在.json.disabled'),
    );
    expect(failure).toMatch(/^切换启用状态失败: /);
  });
});

describe('installModFromDirectory：解压目录安装', () => {
  it('源目录本身是 Mod：整目录复制并回写快照（自动创建 Mods）', async () => {
    const root = await makeTempRoot();
    const sourceDir = join(root, 'src', 'CoolMod');
    await writeText(join(sourceDir, 'manifest.json'), manifestText({ Name: 'Cool Mod' }));
    await writeText(join(sourceDir, 'assets', 'data.json'), '{}');
    const modsDir = join(root, 'Mods'); // 尚不存在

    const result = await installModFromDirectory(sourceDir, modsDir);
    expect(result.ok).toBe(true);
    expect(result.folderName).toBe('CoolMod');
    expect(await readFile(join(modsDir, 'CoolMod', 'assets', 'data.json'), 'utf8')).toBe('{}');
    expect(result.snapshot?.exists).toBe(true);
    expect(result.snapshot?.mods.map((mod) => mod.name)).toEqual(['Cool Mod']);
  });

  it('压缩包只有一个一级子目录时安装该子目录', async () => {
    const root = await makeTempRoot();
    const sourceDir = join(root, 'pkg');
    await writeText(join(sourceDir, 'readme.txt'), '解压说明');
    await writeText(join(sourceDir, 'InnerMod', 'manifest.json'), manifestText({ Name: 'Inner' }));

    const result = await installModFromDirectory(sourceDir, join(root, 'Mods'));
    expect(result.ok).toBe(true);
    expect(result.folderName).toBe('InnerMod');
    expect(result.snapshot?.mods.map((mod) => mod.name)).toEqual(['Inner']);
  });

  it('多个候选 Mod 时拒绝并只列出前三个名字', async () => {
    const root = await makeTempRoot();
    const sourceDir = join(root, 'pkg');
    await addCandidateMods(sourceDir, ['ModD', 'ModC', 'ModB', 'ModA']);
    const result = await installModFromDirectory(sourceDir, join(root, 'Mods'));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('压缩包内包含多个 Mod');
    expect(result.error).toContain('ModA、ModB、ModC');
    expect(result.error).not.toContain('ModD');
  });

  it('目标重名时追加 -2，不覆盖已有 Mod', async () => {
    const root = await makeTempRoot();
    const sourceDir = join(root, 'src', 'CoolMod');
    await writeText(join(sourceDir, 'manifest.json'), manifestText({ Name: 'Cool Mod' }));
    const modsDir = join(root, 'Mods');

    const first = await installModFromDirectory(sourceDir, modsDir);
    const second = await installModFromDirectory(sourceDir, modsDir);
    expect(first.folderName).toBe('CoolMod');
    expect(second.folderName).toBe('CoolMod-2');
    expect(second.snapshot?.mods.map((mod) => mod.folderName)).toEqual(['CoolMod', 'CoolMod-2']);
  });

  it('源目录没有 manifest 时失败且不抛错', async () => {
    const root = await makeTempRoot();
    const sourceDir = join(root, 'empty');
    await writeText(join(sourceDir, 'readme.txt'), 'x');
    const result = await installModFromDirectory(sourceDir, join(root, 'Mods'));
    expect(result).toEqual({ ok: false, error: '源目录中未找到 manifest.json' });
  });

  it('源目录不存在时返回读取失败', async () => {
    const root = await makeTempRoot();
    const result = await installModFromDirectory(join(root, 'nope'), join(root, 'Mods'));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^读取源目录失败: /);
  });

  it('Mods 路径不可用（父级是文件）时返回安装失败', async () => {
    const root = await makeTempRoot();
    const sourceDir = join(root, 'src', 'CoolMod');
    await writeText(join(sourceDir, 'manifest.json'), manifestText());
    await writeText(join(root, 'blocker'), 'i am a file');

    const result = await installModFromDirectory(sourceDir, join(root, 'blocker', 'Mods'));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^安装 Mod 失败: /);
  });

  it('同名副本占满上限时失败而不是无限追加', async () => {
    const root = await makeTempRoot();
    const sourceDir = join(root, 'src', 'CoolMod');
    await writeText(join(sourceDir, 'manifest.json'), manifestText());
    const modsDir = join(root, 'Mods');
    await mkdir(join(modsDir, 'CoolMod'), { recursive: true });
    for (let suffix = 2; suffix <= 99; suffix += 1) {
      await mkdir(join(modsDir, `CoolMod-${suffix}`), { recursive: true });
    }

    const result = await installModFromDirectory(sourceDir, modsDir);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^安装 Mod 失败: .*同名副本/);
  });
});

describe('guessModsDirs / 目录名工具', () => {
  it('darwin 返回 Contents/MacOS/Mods 与根目录 Mods 两个候选', () => {
    expect(guessModsDirs('darwin', '/Users/whale')).toEqual([
      '/Users/whale/Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/MacOS/Mods',
      '/Users/whale/Library/Application Support/Steam/steamapps/common/Stardew Valley/Mods',
    ]);
  });

  it('win32 返回 Program Files (x86) 与 Program Files 两个候选', () => {
    expect(guessModsDirs('win32', 'C:\\Users\\whale')).toEqual([
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Stardew Valley\\Mods',
      'C:\\Program Files\\Steam\\steamapps\\common\\Stardew Valley\\Mods',
    ]);
  });

  it('linux 返回 ~/.steam 与 ~/.local/share/Steam 两个候选', () => {
    expect(guessModsDirs('linux', '/home/whale')).toEqual([
      '/home/whale/.steam/steam/steamapps/common/Stardew Valley/Mods',
      '/home/whale/.local/share/Steam/steamapps/common/Stardew Valley/Mods',
    ]);
  });

  it('未知平台返回空数组', () => {
    expect(guessModsDirs('freebsd', '/home/whale')).toEqual([]);
  });

  it('sanitizeModFolderName 清洗非法字符与首尾点 / 空格', () => {
    expect(sanitizeModFolderName('Mod:Name?')).toBe('Mod_Name_');
    expect(sanitizeModFolderName('  spaced  ')).toBe('spaced');
    expect(sanitizeModFolderName('.hidden')).toBe('hidden');
    expect(sanitizeModFolderName('..')).toBe('mod');
    expect(sanitizeModFolderName('')).toBe('mod');
  });

  it('isSafeModFolderName 拒绝穿越与路径分隔符', () => {
    expect(isSafeModFolderName('Mod A')).toBe(true);
    expect(isSafeModFolderName('')).toBe(false);
    expect(isSafeModFolderName('.')).toBe(false);
    expect(isSafeModFolderName('..')).toBe(false);
    expect(isSafeModFolderName('a/b')).toBe(false);
    expect(isSafeModFolderName('a\\b')).toBe(false);
    expect(isSafeModFolderName('a\u0000b')).toBe(false);
  });

  it('errorMessage 把非 Error 值转成字符串', () => {
    expect(errorMessage('boom')).toBe('boom');
    expect(errorMessage(new Error('bad'))).toBe('bad');
  });
});
