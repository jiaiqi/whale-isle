/**
 * T-M0-02：契约跨语言导出器（Single Source of Truth 的编译器）
 *
 * Zod（src/registry.ts）→
 *   ① packages/shared-protocol/schema/*.schema.json   —— 供 C# SMAPI Mod 校验
 *   ② packages/shared-protocol/schema/workbench.schema.json —— 合并视图（去重 $defs）
 *   ③ services/audio-ai-worker/protocol_models.py     —— Pydantic（datamodel-codegen）
 *
 * 生成物一律不入手工编辑；重跑：`pnpm gen:contracts`
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CONTRACT_SCHEMAS, CONTRACT_VERSION } from '../../packages/shared-protocol/src/registry';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA_DIR = join(ROOT, 'packages/shared-protocol/schema');
const MERGED_PATH = join(SCHEMA_DIR, 'workbench.schema.json');
const PY_OUT = join(ROOT, 'services/audio-ai-worker/protocol_models.py');

type JsonSchemaDoc = {
  $ref?: string;
  $defs?: Record<string, unknown>;
  [key: string]: unknown;
};

const names = Object.keys(CONTRACT_SCHEMAS);
mkdirSync(SCHEMA_DIR, { recursive: true });

const mergedDefs: Record<string, unknown> = {};
const properties: Record<string, unknown> = {};

for (const name of names) {
  const raw = zodToJsonSchema(CONTRACT_SCHEMAS[name], {
    name,
    target: 'jsonSchema7',
    definitionPath: '$defs', // 默认是 draft-05 风格的 definitions，统一为 draft-07 的 $defs
  }) as JsonSchemaDoc;
  const doc = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    // 注意：不设 $id —— $id 会改变 $ref 基 URI，导致下游解析器把 '#/$defs/...' 视为远程引用
    title: name,
    contractVersion: CONTRACT_VERSION,
    ...raw,
  };
  writeFileSync(join(SCHEMA_DIR, `${name}.schema.json`), `${JSON.stringify(doc, null, 2)}\n`);

  for (const [defName, def] of Object.entries(raw.$defs ?? {})) {
    const prev = mergedDefs[defName];
    if (prev !== undefined && JSON.stringify(prev) !== JSON.stringify(def)) {
      throw new Error(`契约 $defs 名称冲突：${defName} 在不同 Schema 中内容不一致（契约漂移，禁止生成）`);
    }
    mergedDefs[defName] = def;
  }
  properties[name] = { $ref: `#/$defs/${name}` };
  console.log(`  ✓ ${name}.schema.json`);
}

// 合并视图：Python 侧一次生成、共享子 Schema 类不重复
const merged = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'AIWorkbenchContracts',
  contractVersion: CONTRACT_VERSION,
  type: 'object',
  required: names,
  properties,
  additionalProperties: false,
  $defs: mergedDefs,
};
writeFileSync(MERGED_PATH, `${JSON.stringify(merged, null, 2)}\n`);
console.log(`  ✓ workbench.schema.json（${names.length} 个契约，${Object.keys(mergedDefs).length} 个 $defs）`);

// Pydantic 生成（uv 临时环境，免污染系统 Python）
execFileSync('uv', [
  'run', '--quiet', '--with', 'datamodel-code-generator',
  'datamodel-codegen',
  '--input', MERGED_PATH,
  '--input-file-type', 'jsonschema',
  '--output', PY_OUT,
  '--target-python-version', '3.11',
  '--use-default',
  // Pydantic v2 推荐：约束用 Annotated[...] 而非 conint() 函数调用（mypy --strict 兼容）
  '--use-annotated',
  '--disable-timestamp',
], { cwd: ROOT, stdio: 'inherit' });

// 统一横幅：标记生成物与事实源
const banner = [
  `# AUTO-GENERATED（T-M0-02 契约跨语言导出器）—— 请勿手工编辑`,
  `# 事实源：packages/shared-protocol/src/registry.ts（contractVersion=${CONTRACT_VERSION}）`,
  `# 重新生成：pnpm gen:contracts ｜ 线上字段名保持 camelCase（与 JSON Schema / 网络字节一致）`,
  '',
].join('\n');
writeFileSync(PY_OUT, banner + readFileSync(PY_OUT, 'utf8'));
console.log(`  ✓ protocol_models.py`);
console.log('跨语言导出完成。下一步：pnpm py:check（ruff + mypy --strict + pytest 夹具回放）');
