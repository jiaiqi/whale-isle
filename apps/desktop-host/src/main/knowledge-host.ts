/** V2-P4-04C/D：薄宿主编排，复用既有 BWF transport/ActionLock，绝不另起游戏运行时。 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EnvoyKnowledgeSource } from '@workbench/agent-harness';
import { SqliteStore } from '@workbench/local-store';
import {
  applyPlayReceipt, assessKnowledge, buildEvidencePack, candidatesFromEvidence, GuideLibrary,
  invalidateMaterialEvidence, isStardewWorldReadyText, locateSourceText, sha256,
  type ActionLock, type GameAdapter,
} from '@workbench/game-bridge-mcp';
import {
  KnowledgeExecuteInputSchema, KnowledgeImportMaterialInputSchema, KnowledgeSourceConfigSchema, KnowledgeIdSchema, KnowledgeSnapshotSchema, PlayReceiptSchema,
  type EvidencePack, type GameKnowledgeItem, type KnowledgeExecutionResult,
  type KnowledgeImportResult, type MaterialChunk,
} from '@workbench/shared-protocol';

/** 第一切片仅开放已有的四种游戏动作；不构造策略或从材料内容执行工具。 */
const SLICE_ACTIONS = new Set(['water_crops', 'harvest_crops', 'travel_to', 'wait']);
export interface KnowledgeGamePort {
  adapter: GameAdapter;
  lock: ActionLock;
  /** 复用宿主的急停、接管、自治/联机占用检查，执行前再次核对。 */
  blockedReason(): string | null;
}

export class KnowledgeHost {
  private readonly source: EnvoyKnowledgeSource;
  private readonly store: SqliteStore;
  private readonly localGuides: GuideLibrary;
  private executing = false;
  private closed = false;

