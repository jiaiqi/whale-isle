/**
 * 「我们的小本子」（T-M6-48 / T-M6-65，对齐 design/pet-stage.html Tab 3）。
 *
 * 双页书签：
 *   1. 相处记录：真实友谊 SQLite 统计、里程碑、主人留言；
 *   2. 朋友们的留言：从真实互聊记录反向抽取，每条用留言者自己的手写体；
 *      按好感档位分层（便签 / 贴纸徽章 / 挚友双人对话卡 + 双头像合照）。
 *
 * 8 套随包手写体按角色家族自动匹配，也可手动指定并存 prefs.notebookFontId；
 * 冷启动「扫描本机历史记录补录」只读统计时间/模型/工具数，幂等且零正文。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookHeart, ChevronLeft, ChevronRight, Eraser, Heart, History, MessageSquareHeart, PenLine, ScanLine } from 'lucide-react';
import { toast } from 'sonner';
import {
  notebookFontById,
  notebookFontForCharacter,
  notebookFontUrl,
  notebookPaperForCharacter,
  NOTEBOOK_FONTS,
} from '@workbench/pet-renderer/notebook-fonts';

interface StatsView {
  characterId: string;
  points: number;
  dailyGained: number;
  quarterHearts: number;
  hearts: number;
  tier: 'stranger' | 'familiar' | 'friend' | 'best';
  pats: number;
  pokes: number;
  rounds: number;
  cowork: number;
  cofinish: number;
}
interface NoteView { id: number; text: string; createdAt: number }
interface BanterView { id: number; aId: string; aName: string; aText: string; bId: string; bName: string; bText: string; createdAt: number }
interface FriendNoteView {
  id: number;
  characterId: string;
  name: string;
  text: string;
  replyText: string;
  replyName: string;
  tier: StatsView['tier'];
  createdAt: number;
}
interface NotebookView {
  characterId: string;
  stats: StatsView | null;
  notes: NoteView[];
  banter: BanterView[];
  friendNotes?: FriendNoteView[];
  milestones?: Array<{ id: string; text: string; at: number }>;
  notebookTitle?: string;
  notebookEntries?: string[];
  notebookSign?: string;
}

const TIER_LABEL: Record<StatsView['tier'], string> = {
  stranger: '初次见面',
  familiar: '渐渐熟悉',
  friend: '好朋友',
  best: '最好的朋友',
};
const BANTER_PAGE_SIZE = 3;

function portraitUrl(characterId: string): string | null {
  if (!characterId.startsWith('crosspet-')) return null;
  const dir = characterId.slice('crosspet-'.length);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(dir)) return null;
  return `whale-pet://crosspet/characters/${encodeURIComponent(dir)}/portrait.webp`;
}

function Avatar({ characterId, name, accent }: { characterId: string; name: string; accent: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  const url = portraitUrl(characterId);
  if (url !== null && !failed) {
    return (
      <img
        src={url}
        alt={name}
        width={22}
        height={22}
        style={{ width: 22, height: 22, borderRadius: '50%', objectFit: 'cover', border: `1px solid ${accent}`, background: 'var(--inset)' }}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      title={name}
      style={{ width: 22, height: 22, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 700, color: accent, border: `1px solid ${accent}`, background: 'var(--inset)' }}
    >
      {name.slice(0, 1)}
    </span>
  );
}

export function NotebookPanel({ characterId, characterName }: { characterId: string; characterName: string }): React.JSX.Element {
  const [view, setView] = useState<NotebookView | null>(null);
  const [page, setPage] = useState<'records' | 'friends'>('records');
  const [fontId, setFontId] = useState('auto');
  const [wide, setWide] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [backfill, setBackfill] = useState<{ already?: boolean; scannedFiles?: number; rounds?: number; busiestDate?: string } | null>(null);
  const [banterPage, setBanterPage] = useState(0);

  const reload = useCallback((): void => {
    void window.directorBridge.friendNotebook(characterId)
      .then((next) => setView(next as NotebookView))
      .catch(() => setView(null));
  }, [characterId]);

  useEffect(() => {
    reload();
    void window.directorBridge.prefsGet()
      .then((prefs) => setFontId(prefs.notebookFontId || 'auto'))
      .catch(() => undefined);
    setBanterPage(0);
    setPage('records');
  }, [reload, characterId]);

  const paper = notebookPaperForCharacter(characterId);
  const autoFont = notebookFontForCharacter(characterId);
  const selectedFont = fontId === 'auto' ? autoFont : notebookFontById(fontId);
  const currentFontFamily = selectedFont === null ? undefined : `whale-hand-${selectedFont.id}`;
  /** 所有 8 套字体一次性注入：朋友留言必须各自用留言者的手写体 */
  const fontFaces = useMemo(() => NOTEBOOK_FONTS.map((font) =>
    `@font-face{font-family:'whale-hand-${font.id}';src:url("${notebookFontUrl(font.file)}");font-display:swap}`
  ).join('\n'), []);

  const stats = view?.stats ?? null;
  const quarterHearts = stats?.quarterHearts ?? 0;
  const achievements = useMemo(() => {
    if (stats === null) return [];
    const custom = (view?.milestones ?? []).map((item) => ({
      id: `custom-${item.id}`,
      label: item.text,
      unlocked: item.at === 0 || stats.points >= item.at,
    }));
    return [
      ...custom,
      { id: 'first-pat', label: '第一次被摸头', unlocked: stats.pats > 0 },
      { id: 'ten-pats', label: '摸头十连', unlocked: stats.pats >= 10 },
      { id: 'teammate', label: '一起扛过活', unlocked: stats.cowork + stats.cofinish > 0 },
      { id: 'goal', label: '共同目标达成', unlocked: stats.cofinish > 0 },
      { id: 'friend', label: '成为好朋友', unlocked: quarterHearts >= 20 },
    ];
  }, [stats, quarterHearts, view?.milestones]);

  const pairChat = async (): Promise<void> => {
    setBusy('pair');
    try {
      const result = await window.directorBridge.friendPairChat();
      if (!result.ok) toast.error(result.error ?? '互聊失败');
      else {
        toast.success(`${result.aName} 和 ${result.bName} 聊了两句（已串行播报并记进小本子）`);
        reload();
      }
    } finally { setBusy(null); }
  };

  const addNote = async (): Promise<void> => {
    if (note.trim() === '') return;
    setBusy('note');
    try {
      const result = await window.directorBridge.friendNoteAdd(characterId, note);
      if (!result.ok) toast.error(result.error ?? '留言保存失败');
      else { setNote(''); toast.success('已写进小本子'); reload(); }
    } finally { setBusy(null); }
  };

  const runBackfill = async (): Promise<void> => {
    setBusy('backfill');
    try {
      const result = await window.directorBridge.friendBackfillHistory();
      if (!result.ok) { toast.error(result.error ?? '历史补录失败'); return; }
      setBackfill(result);
      toast.success(result.already
        ? `本机历史已补录过：${result.scannedFiles ?? 0} 个文件 / ${result.rounds ?? 0} 轮`
        : `已扫描 ${result.scannedFiles ?? 0} 个文件，补录 ${result.rounds ?? 0} 轮（只统计，不读正文）`);
      reload();
    } finally { setBusy(null); }
  };

  const friendNotes = view?.friendNotes ?? [];
  const banter = view?.banter ?? [];
  const banterPages = Math.max(1, Math.ceil(banter.length / BANTER_PAGE_SIZE));
  const banterSlice = banter.slice(banterPage * BANTER_PAGE_SIZE, banterPage * BANTER_PAGE_SIZE + BANTER_PAGE_SIZE);
  const noteFontFamily = (writerId: string): string | undefined => {
    const font = notebookFontForCharacter(writerId);
    return font === null ? undefined : `whale-hand-${font.id}`;
  };

  return (
    <section className={`grid gap-3 ${wide ? '' : 'xl:grid-cols-2'}`} data-notebook-panel data-notebook-width={wide ? 'wide' : 'narrow'}>
      <style>{`${fontFaces}\n${currentFontFamily !== undefined ? `.whale-notebook-font{font-family:'${currentFontFamily}', var(--font-sans)}` : ''}`}</style>
      <div
        className="card p-4"
        data-notebook-page="records"
        style={{ display: page === 'records' ? 'block' : 'none', background: paper.paper, borderColor: 'var(--stroke-2)' }}
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold" style={{ color: paper.accent }}>
            <BookHeart size={15} />我们的小本子 · {characterName}
          </h3>
          <div className="flex items-center gap-1.5">
            <span className="pill" style={{ fontSize: 9.5, borderColor: paper.accent, color: paper.accent }}>{paper.label}</span>
            <button type="button" className="btn-pill ghost" data-notebook-width-toggle onClick={() => setWide((value) => !value)}>
              {wide ? '窄版' : '宽版'}
            </button>
          </div>
        </div>

        <div className="seg-tabs mb-3">
          <button type="button" data-notebook-page-tab="records" className="seg-tab on" onClick={() => setPage('records')}>相处记录</button>
          <button type="button" data-notebook-page-tab="friends" className="seg-tab" onClick={() => setPage('friends')}>朋友们的留言</button>
        </div>

        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          {[
            ['陪伴心数', stats === null ? '—' : `${stats.hearts} 心 ${quarterHearts % 4}/4`],
            ['今日好感', stats === null ? '—' : `${stats.dailyGained}/15`],
            ['摸头 / 被戳', stats === null ? '—' : `${stats.pats} / ${stats.pokes}`],
            ['协作 / 完成', stats === null ? '—' : `${stats.cowork} / ${stats.cofinish}`],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl px-3 py-2" style={{ background: 'var(--inset)', border: '1px solid var(--stroke)' }}>
              <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>{label}</div>
              <div className="mono mt-0.5 text-[13px] font-semibold">{value}</div>
            </div>
          ))}
        </div>

        <div className="mb-2 flex items-center justify-between text-[11px]" style={{ color: 'var(--text-2)' }}>
          <span className="flex items-center gap-1"><Heart size={11} style={{ color: 'var(--red)' }} />
            关系：{stats === null ? '尚无互动' : TIER_LABEL[stats.tier]}
          </span>
          <label className="flex items-center gap-1.5">
            <PenLine size={11} />
            <select
              value={fontId}
              data-notebook-font-select
              onChange={(event) => {
                const value = event.target.value;
                setFontId(value);
                void window.directorBridge.prefsSet({ notebookFontId: value });
              }}
              className="rounded-full px-2 py-0.5 text-[11px] outline-none"
              style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-1)' }}
            >
              <option value="auto">跟随角色{autoFont === null ? '' : `（${autoFont.label}）`}</option>
              {NOTEBOOK_FONTS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </label>
        </div>

        <div className="mb-2 space-y-1" data-notebook-hearts>
          {Array.from({ length: 10 }, (_, index) => {
            const fill = Math.max(0, Math.min(4, quarterHearts - index * 4));
            return (
              <Heart
                key={index}
                size={12}
                className="mr-0.5 inline-block"
                style={{ color: fill > 0 ? 'var(--red)' : 'var(--text-3)' }}
                fill={fill >= 4 ? 'var(--red)' : fill > 0 ? 'color-mix(in srgb, var(--red) 35%, transparent)' : 'none'}
                aria-label={`第 ${index + 1} 颗心 ${fill}/4`}
              />
            );
          })}
          <span className="ml-1 text-[10px]" style={{ color: 'var(--text-3)' }}>10 颗像素心 · 每颗 1/4 填充 · 每日上限 15 分</span>
        </div>

        <div className="mb-2 flex flex-wrap gap-1.5" data-notebook-achievements>
          {achievements.map((item) => (
            <span
              key={item.id}
              className="rounded-full px-2 py-0.5 text-[10px]"
              style={{
                border: `1px solid ${item.unlocked ? 'var(--green-line)' : 'var(--stroke)'}`,
                background: item.unlocked ? 'var(--green-dim)' : 'var(--inset)',
                color: item.unlocked ? 'var(--green)' : 'var(--text-3)',
              }}
            >
              {item.unlocked ? '' : '· '}{item.label}
            </span>
          ))}
        </div>

        {((view?.notebookEntries?.length ?? 0) > 0 || (view?.notebookSign ?? '') !== '' || (view?.notebookTitle ?? '') !== '') && (
          <div className="mb-2 rounded-xl px-3 py-2" style={{ background: 'var(--surface-2)', border: '1px solid var(--stroke)' }} data-notebook-custom>
            {(view?.notebookTitle ?? '') !== '' && (
              <div className="mb-1 text-[11px] font-semibold" style={{ color: paper.accent }}>{view?.notebookTitle}</div>
            )}
            {(view?.notebookEntries ?? []).map((entry, index) => (
              <div key={`${index}:${entry}`} className="text-[11px] leading-relaxed" style={{ color: 'var(--text-2)' }}>· {entry}</div>
            ))}
            {(view?.notebookSign ?? '') !== '' && (
              <div className="mt-1 text-right text-[10.5px]" style={{ color: 'var(--text-3)' }}>{view?.notebookSign}</div>
            )}
          </div>
        )}

        <div className="mt-2 flex gap-1.5">
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void addNote(); }}
            placeholder={`给 ${characterName} 留句话…`}
            data-notebook-input
            className="min-w-0 flex-1 rounded-lg px-2.5 py-1.5 text-[12px] outline-none"
            style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-1)' }}
          />
          <button className="btn-pill primary" disabled={busy !== null} onClick={() => void addNote()}>写下</button>
          <button
            className="btn-pill ghost"
            title="隐私擦除：只清友谊/留言/互聊三表"
            disabled={busy !== null}
            onClick={() => {
              if (!window.confirm('确定擦除友谊记录、留言与互聊记录？此操作不可恢复。')) return;
              void window.directorBridge.friendWipe().then(() => { toast.success('已擦除本机友谊数据'); reload(); });
            }}
          >
            <Eraser size={12} />
          </button>
        </div>

        <div className={`mt-3 space-y-1.5 ${currentFontFamily !== undefined ? 'whale-notebook-font' : ''}`} data-notebook-notes>
          {(view?.notes ?? []).map((entry) => (
            <div key={entry.id} className="rounded-lg px-2.5 py-1.5 text-[11.5px]" style={{ background: 'var(--surface-2)', border: '1px solid var(--stroke)' }}>
              {entry.text}
              <span className="ml-2 text-[9px]" style={{ color: 'var(--text-3)' }}>{new Date(entry.createdAt).toLocaleDateString('zh-CN')}</span>
            </div>
          ))}
          {(view?.notes ?? []).length === 0 && <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>小本子还是空的，写第一句话吧。</div>}
        </div>

        <div className="mt-3 rounded-xl px-3 py-2" style={{ background: 'var(--inset)', border: '1px solid var(--stroke)' }} data-notebook-backfill-card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[10.5px]" style={{ color: 'var(--text-2)' }}>
              <History size={11} className="mr-1 inline" />冷启动历史补录：只读统计时间/模型/工具数，幂等
            </span>
            <button type="button" className="btn-pill ghost" data-notebook-backfill disabled={busy !== null} onClick={() => void runBackfill()}>
              <ScanLine size={11} />{busy === 'backfill' ? '扫描中…' : '扫描本机历史记录补录'}
            </button>
          </div>
          {backfill !== null && (
            <div className="mono mt-1 text-[10px]" style={{ color: 'var(--text-3)' }} data-notebook-backfill-result>
              {backfill.already ? '已补录过' : '本次补录'}：{backfill.scannedFiles ?? 0} 个文件 · {backfill.rounds ?? 0} 轮
              {backfill.busiestDate ? ` · 最忙 ${backfill.busiestDate}` : ''}
            </div>
          )}
        </div>
      </div>

      <div
        className="card p-4"
        data-notebook-page="friends"
        style={{ display: page === 'friends' ? 'block' : 'none', background: paper.paper, borderColor: 'var(--stroke-2)' }}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold" style={{ color: paper.accent }}>朋友们的留言</h3>
          <div className="seg-tabs">
            <button type="button" data-notebook-page-tab="records" className="seg-tab" onClick={() => setPage('records')}>相处记录</button>
            <button type="button" data-notebook-page-tab="friends" className="seg-tab on" onClick={() => setPage('friends')}>朋友们的留言</button>
          </div>
        </div>

        <div className="space-y-2" data-notebook-friend-notes>
          {friendNotes.map((entry) => {
            const writerFont = noteFontFamily(entry.characterId);
            const writerStyle = { fontFamily: writerFont === undefined ? undefined : `'${writerFont}', var(--font-sans)` };
            return (
              <div key={`${entry.id}:${entry.characterId}`} data-notebook-friend-note data-notebook-tier={entry.tier}>
                {entry.tier === 'best' ? (
                  <div className="rounded-2xl px-3 py-2.5" style={{ background: 'var(--surface-2)', border: `1px solid ${paper.accent}` }}>
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <Avatar characterId={characterId} name={characterName} accent={paper.accent} />
                      <Avatar characterId={entry.characterId} name={entry.name} accent={paper.accent} />
                      <span className="rounded-full px-1.5 py-px text-[9px]" style={{ background: 'var(--violet-dim)', color: 'var(--violet)' }}>挚友 · 双人对话</span>
                      <span className="ml-auto text-[9px]" style={{ color: 'var(--text-3)' }}>{new Date(entry.createdAt).toLocaleDateString('zh-CN')}</span>
                    </div>
                    <div className="text-[11.5px]" style={{ color: 'var(--text-2)', ...writerStyle }}><b>{entry.name}</b>：{entry.text}</div>
                    {entry.replyText !== '' && (
                      <div className="mt-1 rounded-xl px-2.5 py-1.5 text-[11.5px]" style={{ color: 'var(--text-1)', background: 'var(--inset)', ...(currentFontFamily === undefined ? {} : { fontFamily: `'${currentFontFamily}', var(--font-sans)` }) }}>
                        <b>{entry.replyName || characterName}</b>：{entry.replyText}
                      </div>
                    )}
                  </div>
                ) : entry.tier === 'friend' ? (
                  <div className="flex items-start gap-2 rounded-2xl px-3 py-2" style={{ background: 'var(--inset)', border: `1px dashed ${paper.accent}` }}>
                    <Avatar characterId={entry.characterId} name={entry.name} accent={paper.accent} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-[10px]" style={{ color: paper.accent }}>
                        <b>{entry.name}</b>
                        <span className="rounded-full px-1.5 py-px text-[9px]" style={{ background: 'var(--blue-dim)', color: 'var(--blue)' }}>好朋友 · 贴纸</span>
                      </div>
                      <div className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-2)', ...writerStyle }}>{entry.text}</div>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg px-3 py-2" style={{ background: 'var(--surface-2)', borderLeft: `3px solid ${paper.accent}` }}>
                    <div className="text-[10px]" style={{ color: 'var(--text-3)' }}><b>{entry.name}</b> · 便签 · {new Date(entry.createdAt).toLocaleDateString('zh-CN')}</div>
                    <div className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-2)', ...writerStyle }}>{entry.text}</div>
                  </div>
                )}
              </div>
            );
          })}
          {friendNotes.length === 0 && (
            <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>
              还没有朋友留言。打开至少两只桌宠后触发一次「闲时互聊」，对方的真实回话会自动收录到这里，并用手写体呈现。
            </div>
          )}
        </div>

        <div className="mt-3 flex items-center justify-between">
          <h4 className="text-[12px] font-semibold" style={{ color: 'var(--text-2)' }}>最近互聊</h4>
          <div className="flex items-center gap-1">
            <button type="button" className="btn-pill ghost" data-notebook-banter-prev disabled={banterPage === 0} onClick={() => setBanterPage((value) => Math.max(0, value - 1))}><ChevronLeft size={11} /></button>
            <span className="mono text-[10px]" style={{ color: 'var(--text-3)' }}>{banterPage + 1}/{banterPages}</span>
            <button type="button" className="btn-pill ghost" data-notebook-banter-next disabled={banterPage >= banterPages - 1} onClick={() => setBanterPage((value) => Math.min(banterPages - 1, value + 1))}><ChevronRight size={11} /></button>
            <button className="btn-pill violet ml-1" data-notebook-pair-chat disabled={busy !== null} onClick={() => void pairChat()}>
              <MessageSquareHeart size={12} />{busy === 'pair' ? '正在聊…' : '触发闲时互聊'}
            </button>
          </div>
        </div>
        <div className="mt-1.5 space-y-2" data-notebook-banter>
          {banterSlice.map((entry) => (
            <div key={entry.id} className="rounded-xl px-3 py-2 text-[11.5px]" style={{ background: 'var(--violet-dim)', border: '1px solid var(--violet-line)' }}>
              <div style={{ ...(noteFontFamily(entry.aId) === undefined ? {} : { fontFamily: `'${noteFontFamily(entry.aId)}', var(--font-sans)` }) }}><b style={{ color: 'var(--violet)' }}>{entry.aName}</b>：{entry.aText}</div>
              <div className="mt-1" style={{ ...(noteFontFamily(entry.bId) === undefined ? {} : { fontFamily: `'${noteFontFamily(entry.bId)}', var(--font-sans)` }) }}><b style={{ color: 'var(--blue)' }}>{entry.bName}</b>：{entry.bText}</div>
              <div className="mt-1 text-[9px]" style={{ color: 'var(--text-3)' }}>{new Date(entry.createdAt).toLocaleString('zh-CN')}</div>
            </div>
          ))}
          {banter.length === 0 && (
            <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>
              还没有互聊记录——打开至少两只桌宠后点「触发闲时互聊」，她们会经全局语音锁串行说两句。
            </div>
          )}
        </div>
        <p className="mt-3 text-[10px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
          互聊使用角色预置模板（不是 LLM 实时生成）；每句经 AudioLeaseManager 串行播报，并写入 memory-graph 供之后检索。
        </p>
      </div>
    </section>
  );
}
