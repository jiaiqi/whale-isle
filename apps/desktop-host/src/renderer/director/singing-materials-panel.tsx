/**
 * 中控台「演唱素材」面板（`V2-P3-07A`，点歌台页签内）。
 *
 * 只展示宿主扫描出来的**事实与判定**：
 *  - 素材目录路径（可复制）与重新扫描；
 *  - 六组情绪覆盖（缺哪组）；
 *  - 逐文件问题（采样率/位深/时长/峰值/静音/授权/坏文件）；
 *  - `ready`（现在能不能唱）与 `commercialReady`（能不能商用/开播）两行结论。
 *
 * 诚实红线：前端不做任何"默认通过"或"猜授权"，所有结论都来自宿主 IPC。
 */
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Copy, FolderOpen, Music2, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import type { SingingMaterialScanResult } from '@workbench/shared-protocol';

const EMOTION_LABEL: Record<string, string> = {
  sweet_normal: '日常软萌',
  tsundere_refuse: '傲娇嘴硬',
  rage_spray: '炸毛喷水',
  lazy_yawn: '慵懒困倦',
  clumsy_panic: '心虚慌乱',
  happy_rice: '干饭开心',
};

const ALL_EMOTIONS = Object.keys(EMOTION_LABEL);

const KIND_LABEL: Record<string, string> = {
  emotion_reference: '情绪参考',
  svc_training_dry_vocal: '训练干声',
};

function shortPath(filePath: string, max = 44): string {
  if (filePath.length <= max) return filePath;
  const parts = filePath.split('/');
  return `…/${parts.slice(-2).join('/')}`;
}

