import { describe, expect, it } from 'vitest';
import {
  mapLocaleToStardewLanguage,
  StardewAvatarSyncSchema,
  StardewCharacterAppearanceSchema,
  StardewLanHostStatusSchema,
  StardewLaunchOptionsSchema,
  StardewLaunchPrefsSchema,
  StardewLaunchStatusSchema,
  StardewNewSaveConfigSchema,
  StardewPetPreferenceSchema,
} from './index';

describe('V2-P3-07A 星露谷建档、存储隔离与语言映射契约', () => {
  it('mapLocaleToStardewLanguage：覆盖中文、常见语言变体及空串兜底 zh', () => {
    expect(mapLocaleToStardewLanguage()).toBe('zh');
    expect(mapLocaleToStardewLanguage(null)).toBe('zh');
    expect(mapLocaleToStardewLanguage('')).toBe('zh');
    expect(mapLocaleToStardewLanguage('zh-CN')).toBe('zh');
    expect(mapLocaleToStardewLanguage('zh_TW')).toBe('zh');
    expect(mapLocaleToStardewLanguage('en-US')).toBe('en');
    expect(mapLocaleToStardewLanguage('ja')).toBe('ja');
    expect(mapLocaleToStardewLanguage('ko-KR')).toBe('ko');
    expect(mapLocaleToStardewLanguage('pt_BR')).toBe('pt');
    expect(mapLocaleToStardewLanguage('es-ES')).toBe('es');
    expect(mapLocaleToStardewLanguage('fr-FR')).toBe('fr');
    expect(mapLocaleToStardewLanguage('de')).toBe('de');
    expect(mapLocaleToStardewLanguage('ru')).toBe('ru');
    expect(mapLocaleToStardewLanguage('th')).toBe('th');
    expect(mapLocaleToStardewLanguage('it')).toBe('it');
    expect(mapLocaleToStardewLanguage('tr')).toBe('tr');
    expect(mapLocaleToStardewLanguage('hu')).toBe('hu');
    expect(mapLocaleToStardewLanguage('xx-UNKNOWN')).toBe('zh');
  });

  it('StardewNewSaveConfigSchema：单机默认与 8 种农场、小屋边界与路径非法字符拦截', () => {
    const single = StardewNewSaveConfigSchema.parse({
      farmerName: '小鲸',
      farmName: '鲸屿',
      favoriteThing: '白米饭',
      farmType: 'meadowlands',
    });
    expect(single.mode).toBe('singleplayer');
    expect(single.startingCabins).toBe(0);
    expect(single.cabinLayout).toBe('nearby');
    expect(single.skipIntro).toBe(true);
    expect(single.profitMargin).toBe('normal');

    const coopOk = StardewNewSaveConfigSchema.parse({
      farmerName: '小鲸',
      farmName: '鲸屿联机',
      favoriteThing: '白米饭',
      mode: 'coop_host',
      startingCabins: 2,
      cabinLayout: 'separate',
      separateWallets: true,
      profitMargin: '75',
      pet: { type: 'Dog', breed: '1' },
      appearance: {
        characterId: 'blue-whale-maid',
        syncPixelAvatar: true,
        gender: 'female',
        hairColor: '#3b82f6',
      },
    });
    expect(coopOk.startingCabins).toBe(2);
    expect(coopOk.cabinLayout).toBe('separate');

    // 联机房主模式禁止 0 间小屋
    const coopZeroCabins = StardewNewSaveConfigSchema.safeParse({
      farmerName: '小鲸',
      farmName: '鲸屿',
      favoriteThing: '白米饭',
      mode: 'coop_host',
      startingCabins: 0,
    });
    expect(coopZeroCabins.success).toBe(false);

    // 小屋数超过 7 间拒绝
    expect(StardewNewSaveConfigSchema.safeParse({
      farmerName: '小鲸',
      farmName: '鲸屿',
      favoriteThing: '白米饭',
      mode: 'coop_host',
      startingCabins: 8,
    }).success).toBe(false);

    // 路径非法字符与超长拒绝
    expect(StardewNewSaveConfigSchema.safeParse({
      farmerName: 'bad/name',
      farmName: '鲸屿',
      favoriteThing: '白米饭',
    }).success).toBe(false);
    expect(StardewNewSaveConfigSchema.safeParse({
      farmerName: '小鲸',
      farmName: 'x'.repeat(25),
      favoriteThing: '白米饭',
    }).success).toBe(false);
  });

  it('StardewLaunchOptionsSchema：向后兼容空对象，拒绝缺失 newSave 或相对路径隔离/Mods 目录', () => {
    expect(StardewLaunchOptionsSchema.safeParse({}).success).toBe(true);
    expect(StardewLaunchOptionsSchema.safeParse({
      port: 18088,
      timeoutMs: 90_000,
      autoLoadSave: true,
      strategy: 'smapi',
      isolateDataDir: '/tmp/whale-iso',
      modsPath: 'C:\\Stardew\\Mods',
      storageMode: 'isolated',
      language: 'zh',
    }).success).toBe(true);

    // always_new / continue_or_create 缺 newSave 拒绝
    expect(StardewLaunchOptionsSchema.safeParse({ savePolicy: 'always_new' }).success).toBe(false);
    expect(StardewLaunchOptionsSchema.safeParse({ savePolicy: 'continue_or_create' }).success).toBe(false);

    // 嵌套 newSave 校验（coop_host 且 startingCabins=0）在 options 层也要拦截
    const badNested = StardewLaunchOptionsSchema.safeParse({
      savePolicy: 'always_new',
      newSave: {
        farmerName: '小鲸',
        farmName: '鲸屿',
        favoriteThing: '白米饭',
        mode: 'coop_host',
        startingCabins: 0,
      },
    });
    expect(badNested.success).toBe(false);

    // 相对路径 isolateDataDir 与 modsPath 均拒绝
    expect(StardewLaunchOptionsSchema.safeParse({ isolateDataDir: 'relative/path' }).success).toBe(false);
    expect(StardewLaunchOptionsSchema.safeParse({ modsPath: 'relative/mods' }).success).toBe(false);
  });

  it('StardewLaunchPrefs / Status / LanHost / AvatarSync 默认字段完整落位', () => {
    const prefs = StardewLaunchPrefsSchema.parse({});
    expect(prefs.storageMode).toBe('isolated');
    expect(prefs.language).toBe('zh');
    expect(prefs.farmName).toBe('鲸屿');
    expect(prefs.favoriteThing).toBe('白米饭');
    expect(prefs.skipIntro).toBe(true);
    expect(prefs.syncPixelAvatar).toBe(true);

    const lan = StardewLanHostStatusSchema.parse({});
    expect(lan.lanPort).toBe(24642);
    expect(lan.isHost).toBe(false);
    expect(lan.inviteCode).toBeNull();

    const status = StardewLaunchStatusSchema.parse({
      state: 'ready',
      install: { gameInstalled: true, smapiInstalled: true, bwfInstalled: true },
    });
    expect(status.phase).toBe('idle');
    expect(status.errorCode).toBe('NONE');
    expect(status.savePolicy).toBe('load_only');
    expect(status.gameMode).toBe('singleplayer');
    expect(status.storageMode).toBe('standard');
    expect(status.language).toBe('zh');
    expect(status.createdSaveSlot).toBeNull();
    expect(status.lanHost).toBeNull();

    const avatar = StardewAvatarSyncSchema.parse({
      version: 1,
      characterId: 'blue-whale-maid',
      displayName: '小鲸',
      preset: {},
    });
    expect(avatar.syncDisplayName).toBe(true);

    expect(StardewPetPreferenceSchema.parse({}).type).toBe('Cat');
    expect(StardewCharacterAppearanceSchema.parse({}).gender).toBe('female');
  });
});
