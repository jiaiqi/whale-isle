/**
 * 外部服务商配置只读导入器单测（T-M6-09）：
 * - Magpie 三种根形态 / 字段别名 / 完整端点 / 缺 Key / 损坏 JSON / 文件不存在；
 * - CC Switch JSON（settings_config 字符串、config 对象、旧版 config.json、模型逗号分隔）；
 * - CC Switch SQLite（系统 sqlite3 建临时 db；断言 scan 前后 mtime + sha256 不变 = 只读铁律）；
 * - 预览掩码不含明文、planImport 三态与安全优先。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectImportCandidates,
  planImport,
  scanCcSwitch,
  scanImportFile,
  scanMagpie,
  toPreview,
  type ImportCandidate,
} from './provider-importer';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'prov-import-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeJson(dir: string, relativePath: string, value: unknown): string {
  const filePath = join(dir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
  return filePath;
}

function writeText(dir: string, relativePath: string, text: string): string {
  const filePath = join(dir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, text, 'utf8');
  return filePath;
}

const sqlite3Available = (() => {
  try {
    execFileSync('sqlite3', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
})();

interface SqliteFixtureRow {
  id: string;
  app?: string;
  name?: string;
  settings_config?: string;
}

function sqlQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function createProvidersDb(dbPath: string, rows: SqliteFixtureRow[]): void {
  const statements = [
    'CREATE TABLE providers (id TEXT PRIMARY KEY, app TEXT, name TEXT, settings_config TEXT);',
    ...rows.map(
      (row) =>
        `INSERT INTO providers (id, app, name, settings_config) VALUES ('${sqlQuote(row.id)}', '${sqlQuote(row.app ?? 'claude')}', '${sqlQuote(row.name ?? '')}', '${sqlQuote(row.settings_config ?? '')}');`,
    ),
  ];
  execFileSync('sqlite3', [dbPath, statements.join('\n')], { encoding: 'utf8' });
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function candidate(overrides: Partial<ImportCandidate> = {}): ImportCandidate {
  return {
    id: 'deepseek-official',
    name: 'DeepSeek 官方',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    isFullUrl: false,
    models: ['deepseek-chat'],
    apiKey: 'sk-deepseek-1234567890',
    source: 'magpie',
    matchedBuiltin: true,
    ...overrides,
  };
}

// ============================================================================
// Magpie
// ============================================================================

describe('Magpie 解析', () => {
  it('根为数组：解析两个供应商并命中内置 id', async () => {
    const dir = await tempDir();
    const filePath = writeJson(dir, 'magpie-array.json', [
      {
        name: 'DeepSeek 官方',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-deepseek-1234567890',
        models: ['deepseek-chat', 'deepseek-reasoner'],
      },
      {
        name: 'My Relay',
        baseUrl: 'https://relay.example.com/v1',
        key: 'sk-relay-abcdefghijkl',
        protocol: 'openai',
        models: ['relay-large'],
      },
    ]);

    const result = scanMagpie(filePath);
    expect(result.ok).toBe(true);
    expect(result.source).toBe('magpie');
    expect(result.detectedPath).toBe(filePath);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      id: 'deepseek-official',
      name: 'DeepSeek 官方',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      matchedBuiltin: true,
    });
    expect(result.items[1]?.id).toBe('imported-my-relay-1');
    expect(result.items[1]?.matchedBuiltin).toBe(false);
  });

  it('根为 {providers:[...]}：正常解析', async () => {
    const dir = await tempDir();
    const filePath = writeJson(dir, 'magpie-nested.json', {
      version: 1,
      providers: [
        {
          name: 'OpenRouter 中转',
          base_url: 'https://openrouter.ai/api/v1',
          api_key: 'sk-or-1234567890123456',
          models: ['openrouter/auto'],
        },
      ],
    });

    const result = scanMagpie(filePath);
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: 'openrouter',
      protocol: 'openai',
      matchedBuiltin: true,
    });
  });

  it('根为 {providers:{id:{...}}} 映射：用映射键兜底 id/名称', async () => {
    const dir = await tempDir();
    const filePath = writeJson(dir, 'magpie-map.json', {
      providers: {
        'deepseek-official': {
          name: 'DeepSeek 官方',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-deepseek-1234567890',
          models: ['deepseek-chat'],
        },
        'custom-gw': {
          name: 'Custom GW',
          base_url: 'https://gw.example.com/v1',
          api_key: 'sk-custom-1234567890',
          models: [],
        },
      },
    });

    const result = scanMagpie(filePath);
    expect(result.ok).toBe(true);
    expect(result.items.map((item) => item.id)).toEqual([
      'deepseek-official',
      'imported-custom-gw-1',
    ]);
  });

  it('字段别名容错：displayName / endpoint / token / {id}[] 模型 / anthropic 关键字', async () => {
    const dir = await tempDir();
    const filePath = writeJson(dir, 'magpie-alias.json', {
      providers: [
        {
          displayName: 'Relay A',
          endpoint: 'https://relay-a.example.com/v1/messages',
          token: 'sk-ant-1234567890abcdef',
          type: 'anthropic-messages',
          models: [{ id: 'claude-x' }, { id: 'claude-y' }],
        },
      ],
    });

    const result = scanMagpie(filePath);
    expect(result.ok).toBe(true);
    expect(result.items[0]).toMatchObject({
      id: 'imported-relay-a-1',
      name: 'Relay A',
      protocol: 'anthropic',
      baseUrl: 'https://relay-a.example.com/v1',
      models: ['claude-x', 'claude-y'],
      hasKey: true,
      matchedBuiltin: false,
    });
  });

  it('完整端点 /chat/completions：剥离到 base 并识别协议', async () => {
    const dir = await tempDir();
    const filePath = writeJson(dir, 'magpie-full-url.json', [
      {
        name: 'DeepSeek 完整端点',
        url: 'https://api.deepseek.com/v1/chat/completions',
        apiKey: 'sk-deepseek-1234567890',
      },
    ]);

    const result = scanMagpie(filePath);
    expect(result.ok).toBe(true);
    expect(result.items[0]).toMatchObject({
      id: 'deepseek-official',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
    });
  });

  it('完整端点 /messages 且无 protocol 字段：推断为 anthropic', async () => {
    const dir = await tempDir();
    const filePath = writeJson(dir, 'magpie-messages.json', [
      {
        name: 'Anthropic 官方',
        endpoint: 'https://api.anthropic.com/v1/messages',
        apiKey: 'sk-ant-1234567890abcdef',
      },
    ]);

    const result = scanMagpie(filePath);
    expect(result.ok).toBe(true);
    expect(result.items[0]).toMatchObject({
      id: 'anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      matchedBuiltin: true,
    });
  });

  it('缺 Key：仍生成候选，但 hasKey=false、keyMask 为空', async () => {
    const dir = await tempDir();
    const filePath = writeJson(dir, 'magpie-no-key.json', [
      { name: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', models: ['abab6.5'] },
    ]);

    const result = scanMagpie(filePath);
    expect(result.ok).toBe(true);
    expect(result.items[0]).toMatchObject({
      id: 'minimax',
      hasKey: false,
      keyMask: '',
      matchedBuiltin: true,
    });
  });

  it('损坏 JSON：ok=false + 中文错误，不抛异常', async () => {
    const dir = await tempDir();
    const filePath = writeText(dir, 'magpie-broken.json', '{"providers": [{"name": "x"');

    const result = scanMagpie(filePath);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('JSON 解析失败');
    expect(result.detectedPath).toBe(filePath);
    expect(result.items).toEqual([]);
  });

  it('文件不存在：ok=false、detectedPath 为空、错误含「未找到」', async () => {
    const dir = await tempDir();
    const result = scanMagpie(join(dir, 'nope', 'providers.json'));
    expect(result.ok).toBe(false);
    expect(result.detectedPath).toBe('');
    expect(result.error).toContain('未找到 Magpie');
    expect(result.items).toEqual([]);
  });

  it('默认路径：<home>/.config/magpie/providers.json', async () => {
    const home = await tempDir();
    const expected = writeJson(home, '.config/magpie/providers.json', [
      { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen2.5:7b'] },
    ]);

    const result = scanMagpie(undefined, home);
    expect(result.ok).toBe(true);
    expect(result.detectedPath).toBe(expected);
    expect(result.items[0]).toMatchObject({ id: 'local-ollama', matchedBuiltin: true });
  });
});

// ============================================================================
// CC Switch JSON
// ============================================================================

describe('CC Switch JSON 解析', () => {
  it('settings_config 字符串：ANTHROPIC_* env + 逗号分隔模型', async () => {
    const dir = await tempDir();
    const filePath = writeJson(dir, 'cc-switch.json', {
      version: 3,
      providers: [
        {
          id: 'uuid-claude',
          app: 'claude',
          name: 'Claude 订阅',
          settings_config: JSON.stringify({
            env: {
              ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1',
              ANTHROPIC_AUTH_TOKEN: 'sk-ant-1234567890abcdef',
              ANTHROPIC_MODEL: 'claude-sonnet-4,claude-haiku-4',
            },
          }),
        },
      ],
    });

    const result = scanCcSwitch(filePath);
    expect(result.ok).toBe(true);
    expect(result.source).toBe('ccswitch');
    expect(result.detectedPath).toBe(filePath);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: 'anthropic',
      name: 'Claude 订阅',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      models: ['claude-sonnet-4', 'claude-haiku-4'],
      hasKey: true,
      matchedBuiltin: true,
    });
  });

  it('config 对象：OPENAI_* env + config.model', async () => {
    const dir = await tempDir();
    const filePath = writeJson(dir, 'cc-switch-object.json', {
      providers: [
        {
          id: 'uuid-relay',
          name: 'Relay OAI',
          config: {
            env: {
              OPENAI_BASE_URL: 'https://relay.example.com/v1',
              OPENAI_API_KEY: 'sk-openai-1234567890',
            },
            model: 'gpt-4o-mini',
          },
        },
      ],
    });

    const result = scanCcSwitch(filePath);
    expect(result.ok).toBe(true);
    expect(result.items[0]).toMatchObject({
      id: 'imported-relay-oai-1',
      protocol: 'openai',
      baseUrl: 'https://relay.example.com/v1',
      models: ['gpt-4o-mini'],
      hasKey: true,
      matchedBuiltin: false,
    });
  });

  it('旧版 ~/.cc-switch/config.json 默认路径 + 映射形态', async () => {
    const home = await tempDir();
    const expected = writeJson(home, '.cc-switch/config.json', {
      providers: {
        claude: {
          name: 'Claude 旧版',
          settingsConfig: {
            env: {
              ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
              ANTHROPIC_API_KEY: 'sk-ant-old-1234567890',
              ANTHROPIC_MODEL: 'claude-3-7-sonnet',
            },
          },
        },
      },
    });

    const result = scanCcSwitch(undefined, home);
    expect(result.ok).toBe(true);
    expect(result.detectedPath).toBe(expected);
    expect(result.items[0]).toMatchObject({
      id: 'anthropic',
      name: 'Claude 旧版',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      models: ['claude-3-7-sonnet'],
    });
  });

  it('JSON 数组导出备份：可解析', async () => {
    const dir = await tempDir();
    const filePath = writeJson(dir, 'cc-switch-export.json', [
      {
        name: 'SiliconFlow',
        settings_config: {
          env: {
            OPENAI_BASE_URL: 'https://api.siliconflow.cn/v1',
            OPENAI_API_KEY: 'sk-sf-1234567890abcdef',
          },
        },
      },
    ]);

    const result = scanCcSwitch(filePath);
    expect(result.ok).toBe(true);
    expect(result.items[0]).toMatchObject({
      id: 'siliconflow',
      protocol: 'openai',
      matchedBuiltin: true,
    });
  });

  it('settings_config 损坏字符串：跳过该行并返回中文错误（不抛异常）', async () => {
    const dir = await tempDir();
    const filePath = writeJson(dir, 'cc-switch-broken-env.json', {
      providers: [{ name: '坏配置', settings_config: '{"env": {' }],
    });

    const result = scanCcSwitch(filePath);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未从 CC Switch');
    expect(result.items).toEqual([]);
  });

  it('ANTHROPIC_* / OPENAI_* 两套都缺失：跳过该行；全部缺失 → ok=false', async () => {
    const dir = await tempDir();
    const filePath = writeJson(dir, 'cc-switch-empty.json', {
      providers: [
        { name: '只有名字', settings_config: { env: { SOME_OTHER_KEY: 'x' } } },
        { name: '只有备注' },
      ],
    });

    const result = scanCcSwitch(filePath);
    expect(result.ok).toBe(false);
    expect(result.items).toEqual([]);
  });
});

// ============================================================================
// CC Switch SQLite（系统 sqlite3 CLI）
// ============================================================================

describe('CC Switch SQLite 解析（只读）', () => {
  it.skipIf(!sqlite3Available)(
    '读取 providers 表：anthropic / openai 两行正确归一',
    async () => {
      const dir = await tempDir();
      const dbPath = join(dir, 'cc-switch.db');
      createProvidersDb(dbPath, [
        {
          id: 'row-claude',
          app: 'claude',
          name: 'Claude 主号',
          settings_config: JSON.stringify({
            env: {
              ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1',
              ANTHROPIC_AUTH_TOKEN: 'sk-ant-1234567890abcdef',
              ANTHROPIC_MODEL: 'claude-sonnet-4',
            },
          }),
        },
        {
          id: 'row-relay',
          app: 'codex',
          name: 'Relay OAI',
          settings_config: JSON.stringify({
            env: {
              OPENAI_BASE_URL: 'https://relay.example.com/v1',
              OPENAI_API_KEY: 'sk-relay-1234567890',
              OPENAI_MODEL: 'gpt-4o-mini, gpt-4o',
            },
          }),
        },
      ]);

      const result = scanCcSwitch(dbPath);
      expect(result.ok).toBe(true);
      expect(result.source).toBe('ccswitch');
      expect(result.detectedPath).toBe(dbPath);
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({
        id: 'anthropic',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        models: ['claude-sonnet-4'],
      });
      expect(result.items[1]).toMatchObject({
        id: 'imported-relay-oai-1',
        protocol: 'openai',
        baseUrl: 'https://relay.example.com/v1',
        models: ['gpt-4o-mini', 'gpt-4o'],
      });
    },
  );

  it.skipIf(!sqlite3Available)('默认路径 <home>/.cc-switch/cc-switch.db：自动命中', async () => {
    const home = await tempDir();
    const dbPath = join(home, '.cc-switch', 'cc-switch.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    createProvidersDb(dbPath, [
      {
        id: 'row-default',
        name: 'Local Ollama',
        settings_config: JSON.stringify({
          env: {
            OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1',
            OPENAI_API_KEY: 'ollama',
            OPENAI_MODEL: 'qwen2.5:7b',
          },
        }),
      },
    ]);

    const result = scanCcSwitch(undefined, home);
    expect(result.ok).toBe(true);
    expect(result.detectedPath).toBe(dbPath);
    expect(result.items[0]).toMatchObject({
      id: 'local-ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: ['qwen2.5:7b'],
      matchedBuiltin: true,
    });
  });

  it.skipIf(!sqlite3Available)(
    '只读铁律：scan 前后原文件 mtime 与 sha256 完全不变',
    async () => {
      const dir = await tempDir();
      const dbPath = join(dir, 'cc-switch.db');
      createProvidersDb(dbPath, [
        {
          id: 'row-1',
          name: 'Claude 主号',
          settings_config: JSON.stringify({
            env: {
              ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1',
              ANTHROPIC_AUTH_TOKEN: 'sk-ant-1234567890abcdef',
            },
          }),
        },
      ]);

      const beforeMtime = statSync(dbPath).mtimeMs;
      const beforeHash = sha256File(dbPath);
      const result = scanCcSwitch(dbPath);
      const afterMtime = statSync(dbPath).mtimeMs;
      const afterHash = sha256File(dbPath);

      expect(result.ok).toBe(true);
      expect(afterMtime).toBe(beforeMtime);
      expect(afterHash).toBe(beforeHash);
    },
  );

  it.skipIf(!sqlite3Available)('无 providers 表：ok=false + 中文错误', async () => {
    const dir = await tempDir();
    const dbPath = join(dir, 'cc-switch.db');
    execFileSync('sqlite3', [dbPath, 'CREATE TABLE other (id TEXT);'], { encoding: 'utf8' });

    const result = scanCcSwitch(dbPath);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('providers 表');
    expect(result.detectedPath).toBe(dbPath);
  });

  it.skipIf(!sqlite3Available)('providers 表为空：ok=true 且 items 为空（合法空库）', async () => {
    const dir = await tempDir();
    const dbPath = join(dir, 'cc-switch.db');
    createProvidersDb(dbPath, []);

    const result = scanCcSwitch(dbPath);
    expect(result.ok).toBe(true);
    expect(result.items).toEqual([]);
  });

  it.skipIf(!sqlite3Available)('camelCase 列名 settingsConfig 容错', async () => {
    const dir = await tempDir();
    const dbPath = join(dir, 'cc-switch.db');
    const sql = [
      'CREATE TABLE providers (id TEXT PRIMARY KEY, app TEXT, name TEXT, settingsConfig TEXT);',
      `INSERT INTO providers VALUES ('r1', 'codex', 'Camel Relay', '${sqlQuote(
        JSON.stringify({
          env: {
            OPENAI_BASE_URL: 'https://camel.example.com/v1',
            OPENAI_API_KEY: 'sk-camel-1234567890',
            OPENAI_MODEL: 'camel-1,camel-2',
          },
        }),
      )}');`,
    ].join('\n');
    execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' });

    const result = scanCcSwitch(dbPath);
    expect(result.ok).toBe(true);
    expect(result.items[0]).toMatchObject({
      id: 'imported-camel-relay-1',
      baseUrl: 'https://camel.example.com/v1',
      models: ['camel-1', 'camel-2'],
    });
  });

  it('非法 DB 文件：ok=false，容错不抛异常', async () => {
    const dir = await tempDir();
    const dbPath = writeText(dir, 'garbage.db', 'this is definitely not a sqlite database');

    const result = scanCcSwitch(dbPath);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.items).toEqual([]);
  });
});

// ============================================================================
// 安全掩码
// ============================================================================

describe('预览掩码（绝不下发明文 Key）', () => {
  it('长 Key：前 4 + 8 个圆点 + 后 4，序列化结果不含明文', async () => {
    const dir = await tempDir();
    const apiKey = 'sk-secret-1234567890abcdef';
    const filePath = writeJson(dir, 'magpie-mask.json', [
      { name: 'Masked', baseUrl: 'https://mask.example.com/v1', apiKey },
    ]);

    const result = scanMagpie(filePath);
    const item = result.items[0] as NonNullable<(typeof result.items)[number]>;
    expect(item.hasKey).toBe(true);
    expect(item.keyMask).toBe(`${apiKey.slice(0, 4)}••••••••${apiKey.slice(-4)}`);
    expect('apiKey' in item).toBe(false);
    expect(JSON.stringify(result.items)).not.toContain(apiKey);
  });

  it('短 Key（<12）：全掩码，但仍标记 hasKey', async () => {
    const dir = await tempDir();
    const filePath = writeJson(dir, 'magpie-short.json', [
      { name: 'Short', baseUrl: 'https://short.example.com/v1', apiKey: 'sk-123' },
    ]);

    const result = scanMagpie(filePath);
    expect(result.items[0]).toMatchObject({ hasKey: true, keyMask: '••••••••' });
    expect(JSON.stringify(result.items)).not.toContain('sk-123');
  });

  it('无 Key：hasKey=false、keyMask 为空串', () => {
    const preview = toPreview(candidate({ apiKey: '' }));
    expect(preview.hasKey).toBe(false);
    expect(preview.keyMask).toBe('');
    expect(JSON.stringify(preview)).not.toContain('apiKey');
  });
});

// ============================================================================
// planImport
// ============================================================================

describe('planImport 冲突计划', () => {
  it('create / update / skip 三态：overwrite 更新，skip 保留（含无 Key 的已有项）', () => {
    const list = [
      candidate({ id: 'brand-new' }),
      candidate({ id: 'existing-with-key' }),
      candidate({ id: 'existing-without-key' }),
    ];

    const overwrite = planImport(list, {
      policy: 'overwrite',
      existingKeys: { 'existing-with-key': true, 'existing-without-key': false },
    });
    expect(overwrite.map((entry) => entry.action)).toEqual(['create', 'update', 'update']);

    const skip = planImport(list, {
      policy: 'skip',
      existingKeys: { 'existing-with-key': true, 'existing-without-key': false },
    });
    // 设计稿语义：已有条目但无凭据时补全元数据（update），只有已有凭据才 skip
    expect(skip.map((entry) => entry.action)).toEqual(['create', 'skip', 'update']);
  });

  it('保持候选引用不变（含明文 Key，交由调用方安全写入 vault）', () => {
    const list = [candidate({ id: 'ref-check', apiKey: 'sk-ref-1234567890' })];
    const planned = planImport(list, { policy: 'skip', existingKeys: {} });
    expect(planned[0]?.candidate).toBe(list[0]);
    expect(planned[0]?.candidate.apiKey).toBe('sk-ref-1234567890');
  });
});

// ============================================================================
// scanImportFile 自动嗅探
// ============================================================================

describe('scanImportFile 自动嗅探', () => {
  it('Magpie JSON：识别为 magpie', async () => {
    const dir = await tempDir();
    const filePath = writeJson(dir, 'magpie-auto.json', {
      providers: [
        {
          name: 'DeepSeek 官方',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-deepseek-1234567890',
        },
      ],
    });

    const result = scanImportFile(filePath);
    expect(result.ok).toBe(true);
    expect(result.source).toBe('magpie');
    expect(result.items[0]?.id).toBe('deepseek-official');
  });

  it('CC Switch JSON：识别为 ccswitch', async () => {
    const dir = await tempDir();
    const filePath = writeJson(dir, 'cc-switch-auto.json', {
      providers: [
        {
          name: 'Claude 订阅',
          settings_config: {
            env: {
              ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1',
              ANTHROPIC_AUTH_TOKEN: 'sk-ant-1234567890abcdef',
            },
          },
        },
      ],
    });

    const result = scanImportFile(filePath);
    expect(result.ok).toBe(true);
    expect(result.source).toBe('ccswitch');
    expect(result.items[0]?.id).toBe('anthropic');
  });

  it.skipIf(!sqlite3Available)('SQLite .db：按 CC Switch 数据库解析', async () => {
    const dir = await tempDir();
    const dbPath = join(dir, 'auto-cc-switch.db');
    createProvidersDb(dbPath, [
      {
        id: 'row-1',
        name: 'Relay Auto',
        settings_config: JSON.stringify({
          env: {
            OPENAI_BASE_URL: 'https://auto.example.com/v1',
            OPENAI_API_KEY: 'sk-auto-1234567890',
          },
        }),
      },
    ]);

    const result = scanImportFile(dbPath);
    expect(result.ok).toBe(true);
    expect(result.source).toBe('ccswitch');
    expect(result.items[0]?.id).toBe('imported-relay-auto-1');
  });

  it('无法识别的 JSON：ok=false、source=file + 中文错误', async () => {
    const dir = await tempDir();
    const filePath = writeJson(dir, 'unknown.json', { hello: 'world' });

    const result = scanImportFile(filePath);
    expect(result.ok).toBe(false);
    expect(result.source).toBe('file');
    expect(result.error).toContain('无法识别');
  });

  it('文件不存在：ok=false + 未找到', async () => {
    const dir = await tempDir();
    const result = scanImportFile(join(dir, 'missing.json'));
    expect(result.ok).toBe(false);
    expect(result.detectedPath).toBe('');
    expect(result.error).toContain('未找到导入文件');
  });
});

// ============================================================================
// collectImportCandidates（主进程内部：预览 + 明文候选同批返回）
// ============================================================================

describe('collectImportCandidates 内部候选收集', () => {
  it('Magpie 成功：candidates 与 items 同序一一对应，候选保留明文 Key、预览不含', async () => {
    const dir = await tempDir();
    const apiKey = 'sk-collect-1234567890abcdef';
    const filePath = writeJson(dir, 'collect-magpie.json', [
      {
        name: 'DeepSeek 官方',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey,
        models: ['deepseek-chat'],
      },
      {
        name: 'No Key Relay',
        baseUrl: 'https://relay.example.com/v1',
        models: [],
      },
    ]);

    const { result, candidates } = collectImportCandidates('magpie', filePath);
    expect(result.ok).toBe(true);
    expect(candidates).toHaveLength(result.items.length);
    expect(candidates[0]).toMatchObject({
      id: result.items[0]?.id,
      apiKey,
      source: 'magpie',
    });
    expect(candidates[1]).toMatchObject({
      id: result.items[1]?.id,
      apiKey: '',
    });
    expect(result.items[0]?.hasKey).toBe(true);
    expect(result.items[1]?.hasKey).toBe(false);
    expect(JSON.stringify(result.items)).not.toContain(apiKey);
  });

  it('file 成功：自动嗅探为 ccswitch，候选与预览同批且明文 Key 只在候选里', async () => {
    const dir = await tempDir();
    const apiKey = 'sk-ant-collect-1234567890';
    const filePath = writeJson(dir, 'collect-ccswitch.json', {
      providers: [
        {
          name: 'Claude 订阅',
          settings_config: JSON.stringify({
            env: {
              ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1',
              ANTHROPIC_AUTH_TOKEN: apiKey,
            },
          }),
        },
      ],
    });

    const { result, candidates } = collectImportCandidates('file', filePath);
    expect(result.ok).toBe(true);
    expect(result.source).toBe('ccswitch');
    expect(candidates).toHaveLength(result.items.length);
    expect(candidates[0]).toMatchObject({
      id: result.items[0]?.id,
      apiKey,
      source: 'ccswitch',
    });
    expect(JSON.stringify(result.items)).not.toContain(apiKey);
  });

  it('失败路径：文件不存在 / 无法识别 / 未给 file 路径时 candidates 均为空', async () => {
    const dir = await tempDir();

    const missing = collectImportCandidates('magpie', join(dir, 'nope.json'));
    expect(missing.result.ok).toBe(false);
    expect(missing.candidates).toEqual([]);

    const unknownPath = writeJson(dir, 'collect-unknown.json', { hello: 'world' });
    const unknown = collectImportCandidates('file', unknownPath);
    expect(unknown.result.ok).toBe(false);
    expect(unknown.candidates).toEqual([]);

    const noPath = collectImportCandidates('file');
    expect(noPath.result.ok).toBe(false);
    expect(noPath.candidates).toEqual([]);
  });
});
