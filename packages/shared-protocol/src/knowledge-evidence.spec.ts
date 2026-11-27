import { describe, expect, it } from 'vitest';
import { EvidenceLocatorSchema, EvidenceRefSchema, GameKnowledgeItemSchema } from './knowledge';
import { EnvoyReadResponseSchema, KnowledgeExecuteInputSchema, KnowledgeImportMaterialInputSchema, KnowledgeSourceStatusSchema } from './knowledge-evidence';

describe('04A：证据契约与向后兼容', () => {
  it('旧记录无新字段仍可解析且不会被冒称 verified/真实证据', () => {
    const old = GameKnowledgeItemSchema.parse({ knowledgeId: 'k', topic: '春', claim: '浇水', sourceType: 'wiki', retrievedAt: '2026-11-27', confidence: 0.5, status: 'verified' });
    expect(old.unitState).toBe('candidate');
    expect(old.evidenceLevel).toBe('unverified');
    expect(old.evidenceRefs).toEqual([]);
    expect(old.status).toBe('verified');
  });
  it('定位判别联合拒绝非法范围/组合，SHA 拒绝大写、短哈希', () => {
    for (const locator of [
      { kind: 'text', startLine: 1, endLine: 4 }, { kind: 'video', startMs: 0, endMs: 50 },
      { kind: 'pdf', page: 1 }, { kind: 'web', url: 'https://example.test' },
      { kind: 'image-region', x: 0, y: 0, w: 1, h: 1 },
    ]) expect(EvidenceLocatorSchema.safeParse(locator).success).toBe(true);
    for (const locator of [
      { kind: 'text', startLine: 4, endLine: 1 }, { kind: 'video', startMs: 1, endMs: 1 },
      { kind: 'text', page: 1 }, { kind: 'pdf', page: 0 }, { kind: 'image-region', x: -1, y: 0, w: 1, h: 1 },
    ]) expect(EvidenceLocatorSchema.safeParse(locator).success).toBe(false);
    const ref = { evidenceId: 'e', materialId: 'm', locator: { kind: 'text', startLine: 1, endLine: 1 }, capturedAt: '2026-11-27' };
    expect(EvidenceRefSchema.parse(ref).extraction).toBe('unknown');
    for (const hash of ['abc', 'A'.repeat(64), 'g'.repeat(64)]) expect(EvidenceRefSchema.safeParse({ ...ref, materialSha256: hash }).success).toBe(false);
  });
  it('知识源不能宣称可写，导入许可默认未知，执行不存在绕过条件开关', () => {
    expect(KnowledgeSourceStatusSchema.safeParse({ state: 'available', checkedAt: 'now', readOnly: false }).success).toBe(false);
    expect(KnowledgeImportMaterialInputSchema.parse({ filePath: '/fixture', topic: '春' }).licenseScope).toBe('unknown');
    const request = KnowledgeExecuteInputSchema.parse({ knowledgeId: 'k', tool: 'wait', ownerOverride: true });
    expect(request).not.toHaveProperty('ownerOverride');
    expect(EnvoyReadResponseSchema.safeParse({ result: 'made-up' }).success).toBe(false);
  });
});
