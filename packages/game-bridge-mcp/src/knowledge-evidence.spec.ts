import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PlayReceiptSchema, type GameKnowledgeItem } from '@workbench/shared-protocol';
import { GuideLibrary } from './guide-library';
import { applyPlayReceipt, assessKnowledge, buildEvidencePack, candidatesFromEvidence, canonicalJson, invalidateMaterialEvidence, locateSourceText, reviseKnowledge, sha256, transitionKnowledge, verifyEvidencePack } from './knowledge-evidence';

const text = readFileSync(new URL('../../../tools/mock-harness/fixtures/knowledge-slice/spring-guide.md', import.meta.url), 'utf8');
const quote = text.trimEnd().split('\n').at(-1)!;
const material = { materialId: 'mat-fixture-spring', title: 'spring-guide.md', originUri: 'file:///fixture/spring-guide.md', sha256: sha256(text), sourceRevision: 'fixture-rev-1', licenseScope: 'mit' as const, readAt: '2026-11-27T00:00:00Z' };
const makePack = () => buildEvidencePack({ material, chunks: [{ chunkId: 'blk-body', locator: locateSourceText(text, quote)!, text: quote, origin: 'source' }], extraction: 'complete', topic: '春季浇水', sourceType: 'wiki', readerVersion: 'fixture-1' });
const unit = (): GameKnowledgeItem => candidatesFromEvidence(makePack(), text)[0]!;
const state = '游戏版本：1.6.15\n已装 Mod：原版\n时间：第1年春3日 06:00，天气：晴，明天天气：雨\n地点：Farm，室外';

