/**
 * 外部服务商配置导入宿主（T-M6-09）：
 *   - providers:import-scan   只读解析（Magpie / CC Switch / 手动文件）→ 仅返回掩码预览
 *   - providers:import-apply  主进程内部重扫 → 勾选条目明文 Key 直接 safeStorage 加密写入 vault
 *   - providers:import-pick-file  手动选择 JSON / SQLite 备份
 * 安全铁律：明文 Key 永不跨 IPC；扫描阶段只下发 name/protocol/baseUrl/models/掩码状态。
 */
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { homedir } from 'node:os';
import { hasVaultKey, maskKey, readVaultKey, writeVaultKey } from './provider-vault';
import { collectImportCandidates, planImport, type ImportCandidate, type ImportSource } from './provider-importer';
/** IPC 返回形状（与 renderer bridge 的 ImportScanView/ImportApplyView 同构；主进程不反向 import UI） */
interface ImportScanView {
  ok: boolean;
  error?: string;
  source: ImportSource;
  detectedPath: string;
  items: Array<{
    id: string;
    name: string;
    protocol: 'openai' | 'anthropic';
    baseUrl: string;
    models: string[];
    hasKey: boolean;
    keyMask: string;
    matchedBuiltin: boolean;
  }>;
}

interface ImportApplyView {
  ok: boolean;
  error?: string;
  items: Array<{
    id: string;
    name: string;
    protocol: 'openai' | 'anthropic';
    baseUrl: string;
    isFullUrl: boolean;
    models: string[];
    matchedBuiltin: boolean;
    action: 'create' | 'update' | 'skip';
    keyMask: string;
  }>;
}

interface ScanArgs {
  source: ImportSource;
  filePath?: string;
}

interface ApplyArgs extends ScanArgs {
  selectedIds: string[];
  policy: 'skip' | 'overwrite';
}

function metaOf(candidate: ImportCandidate, action: 'create' | 'update' | 'skip', keyMask: string): ImportApplyView['items'][number] {
  return {
    id: candidate.id,
    name: candidate.name,
    protocol: candidate.protocol,
    baseUrl: candidate.baseUrl,
    isFullUrl: candidate.isFullUrl,
    models: candidate.models,
    matchedBuiltin: candidate.matchedBuiltin,
    action,
    keyMask,
  };
}

export function createProviderImportHost(vaultPath: string): void {
  ipcMain.handle('providers:import-pick-file', async (): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options = {
      title: '选择 Magpie / CC Switch 配置备份',
      properties: ['openFile' as const],
      filters: [
        { name: 'Magpie JSON / CC Switch 导出', extensions: ['json'] },
        { name: 'CC Switch SQLite', extensions: ['db', 'sqlite', 'sqlite3'] },
      ],
    };
    const picked = owner === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(owner, options);
    if (picked.canceled || picked.filePaths[0] === undefined) return { ok: false, error: '已取消' };
    return { ok: true, path: picked.filePaths[0] };
  });

  ipcMain.handle('providers:import-scan', (_event, args: ScanArgs): ImportScanView => {
    if (args === null || typeof args !== 'object' || (args.source !== 'magpie' && args.source !== 'ccswitch' && args.source !== 'file')) {
      return { ok: false, error: '无效的导入来源', source: 'magpie', detectedPath: '', items: [] };
    }
    const { result } = collectImportCandidates(args.source, args.filePath, homedir());
    return result;
  });

  ipcMain.handle('providers:import-apply', (_event, args: ApplyArgs): ImportApplyView => {
    try {
      if (args === null || typeof args !== 'object' || !Array.isArray(args.selectedIds) || args.selectedIds.length === 0) {
        return { ok: false, error: '未勾选任何服务商', items: [] };
      }
      const { result, candidates } = collectImportCandidates(args.source, args.filePath, homedir());
      if (!result.ok) return { ok: false, error: result.error ?? '扫描失败', items: [] };

      const selected = new Set(args.selectedIds);
      const picked = candidates.filter((candidate) => selected.has(candidate.id));
      if (picked.length === 0) return { ok: false, error: '勾选的服务商在源配置中不存在（文件可能已变化）', items: [] };

      const existingKeys: Record<string, boolean> = {};
      for (const candidate of picked) existingKeys[candidate.id] = hasVaultKey(vaultPath, candidate.id);

      const plan = planImport(picked, { policy: args.policy === 'overwrite' ? 'overwrite' : 'skip', existingKeys });
      const items: ImportApplyView['items'] = [];
      for (const step of plan) {
        const { candidate, action } = step;
        if (action === 'skip') {
          const current = readVaultKey(vaultPath, candidate.id);
          items.push(metaOf(candidate, 'skip', current !== null ? maskKey(current) : ''));
          continue;
        }
        let keyMask = '';
        if (candidate.apiKey.trim() !== '') {
          const written = writeVaultKey(vaultPath, candidate.id, candidate.apiKey);
          if (!written.ok) return { ok: false, error: written.error ?? '凭据加密写入失败', items: [] };
          keyMask = written.mask ?? '';
        } else {
          const current = readVaultKey(vaultPath, candidate.id);
          keyMask = current !== null ? maskKey(current) : '';
        }
        items.push(metaOf(candidate, action, keyMask));
      }
      return { ok: true, items };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), items: [] };
    }
  });
}