export function SingingMaterialsPanel(): React.JSX.Element {
  const [directory, setDirectory] = useState<string>('');
  const [result, setResult] = useState<SingingMaterialScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((): void => {
    void window.directorBridge.v2SingingMaterialsDir().then(setDirectory).catch(() => setDirectory(''));
    void window.directorBridge
      .v2SingingMaterialsState()
      .then((state) => {
        if (state !== null) setResult(state);
      })
      .catch(() => undefined);
  }, []);

  useEffect(load, [load]);

  const scan = async (): Promise<void> => {
    if (scanning) return;
    setScanning(true);
    setError(null);
    try {
      const response = await window.directorBridge.v2SingingMaterialsScan();
      if (!response.ok) {
        setError(response.error);
        toast.error(`扫描失败：${response.error}`);
        return;
      }
      setResult(response.result);
      const { blockers, warnings } = response.result.readiness;
      if (blockers.length > 0) toast.error(`扫描完成：${blockers.length} 个阻断项`);
      else if (warnings.length > 0) toast.warning(`扫描完成：${warnings.length} 条提醒`);
      else toast.success('扫描完成：没有发现问题');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error(`扫描失败：${message}`);
    } finally {
      setScanning(false);
    }
  };

  const copyDirectory = (): void => {
    if (directory === '') return;
    void navigator.clipboard.writeText(directory).then(
      () => toast.success('素材目录已复制'),
      () => toast.error('复制失败，请手动选择路径'),
    );
  };

  const summary = result?.summary ?? null;
  const readiness = result?.readiness ?? null;
  const missing = new Set<string>(readiness?.missingEmotionKeys ?? ALL_EMOTIONS);

  return (
    <section className="card mb-3 p-3.5" data-singing-materials>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Music2 size={14} /> 演唱素材
          {summary !== null && (
            <span
              className={`pill ${summary.verdict === 'pass' ? 'pill-green' : summary.verdict === 'warn' ? 'pill-amber' : 'pill-red'}`}
              data-singing-verdict
            >
              {summary.verdict === 'pass' ? '通过' : summary.verdict === 'warn' ? '有提醒' : '有阻断'}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <button type="button" className="wb-foot-btn" onClick={copyDirectory} disabled={directory === ''}>
            <Copy size={12} /> 复制目录
          </button>
          <button type="button" className="btn-pill primary" data-singing-scan disabled={scanning} onClick={() => void scan()}>
            <RefreshCw size={12} className={scanning ? 'animate-spin' : undefined} /> {scanning ? '扫描中…' : '重新扫描'}
          </button>
        </div>
      </div>

      <p className="mb-2 flex items-center gap-1.5 break-all text-[11px]" style={{ color: 'var(--text-3)' }} data-singing-dir>
        <FolderOpen size={12} /> {directory === '' ? '（宿主未返回素材目录）' : directory}
      </p>

      {error !== null && (
        <p className="mb-2 text-[11px]" style={{ color: 'var(--red)' }}>扫描失败：{error}</p>
      )}

      {result === null ? (
        <p className="text-xs" style={{ color: 'var(--text-3)' }}>
          还没有扫描过。把六组情绪参考音和训练干声放进上面的目录，再点「重新扫描」；录音规格见
          <code className="mx-1">docs/v2/SINGING-RECORDING-CHECKLIST.md</code>。
        </p>
      ) : (
        <>
          <div className="mb-3 grid gap-2 md:grid-cols-2">
            <div className="rounded-lg p-2.5" style={{ background: 'var(--inset)' }}>
              <p className="flex items-center gap-1.5 text-[12px] font-medium">
                {readiness?.ready === true
                  ? <CheckCircle2 size={14} style={{ color: 'var(--green)' }} />
                  : <XCircle size={14} style={{ color: 'var(--red)' }} />}
                可以唱（ready）
                <span className={`pill ${readiness?.ready === true ? 'pill-green' : 'pill-red'}`} data-singing-ready>
                  {readiness?.ready === true ? '是' : '否'}
                </span>
              </p>
              <p className="mt-1 text-[11px]" style={{ color: 'var(--text-3)' }}>
                只管「现在能不能出声」；授权与权重问题在下面逐条列出。
              </p>
            </div>
            <div className="rounded-lg p-2.5" style={{ background: 'var(--inset)' }}>
              <p className="flex items-center gap-1.5 text-[12px] font-medium">
                <ShieldAlert size={14} style={{ color: readiness?.commercialReady === true ? 'var(--green)' : 'var(--amber)' }} />
                可商用/开播（commercialReady）
                <span className={`pill ${readiness?.commercialReady === true ? 'pill-green' : 'pill-amber'}`} data-singing-commercial-ready>
                  {readiness?.commercialReady === true ? '是' : '否'}
                </span>
              </p>
              <p className="mt-1 text-[11px]" style={{ color: 'var(--text-3)' }}>
                商用要求授权含 commercial_livestream + 权重 commercial_ok；RVC 官方底模「仅供研究」，**商用必须自训底模/声库**。
              </p>
            </div>
          </div>

          <div className="mb-3">
            <p className="mb-1 text-[11px]" style={{ color: 'var(--text-3)' }}>六组情绪覆盖（缺的会标红）</p>
            <div className="flex flex-wrap gap-1.5" data-singing-emotions>
              {ALL_EMOTIONS.map((key) => {
                const isMissing = missing.has(key);
                return (
                  <span
                    key={key}
                    className={`pill ${isMissing ? 'pill-red' : 'pill-green'}`}
                    title={isMissing ? '缺这一组' : '已齐'}
                  >
                    {EMOTION_LABEL[key]} · {isMissing ? '缺' : '齐'}
                  </span>
                );
              })}
            </div>
          </div>

          {readiness !== null && readiness.blockers.length > 0 && (
            <div className="mb-3" data-singing-blockers>
              <p className="mb-1 text-[11px]" style={{ color: 'var(--red)' }}>阻断项（{readiness.blockers.length}）</p>
              <ul className="grid gap-1 text-[11.5px]">
                {readiness.blockers.map((blocker, index) => (
                  <li key={`${index}-${blocker}`} className="flex gap-1.5" style={{ color: 'var(--text-2)' }}>
                    <XCircle size={12} style={{ color: 'var(--red)', flexShrink: 0, marginTop: 2 }} />
                    <span>{blocker}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {readiness !== null && readiness.warnings.length > 0 && (
            <div className="mb-3" data-singing-warnings>
              <p className="mb-1 text-[11px]" style={{ color: 'var(--amber)' }}>提醒（{readiness.warnings.length}）</p>
              <ul className="grid gap-1 text-[11.5px]" style={{ color: 'var(--text-2)' }}>
                {readiness.warnings.map((warning, index) => (
                  <li key={`${index}-${warning}`}>· {warning}</li>
                ))}
              </ul>
            </div>
          )}

          {summary !== null && summary.issues.length > 0 && (
            <div className="mb-3" data-singing-issues>
              <p className="mb-1 text-[11px]" style={{ color: 'var(--text-3)' }}>逐文件问题（{summary.issues.length}）</p>
              <div className="max-h-40 overflow-y-auto rounded-lg" style={{ border: '1px solid var(--stroke)' }}>
                <table className="w-full text-[11px]">
                  <thead style={{ background: 'var(--inset)', color: 'var(--text-3)' }}>
                    <tr>
                      <th className="px-2 py-1 text-left">级别</th>
                      <th className="px-2 py-1 text-left">问题码</th>
                      <th className="px-2 py-1 text-left">说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.issues.map((issue, index) => (
                      <tr key={`${issue.code}-${index}`} style={{ borderTop: '1px solid var(--stroke)' }}>
                        <td className="px-2 py-1" style={{ color: issue.severity === 'blocker' ? 'var(--red)' : 'var(--amber)' }}>
                          {issue.severity === 'blocker' ? '阻断' : '提醒'}
                        </td>
                        <td className="px-2 py-1 font-mono">{issue.code}</td>
                        <td className="px-2 py-1" style={{ color: 'var(--text-2)' }}>{issue.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div data-singing-files>
            <p className="mb-1 text-[11px]" style={{ color: 'var(--text-3)' }}>
              已读素材（{result.files.length}）· 扫描于 {new Date(result.scannedAt).toLocaleTimeString()} ·
              档案来源：{result.profileSource === 'file' ? 'singing/profile.json' : '未配置（用 consent.json/默认值）'}
            </p>
            {result.files.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--text-3)' }}>目录里还没有可读的 WAV。</p>
            ) : (
              <div className="max-h-48 overflow-y-auto rounded-lg" style={{ border: '1px solid var(--stroke)' }}>
                <table className="w-full text-[11px]">
                  <thead style={{ background: 'var(--inset)', color: 'var(--text-3)' }}>
                    <tr>
                      <th className="px-2 py-1 text-left">文件</th>
                      <th className="px-2 py-1 text-left">类型</th>
                      <th className="px-2 py-1 text-left">时长</th>
                      <th className="px-2 py-1 text-left">格式</th>
                      <th className="px-2 py-1 text-left">峰值</th>
                      <th className="px-2 py-1 text-left">头/尾静音</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.files.map((file) => (
                      <tr key={file.materialId} style={{ borderTop: '1px solid var(--stroke)' }} title={file.filePath}>
                        <td className="px-2 py-1 font-mono">{shortPath(file.materialId)}</td>
                        <td className="px-2 py-1">
                          {KIND_LABEL[file.kind] ?? file.kind}
                          {file.emotion !== undefined ? ` · ${EMOTION_LABEL[file.emotion] ?? file.emotion}` : ''}
                        </td>
                        <td className="px-2 py-1">{(file.durationMs / 1000).toFixed(2)}s</td>
                        <td className="px-2 py-1">{file.sampleRate / 1000}kHz/{file.bitDepth}bit/{file.channels === 1 ? 'mono' : `${file.channels}ch`}</td>
                        <td className="px-2 py-1">{file.peakDbfs.toFixed(1)}dBFS</td>
                        <td className="px-2 py-1">{file.headSilenceMs}ms / {file.tailSilenceMs}ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
