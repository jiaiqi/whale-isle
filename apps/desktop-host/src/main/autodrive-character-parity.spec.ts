import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { isPackaged: false }, ipcMain: { handle: vi.fn() }, safeStorage: {} }));
import { PetAvatarManifestSchema, PetCharacterSchema, type PetAvatarManifest, type PetCharacter, type PetDesktopPrefs } from '@workbench/shared-protocol';
import type { CharacterRegistry } from './character-registry';
import { characterShortName, selectedCharacterManifest, voiceSceneForCharacter } from './autodrive-host';

const ROLES: Array<[string, string, string]> = [
  ['blue-whale-maid', '小鲸（蓝鲸女仆）', 'qiaopi_mengmei'],
  ['aboutme-dsh', '蓝蓝（蓝毛小女仆）', 'qiaopi_mengmei'],
  ['aboutme-dsh1', '蓝蓝·活力装', 'Chinese (Mandarin)_Crisp_Girl'],
  ['aboutme-gpt', '小吉', 'Arrogant_Miss'],
  ['aboutme-claude', '小克', 'Chinese (Mandarin)_Stubborn_Friend'],
  ['aboutme-gemini', '小芽', 'diadia_xuemei'],
  ['aboutme-qwen', '小千', 'Chinese (Mandarin)_Crisp_Girl'],
  ['aboutme-glm', '小蓝狐', 'Arrogant_Miss'],
  ['aboutme-grok', '小魔女', 'Arrogant_Miss'],
  ['aboutme-kimi', '小星', 'diadia_xuemei'],
];

function characterOf(id: string, name: string, voiceId: string): PetCharacter {
  return PetCharacterSchema.parse({
    id, displayName: name, manifestPath: `pet-characters/${id}/manifest.json`, personaPrompt: `你是${name}`,
    voiceId, voiceRatePercent: 96, voicePitchMul: 1.18, packId: id.startsWith('aboutme-') ? id.slice(8) : '',
    actionCount: 1, audioClipCount: 0, anchorRatio: 0.5, licenseScope: 'DEV_ONLY_NON_COMMERCIAL', builtin: id === 'blue-whale-maid',
  });
}

function manifestOf(character: PetCharacter): PetAvatarManifest {
  return PetAvatarManifestSchema.parse({
    petId: character.id, renderer: character.id === 'blue-whale-maid' ? 'webm-alpha' : 'sprite-sheet', licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
    attribution: character.id, width: 640, height: 360, defaultAction: 'idle',
    actions: [{ actionState: 'idle', clips: [{ clipId: 'idle', webmPath: `assets/${character.id}/idle.webp` }] }], ambientPool: [],
  });
}

function registryWith(selected: PetCharacter): CharacterRegistry {
  return {
    list: () => [selected],
    selected: () => selected,
    manifestOf: (character) => ({ ok: true, manifest: manifestOf(character) }),
  };
}

describe('9 角色 autodrive 平权', () => {
  it('切换任一 aboutme-* 后 pets:manifest 返回该角色真实 manifest', () => {
    for (const [id, name, voiceId] of ROLES) {
      const result = selectedCharacterManifest(registryWith(characterOf(id, name, voiceId)));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.character.id).toBe(id);
      expect(result.manifest.petId).toBe(id);
      expect(result.manifest.renderer).toBe(id === 'blue-whale-maid' ? 'webm-alpha' : 'sprite-sheet');
    }
  });

  it('autodrive speak 使用的声线入参透传 characterId / speakerName / voiceId / 语速音高', () => {
    for (const [id, name, voiceId] of ROLES) {
      const character = characterOf(id, name, voiceId);
      const scene = voiceSceneForCharacter({ text: '收到', scene: 'normal' }, character);
      expect(scene).toMatchObject({
        characterId: id,
        speakerName: id === 'blue-whale-maid' ? '小鲸' : name.split('（')[0],
        voiceId,
        ratePercent: 96,
        pitchMul: 1.18,
      });
      expect(characterShortName(character)).toBe(name.split('（')[0]);
    }
  });

  it('注册表缺失/坏 manifest 时如实失败，不伪造当前角色', () => {
    expect(selectedCharacterManifest(undefined)).toMatchObject({ ok: false });
    const broken: CharacterRegistry = {
      list: () => [], selected: () => characterOf('aboutme-dsh', '蓝蓝', 'qiaopi_mengmei'), manifestOf: () => ({ ok: false, error: 'manifest missing' }),
    };
    expect(selectedCharacterManifest(broken)).toEqual({ ok: false, error: 'manifest missing' });
    expect(voiceSceneForCharacter({ text: 'hi' }, undefined)).toEqual({ text: 'hi' });
  });
});
