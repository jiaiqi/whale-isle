/**
 * 「桌宠工坊」面板外壳（T-M6-46，对齐 design/pet-stage.html 4 页签）：
 *   舞台与互动 / 动作预览与素材库 / 小本子与友谊 / 跨 AI 跟随与接口
 *
 * 顶部共享 9 角色 + 皮肤快切条；素材目录经 `pet:studio-catalog` 一次拉取后
 * 分发给动作播放器与皮肤选择器（同一份数据，避免重复读盘）。
 */
import { useEffect, useState } from 'react';
import { BookHeart, Clapperboard, Cpu, Sparkles, Stethoscope } from 'lucide-react';
import type { PetStudioCatalog } from '@workbench/shared-protocol';
import type { ModelProviderConfig } from '@workbench/shared-protocol';
import type { DirectorStore } from '@workbench/local-store/dexie';
import type { AutodriveEventView, CharacterSummary } from '../bridge';
import { PetStagePanel } from '../pet-stage-panel';
import { CharacterStrip } from './character-strip';
import { ActionPlayer } from './action-player';
import { NotebookPanel } from './notebook-panel';
import { CreatorCenter } from './creator-center';
import { AcceptanceBench } from './acceptance-bench';
import { WorkFollowPanel } from './work-follow-panel';

const SKIN_STORAGE_KEY = 'whale-isle:pet-studio:skin';

export type PetStudioTab = 'stage' | 'library' | 'social' | 'work';

const TABS: Array<{ id: PetStudioTab; label: string; icon: React.JSX.Element }> = [
  { id: 'stage', label: '舞台与互动', icon: <Sparkles size={12} /> },
  { id: 'library', label: '动作预览与素材库', icon: <Clapperboard size={12} /> },
  { id: 'social', label: '小本子与友谊', icon: <BookHeart size={12} /> },
  { id: 'work', label: '跨 AI 跟随与接口', icon: <Cpu size={12} /> },
];

export function PetStudioPanel(props: {
  events: AutodriveEventView[];
  running: boolean;
  characters: CharacterSummary[];
  characterId: string;
  onSelectCharacter: (id: string) => void;
  /** 桌宠右键「小本子」信号：每次自增即切到 Tab 3 */
  openNotebookSignal?: number;
  /** 桌宠右键/顶栏「创作中心」「验收台」信号 */
  openCreatorSignal?: number;
  openBenchSignal?: number;
  /** 生图供应商（创作中心直连出图用；Key 只在主进程 vault） */
  providers?: ModelProviderConfig[];
  store?: DirectorStore;
  onOpenProviders?: () => void;
}): React.JSX.Element {
  const { events, running, characters, characterId, onSelectCharacter, openNotebookSignal, openCreatorSignal, openBenchSignal, providers, store, onOpenProviders } = props;
  const [tab, setTab] = useState<PetStudioTab>('stage');
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [benchOpen, setBenchOpen] = useState(false);
  const [catalog, setCatalog] = useState<PetStudioCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skinId, setSkinId] = useState<string>(() => {
    try { return localStorage.getItem(SKIN_STORAGE_KEY) ?? ''; } catch { return ''; }
  });

  useEffect(() => {
    if (openNotebookSignal !== undefined && openNotebookSignal > 0) setTab('social');
  }, [openNotebookSignal]);
  useEffect(() => {
    if (openCreatorSignal !== undefined && openCreatorSignal > 0) setCreatorOpen(true);
  }, [openCreatorSignal]);
  useEffect(() => {
    if (openBenchSignal !== undefined && openBenchSignal > 0) setBenchOpen(true);
  }, [openBenchSignal]);

  useEffect(() => {
    void window.directorBridge.petStudioCatalog()
      .then((next) => {
        setCatalog(next);
        setError(next.errors.length > 0 ? next.errors.join('；') : null);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  const selectSkin = (id: string): void => {
    setSkinId(id);
    try { localStorage.setItem(SKIN_STORAGE_KEY, id); } catch { /* 隐私模式忽略 */ }
    // 热换装：皮肤是 CrossPet 的独立角色目录，召唤对应角色的桌宠窗（夜间自动换成睡衣）
    if (id !== '') {
      void window.directorBridge.petSummon(`crosspet-${id}`).then((result) => {
        if (!result.ok) window.alert(result.error ?? '换装失败');
      });
    }
  };

  const active = characters.find((character) => character.id === characterId);
  const characterName = active?.displayName ?? '小鲸';

  return (
    <div data-pet-studio data-pet-tab-active={tab}>
      <header className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">桌宠工坊</h1>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-2)' }}>
            9 角色全平权 · 全量素材随包离线 · {catalog?.actions.length ?? 0} 个动作 / {catalog?.slots.length ?? 0} 条槽位映射 / {catalog?.skins.length ?? 0} 套皮肤与彩蛋
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-pill primary" data-open-creator onClick={() => setCreatorOpen(true)}><Sparkles size={12} />创作中心</button>
          <button type="button" className="btn-pill ghost" data-open-bench onClick={() => setBenchOpen(true)}><Stethoscope size={12} />验收台</button>
          <div className="seg-tabs" role="tablist" aria-label="桌宠工坊页签">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              data-pet-studio-tab={entry.id}
              aria-selected={tab === entry.id}
              className={`seg-tab${tab === entry.id ? ' on' : ''}`}
              onClick={() => setTab(entry.id)}
            >
              {entry.icon}{entry.label}
            </button>
          ))}
          </div>
        </div>
      </header>

      <CharacterStrip
        characters={characters}
        characterId={characterId}
        onSelect={onSelectCharacter}
        skins={catalog?.skins ?? []}
        skinId={skinId}
        onSelectSkin={selectSkin}
      />

      {tab === 'stage' && (
        <PetStagePanel
          events={events}
          running={running}
          characters={characters}
          characterId={characterId}
          onSelectCharacter={onSelectCharacter}
          onOpenCreator={() => setCreatorOpen(true)}
          onOpenBench={() => setBenchOpen(true)}
        />
      )}

      {tab === 'library' && (
        <ActionPlayer
          characterId={characterId}
          characterName={characterName}
          catalog={catalog}
          error={error}
          onOpenCreator={() => setCreatorOpen(true)}
          onOpenBench={() => setBenchOpen(true)}
        />
      )}

      {tab === 'social' && <NotebookPanel characterId={characterId} characterName={characterName} />}

      {tab === 'work' && <WorkFollowPanel characterId={characterId} characterName={characterName} />}

      <CreatorCenter
        open={creatorOpen}
        onClose={() => setCreatorOpen(false)}
        characterId={characterId}
        characterName={characterName}
        onReloaded={() => window.dispatchEvent(new Event('pet:characters-changed'))}
        {...(providers === undefined ? {} : { providers })}
        {...(store === undefined ? {} : { store })}
        {...(onOpenProviders === undefined ? {} : { onOpenProviders })}
      />
      <AcceptanceBench open={benchOpen} onClose={() => setBenchOpen(false)} />
    </div>
  );
}
