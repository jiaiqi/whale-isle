import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  CharacterRegistryCore,
  RuntimeEventBus,
  WhaleError,
  WhaleKernel,
} from './index';

describe('CharacterRegistryCore & WhaleKernel', () => {
  it('manages primary/passive character states, moods, goals, and emergency halt/resume', () => {
    let tick = 500;
    const bus = new RuntimeEventBus({ now: () => ++tick });
    const chars = new CharacterRegistryCore(bus, { now: () => ++tick });

    expect(chars.primaryState().identity.characterId).toBe('char_xiaojing');
    expect(chars.list()).toHaveLength(1);

    const passive = chars.registerCharacter({
      characterId: 'char_puff',
      displayName: '泡芙',
      roleMode: 'passive',
      personaId: 'puff',
      voiceProfileId: 'puff-voice',
    });
    expect(passive.identity.roleMode).toBe('passive');

    chars.registerCharacter({
      characterId: 'char_alt_primary',
      displayName: '替代主角色',
      roleMode: 'primary',
      personaId: 'alt',
      voiceProfileId: 'alt-v',
    });
    expect(chars.primaryState().identity.characterId).toBe('char_alt_primary');

    chars.setExpression('char_xiaojing', 'thinking', '分析攻略');
    chars.updateMood('char_xiaojing', { valence: 0.8, arousal: 0.7, label: '雀跃' });
    chars.updateMood('char_xiaojing', {});
    chars.setControlMode('char_xiaojing', 'coop', '玩家上线');
    chars.setActiveGoal('char_xiaojing', '去海滩钓鱼');
    chars.setActiveGoal('char_xiaojing', null);

    const halted = chars.emergencyHalt('测试急停', 'char_xiaojing');
    expect(halted.halted).toBe(true);
    expect(halted.controlMode).toBe('manual_takeover');
    expect(halted.expression).toBe('idle');

    const resumed = chars.resume('autonomous', 'char_xiaojing');
    expect(resumed.halted).toBe(false);
    expect(resumed.controlMode).toBe('autonomous');

    expect(() => chars.get('unknown')).toThrow(WhaleError);
    expect(() => chars.setExpression('unknown', 'idle')).toThrow(WhaleError);
  });

  it('boots WhaleKernel, enforces plugin permissions, isolates plugin crashes, and stops cleanly', async () => {
    let tick = 1000;
    const sink = vi.fn();
    const kernel = new WhaleKernel({
      logSink: sink,
      now: () => ++tick,
      primaryCharacter: { displayName: '小鲸' },
    });

    expect(kernel.lifecycle).toBe('created');
    await kernel.start();
    await kernel.start(); // idempotent
    expect(kernel.lifecycle).toBe('running');

    // forbidden resource prefixes are hard-denied
    expect(() => kernel.registerPlugin({
      manifest: {
        id: 'bad-vault-plugin',
        name: 'Bad',
        version: '0.1.0',
        permissions: [{ resource: 'vault://keys', policy: 'allow' }],
      },
      setup: () => {},
    })).toThrow(WhaleError);

    expect(() => kernel.registerPlugin({
      manifest: {
        id: 'bad-shell-plugin',
        name: 'BadShell',
        version: '0.1.0',
        permissions: [{ resource: 'shell://exec', policy: 'ask' }],
      },
      setup: () => {},
    })).toThrow(WhaleError);

    // crashing plugin is isolated without bringing down kernel
    kernel.registerPlugin({
      manifest: { id: 'crash-plugin', name: 'Crash', version: '0.1.0' },
      setup: () => {
        throw new Error('plugin init boom');
      },
    });
    expect(kernel.pluginErrors()).toHaveLength(1);

    // valid plugin with tool, event subscription, and effect cleanup
    const disposed = vi.fn();
    const received: unknown[] = [];
    kernel.registerPlugin({
      manifest: {
        id: 'sample-plugin',
        name: 'Sample',
        version: '0.1.0',
        extensions: ['tool'],
        permissions: [{ resource: 'game:read', policy: 'allow' }],
      },
      setup: (api) => {
        expect(api.configSnapshot().activeCharacterId).toBe('char_xiaojing');
        expect(api.primaryCharacter().identity.displayName).toBe('小鲸');
        api.subscribe('sample:*', (ev) => {
          received.push(ev.payload);
        });
        api.defineTool({
          name: 'sample:ping',
          description: 'ping tool',
          schema: z.object({ msg: z.string() }),
          policy: 'allow',
          execute: (args) => {
            api.publish('sample:pong', { msg: args.msg });
            return { pong: args.msg };
          },
        });
        api.defineTool({
          name: 'sample:denied',
          description: 'denied tool',
          schema: z.object({}),
          policy: 'deny',
          execute: () => ({ ok: true }),
        });
        api.effect(() => () => disposed());
      },
    });

    const toolRes = await kernel.invokeTool('sample:ping', { msg: 'hello' });
    expect(toolRes).toEqual({ ok: true, result: { pong: 'hello' } });
    expect(received).toEqual([{ msg: 'hello' }]);

    expect((await kernel.invokeTool('vault:read', {})).ok).toBe(false);
    expect((await kernel.invokeTool('sample:denied', {})).ok).toBe(false);

    // listener exception isolation on kernel event bus
    kernel.events.subscribe('config:updated', () => {
      throw new Error('listener boom');
    });
    kernel.config.update({ theme: 'dark', logLevel: 'debug' });

    expect(kernel.listPlugins()).toHaveLength(2);
    kernel.disablePlugin('sample-plugin');
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(kernel.enablePlugin('sample-plugin')).toBe(true);

    const health = kernel.health();
    expect(health.lifecycle).toBe('running');
    expect(health.plugins.total).toBe(2);
    expect(health.plugins.enabled).toBe(1);
    expect(health.vaultBackend).toBe('memory');

    await kernel.stop();
    await kernel.stop(); // idempotent
    expect(kernel.lifecycle).toBe('stopped');
  });
});
