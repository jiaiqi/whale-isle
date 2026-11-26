/**
 * OBS 透明挂件（v4 设计稿 06）：图层开关 + 520px 预演 + 真实浏览器源。
 * T-M6-34：内嵌 WebUI 的 `/obs` 只读透明挂件已接通（STAGE_PROTOCOL=1，WebSocket 推送
 * 动作/回执，token 鉴权）；本页预演用真实 autodrive 事件渲染，投票/歌词层仍为预演。
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, MonitorPlay, Play, Radio, RefreshCw, Wheat } from 'lucide-react';
import type { AutodriveEventView } from './bridge';

const LAYERS = [
  { id: 'bubbles', label: '双轨气泡' },
  { id: 'vote', label: '弹幕议会' },
  { id: 'lyrics', label: 'RVC 歌词卡' },
  { id: 'rice', label: '赛博饭碗徽' },
  { id: 'bar', label: '弹幕交互条' },
] as const;
type LayerId = (typeof LAYERS)[number]['id'];

/** 「预演」可见徽章：演示数据必须在 UI 上如实标记，不得只在代码注释里说明（审计红线：严禁虚假指标冒充真实数据） */
function PreviewBadge(): React.JSX.Element {
  return (
    <span
      className="mono"
      style={{
        fontSize: 8.5, padding: '1px 5px', borderRadius: 99, letterSpacing: 0.5,
        color: 'var(--amber)', border: '1px dashed var(--amber-line)', background: 'var(--amber-dim)',
      }}
    >预演</span>
  );
}

export interface ObsPanelProps {
  rice: number;
  riceCap: number;
  events: AutodriveEventView[];
}

interface LiveBatchView {
  tier: string;
  at: number;
  events: Array<{ eventId: string; eventType: string; nickname: string; text: string; priority: string }>;
}