describe('04B/D：确定性证据、四态与适用性', () => {
  it('键顺序、读取墙钟和机器路径变化不改 digest，正文/许可/版本/参数变化会改', () => {
    const pack = makePack();
    expect(pack).toEqual(JSON.parse(readFileSync(new URL('../../../tools/mock-harness/fixtures/knowledge-slice/expected-pack.json', import.meta.url), 'utf8')));
    expect(canonicalJson({ b: [true, null], a: 2 })).toBe('{"a":2,"b":[true,null]}');
    for (const value of [undefined, Number.NaN, () => null]) expect(() => canonicalJson(value)).toThrow();
    expect(verifyEvidencePack(pack)).toBe(true);
    const later = buildEvidencePack({ material: { ...material, readAt: 'later', originUri: 'file:///another/machine.md' }, chunks: pack.chunks, extraction: 'complete', topic: pack.parameters.topic, sourceType: 'wiki', readerVersion: 'fixture-1' });
    expect(later.digest).toBe(pack.digest);
    expect(verifyEvidencePack({ ...pack, chunks: [] })).toBe(false);
    expect(verifyEvidencePack({ ...pack, digest: 'bad' })).toBe(false);
    expect(verifyEvidencePack({ ...pack, source: { ...pack.source, licenseScope: 'unknown' } })).toBe(false);
    expect(verifyEvidencePack({ ...pack, sourceRevision: 'changed' })).toBe(false);
    expect(verifyEvidencePack({ ...pack, parameters: { ...pack.parameters, topic: 'changed' } })).toBe(false);
    expect(() => candidatesFromEvidence({ ...pack, chunks: [] }, text)).toThrow();
  });
  it('原文定位、候选来源、派生文本拒绝与部分抽取降级', () => {
    expect(locateSourceText(text, quote)).toEqual({ kind: 'text', startLine: 7, endLine: 7 });
    expect(locateSourceText(text, '')).toBeNull();
    expect(locateSourceText(text, '不在原文')).toBeNull();
    expect(locateSourceText(text, '<!--\ngameId: stardew')).toEqual({ kind: 'text', startLine: 1, endLine: 2 });
    expect(unit()).toMatchObject({ unitState: 'candidate', status: 'unverified', evidenceLevel: 'unverified', confidence: 0.5, gameVersion: '1.6' });
    const partial = buildEvidencePack({ material, chunks: makePack().chunks, extraction: 'partial', topic: '春', sourceType: 'wiki', readerVersion: 'fixture-1' });
    expect(candidatesFromEvidence(partial, text)[0]!.confidence).toBe(0);
    const derived = buildEvidencePack({ material, chunks: [{ ...makePack().chunks[0]!, origin: 'derived' }], extraction: 'complete', topic: '春', sourceType: 'wiki', readerVersion: 'fixture-1' });
    expect(candidatesFromEvidence(derived, text)).toEqual([]);
  });
  it('跳级被拒，verified 需证据和定位复核，修改与修订/缺失使生命周期退回 candidate', () => {
    expect(() => transitionKnowledge(unit(), 'promoted', true)).toThrow('非法');
    expect(() => transitionKnowledge(unit(), 'verified')).toThrow('证据');
    expect(() => transitionKnowledge({ ...unit(), evidenceRefs: [] }, 'verified', true)).toThrow();
    const verified = transitionKnowledge(unit(), 'verified', true);
    expect(transitionKnowledge(verified, 'promoted').unitState).toBe('promoted');
    const archived = transitionKnowledge(verified, 'archived');
    expect(transitionKnowledge(archived, 'candidate').unitState).toBe('candidate');
    expect(reviseKnowledge(verified, '新说法')).toMatchObject({ claim: '新说法', unitState: 'candidate', confidence: 0 });
    expect(invalidateMaterialEvidence(verified, material.materialId, false).evidenceRefs[0]!.extraction).toBe('partial');
    expect(invalidateMaterialEvidence(verified, material.materialId, true).evidenceRefs[0]!.extraction).toBe('failed');
    expect(invalidateMaterialEvidence(verified, 'other', false).evidenceRefs).toEqual(verified.evidenceRefs);
  });
  it('真实状态核对版本/Mod/季节/日期/天气/地点；不满足、未知条件和不可达都拒绝执行', () => {
    const item = { ...unit(), applicability: ['春季', '第3日', '天气：晴', '地点：Farm'] };
    expect(assessKnowledge(item, state, '2026-11-27')).toMatchObject({ executable: true, status: 'compatible', runtimeSeason: '春', runtimeDay: 3 });
    expect(assessKnowledge({ ...item, applicability: ['夏', '第4日'] }, state, 'now').status).toBe('not-applicable');
    expect(assessKnowledge({ ...item, applicability: ['明年赚钱最多'] }, state, 'now').status).toBe('uncertain');
    expect(assessKnowledge(item, null, 'now')).toMatchObject({ executable: false, status: 'uncertain' });
    expect(assessKnowledge({ ...item, gameVersion: '1.5' }, state, 'now').executable).toBe(false);
    expect(assessKnowledge({ ...item, modContext: ['SVE'] }, state, 'now').status).toBe('mod-mismatch');
    expect(assessKnowledge({ ...item, modContext: ['SVE'] }, '游戏版本：1.6', 'now').modMatch).toBe('unreadable');
    expect(assessKnowledge({ ...item, evidenceRefs: [] }, state, 'now').executable).toBe(false);
    expect(assessKnowledge({ ...item, unitState: 'archived' }, state, 'now').executable).toBe(false);
    expect(assessKnowledge({ ...item, status: 'rejected' }, state, 'now').executable).toBe(false);
    expect(assessKnowledge({ ...item, expiresAt: '2020-01-01' }, state, '2026-11-27').executable).toBe(false);
    expect(assessKnowledge({ ...item, gameVersion: undefined }, state, 'now').versionMatch).toBe('not-declared');
  });
  it('本地旧攻略候选仍可读但不捏造证据，实玩回执只演进可信度、不自动晋升', () => {
    const library = new GuideLibrary({ 春季: text });
    expect(library.readSection('春季').ok).toBe(true);
    expect(library.knowledgeCandidates('now')[0]).toMatchObject({ unitState: 'candidate', evidenceRefs: [], confidence: 0 });
    expect(library.knowledgeCandidates('later')[0]!.knowledgeId).toBe(library.knowledgeCandidates('now')[0]!.knowledgeId);
    const receipt = PlayReceiptSchema.parse({ receiptId: 'r', knowledgeId: unit().knowledgeId, actionId: 'a', tool: 'water_crops', receiptStatus: 'COMPLETED', summary: '成功', stateChanged: true, evidenceLevel: 'simulation', beforeState: 'a', afterState: 'b', rawReceipt: '成功', simulation: true, capturedAt: 'now' });
    expect(applyPlayReceipt(unit(), receipt)).toMatchObject({ unitState: 'candidate', confidence: 0.6, status: 'partially-verified', evidenceLevel: 'simulation' });
    expect(applyPlayReceipt(unit(), { ...receipt, receiptStatus: 'FAILED' }).contradictoryEvidence).toEqual(['成功']);
    expect(applyPlayReceipt(unit(), { ...receipt, suspicious: true })).toEqual(unit());
    expect(applyPlayReceipt(unit(), { ...receipt, receiptStatus: 'UNCERTAIN' })).toEqual(unit());
    expect(() => applyPlayReceipt(unit(), { ...receipt, knowledgeId: 'other' })).toThrow();
  });
});
