/**
 * 桌宠创作中心（T-M6-53，对齐 design/pet-stage.html）：
 * A AI 角色/皮肤生图提示词 · B AI 彩蛋生成器（5 态台词）· C 自定义建角与拖入处理。
 * 零 emoji；所有数据经真实 IPC，不伪造「已出图/已保存」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, FolderOpen, ImagePlus, Sparkles, UploadCloud, Wand2, X } from 'lucide-react';
import { toast } from 'sonner';

type CreatorTab = 'char' | 'egg' | 'import';
type TierId = 'A' | 'B' | 'C' | 'MEME';

const inputStyle: React.CSSProperties = { border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-1)', borderRadius: 8 };
const labelStyle: React.CSSProperties = { fontSize: 11, color: 'var(--text-2)' };

let eggSeq = 0;
function nextEggId(): string {
  eggSeq += 1;
  return `egg-custom-${Date.now().toString(36)}-${eggSeq}`;
}

export function CreatorCenter(props: {
  open: boolean;
  onClose: () => void;
  characterId: string;
  characterName: string;
  onReloaded: () => void;
}): React.JSX.Element | null {
  const { open, onClose, characterId, characterName, onReloaded } = props;
  const [tab, setTab] = useState<CreatorTab>('char');
  const [tiers, setTiers] = useState<Array<{ id: TierId; label: string; count: number; poses: Array<{ id: string; hint: string }> }>>([]);
  const [locks, setLocks] = useState<Array<{ id: string; label: string; reference: string; traits: string }>>([]);
  const [lock, setLock] = useState('deepseek');
  const [customName, setCustomName] = useState('');
  const [customTraits, setCustomTraits] = useState('');
  const [selectedTiers, setSelectedTiers] = useState<TierId[]>(['A', 'MEME']);
  const [charPrompt, setCharPrompt] = useState('');
  const [eggMode, setEggMode] = useState<'cosplay' | 'prank'>('cosplay');
  const [guest, setGuest] = useState('deepseek');
  const [host, setHost] = useState('claude');
  const [eggPrompt, setEggPrompt] = useState('');
  const [eggId, setEggId] = useState(() => nextEggId());
  const [eggName, setEggName] = useState('串门彩蛋');
  const [eggLines, setEggLines] = useState<Record<string, string[]> | null>(null);
  const [eggBusy, setEggBusy] = useState(false);
  const [importId, setImportId] = useState('my-character');
  const [importName, setImportName] = useState('');
  const [reactTo, setReactTo] = useState('*');
  const [longThinkAfter, setLongThinkAfter] = useState(20);
  const [longThinkPose, setLongThinkPose] = useState('deepthink');
  const [correctedPose, setCorrectedPose] = useState('sorry');
  const [fxText, setFxText] = useState('thinking: bubbles, proud: victory');
  const [images, setImages] = useState<string[]>([]);
  const [folder, setFolder] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<{ poses: string[]; warnings: string[] } | null>(null);
  const [cloneId, setCloneId] = useState('deepseek-mine');
  const [cloneName, setCloneName] = useState('');
  const [cloneBuiltinId, setCloneBuiltinId] = useState('crosspet-deepseek');
  const [customList, setCustomList] = useState<Array<{ id: string; name: string; poses: string[] }>>([]);
  const [renameTarget, setRenameTarget] = useState('');
  const [renameName, setRenameName] = useState('');
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void window.directorBridge.creatorListCustom().then(setCustomList).catch(() => setCustomList([]));
    void window.directorBridge.creatorPoseTiers().then((data) => {
      setTiers(data.tiers as never);
      setLocks(data.locks);
      if (data.locks.length > 0) {
        setGuest(data.locks[0]!.id);
        setHost(data.locks[1]?.id ?? data.locks[0]!.id);
      }
    }).catch(() => undefined);
  }, [open]);

  const charInput = useMemo(() => ({
    lock,
    customName,
    customTraits,
    tiers: selectedTiers,
  }), [lock, customName, customTraits, selectedTiers]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      void window.directorBridge.creatorCompileCharacter(charInput).then((result) => setCharPrompt(result.prompt)).catch(() => undefined);
    }, 180);
    return () => clearTimeout(timer);
  }, [open, charInput]);

  useEffect(() => {
    if (!open) return;
    void window.directorBridge.creatorCompileEgg({ mode: eggMode, guest, host }).then((result) => setEggPrompt(result.prompt)).catch(() => undefined);
  }, [open, eggMode, guest, host]);

  const copy = useCallback(async (text: string, message: string) => {
    if (text === '') return;
    await navigator.clipboard.writeText(text);
    toast.success(message);
  }, []);

  const parseFx = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const part of fxText.split(/[,，]/)) {
      const [key, value] = part.split(':').map((item) => item.trim());
      if (key !== undefined && key !== '' && value !== undefined && value !== '') out[key] = value;
    }
    return out;
  };

  const characterPatch = (): Record<string, unknown> => ({
    reactTo: reactTo.trim() === '*' ? '*' : reactTo.split(/[,，]/).map((item) => item.trim()).filter((item) => item !== ''),
    longThink: { after: longThinkAfter, pose: longThinkPose },
    correctedPose,
    fx: parseFx(),
  });

  const importNow = async (): Promise<void> => {
    if (images.length === 0 && folder === '') { toast.error('先选择图片或角色文件夹'); return; }
    setImportBusy(true);
    try {
      const result = await window.directorBridge.creatorImport({
        id: importId,
        ...(importName.trim() === '' ? {} : { displayName: importName.trim() }),
        ...(folder === '' ? { paths: images } : { folder }),
        characterPatch: characterPatch(),
      });
      if (!result.ok) { toast.error(result.error ?? '导入失败'); return; }
      setImportResult({ poses: result.poses ?? [], warnings: result.warnings ?? [] });
      toast.success(`已处理 ${result.poses?.length ?? 0} 个姿态并写入 userData/pet-characters/${result.id ?? importId}/`);
      await window.directorBridge.customReload();
      // 导入后立刻切到新角色，验收台/桌面桌宠都直接用这套姿态
      await window.directorBridge.characterSelect(`custom-${result.id ?? importId}`).catch(() => undefined);
      onReloaded();
    } finally {
      setImportBusy(false);
    }
  };

  const generateEggLines = async (): Promise<void> => {
    setEggBusy(true);
    try {
      const result = await window.directorBridge.creatorGenerateEggLines({
        id: eggId,
        name: eggName,
        mode: eggMode,
        host,
        persona: guest === 'deepseek' ? '嘴硬心软的蓝鲸女仆' : undefined,
      });
      if (!result.ok) { toast.error(result.error ?? '台词生成失败'); return; }
      setEggLines(result.lines ?? null);
      toast.success('已生成 5 态台词并写入彩蛋配置');
      await window.directorBridge.customReload();
      onReloaded();
    } finally {
      setEggBusy(false);
    }
  };

  const cloneBuiltin = async (): Promise<void> => {
    const result = await window.directorBridge.customClone({ builtinId: cloneBuiltinId, newId: cloneId, ...(cloneName.trim() === '' ? {} : { displayName: cloneName.trim() }) });
    if (!result.ok) { toast.error(result.error ?? '克隆失败'); return; }
    toast.success(`已克隆到 userData/pet-characters/${cloneId}/ 并热重载`);
    await window.directorBridge.customReload();
    onReloaded();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center px-4" style={{ background: 'rgba(2,6,16,.72)', backdropFilter: 'blur(6px)' }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} data-creator-center>
      <div className="card w-full max-w-[900px]" style={{ maxHeight: '88vh', overflow: 'auto', padding: 18 }}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-[15px] font-semibold"><Sparkles size={15} style={{ color: 'var(--violet)' }} />桌宠创作中心</h2>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-2)' }}>零命令行建角 · 生图提示词编译器 · 当前角色 {characterName}（{characterId}）</p>
          </div>
          <button className="icon-btn" aria-label="关闭创作中心" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="seg-tabs mb-3">
          {([
            ['char', 'AI 角色/皮肤生图'],
            ['egg', 'AI 彩蛋生成器 (5 态)'],
            ['import', '自定义建角与拖入处理'],
          ] as Array<[CreatorTab, string]>).map(([id, label]) => (
            <button key={id} className={`seg-tab${tab === id ? ' on' : ''}`} data-creator-tab={id} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>

        {tab === 'char' && (
          <section data-creator-pane="char" className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block" style={labelStyle}>角色锁定模板
                <select value={lock} onChange={(event) => setLock(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px]" style={inputStyle}>
                  {locks.map((item) => <option key={item.id} value={item.id}>{item.label}（{item.reference}）</option>)}
                  <option value="custom">自定义原创角色</option>
                </select>
              </label>
              <div className="text-[11px] rounded-lg px-3 py-2" style={{ ...inputStyle, color: 'var(--text-2)' }}>
                画幅规范：transparent_background · 1024×1024 · 2.5 头身 Q 版 · 90% 身高居中
              </div>
            </div>
            {lock === 'custom' && (
              <div className="grid gap-3 md:grid-cols-2">
                <label className="block" style={labelStyle}>角色名<input value={customName} onChange={(event) => setCustomName(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px]" style={inputStyle} placeholder="例如：小海豹" /></label>
                <label className="block" style={labelStyle}>外观特征<input value={customTraits} onChange={(event) => setCustomTraits(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px]" style={inputStyle} placeholder="发色 / 瞳色 / 服装 / 标志道具" /></label>
              </div>
            )}
            <div>
              <div className="mb-1.5 text-[11px] font-semibold" style={{ color: 'var(--text-2)' }}>选择要生成的姿态批次</div>
              <div className="flex flex-wrap gap-1.5">
                {tiers.map((tier) => {
                  const on = selectedTiers.includes(tier.id);
                  return (
                    <button key={tier.id} data-pose-tier={tier.id} onClick={() => setSelectedTiers((prev) => (on ? prev.filter((id) => id !== tier.id) : [...prev, tier.id]))} className="rounded-full px-3 py-1 text-[11px]" style={{ border: `1px solid ${on ? 'var(--blue-line)' : 'var(--stroke)'}`, background: on ? 'var(--blue-dim)' : 'var(--surface)', color: on ? 'var(--blue)' : 'var(--text-2)' }}>
                      {tier.label}（{tier.poses.length}）
                    </button>
                  );
                })}
              </div>
            </div>
            <pre data-char-prompt className="max-h-[260px] overflow-auto rounded-xl p-3 text-[10.5px] whitespace-pre-wrap" style={{ ...inputStyle, color: 'var(--text-2)' }}>{charPrompt}</pre>
            <div className="flex flex-wrap justify-end gap-2">
              <button className="btn-pill ghost" onClick={() => void copy(charPrompt, '已复制完整生图提示词')}><Copy size={12} />一键复制提示词</button>
              <button
                className="btn-pill primary"
                onClick={() => toast.info('生图模型调用未接线：请复制提示词到你的生图工具，出图后拖到「自定义建角」页自动处理；或在「模型服务商」配置支持图像生成的供应商')}
              >
                <Wand2 size={12} />调用生图模型批量出图
              </button>
            </div>
          </section>
        )}

        {tab === 'egg' && (
          <section data-creator-pane="egg" className="space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              <label className="block" style={labelStyle}>彩蛋类型
                <select value={eggMode} onChange={(event) => setEggMode(event.target.value as 'cosplay' | 'prank')} className="mt-1 w-full px-3 py-2 text-[12px]" style={inputStyle}>
                  <option value="cosplay">Cosplay 冒充（穿对方衣服 + 假发箍）</option>
                  <option value="prank">对手串门捣乱（含 caught 双人同框）</option>
                </select>
              </label>
              <label className="block" style={labelStyle}>主角（串门者）
                <select value={guest} onChange={(event) => setGuest(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px]" style={inputStyle}>
                  {locks.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
              <label className="block" style={labelStyle}>宿主
                <select value={host} onChange={(event) => setHost(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px]" style={inputStyle}>
                  {locks.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
            </div>
            <pre data-egg-prompt className="max-h-[240px] overflow-auto rounded-xl p-3 text-[10.5px] whitespace-pre-wrap" style={{ ...inputStyle, color: 'var(--text-2)' }}>{eggPrompt}</pre>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="block" style={labelStyle}>彩蛋目录 id<input value={eggId} onChange={(event) => setEggId(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px] mono" style={inputStyle} /></label>
              <label className="block" style={labelStyle}>彩蛋名<input value={eggName} onChange={(event) => setEggName(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px]" style={inputStyle} /></label>
              <div />
            </div>
            {eggLines !== null && (
              <div className="grid gap-2 md:grid-cols-5" data-egg-lines>
                {Object.entries(eggLines).map(([key, lines]) => (
                  <div key={key} className="rounded-lg p-2 text-[11px]" style={inputStyle}>
                    <div className="mono mb-1" style={{ color: 'var(--blue)' }}>{key}</div>
                    {lines.map((line) => <div key={line} style={{ color: 'var(--text-2)' }}>{line}</div>)}
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button className="btn-pill ghost" onClick={() => void copy(eggPrompt, '已复制双参考图彩蛋提示词')}><Copy size={12} />复制提示词</button>
              <button className="btn-pill violet" data-egg-generate disabled={eggBusy} onClick={() => void generateEggLines()}>
                <Sparkles size={12} />{eggBusy ? '生成中…' : '生成 5 态台词并入库'}
              </button>
            </div>
          </section>
        )}

        {tab === 'import' && (
          <section data-creator-pane="import" className="space-y-3">
            <div
              ref={dropRef}
              data-creator-drop
              className="rounded-xl p-5 text-center"
              style={{ border: '1px dashed var(--blue-line)', background: 'var(--blue-dim)' }}
              onDragOver={(event) => { event.preventDefault(); }}
              onDrop={(event) => {
                event.preventDefault();
                const paths = [...event.dataTransfer.files].map((file) => window.directorBridge.pathForFile(file)).filter((path) => path !== '');
                if (paths.length > 0) { setImages(paths); setFolder(''); toast.success(`已接收 ${paths.length} 个文件`); }
              }}
            >
              <UploadCloud size={24} style={{ color: 'var(--blue)', margin: '0 auto 6px' }} />
              <div className="text-[13px] font-semibold">拖入角色文件夹（character.json + 立绘）或 PNG/WebP 原图</div>
              <div className="mt-1 text-[11px]" style={{ color: 'var(--text-2)' }}>自动完成：白底抠像 → 90% 身高脚底对齐 → idle-blink 仅闭眼贴回 → avatar 192×192 / portrait-card 256×384</div>
              <div className="mt-3 flex justify-center gap-2">
                <button className="btn-pill ghost" onClick={() => void window.directorBridge.creatorPickImages().then((result) => { if (result.ok) { setImages(result.paths ?? []); setFolder(''); } })}><ImagePlus size={12} />选择图片</button>
                <button className="btn-pill ghost" onClick={() => void window.directorBridge.creatorPickFolder().then((result) => { if (result.ok && result.folder !== undefined) { setFolder(result.folder); setImages([]); } })}><FolderOpen size={12} />选择文件夹</button>
              </div>
              <div className="mt-2 text-[10.5px] mono" style={{ color: 'var(--text-3)' }}>{folder !== '' ? folder.split('/').slice(-1)[0] : images.length > 0 ? `${images.length} 张图片` : '尚未选择文件'}</div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="block" style={labelStyle}>目录 id（小写字母/数字/连字符）<input data-import-id value={importId} onChange={(event) => setImportId(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px] mono" style={inputStyle} /></label>
              <label className="block" style={labelStyle}>角色名称<input data-import-name value={importName} onChange={(event) => setImportName(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px]" style={inputStyle} placeholder="留空沿用 character.json" /></label>
              <label className="block" style={labelStyle}>reactTo（* 或 AI 列表）<input data-import-reactto value={reactTo} onChange={(event) => setReactTo(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px] mono" style={inputStyle} /></label>
              <label className="block" style={labelStyle}>出错/打断后姿态<input value={correctedPose} onChange={(event) => setCorrectedPose(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px] mono" style={inputStyle} /></label>
              <label className="block" style={labelStyle}>长思考 after（秒）
                <input type="number" min={1} max={600} value={longThinkAfter} onChange={(event) => setLongThinkAfter(Number(event.target.value))} className="mt-1 w-full px-3 py-2 text-[12px] mono" style={inputStyle} />
              </label>
              <label className="block" style={labelStyle}>长思考姿态<input value={longThinkPose} onChange={(event) => setLongThinkPose(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px] mono" style={inputStyle} /></label>
            </div>
            <label className="block" style={labelStyle}>fx 映射（pose: effect，逗号分隔）<input data-import-fx value={fxText} onChange={(event) => setFxText(event.target.value)} className="mt-1 w-full px-3 py-2 text-[12px] mono" style={inputStyle} /></label>

            {importResult !== null && (
              <div className="rounded-lg p-2.5 text-[11px]" style={inputStyle} data-import-result>
                <div>已生成姿态：{importResult.poses.join('、')}</div>
                {importResult.warnings.map((warning) => <div key={warning} style={{ color: 'var(--amber)' }}>{warning}</div>)}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <button className="btn-pill ghost" data-save-custom onClick={() => void window.directorBridge.customSave(importId, {
                name: importName.trim() || importId,
                reactTo: reactTo.trim() === '*' ? '*' : reactTo.split(/[,，]/).map((item) => item.trim()).filter((item) => item !== ''),
                longThink: { after: longThinkAfter, pose: longThinkPose },
                correctedPose,
                fx: parseFx(),
              }).then(async (result) => {
                if (!result.ok) { toast.error(result.error ?? '保存失败（需先导入姿态图）'); return; }
                toast.success('配置已保存并热重载');
                await window.directorBridge.customReload();
                onReloaded();
              })}>保存并热重载</button>
              <button className="btn-pill primary" data-import-run disabled={importBusy} onClick={() => void importNow()}>
                <Wand2 size={12} />{importBusy ? '处理中…' : '导入并后处理'}
              </button>
            </div>

            <div className="rounded-xl p-3" style={{ border: '1px solid var(--stroke)', background: 'var(--surface-2)' }}>
              <div className="mb-2 text-[12px] font-semibold">已有自定义角色改名（落盘本机设置，升级不丢）</div>
              <div className="grid gap-2 md:grid-cols-4">
                <select value={renameTarget} onChange={(event) => { setRenameTarget(event.target.value); setRenameName(customList.find((item) => item.id === event.target.value)?.name ?? ''); }} className="px-2 py-1.5 text-[11.5px]" style={inputStyle}>
                  <option value="">选择自定义角色</option>
                  {customList.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.id}）</option>)}
                </select>
                <input value={renameName} onChange={(event) => setRenameName(event.target.value)} className="px-2 py-1.5 text-[11.5px]" style={inputStyle} placeholder="新名字" />
                <button
                  className="btn-pill ghost"
                  data-rename-custom
                  disabled={renameTarget === ''}
                  onClick={() => void window.directorBridge.customRename(renameTarget, renameName).then(async (result) => {
                    if (!result.ok) { toast.error(result.error ?? '改名失败'); return; }
                    toast.success('已改名并热重载');
                    await window.directorBridge.customReload();
                    setCustomList(await window.directorBridge.creatorListCustom());
                    onReloaded();
                  })}
                >保存新名字</button>
                <div />
              </div>
            </div>

            <div className="rounded-xl p-3" style={{ border: '1px solid var(--stroke)', background: 'var(--surface-2)' }}>
              <div className="mb-2 text-[12px] font-semibold">克隆内置角色到 userData（不覆盖随包素材）</div>
              <div className="grid gap-2 md:grid-cols-4">
                <select value={cloneBuiltinId} onChange={(event) => setCloneBuiltinId(event.target.value)} className="px-2 py-1.5 text-[11.5px]" style={inputStyle}>
                  {locks.map((item) => <option key={item.id} value={`crosspet-${item.id}`}>{item.label}</option>)}
                </select>
                <input value={cloneId} onChange={(event) => setCloneId(event.target.value)} className="px-2 py-1.5 text-[11.5px] mono" style={inputStyle} placeholder="新目录 id" />
                <input value={cloneName} onChange={(event) => setCloneName(event.target.value)} className="px-2 py-1.5 text-[11.5px]" style={inputStyle} placeholder="新角色名（可选）" />
                <button className="btn-pill ghost" data-clone-builtin onClick={() => void cloneBuiltin()}>克隆内置角色</button>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
