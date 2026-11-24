import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareStardewProfile, safeAgentId, safePort } from './coop-launcher';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('coop-launcher 星露谷隔离 profile', () => {
  it('普通 Mod 符号链接，BWF 独立拷贝并改 McpPort，不污染原配置', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coop-launch-')); dirs.push(root);
    const mods = join(root, 'Mods'); mkdirSync(join(mods, 'OtherMod'), { recursive: true });
    writeFileSync(join(mods, 'OtherMod', 'manifest.json'), JSON.stringify({ UniqueID: 'Other.Mod', Name: 'Other' }));
    mkdirSync(join(mods, 'BlindWhaleFarmer'), { recursive: true });
    writeFileSync(join(mods, 'BlindWhaleFarmer', 'manifest.json'), JSON.stringify({ UniqueID: 'Darian.BWF', Name: 'Blind Whale Farmer' }));
    writeFileSync(join(mods, 'BlindWhaleFarmer', 'config.json'), JSON.stringify({ McpPort: 18080, ShowHud: true, Keep: 1 }));
    const result = await prepareStardewProfile({ modsDir: mods, profileDir: join(root, 'profiles'), agentId: 'agent-1', port: 18081 });
    expect(lstatSync(join(result.profileModsDir, 'OtherMod')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(result.profileModsDir, 'BlindWhaleFarmer')).isSymbolicLink()).toBe(false);
    const copied = JSON.parse(readFileSync(join(result.bwfFolder, 'config.json'), 'utf8'));
    expect(copied).toMatchObject({ McpPort: 18081, ShowHud: false, Keep: 1 });
    expect(JSON.parse(readFileSync(join(mods, 'BlindWhaleFarmer', 'config.json'), 'utf8')).McpPort).toBe(18080);
    expect(existsSync(join(root, 'profiles', 'agent-1', 'Mods'))).toBe(true);
  });
  it('拒绝路径穿越与非法端口', () => {
    expect(() => safeAgentId('../escape')).toThrow(/非法/);
    expect(() => safePort(80)).toThrow(/非法/);
  });
});
