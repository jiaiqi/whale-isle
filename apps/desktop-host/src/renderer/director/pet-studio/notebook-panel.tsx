/**
 * 「我们的小本子」（T-M6-48，对齐 design/pet-stage.html Tab 3）。
 *
 * 真实数据：友谊 SQLite（`friendship:notebook`）、8 套 CrossPet 手写字体（`whale-pet://` 直链）、
 * 好友留言（`friendship:note-add`）、最近互聊（`friendship:pair-chat` 经全局语音锁串行播报）。
 * 成就只按真实计数解锁，不显示未达成的假徽章。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookHeart, Eraser, Heart, MessageSquareHeart, PenLine } from 'lucide-react';
import { toast } from 'sonner';
import type { PetStudioFont } from '@workbench/shared-protocol';

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
interface BanterView { id: number; aName: string; aText: string; bName: string; bText: string; createdAt: number }
interface NotebookView { characterId: string; stats: StatsView | null; notes: NoteView[]; banter: BanterView[] }

const TIER_LABEL: Record<StatsView['tier'], string> = {
  stranger: '初次见面',
  familiar: '渐渐熟悉',
  friend: '好朋友',
  best: '最好的朋友',
};
const FONT_STORAGE_KEY = 'whale-isle:notebook:font';

export function NotebookPanel({ characterId, characterName }: { characterId: string; characterName: string }): React.JSX.Element {
  const [view, setView] = useState<NotebookView | null>(null);
  const [fonts, setFonts] = useState<PetStudioFont[]>([]);
  const [fontId, setFontId] = useState<string>(() => {
    try { return localStorage.getItem(FONT_STORAGE_KEY) ?? ''; } catch { return ''; }
  });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback((): void => {
    void window.directorBridge.friendNotebook(characterId)
      .then((next) => setView(next as NotebookView))
      .catch(() => setView(null));
  }, [characterId]);

  useEffect(() => {
    reload();
    void window.directorBridge.petStudioCatalog().then((catalog) => setFonts(catalog.fonts)).catch(() => setFonts([]));
  }, [reload]);

  const font = fonts.find((entry) => entry.id === fontId);
  const fontFace = useMemo(() => {
    if (font === undefined) return '';
    return `@font-face{font-family:whale-notebook;src:url("${font.url}");font-display:swap} .whale-notebook-font{font-family:whale-notebook, var(--font-sans)}`;
  }, [font]);

  const stats = view?.stats ?? null;
  const quarterHearts = stats?.quarterHearts ?? 0;
  const achievements = useMemo(() => {
    if (stats === null) return [];
    return [
      { id: 'first-pat', label: '第一次被摸头', unlocked: stats.pats > 0 },
      { id: 'ten-pats', label: '摸头十连', unlocked: stats.pats >= 10 },
      { id: 'teammate', label: '一起扛过活', unlocked: stats.cowork + stats.cofinish > 0 },
      { id: 'goal', label: '共同目标达成', unlocked: stats.cofinish > 0 },
      { id: 'friend', label: '成为好朋友', unlocked: quarterHearts >= 20 },
    ];
  }, [stats, quarterHearts]);

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

  return (
    <section className="grid gap-3 xl:grid-cols-2" data-notebook-panel>
      {fontFace !== '' && <style>{fontFace}</style>}
      <div className="card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <BookHeart size={15} style={{ color: 'var(--blue)' }} />我们的小本子 · {characterName}
          </h3>
          <span className="pill pill-blue" style={{ fontSize: 10 }}>{fonts.length} 套手写字体 · SQLite</span>
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
              onChange={(event) => {
                setFontId(event.target.value);
                try { localStorage.setItem(FONT_STORAGE_KEY, event.target.value); } catch { /* ignore */ }
              }}
              className="rounded-full px-2 py-0.5 text-[11px] outline-none"
              style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-1)' }}
            >
              <option value="">默认字体</option>
              {fonts.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </label>
        </div>

        <div className="mb-2 space-y-1" data-notebook-hearts>
          {Array.from({ length: 10 }, (_, index) => {
            const fill = Math.max(0, Math.min(4, quarterHearts - index * 4));
            return (
              <span key={index} className="mr-0.5 inline-block" style={{ color: fill > 0 ? 'var(--red)' : 'var(--text-3)' }} title={`${fill}/4`}>
                {fill >= 4 ? '♥' : fill > 0 ? '♡' : '♡'}
              </span>
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
              {item.unlocked ? '✓ ' : '· '}{item.label}
            </span>
          ))}
        </div>

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

        <div className={`mt-3 space-y-1.5 ${font !== undefined ? 'whale-notebook-font' : ''}`} data-notebook-notes>
          {(view?.notes ?? []).map((entry) => (
            <div key={entry.id} className="rounded-lg px-2.5 py-1.5 text-[11.5px]" style={{ background: 'var(--surface-2)', border: '1px solid var(--stroke)' }}>
              {entry.text}
              <span className="ml-2 text-[9px]" style={{ color: 'var(--text-3)' }}>{new Date(entry.createdAt).toLocaleDateString('zh-CN')}</span>
            </div>
          ))}
          {(view?.notes ?? []).length === 0 && <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>小本子还是空的，写第一句话吧。</div>}
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">她们最近聊了什么</h3>
          <button className="btn-pill violet" data-notebook-pair-chat disabled={busy !== null} onClick={() => void pairChat()}>
            <MessageSquareHeart size={12} />{busy === 'pair' ? '正在聊…' : '触发闲时互聊'}
          </button>
        </div>
        <div className="space-y-2" data-notebook-banter>
          {(view?.banter ?? []).map((entry) => (
            <div key={entry.id} className="rounded-xl px-3 py-2 text-[11.5px]" style={{ background: 'var(--violet-dim)', border: '1px solid var(--violet-line)' }}>
              <div><b style={{ color: 'var(--violet)' }}>{entry.aName}</b>：{entry.aText}</div>
              <div className="mt-1"><b style={{ color: 'var(--blue)' }}>{entry.bName}</b>：{entry.bText}</div>
              <div className="mt-1 text-[9px]" style={{ color: 'var(--text-3)' }}>{new Date(entry.createdAt).toLocaleString('zh-CN')}</div>
            </div>
          ))}
          {(view?.banter ?? []).length === 0 && (
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
