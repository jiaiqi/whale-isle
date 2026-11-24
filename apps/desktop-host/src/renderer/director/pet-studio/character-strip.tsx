/**
 * 桌宠工坊顶部共享条（T-M6-46）：9 角色快切 + 皮肤快切。
 * 皮肤来自随包 crosspet 目录（PetStudioCatalog.skins），选中的皮肤记在本地，
 * 渲染层热换装由 PoseSkinRenderer 在批次 3 接线；此条先负责展示与选择。
 */
import type { CharacterSummary } from '../bridge';
import type { PetStudioSkin } from '@workbench/shared-protocol';
import { Shirt } from 'lucide-react';

export function CharacterStrip(props: {
  characters: CharacterSummary[];
  characterId: string;
  onSelect: (id: string) => void;
  skins?: PetStudioSkin[];
  skinId?: string;
  onSelectSkin?: (id: string) => void;
}): React.JSX.Element {
  const { characters, characterId, onSelect, skins = [], skinId = '', onSelectSkin } = props;
  return (
    <div
      data-character-strip
      className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl px-4 py-2.5"
      style={{ border: '1px solid var(--stroke)', background: 'var(--surface)' }}
    >
      <span className="text-[11px] font-semibold" style={{ color: 'var(--text-3)' }}>
        当前角色（随包离线内置）：
      </span>
      {characters.map((character) => {
        const active = character.id === characterId;
        return (
          <button
            key={character.id}
            type="button"
            data-character-chip={character.id}
            data-selected={active ? 'true' : 'false'}
            onClick={() => onSelect(character.id)}
            className="rounded-full px-3 py-1 text-[11.5px] font-semibold transition"
            style={{
              border: `1px solid ${active ? 'var(--blue-line)' : 'var(--stroke)'}`,
              background: active ? 'var(--blue-dim)' : 'var(--inset)',
              color: active ? 'var(--blue)' : 'var(--text-2)',
            }}
            title={`${character.displayName}${character.licenseScope === 'DEV_ONLY_NON_COMMERCIAL' ? ' · DEV_ONLY_NON_COMMERCIAL' : ''}`}
          >
            {character.displayName}
          </button>
        );
      })}
      {characters.length === 0 && (
        <span className="text-[11px]" style={{ color: 'var(--red)' }}>角色注册表为空 · 请先运行 pnpm sync:pet-packs</span>
      )}
      {skins.length > 0 && onSelectSkin !== undefined && (
        <label className="ml-auto flex items-center gap-2 text-[11.5px]" style={{ color: 'var(--text-2)' }}>
          <Shirt size={13} className="text-[var(--violet)]" />
          <span>皮肤：</span>
          <select
            data-skin-select
            value={skinId}
            onChange={(event) => onSelectSkin(event.target.value)}
            className="rounded-full px-2.5 py-1 text-[11.5px] outline-none"
            style={{ border: '1px solid var(--stroke-2)', background: 'var(--bg-elev)', color: 'var(--text-1)' }}
          >
            <option value="">默认外观</option>
            {skins.filter((skin) => skin.kind === 'skin').map((skin) => (
              <option key={skin.id} value={skin.id}>{skin.outfit !== '' ? `${skin.name} · ${skin.outfit}` : skin.name}</option>
            ))}
          </select>
        </label>
      )}
      <div className="flex items-center gap-1.5" style={{ marginLeft: skins.length > 0 ? 0 : 'auto' }}>
        <button
          type="button"
          data-pet-summon
          className="btn-pill ghost"
          style={{ fontSize: 10.5, padding: '3px 9px' }}
          title="召唤当前角色到桌面（已在该角色会聚焦）"
          onClick={() => { void window.directorBridge.petSummon(characterId).then((result) => { if (!result.ok) window.alert(result.error ?? '召唤失败'); }); }}
        >
          叫她出来
        </button>
        <button
          type="button"
          data-pet-assemble
          className="btn-pill ghost"
          style={{ fontSize: 10.5, padding: '3px 9px' }}
          onClick={() => { void window.directorBridge.petAssemble(); }}
        >
          集合！
        </button>
        <button
          type="button"
          data-pet-dismiss
          className="btn-pill ghost"
          style={{ fontSize: 10.5, padding: '3px 9px' }}
          onClick={() => { void window.directorBridge.petDismiss(); }}
        >
          解散
        </button>
        <button
          type="button"
          data-pet-egg
          className="btn-pill ghost"
          style={{ fontSize: 10.5, padding: '3px 9px' }}
          title="随机召唤一只 egg-* 串门彩蛋（点它会逃跑）"
          onClick={() => { void window.directorBridge.petEggSummon().then((result) => { if (!result.ok) window.alert(result.error ?? '彩蛋召唤失败'); }); }}
        >
          召唤彩蛋
        </button>
      </div>
    </div>
  );
}