  constructor(private readonly options: {
    userDataDir: string; materialsRoot: string; game: () => KnowledgeGamePort | null;
    guides?: Record<string, string>; guidesDir?: string; simulation?: boolean;
    /** 只由测试/CLI 构造，生产 IPC 无注入能力。 */
    source?: EnvoyKnowledgeSource;
  }) {
    let enabled = true;
    const configPath = join(options.userDataDir, 'v2-knowledge.json');
    if (existsSync(configPath)) {
      try { enabled = KnowledgeSourceConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf8'))).envoy.enabled; }
      catch { enabled = false; } // 坏配置拒绝开启外部源，旧攻略继续可读。
    }
    this.source = options.source ?? new EnvoyKnowledgeSource({
      materialsRoot: options.materialsRoot, stateDir: join(options.userDataDir, 'envoy-knowledge'), enabled,
    });
    // 不使用「损坏即重建」路径：迁移失败不能悄悄替换既有权威数据库。
    this.store = new SqliteStore(join(options.userDataDir, 'workbench.db'));
    const guides: Record<string, string> = { ...options.guides };
    if (options.guidesDir && existsSync(options.guidesDir)) {
      for (const name of readdirSync(options.guidesDir).filter((name) => name.endsWith('.md'))) {
        guides[basename(name, '.md')] = readFileSync(join(options.guidesDir, name), 'utf8');
      }
    }
    this.localGuides = new GuideLibrary(guides);
    // 幂等一次导入；没有证据引用，不会冒充 Envoy 材料。
    this.store.runInTransaction(() => {
      for (const unit of this.localGuides.knowledgeCandidates(new Date().toISOString())) this.store.knowledge.insertCandidate(unit);
    });
  }

  async sourceStatus() {
    const status = await this.source.probe();
    return { ...status, materialCount: this.store.knowledge.materials().length };
  }

  private refreshEvidence(): void {
    for (const material of this.store.knowledge.materials()) {
      let missing = false, changed = false;
      try {
        const file = this.source.authorizedFile(fileURLToPath(material.originUri));
        changed = sha256(file.bytes) !== material.sha256 || file.revision !== material.sourceRevision.split('|local:')[1];
      } catch { missing = true; }
      if (!missing && !changed) continue;
      for (const unit of this.store.knowledge.list()) {
        if (unit.evidenceRefs.some((ref) => ref.materialId === material.materialId && ref.extraction !== (missing ? 'failed' : 'partial'))) {
          this.store.knowledge.update(invalidateMaterialEvidence(unit, material.materialId, missing));
        }
      }
    }
  }

  list() {
    this.refreshEvidence();
    return KnowledgeSnapshotSchema.parse({ units: this.store.knowledge.list(), materials: this.store.knowledge.materials(), localTopics: this.localGuides.topics() });
  }
  evidence(materialId?: string) { return this.store.knowledge.packs(materialId); }
  receipts(knowledgeId?: string) { return this.store.knowledge.receipts(knowledgeId); }

  async importMaterial(raw: unknown): Promise<KnowledgeImportResult> {
    const input = KnowledgeImportMaterialInputSchema.parse(raw);
    try {
      this.refreshEvidence();
      const { payload, version, file } = await this.source.read(input.filePath);
      if (this.closed) throw new Error('知识宿主已关闭');
      const reread = this.source.authorizedFile(file.path);
      if (sha256(reread.bytes) !== sha256(file.bytes) || reread.revision !== file.revision) throw new Error('读取期间材料发生变化，请重试');
      const materialText = extname(file.path).toLowerCase() === '.pdf' ? '' : file.bytes.toString('utf8');
      const chunks: MaterialChunk[] = [];
      for (const block of payload.blocks.slice(0, input.maxChunks ?? 200)) {
        if (block.origin !== 'source_text' || block.content.type !== 'text' || !block.content.text) continue;
        const locator = materialText ? locateSourceText(materialText, block.content.text)
          : block.locator?.type === 'pdf_page' && block.locator.page_number && block.locator.locator_valid !== false
            ? { kind: 'pdf' as const, page: block.locator.page_number } : null;
        if (locator) chunks.push({ chunkId: block.id, locator, text: block.content.text, origin: 'source' });
      }
      if (chunks.length === 0) throw new Error('证据定位不到材料原文，保持本地攻略，不生成假证据');
      const extraction = payload.result === 'ready' && payload.coverage.unresolved.length === 0
        && payload.coverage.modalities.text?.extraction === 'complete'
        && chunks.length === payload.blocks.length ? 'complete' : 'partial';
      const material = {
        materialId: payload.material_id!, originUri: pathToFileURL(file.path).href,
        title: basename(file.path), sha256: sha256(file.bytes),
        sourceRevision: `${payload.source_revision}|local:${file.revision}`,
        bytes: file.bytes.length, licenseScope: input.licenseScope,
        ...(input.licenseNote ? { licenseNote: input.licenseNote } : {}), readAt: new Date().toISOString(),
      };
      const pack = buildEvidencePack({ material, chunks, extraction, topic: input.topic, sourceType: input.sourceType, readerVersion: version,
        context: {
          ...(input.gameVersion ? { gameVersion: input.gameVersion } : {}),
          ...(input.modContext ? { modContext: input.modContext } : {}), applicability: input.applicability,
        },
      });
      const units = candidatesFromEvidence(pack, materialText);
      const persisted = this.store.knowledge.import(material, pack, units);
      return { ok: true, material, pack, units: persisted };
    } catch (error) {
      this.refreshEvidence();
      return { ok: false, units: [], error: error instanceof Error ? error.message : String(error), degradedReason: '外部知识源不可用或材料无效，使用本地攻略；尚未产生新证据' };
    }
  }

  private unit(id: string): GameKnowledgeItem {
    this.refreshEvidence();
    const unit = this.store.knowledge.get(id);
    if (!unit) throw new Error('知识不存在');
    return unit;
  }

  private async readState(game: KnowledgeGamePort | null): Promise<string | null> {
    if (!game || game.adapter.gameId !== 'stardew') return null;
    try {
      const response = await game.adapter.transport.callTool('get_state', {}, { timeoutMs: 5_000 });
      return response.kind === 'ok' && !response.isError && response.text.trim() && isStardewWorldReadyText(response.text) ? response.text : null;
    } catch { return null; }
  }

  async assess(id: string) {
    return assessKnowledge(this.unit(id), await this.readState(this.options.game()), new Date().toISOString());
  }

  async execute(raw: unknown): Promise<KnowledgeExecutionResult> {
    const input = KnowledgeExecuteInputSchema.parse(raw);
    if (this.closed || this.executing) return { ok: false, availability: 'blocked', reason: '知识宿主已关闭或另一次验证正在执行' };
    if (!SLICE_ACTIONS.has(input.tool)) return { ok: false, availability: 'blocked', reason: '不在第一切片动作白名单内' };
    this.executing = true;
    try {
      const unit = this.unit(input.knowledgeId);
      const game = this.options.game();
      const before = await this.readState(game);
      const applicability = assessKnowledge(unit, before, new Date().toISOString());
      if (!before || !game) return { ok: false, availability: 'unavailable', applicability, reason: '游戏状态不可读，未执行，不写回执' };
      if (!applicability.executable) return { ok: false, availability: 'blocked', applicability, reason: '适用性未通过，不执行' };
      // 未知/非商用许可仅允许本地查看；实玩可能进入直播链路，第一切片保守拒绝。
      const materialIds = new Set(unit.evidenceRefs.map((ref) => ref.materialId));
      const licenses = this.store.knowledge.materials().filter((material) => materialIds.has(material.materialId));
      if (licenses.some((material) => material.licenseScope === 'unknown' || material.licenseScope === 'cc-by-nc-sa')) {
        return { ok: false, availability: 'blocked', applicability, reason: '材料许可未知或仅非商用，当前只允许本地查看' };
      }
      const blocked = game.blockedReason();
      if (this.closed || this.options.game()?.adapter !== game.adapter || blocked || game.lock.isBusy()) return { ok: false, availability: 'blocked', applicability, reason: blocked ?? '游戏会话已变更或动作在途' };
      const result = await game.lock.execute(input.tool, input.args, input.timeoutMs);
      const after = await this.readState(game);
      const classified = game.adapter.classifyReceipt({
        tool: input.tool, kind: result.kind, text: result.kind === 'ok' ? result.text : '',
        isError: result.kind === 'ok' && result.isError, errorMessage: result.kind === 'error' ? result.message : undefined,
      });
      let receiptStatus = classified.status === 'COMPLETED' || classified.status === 'FAILED' ? classified.status : 'UNCERTAIN';
      // 既有适配器保留原行为；本切片额外要求明确完成前缀，执行中/空文本不算完成。
      if (result.kind === 'ok' && /^(?:失败[:：]|错误[:：]|FAILED\b)/.test(result.text.trim())) receiptStatus = 'FAILED';
      if (result.kind === 'ok' && (/UNCERTAIN|不确定|正在执行|还在执行/.test(result.text) || !result.text.trim())) receiptStatus = 'UNCERTAIN';
      if (receiptStatus === 'COMPLETED' && result.kind === 'ok' && !/^(?:成功[:：]|COMPLETED\b)/.test(result.text.trim())) receiptStatus = 'UNCERTAIN';
      const stateChanged = after !== null && before !== after;
      const suspicious = receiptStatus === 'COMPLETED' && !stateChanged;
      if (suspicious) receiptStatus = 'UNCERTAIN';
      const receipt = PlayReceiptSchema.parse({
        receiptId: `receipt_${randomUUID()}`, knowledgeId: unit.knowledgeId, actionId: `act_${randomUUID()}`,
        tool: input.tool, receiptStatus, summary: suspicious ? '可疑：BWF 报完成但执行后状态未变化或无法回读，待复核' : classified.summary || '空回执，待复核',
        stateChanged, suspicious,
        observedStateDelta: stateChanged ? { before, after: after! } : {},
        evidenceLevel: this.options.simulation ? 'simulation' : receiptStatus === 'UNCERTAIN' ? 'unverified' : 'real-device',
        beforeState: before, afterState: after ?? undefined,
        rawReceipt: result.kind === 'ok' ? result.text : result.kind === 'error' ? result.message : `timeout:${result.timeoutMs}`,
        beforeStateDigest: sha256(before), afterStateDigest: after ? sha256(after) : undefined,
        simulation: this.options.simulation ?? false, capturedAt: new Date().toISOString(),
      });
      this.store.knowledge.recordReceipt(receipt, applyPlayReceipt(unit, receipt));
      return { ok: receiptStatus === 'COMPLETED', availability: 'available', applicability, receipt };
    } finally {
      this.executing = false;
      if (this.closed) this.store.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.source.close();
    if (!this.executing) this.store.close();
  }
}

/** 只接受本应用中控台渲染进程的主框架；由宿主注入（测试与 CLI 默认放行）。 */
export type KnowledgeIpcGuard = (event: unknown) => { ok: false; error: string } | null;

/** IPC 仅使用固定通道与 Zod 入参。查询本地 SQLite 不开放外部写/评论/发布工具。 */
export function registerKnowledgeIpc(ipc: { handle(channel: string, listener: (_event: unknown, input?: unknown) => unknown): void }, host: KnowledgeHost, guard: KnowledgeIpcGuard = () => null): void {
  const handle = (channel: string, run: (input?: unknown) => unknown): void => {
    ipc.handle(channel, (event, input) => guard(event) ?? run(input));
  };
  handle('v2:knowledge-source-status', () => host.sourceStatus());
  handle('v2:knowledge-list', () => host.list());
  handle('v2:knowledge-import', (input) => host.importMaterial(input));
  handle('v2:knowledge-evidence', (input) => host.evidence(typeof input === 'string' ? input : undefined));
  handle('v2:knowledge-receipts', (input) => host.receipts(typeof input === 'string' ? input : undefined));
  handle('v2:knowledge-assess', (input) => host.assess(KnowledgeIdSchema.parse(input)));
  handle('v2:knowledge-execute', (input) => host.execute(input));
}
