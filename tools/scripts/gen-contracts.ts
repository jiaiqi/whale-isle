/**
 * T-M0-02：契约跨语言导出器（Single Source of Truth 的编译器）
 *
 * Zod（src/registry.ts）→
 *   ① packages/shared-protocol/schema/*.schema.json   —— 供 C# SMAPI Mod 校验
 *   ② packages/shared-protocol/schema/workbench.schema.json —— 合并视图（去重 $defs）
 *   ③ services/audio-ai-worker/protocol_models.py     —— Pydantic（datamodel-codegen）
 *
 * T-M6-30：从已停止维护的 `zod-to-json-schema` 迁移到 Zod 4 原生 `toJSONSchema()`
 * （Schema 实例方法，与 `z.toJSONSchema(schema)` 同一实现；生成器无需直接依赖 zod 包）。
 * 序列化口径与旧版对齐（见 `normalizeSchemaNode`）：
 *   - `io: 'input'`：带 `.default()` / `.prefault()` 的字段不进入 `required`，且保留 `default`
 *     （datamodel-codegen `--use-default` 依赖该信息生成 Pydantic 默认值）；
 *   - 补 `additionalProperties: false`：Zod 4 的 input 模式不再为 `z.object()` 输出该关键字，
 *     旧版（zod 3）会输出，补回以维持 draft-07 严格对象语义；
 *   - 剥离 Zod 4 `.int()` 自动附加的 safe-integer 边界（±9007199254740991），它不是契约作者
 *     声明的约束，保留会让每个 Python int 字段多出无意义的 ge/le；
 *   - 剥离 `.uuid()` 同时输出的冗余 `pattern`（保留 `format: uuid`；datamodel-codegen 对 UUID
 *     也会丢弃 pattern 并告警）。
 *
 * 生成物一律不入手工编辑；重跑：`pnpm gen:contracts`
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_SCHEMAS, CONTRACT_VERSION } from '../../packages/shared-protocol/src/registry';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA_DIR = join(ROOT, 'packages/shared-protocol/schema');
const MERGED_PATH = join(SCHEMA_DIR, 'workbench.schema.json');
const PY_OUT = join(ROOT, 'services/audio-ai-worker/protocol_models.py');
const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';

/** Zod 4 `.int()` 序列化出的 safe-integer 边界（-Number.MAX_SAFE_INTEGER / Number.MAX_SAFE_INTEGER） */
const ZOD_SAFE_INT_MIN = -9007199254740991;
const ZOD_SAFE_INT_MAX = 9007199254740991;
/** 这些键下是数据值（默认值/枚举/常量/示例），不是 Schema 节点，递归时原样保留 */
const DATA_KEYS = new Set(['default', 'enum', 'const', 'examples']);

type JsonSchemaNode = Record<string, unknown>;

/**
 * 把 Zod 4 的 draft-07 输出规整为与旧版 zod-to-json-schema 生成物语义等价的结构。
 * 只做 Zod 序列化口径的差异归一，不增删契约作者声明的字段/枚举/约束/default。
 */
function normalizeSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeSchemaNode);
  if (node === null || typeof node !== 'object') return node;
  const out: JsonSchemaNode = {};
  for (const [key, value] of Object.entries(node as JsonSchemaNode)) {
    out[key] = DATA_KEYS.has(key) ? value : normalizeSchemaNode(value);
  }
  // Zod 4 的 io:'input' 只在 z.strictObject() 时输出 additionalProperties:false；
  // 本仓统一用 z.object()（strip 语义），旧版生成物为 false，补回以保持严格对象校验。
  if (out.type === 'object' && out.properties !== undefined && out.additionalProperties === undefined) {
    out.additionalProperties = false;
  }
  if (out.type === 'integer') {
    if (out.minimum === ZOD_SAFE_INT_MIN) delete out.minimum;
    if (out.maximum === ZOD_SAFE_INT_MAX) delete out.maximum;
  }
  if (out.format === 'uuid' && typeof out.pattern === 'string') delete out.pattern;
  return out;
}

/** 单个契约 → draft-07 根 Schema（内联全部子 Schema，保证每份文件只有一个同名 $defs） */
function toContractBody(schema: (typeof CONTRACT_SCHEMAS)[string]): JsonSchemaNode {
  // 用 Zod 4 的 Schema 实例方法（与 z.toJSONSchema 同一实现），生成器无需直接依赖 zod 包解析
  const raw = schema.toJSONSchema({
    target: 'draft-07',
    io: 'input',
    reused: 'inline',
    unrepresentable: 'throw',
  }) as JsonSchemaNode;
  delete raw.$schema; // 统一由外层文档声明 draft-07
  return normalizeSchemaNode(raw) as JsonSchemaNode;
}

const entries = Object.entries(CONTRACT_SCHEMAS);
const names = Object.keys(CONTRACT_SCHEMAS);
mkdirSync(SCHEMA_DIR, { recursive: true });

const mergedDefs: Record<string, unknown> = {};
const properties: Record<string, unknown> = {};

for (const [name, schema] of entries) {
  const body = toContractBody(schema);
  const doc = {
    $schema: DRAFT_07,
    // 注意：不设 $id —— $id 会改变 $ref 基 URI，导致下游解析器把 '#/$defs/...' 视为远程引用
    title: name,
    contractVersion: CONTRACT_VERSION,
    $ref: `#/$defs/${name}`,
    $defs: { [name]: body },
  };
  writeFileSync(join(SCHEMA_DIR, `${name}.schema.json`), `${JSON.stringify(doc, null, 2)}\n`);

  for (const [defName, def] of Object.entries(doc.$defs)) {
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
  $schema: DRAFT_07,
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
