import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { EvidencePackSchema, GameKnowledgeItemSchema, KnowledgeMaterialSchema, PlayReceiptSchema } from '@workbench/shared-protocol';
import { CURRENT_SQLITE_SCHEMA_VERSION, SqliteStore } from './sqlite';

const pack = EvidencePackSchema.parse(JSON.parse(readFileSync(new URL('../../../tools/mock-harness/fixtures/knowledge-slice/expected-pack.json', import.meta.url), 'utf8')));
const material = KnowledgeMaterialSchema.parse({ materialId: pack.materialId, originUri: pack.source.originUri, title: pack.source.title, sha256: pack.materialSha256, sourceRevision: pack.sourceRevision, licenseScope: pack.source.licenseScope, readAt: pack.capturedAt });
const unit = GameKnowledgeItemSchema.parse({ knowledgeId: 'knowledge-1', topic: '春', claim: pack.chunks[0]!.text, sourceType: 'wiki', retrievedAt: 'now', confidence: 0.5, status: 'unverified' });

describe('04B：同一 SQLite 的知识仓储', () => {
  it('导入幂等、旧版本可查，材料/证据/回执和原始状态重启后仍在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-repo-'));
    const path = join(dir, 'workbench.db');
    try {
      let store = new SqliteStore(path);
      const repo = store.knowledge;
      expect(repo.get('missing')).toBeNull();
      expect(repo.versions('missing')).toEqual([]);
      repo.import(material, pack, [unit]);
      repo.import(material, pack, [unit]);
      expect(repo.list()).toHaveLength(1);
      expect(repo.packs()).toHaveLength(1);
      expect(repo.packs(material.materialId)).toHaveLength(1);
      repo.update({ ...unit, claim: '编辑后的新说法' });
      repo.update({ ...unit, claim: '编辑后的新说法' });
      expect(repo.versions(unit.knowledgeId)).toEqual([unit]);
      expect(() => repo.update({ ...unit, knowledgeId: 'missing' })).toThrow('不存在');
      const receipt = PlayReceiptSchema.parse({ receiptId: 'r1', knowledgeId: unit.knowledgeId, actionId: 'a1', tool: 'water_crops', receiptStatus: 'FAILED', summary: '失败：未找到作物', stateChanged: false, evidenceLevel: 'simulation', simulation: true, beforeState: '前状态', afterState: '后状态', rawReceipt: '失败：未找到作物', capturedAt: 'now' });
      repo.recordReceipt(receipt, unit);
      expect(() => repo.recordReceipt({ ...receipt, receiptId: 'wrong', knowledgeId: 'other' }, unit)).toThrow();
      expect(() => repo.recordReceipt(receipt, { ...unit, claim: '不应生效' })).toThrow();
      store.close();
      store = new SqliteStore(path);
      expect(store.knowledge.materials()).toEqual([material]);
      expect(store.knowledge.receipts(unit.knowledgeId)).toEqual([receipt]);
      expect(store.knowledge.receipts()).toHaveLength(1);
      expect(store.knowledge.get(unit.knowledgeId)!.claim).toBe(unit.claim);
      expect(store.getMeta('schema_version')).toBe(String(CURRENT_SQLITE_SCHEMA_VERSION));
      expect(store.checkIntegrity().ok).toBe(true);
      store.wipeAllData();
      expect(store.knowledge.list()).toEqual([]);
      expect(store.knowledge.materials()).toEqual([]);
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('导入关联失败原子回滚；错误升级不留下半迁移表或新 user_version', () => {
    const store = new SqliteStore();
    expect(() => store.knowledge.import(material, { ...pack, materialId: 'other' }, [unit])).toThrow('不一致');
    expect(() => store.knowledge.import(material, pack, [{ ...unit, confidence: 5 }])).toThrow();
    expect(store.knowledge.materials()).toEqual([]);
    store.close();
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-migration-'));
    const path = join(dir, 'workbench.db');
    try {
      let db = new DatabaseSync(path);
      db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('schema_version','2'); PRAGMA user_version=2; CREATE TABLE knowledge_play_receipts (broken TEXT);");
      db.close();
      expect(() => new SqliteStore(path)).toThrow();
      db = new DatabaseSync(path);
      expect(db.prepare('PRAGMA user_version').get()!['user_version']).toBe(2);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='knowledge_materials'").get()).toBeUndefined();
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
