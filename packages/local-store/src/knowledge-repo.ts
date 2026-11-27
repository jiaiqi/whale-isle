/** V2-P4-04B：既有 workbench.db 内知识/材料/证据/实玩回执仓储，不另建数据库。 */
import type { DatabaseSync } from 'node:sqlite';
import {
  EvidencePackSchema, GameKnowledgeItemSchema, KnowledgeMaterialSchema, PlayReceiptSchema,
  type EvidencePack, type GameKnowledgeItem, type KnowledgeMaterial, type PlayReceipt,
} from '@workbench/shared-protocol';

export const KNOWLEDGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_materials (material_id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge_evidence (pack_id TEXT PRIMARY KEY, material_id TEXT NOT NULL REFERENCES knowledge_materials(material_id), body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge_units (knowledge_id TEXT PRIMARY KEY, body TEXT NOT NULL, versions TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS knowledge_play_receipts (receipt_id TEXT PRIMARY KEY, knowledge_id TEXT NOT NULL REFERENCES knowledge_units(knowledge_id), body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_knowledge_receipts_unit ON knowledge_play_receipts(knowledge_id);
`;

export class KnowledgeRepository {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(fn: () => T) => T) {}

  putMaterial(material: KnowledgeMaterial): void {
    const parsed = KnowledgeMaterialSchema.parse(material);
    this.db.prepare('INSERT INTO knowledge_materials VALUES (?, ?) ON CONFLICT(material_id) DO UPDATE SET body=excluded.body')
      .run(parsed.materialId, JSON.stringify(parsed));
  }

  materials(): KnowledgeMaterial[] {
    return this.db.prepare('SELECT body FROM knowledge_materials ORDER BY material_id').all()
      .map((row) => KnowledgeMaterialSchema.parse(JSON.parse(String(row.body))));
  }

  putPack(pack: EvidencePack): void {
    const parsed = EvidencePackSchema.parse(pack);
    this.db.prepare('INSERT INTO knowledge_evidence VALUES (?, ?, ?) ON CONFLICT(pack_id) DO NOTHING')
      .run(parsed.packId, parsed.materialId, JSON.stringify(parsed));
  }

  packs(materialId?: string): EvidencePack[] {
    const rows = materialId
      ? this.db.prepare('SELECT body FROM knowledge_evidence WHERE material_id=? ORDER BY pack_id').all(materialId)
      : this.db.prepare('SELECT body FROM knowledge_evidence ORDER BY pack_id').all();
    return rows.map((row) => EvidencePackSchema.parse(JSON.parse(String(row.body))));
  }

  get(knowledgeId: string): GameKnowledgeItem | null {
    const row = this.db.prepare('SELECT body FROM knowledge_units WHERE knowledge_id=?').get(knowledgeId);
    return row ? GameKnowledgeItemSchema.parse(JSON.parse(String(row.body))) : null;
  }

  list(): GameKnowledgeItem[] {
    return this.db.prepare('SELECT body FROM knowledge_units ORDER BY knowledge_id').all()
      .map((row) => GameKnowledgeItemSchema.parse(JSON.parse(String(row.body))));
  }

  versions(knowledgeId: string): GameKnowledgeItem[] {
    const row = this.db.prepare('SELECT versions FROM knowledge_units WHERE knowledge_id=?').get(knowledgeId);
    if (!row) return [];
    return (JSON.parse(String(row.versions)) as unknown[]).map((version) => GameKnowledgeItemSchema.parse(version));
  }

  /** 已存在的导入不覆盖实玩进度；显式 update 才记录旧版本并改当前副本。 */
  insertCandidate(item: GameKnowledgeItem): GameKnowledgeItem {
    const parsed = GameKnowledgeItemSchema.parse(item);
    this.db.prepare("INSERT INTO knowledge_units VALUES (?, ?, '[]') ON CONFLICT(knowledge_id) DO NOTHING")
      .run(parsed.knowledgeId, JSON.stringify(parsed));
    return this.get(parsed.knowledgeId)!;
  }

  update(item: GameKnowledgeItem): void {
    const parsed = GameKnowledgeItemSchema.parse(item);
    this.transaction(() => {
      const previous = this.get(parsed.knowledgeId);
      if (!previous) throw new Error('知识不存在，不能更新');
      if (JSON.stringify(previous) === JSON.stringify(parsed)) return;
      const versions = [...this.versions(parsed.knowledgeId), previous];
      this.db.prepare('UPDATE knowledge_units SET body=?, versions=? WHERE knowledge_id=?')
        .run(JSON.stringify(parsed), JSON.stringify(versions), parsed.knowledgeId);
    });
  }

  import(material: KnowledgeMaterial, pack: EvidencePack, units: GameKnowledgeItem[]): GameKnowledgeItem[] {
    if (pack.materialId !== material.materialId || pack.materialSha256 !== material.sha256) throw new Error('材料与证据包不一致');
    return this.transaction(() => {
      this.putMaterial(material);
      this.putPack(pack);
      return units.map((unit) => {
        const previous = this.get(unit.knowledgeId);
        if (previous && JSON.stringify(previous.evidenceRefs.map((ref) => ref.evidenceId)) !== JSON.stringify(unit.evidenceRefs.map((ref) => ref.evidenceId))) {
          // 来源修订/导入前提变化：保存历史并重新成为 candidate，不能沿用旧的实玩可信度。
          this.update(unit);
          return unit;
        }
        return this.insertCandidate(unit);
      });
    });
  }

  recordReceipt(receipt: PlayReceipt, updatedUnit: GameKnowledgeItem): void {
    const parsed = PlayReceiptSchema.parse(receipt);
    if (updatedUnit.knowledgeId !== parsed.knowledgeId) throw new Error('知识与回执不一致');
    this.transaction(() => {
      this.db.prepare('INSERT INTO knowledge_play_receipts VALUES (?, ?, ?)')
        .run(parsed.receiptId, parsed.knowledgeId, JSON.stringify(parsed));
      this.update(updatedUnit);
    });
  }

  receipts(knowledgeId?: string): PlayReceipt[] {
    const rows = knowledgeId
      ? this.db.prepare('SELECT body FROM knowledge_play_receipts WHERE knowledge_id=? ORDER BY rowid').all(knowledgeId)
      : this.db.prepare('SELECT body FROM knowledge_play_receipts ORDER BY rowid').all();
    return rows.map((row) => PlayReceiptSchema.parse(JSON.parse(String(row.body))));
  }
}
