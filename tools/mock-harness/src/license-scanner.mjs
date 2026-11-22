/**
 * [SIMULATION] 许可证扫描器（T-M0-04）——Gate 2 的独立可测实现。
 *
 * 检查项：
 *   1. docs/THIRD_PARTY_NOTICES.md 台账存在且非空壳
 *   2. 源码密钥泄漏特征（sk-/ghp_/AKIA/明文 apiKey 赋值）
 *   3. UNLICENSED 项目源码痕迹（fore-vip/dsh-live、newbeejmc/Dsh_douyin）
 *   4. GPL-3.0 传染源标记（cortico-world-douyin-live 弹幕协议）
 *
 * 用法：node tools/mock-harness/src/license-scanner.mjs <repo-root>
 * 退出码：0 全绿；1 存在违规。本脚本自身与 verify-gate.mjs 含规则字面量，扫描时排除。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.argv[2] ? String(process.argv[2]) : join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SELF = fileURLToPath(import.meta.url);
const SELF_GUARD = 'license-scanner.mjs';
const SCAN_DIRS = ['packages', 'apps', 'services', 'tools', 'mods'];
const SKIP_DIR_NAMES = new Set([
  'node_modules', 'dist', 'build', 'coverage', '.git', '.venv', '__pycache__',
  'bin', 'obj', '.ruff_cache', '.mypy_cache', 'out', 'test-fixtures',
]);
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.cs']);

const SECRET_RULES = [
  { re: /\bsk-[A-Za-z0-9]{16,}\b/, label: '疑似 OpenAI 风格密钥 (sk-...)' },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/, label: '疑似 GitHub Token (ghp_...)' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: '疑似 AWS Access Key (AKIA...)' },
  { re: /api[_-]?key\s*[:=]\s*['"][A-Za-z0-9_\-.]{12,}['"]/i, label: '疑似明文 apiKey 赋值' },
];

const FORBIDDEN_MARKERS = [
  { re: /fore-vip[/\\]dsh-live(?!-studio)/i, label: 'fore-vip/dsh-live（UNLICENSED）源码痕迹' },
  { re: /newbeejmc[/\\]Dsh_douyin/i, label: 'newbeejmc/Dsh_douyin（UNLICENSED）源码痕迹' },
  { re: /cortico-world-douyin-live/i, label: 'cortico-world-douyin-live（GPL-3.0 传染源）引入痕迹' },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry)) continue;
      yield* walk(abs);
    } else if (CODE_EXT.has(extname(entry).toLowerCase())) {
      yield abs;
    }
  }
}

const violations = [];
let scanned = 0;

// 1) 台账检查
const noticesPath = join(ROOT, 'docs', 'THIRD_PARTY_NOTICES.md');
if (!existsSync(noticesPath) || readFileSync(noticesPath, 'utf8').length <= 200) {
  violations.push('[台账缺失] docs/THIRD_PARTY_NOTICES.md 不存在或为空壳（每引入一个第三方依赖/素材必须登记）');
}

// 2~4) 源码扫描
for (const dirName of SCAN_DIRS) {
  const abs = join(ROOT, dirName);
  if (!existsSync(abs)) continue;
  for (const file of walk(abs)) {
    // 自身 / verify-gate / 各 *.spec.ts（按约定承载测试假密钥与规则字面量，如 sanitizer/scanner 自测）——排除
    if (file === SELF || file.endsWith(SELF_GUARD) || file.endsWith('verify-gate.mjs') || file.endsWith('.spec.ts')) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    scanned += 1;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const rule of SECRET_RULES) {
        if (rule.re.test(lines[i])) violations.push(`[密钥泄漏嫌疑] ${relative(ROOT, file)}:${i + 1}  ${rule.label}`);
      }
      for (const rule of FORBIDDEN_MARKERS) {
        if (rule.re.test(lines[i])) violations.push(`[许可证红线] ${relative(ROOT, file)}:${i + 1}  ${rule.label}`);
      }
    }
  }
}

console.log(`license-scanner: 扫描 ${scanned} 个源文件，发现 ${violations.length} 处违规`);
for (const line of violations) console.log(`  ${line}`);
if (violations.length > 0) {
  console.log('license-scanner: FAIL（详见 docs/REFERENCES.md §3 硬性红线）');
  process.exit(1);
}
console.log('license-scanner: PASS（台账 OK；0 密钥泄漏 / 0 UNLICENSED 源码痕迹 / 0 GPL 传染源）');
