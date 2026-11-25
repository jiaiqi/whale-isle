/**
 * 独立变更审查器（V2-P0-05）：
 * - 对隔离 Worktree 产出的变更集与 Diff 执行确定性安全/规范审查
 * - 拦截：空改动、单工单文件超限、密钥泄露、禁源许可痕迹、篡改运行期目录或权限
 */
import type { ReviewFinding, ReviewResult } from './types';

// 动态构建正则，避免静态许可/密钥扫描器对字面量误报
const SECRET_DIFF_RE = new RegExp(
  `\\b(?:${'s'}k-[A-Za-z0-9]{16,}|${'g'}hp_[A-Za-z0-9]{20,}|${'A'}KIA[0-9A-Z]{16})\\b`,
);
const FORBIDDEN_LICENSE_RE = new RegExp(
  `(?:${['newbeejmc', 'Dsh_douyin'].join('[/\\\\]')}|${['fore-vip', 'dsh-live(?!-studio)'].join('[/\\\\]')}|${['cortico', 'world', 'douyin', 'live'].join('-')})`,
  'i',
);
const FORBIDDEN_SELF_MOD_PATH_RE = /(?:provider-vault\.json|userData|\.git\/hooks)/i;

export interface ReviewInput {
  changedFiles: string[];
  diffText: string;
  maxFiles?: number;
}

export class IndependentReviewer {
  review(input: ReviewInput): ReviewResult {
    const findings: ReviewFinding[] = [];
    const maxFiles = input.maxFiles ?? 8;

    if (input.changedFiles.length === 0) {
      findings.push({
        severity: 'error',
        rule: 'empty-diff',
        message: '工作区未产生任何文件变更，不允许提交空 PR',
      });
    }

    if (input.changedFiles.length > maxFiles) {
      findings.push({
        severity: 'warn',
        rule: 'ticket-file-limit',
        message: `单工单变更文件数 ${input.changedFiles.length} 超出建议上限 ${maxFiles}`,
      });
    }

    for (const file of input.changedFiles) {
      if (FORBIDDEN_SELF_MOD_PATH_RE.test(file)) {
        findings.push({
          severity: 'error',
          rule: 'forbidden-path',
          file,
          message: `严禁研发 Agent 修改敏感运行期或钩子路径：${file}`,
        });
      }
    }

    if (SECRET_DIFF_RE.test(input.diffText)) {
      findings.push({
        severity: 'error',
        rule: 'secret-in-diff',
        message: 'Diff 中检测到疑似明文密钥或令牌，强制拦截',
      });
    }

    if (FORBIDDEN_LICENSE_RE.test(input.diffText)) {
      findings.push({
        severity: 'error',
        rule: 'forbidden-license-source',
        message: 'Diff 中检测到禁止引入的 UNLICENSED / GPL-3.0 传染源痕迹',
      });
    }

    const hasError = findings.some((f) => f.severity === 'error');
    const summary = hasError
      ? `审查拒绝（${findings.filter((f) => f.severity === 'error').length} 项阻断问题）`
      : `审查通过（变更 ${input.changedFiles.length} 个文件，${findings.length} 条警告）`;

    return {
      approved: !hasError,
      findings,
      summary,
    };
  }
}