export function ObsPanel({ rice, riceCap, events }: ObsPanelProps): React.JSX.Element {
  const [on, setOn] = useState<Record<LayerId, boolean>>({ bubbles: true, vote: true, lyrics: true, rice: true, bar: true });
  const [liveBatches, setLiveBatches] = useState<LiveBatchView[]>([]);
  const [liveStats, setLiveStats] = useState<Record<string, unknown> | null>(null);
  const refreshLive = (): void => {
    void Promise.all([window.directorBridge.liveHistory(), window.directorBridge.liveSnapshot()])
      .then(([history, snapshot]) => { setLiveBatches(history); setLiveStats(snapshot); })
      .catch(() => undefined);
  };
  useEffect(() => {
    refreshLive();
    window.directorBridge.onLiveBatch(() => refreshLive());
  }, []);
  const [votes, setVotes] = useState([12, 7, 4]);
  // T-M6-59：OBS 浏览器源布局/主题（/obs?layout=&theme=）
  const [obsLayout, setObsLayout] = useState<'compact' | 'card'>('card');
  const [obsTheme, setObsTheme] = useState<'dark' | 'light'>('dark');
  const buildObsUrl = (port: number, token: string): string =>
    `http://127.0.0.1:${port}/obs?token=${encodeURIComponent(token)}&layout=${obsLayout}&theme=${obsTheme}`;
  const latestThink = [...events].reverse().find((e) => e.type === 'decision')?.intent ?? '（小鲸还没有内心戏）';
  const latestTalk = [...events].reverse().find((e) => e.tool === 'chat_reply' || e.type === 'receipt')?.summary ?? '（暂无正式台词）';
  const total = votes.reduce((a, b) => a + b, 0);
  const pct = Math.min(100, Math.round((rice / riceCap) * 100));

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-5">
      <header className="mb-4 flex items-end justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold"><MonitorPlay size={18} /> OBS 透明挂件</h1>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-2)' }}>
            内嵌 18780 <span className="mono">/obs</span> 浏览器源 · STAGE_PROTOCOL=1（WebSocket）· 只读透明底
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="pill pill-green"><Radio size={11} />只读挂件已接通</span>
          <label className="pill" style={{ gap: 4 }}>
            布局
            <select
              data-obs-layout
              value={obsLayout}
              onChange={(event) => setObsLayout(event.target.value === 'compact' ? 'compact' : 'card')}
              className="bg-transparent text-[10px] outline-none"
              style={{ color: 'var(--text-1)' }}
            >
              <option value="card">卡片</option>
              <option value="compact">紧凑</option>
            </select>
          </label>
          <label className="pill" style={{ gap: 4 }}>
            主题
            <select
              data-obs-theme
              value={obsTheme}
              onChange={(event) => setObsTheme(event.target.value === 'light' ? 'light' : 'dark')}
              className="bg-transparent text-[10px] outline-none"
              style={{ color: 'var(--text-1)' }}
            >
              <option value="dark">深色</option>
              <option value="light">浅色</option>
            </select>
          </label>
          <button
            className="pill"
            data-obs-copy
            onClick={() => {
              void window.directorBridge.webuiInfo().then(async (info) => {
                const url = buildObsUrl(info.port, info.token);
                try {
                  await navigator.clipboard.writeText(url);
                  toast.success('OBS 浏览器源地址已复制（含本机 token，勿外传）');
                } catch {
                  toast.error(`复制失败，请手动使用：${url}`);
                }
              }).catch(() => toast.error('WebUI 未启动，无法生成 OBS 源地址'));
            }}
          >
            <Copy size={11} />复制 OBS 源地址
          </button>
        </div>
      </header>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {LAYERS.map((l) => (
          <button
            key={l.id}
            className={`pill${on[l.id] ? ' pill-blue' : ''}`}
            onClick={() => setOn((prev) => ({ ...prev, [l.id]: !prev[l.id] }))}
            data-obs-layer={l.id}
          >
            <span className="pulse-dot" style={on[l.id] ? undefined : { background: 'var(--text-3)', boxShadow: 'none' }} />
            {l.label}
          </button>
        ))}
      </div>

      {/* 520px 透明预演（棋盘格模拟 OBS 透明区） */}
      <div
        className="relative mx-auto mb-4 overflow-hidden rounded-2xl"
        style={{
          width: '100%', maxWidth: 720, height: 520,
          border: '1px solid var(--stroke-2)',
          background:
            'repeating-conic-gradient(rgba(255,255,255,0.045) 0% 25%, transparent 0% 50%) 0 0 / 22px 22px, var(--bg)',
        }}
      >
        {on.rice && (
          <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full px-3 py-1.5" style={{ background: 'var(--surface)', border: '1px solid var(--stroke-2)', backdropFilter: 'blur(12px)' }}>
            <Wheat size={11} style={{ color: 'var(--amber)' }} />
            <span className="mono text-[10px]" style={{ color: 'var(--text-2)' }}>{rice.toLocaleString()} 粒</span>
            <span className="h-1 w-16 overflow-hidden rounded-full" style={{ background: 'var(--inset)' }}>
              <i className="block h-full" style={{ width: `${Math.max(4, pct)}%`, background: 'linear-gradient(90deg,var(--amber),var(--green))' }} />
            </span>
          </div>
        )}

        {on.vote && (
          <div className="absolute right-3 top-3 w-44 rounded-xl p-2.5" style={{ background: 'var(--surface)', border: '1px solid var(--stroke-2)', backdropFilter: 'blur(12px)' }}>
            <div className="mono mb-1.5 flex items-center justify-between text-[10px]" style={{ color: 'var(--text-3)' }}>
              <span>弹幕议会 <PreviewBadge /></span><span>0:20</span>
            </div>
            {['继续钓鱼', '回家睡觉', '下矿碰碰运气'].map((label, i) => {
              const p = Math.round(((votes[i] ?? 0) / Math.max(1, total)) * 100);
              return (
                <button key={label} onClick={() => setVotes((v) => v.map((x, j) => (j === i ? x + 1 : x)))} className="mb-1 w-full text-left">
                  <div className="flex justify-between text-[10px]" style={{ color: 'var(--text-2)' }}>
                    <span>{label}</span><span className="mono">{p}%</span>
                  </div>
                  <div className="mt-0.5 h-1 overflow-hidden rounded-full" style={{ background: 'var(--inset)' }}>
                    <i className="block h-full" style={{ width: `${p}%`, background: i === 0 ? 'var(--blue)' : i === 1 ? 'var(--green)' : 'var(--violet)' }} />
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {on.bubbles && (
          <div className="absolute bottom-24 left-6 max-w-[60%]">
            <div className="mb-2 rounded-2xl px-3 py-2 text-[12px]" style={{ background: 'linear-gradient(135deg, rgba(191,90,242,0.16), rgba(191,90,242,0.05))', border: '1.5px dashed rgba(191,90,242,0.45)', color: 'var(--text-1)' }}>
              <span className="mono mr-1 text-[9px]" style={{ color: 'var(--violet)' }}>内心戏</span>
              {latestThink}
            </div>
            <div className="rounded-2xl px-3.5 py-2.5 text-[13px]" style={{ background: 'var(--surface)', border: '1px solid var(--blue-line)', backdropFilter: 'blur(14px)', color: 'var(--text-1)' }}>
              {latestTalk}
            </div>
          </div>
        )}

        {/* 桌宠剪影占位（真实 OBS 源为 pet-stage 透明窗） */}
        <svg className="absolute bottom-6 right-10 floaty" width="150" height="150" viewBox="0 0 24 24" fill="none">
          <path d="M3 12c0-4.4 3.6-8 8-8h5a5 5 0 0 1 5 5c0 6.6-5.4 12-12 12H4l2.5-3.2C4.4 16.3 3 14.3 3 12Z" fill="rgba(10,132,255,0.12)" stroke="rgba(10,132,255,0.55)" strokeWidth="0.8" />
          <circle cx="17.5" cy="10.5" r="1.2" fill="var(--blue)" />
        </svg>

        {on.bar && (
          <div className="absolute bottom-4 left-1/2 w-[70%] -translate-x-1/2 rounded-full px-4 py-1.5 text-center text-[11px]" style={{ background: 'var(--surface)', border: '1px solid var(--stroke-2)', color: 'var(--text-2)' }}>
            弹幕交互条 <PreviewBadge />：发送 <span className="mono" style={{ color: 'var(--blue)' }}>点歌 晴天</span> / <span className="mono" style={{ color: 'var(--violet)' }}>投票 2</span>
          </div>
        )}

        {on.lyrics && (
          <div className="absolute bottom-16 right-3 w-52 rounded-xl p-2.5" style={{ background: 'var(--surface)', border: '1px solid var(--stroke-2)', backdropFilter: 'blur(12px)' }}>
            <div className="mono mb-1 flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-3)' }}>正在演唱 · 学猫叫 <PreviewBadge /></div>
            <div className="text-[11px]" style={{ color: 'var(--blue)' }}>我们一起学猫叫</div>
            <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>一起喵喵喵喵喵</div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full" style={{ background: 'var(--inset)' }}>
              <i className="block h-full" style={{ width: '38%', background: 'var(--violet)' }} />
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          ['双轨气泡', '内心戏紫云朵 + 正式台词玻璃泡，事件来自真实 autodrive 总线'],
          ['议会投票', '20s 倒计时三选一；票数实时重排（STAGE_PROTOCOL SSE 接线中）'],
          ['歌词 / 饭碗', 'RVC 当前句与下一句、饭碗余额与进度条'],
        ].map(([t, d]) => (
          <div key={t} className="card px-3.5 py-3">
            <div className="text-xs font-semibold">{t}</div>
            <p className="mt-1 text-[11px] leading-relaxed" style={{ color: 'var(--text-3)' }}>{d}</p>
          </div>
        ))}
      </div>

      <section className="card mt-4 overflow-hidden" data-live-panel>
        <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid var(--stroke)' }}>
          <Radio size={14} />
          <h3 className="text-xs font-semibold">直播事件流（[SIMULATION] 回放）</h3>
          <span className="pill" style={{ fontSize: 9 }}>护栏 · 注意力 · 去重</span>
          <div className="flex-1" />
          <button className="pill" onClick={() => { void window.directorBridge.liveClear().then(refreshLive); }}><RefreshCw size={11} />清空</button>
          <button
            className="btn-pill primary px-3"
            data-live-replay
            onClick={() => { void window.directorBridge.liveReplay().then(refreshLive); }}
          ><Play size={11} />回放样本弹幕</button>
        </div>
        <div className="grid grid-cols-3 gap-2 px-4 py-2.5">
          {([
            ['收到', String(liveStats?.received ?? 0)],
            ['护栏拦截', String(liveStats?.droppedByGuard ?? 0)],
            ['当前档位', String(liveStats?.tier ?? '—')],
          ] as Array<[string, string]>).map(([k, v]) => (
            <div key={String(k)} className="inset px-2.5 py-1.5">
              <div className="text-[9.5px]" style={{ color: 'var(--text-3)' }}>{k}</div>
              <div className="mono text-[11px]">{String(v)}</div>
            </div>
          ))}
        </div>
        <div className="px-4 pb-3">
          {liveBatches.length === 0 && <p className="text-[11px]" style={{ color: 'var(--text-3)' }}>点「回放样本弹幕」查看护栏/注意力流水线；这不是真实直播间数据。</p>}
          {liveBatches.flatMap((batch, bi) => batch.events.map((event, ei) => (
            <div key={`${bi}-${ei}`} data-live-event={event.eventType} className="flex items-center gap-2 py-1 text-[11px]" style={{ borderBottom: '1px dashed var(--stroke)' }}>
              <span className="mono" style={{ color: 'var(--text-3)' }}>{event.priority}</span>
              <span style={{ color: 'var(--text-2)' }}>{event.nickname}</span>
              <span className="min-w-0 flex-1 truncate">{event.text}</span>
              <span className="pill" style={{ fontSize: 9 }}>{batch.tier}</span>
            </div>
          )))}
        </div>
      </section>
    </div>
  );
}
