/**
 * T-M6-03 门禁：插件清单校验 / defineTool 与注册表 / 容器生命周期与崩溃隔离 / dsh 适配器全链路。
 * 全部为确定性单测，不触网、不落盘（[SIMULATION] 之外的真实插件装载由宿主 E2E 覆盖）。
 */
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  EventBus,
  PLUGIN_EXTENSIONS,
  PluginHost,
  PluginManifestSchema,
  ToolRegistry,
  adaptDshPlugin,
  defineTool,
  hasExtension,
  normalizePluginId,
  parsePluginManifest,
  registerDshPlugin,
} from './index';
import type { DshContext, DshLikePlugin, ToolContext } from './index';

/** 最小合法清单（默认值由 schema 补齐） */
const manifestOf = (id: string) => ({ id, name: `插件 ${id}`, version: '1.0.0' });

const toolCtx = (pluginId = 'standalone'): ToolContext => ({ pluginId, emit: () => {} });

/** 可复用的空参数 schema */
const emptyArgs = () => z.object({});

describe('PluginManifestSchema 清单校验', () => {
  it('合法清单填充默认值（描述/图标/扩展点/权限/dsh 标记）', () => {
    const manifest = PluginManifestSchema.parse(manifestOf('stardew-farm'));
    expect(manifest.extensions).toEqual([]);
    expect(manifest.permissions).toEqual([]);
    expect(manifest.icon).toBe('puzzle');
    expect(manifest.description).toBe('');
    expect(manifest.dshCompatible).toBe(false);
  });

  it('非法 id 拒绝（大写/数字开头/scope/空格）', () => {
    for (const id of ['Demo_Plugin', '1st-plugin', '@scope/x', 'plugin kit']) {
      expect(PluginManifestSchema.safeParse({ id, name: 'x', version: '1' }).success).toBe(false);
    }
  });

  it('未知扩展点拒绝，全部合法扩展点可声明', () => {
    const unknown = PluginManifestSchema.safeParse({ ...manifestOf('demo'), extensions: ['magic.widget'] });
    expect(unknown.success).toBe(false);
    const all = PluginManifestSchema.parse({ ...manifestOf('demo'), extensions: [...PLUGIN_EXTENSIONS] });
    expect(all.extensions).toHaveLength(PLUGIN_EXTENSIONS.length);
  });

  it('权限 policy 仅允许 allow/ask/deny', () => {
    const ok = PluginManifestSchema.safeParse({
      ...manifestOf('demo'),
      permissions: [{ resource: 'fs:plugins/', policy: 'allow' }],
    });
    expect(ok.success).toBe(true);
    const bad = PluginManifestSchema.safeParse({
      ...manifestOf('demo'),
      permissions: [{ resource: 'fs:plugins/', policy: 'maybe' }],
    });
    expect(bad.success).toBe(false);
  });

  it('parsePluginManifest 校验外部清单，hasExtension 判定扩展点', () => {
    expect(parsePluginManifest(manifestOf('good')).id).toBe('good');
    expect(() => parsePluginManifest({ id: 'Bad', name: 'x', version: '1' })).toThrow();
    const manifest = PluginManifestSchema.parse({ ...manifestOf('demo'), extensions: ['tool'] });
    expect(hasExtension(manifest, 'tool')).toBe(true);
    expect(hasExtension(manifest, 'aside.card')).toBe(false);
  });
});

describe('defineTool 与 ToolRegistry', () => {
  it('标准化工具对象：policy 默认 allow、pluginId 默认 standalone', async () => {
    const tool = defineTool({
      name: 'echo',
      description: '回声',
      schema: z.object({ text: z.string() }),
      execute: ({ text }) => text,
    });
    expect(tool.policy).toBe('allow');
    expect(tool.pluginId).toBe('standalone');
    await expect(tool.invoke({ text: '喵' }, toolCtx())).resolves.toEqual({ ok: true, result: '喵' });
  });

  it('参数校验失败返回 {ok:false} 而不抛异常', async () => {
    const tool = defineTool({
      name: 'echo',
      description: '',
      schema: z.object({ text: z.string() }),
      execute: ({ text }) => text,
    });
    const result = await tool.invoke({ text: 42 }, toolCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('text');
  });

  it('execute 抛错被包装为 {ok:false,error}（Error 与非 Error 抛出物）', async () => {
    const boom = defineTool({
      name: 'boom',
      description: '',
      schema: emptyArgs(),
      execute: () => {
        throw new Error('锅炸了');
      },
    });
    await expect(boom.invoke({}, toolCtx())).resolves.toEqual({
      ok: false,
      error: '工具执行失败（boom）：锅炸了',
    });
    const weird = defineTool({
      name: 'weird',
      description: '',
      schema: emptyArgs(),
      execute: () => {
        throw '纯字符串';
      },
    });
    await expect(weird.invoke({}, toolCtx())).resolves.toEqual({
      ok: false,
      error: '工具执行失败（weird）：纯字符串',
    });
    const objectBoom = defineTool({
      name: 'object_boom',
      description: '',
      schema: emptyArgs(),
      execute: () => {
        throw { code: 500 };
      },
    });
    await expect(objectBoom.invoke({}, toolCtx())).resolves.toEqual({
      ok: false,
      error: '工具执行失败（object_boom）：[object Object]',
    });
  });

  it('schema 根级类型不符也返回 {ok:false}（path 为空的错误文案）', async () => {
    const scalar = defineTool({
      name: 'scalar',
      description: '',
      schema: z.string(),
      execute: (value) => value,
    });
    const result = await scalar.invoke(42, toolCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('参数校验失败（scalar）');
  });

  it('异步 execute 结果正常返回', async () => {
    const tool = defineTool({
      name: 'later',
      description: '',
      schema: emptyArgs(),
      async execute() {
        return 7;
      },
    });
    await expect(tool.invoke({}, toolCtx())).resolves.toEqual({ ok: true, result: 7 });
  });

  it('注册表基础操作：重名抛错，get/has/list/size/unregister/clear 一致', () => {
    const registry = new ToolRegistry();
    const tool = defineTool({ name: 'alpha', description: '', schema: emptyArgs(), execute: () => 1 });
    registry.register(tool);
    expect(registry.has('alpha')).toBe(true);
    expect(registry.get('alpha')).toBe(tool);
    expect(registry.size).toBe(1);
    expect(registry.list('standalone')).toHaveLength(1);
    expect(registry.list('other')).toHaveLength(0);
    const duplicate = defineTool({ name: 'alpha', description: '', schema: emptyArgs(), execute: () => 2 });
    expect(() => registry.register(duplicate, 'other')).toThrow(/工具重名/);
    expect(registry.unregister('alpha')).toBe(true);
    expect(registry.unregister('alpha')).toBe(false);
    registry.register(tool, 'other');
    expect(registry.list()).toHaveLength(1);
    expect(registry.list('other')).toHaveLength(1);
    registry.clear();
    expect(registry.size).toBe(0);
  });

  it('按插件批量注销：只删该插件工具并返回被删名字', () => {
    const registry = new ToolRegistry();
    const make = (name: string) => defineTool({ name, description: '', schema: emptyArgs(), execute: () => name });
    registry.register(make('p1_one'), 'p1');
    registry.register(make('p1_two'), 'p1');
    registry.register(make('keep'), 'p2');
    expect(registry.unregisterByPlugin('p1')).toEqual(['p1_one', 'p1_two']);
    expect(registry.has('p1_one')).toBe(false);
    expect(registry.has('p1_two')).toBe(false);
    expect(registry.has('keep')).toBe(true);
    expect(registry.unregisterByPlugin('nobody')).toEqual([]);
  });
});

describe('PluginHost 生命周期', () => {
  it('register 即启用，list() 返回 {id,manifest,enabled}', () => {
    const host = new PluginHost();
    host.register(manifestOf('alpha'), () => {});
    expect(host.list()).toEqual([
      { id: 'alpha', manifest: expect.objectContaining({ id: 'alpha' }), enabled: true },
    ]);
    expect(host.isEnabled('alpha')).toBe(true);
    expect(host.isEnabled('ghost')).toBe(false);
    expect(host.get('alpha')?.parentId).toBeUndefined();
    expect(host.get('missing')).toBeUndefined();
  });

  it('enable/disable 幂等：setup 只执行一次，重复 disable 不重复清理', () => {
    const host = new PluginHost();
    let setups = 0;
    let cleanups = 0;
    host.register(manifestOf('alpha'), () => {
      setups++;
      return () => {
        cleanups++;
      };
    });
    host.enable('alpha');
    expect(setups).toBe(1);
    host.disable('alpha');
    host.disable('alpha');
    expect(cleanups).toBe(1);
    expect(host.isEnabled('alpha')).toBe(false);
    host.enable('alpha');
    expect(setups).toBe(2);
    expect(host.isEnabled('alpha')).toBe(true);
  });

  it('可逆副作用：disable 后工具注销、订阅不再触发；re-enable 恢复', async () => {
    const host = new PluginHost();
    const received: string[] = [];
    host.register(manifestOf('alpha'), (ctx) => {
      ctx.defineTool({ name: 'ping', description: '', schema: emptyArgs(), execute: () => 'pong' });
      ctx.on('danmaku:line', (payload) => {
        received.push(String(payload));
      });
    });
    await expect(host.invokeTool('ping')).resolves.toEqual({ ok: true, result: 'pong' });
    host.emit('danmaku:line', 'first');
    expect(received).toEqual(['first']);

    host.disable('alpha');
    expect(host.tools.has('ping')).toBe(false);
    await expect(host.invokeTool('ping')).resolves.toEqual({ ok: false, error: '未知工具：ping' });
    host.emit('danmaku:line', 'second');
    expect(received).toEqual(['first']);

    host.enable('alpha');
    await expect(host.invokeTool('ping')).resolves.toEqual({ ok: true, result: 'pong' });
  });

  it('父子级联：禁用父级级联禁用子级，父级禁用时子级不得单独启用', async () => {
    const host = new PluginHost();
    host.register(manifestOf('parent'), (ctx) => {
      ctx.defineTool({ name: 'parent_tool', description: '', schema: emptyArgs(), execute: () => 'p' });
    });
    host.register(
      manifestOf('child'),
      (ctx) => {
        ctx.defineTool({ name: 'child_tool', description: '', schema: emptyArgs(), execute: () => 'c' });
      },
      { parentId: 'parent' },
    );
    expect(host.children('parent')).toEqual(['child']);
    expect(host.children('child')).toEqual([]);
    expect(host.get('child')?.parentId).toBe('parent');

    host.disable('parent');
    expect(host.isEnabled('child')).toBe(false);
    expect(host.tools.has('child_tool')).toBe(false);
    expect(host.tools.has('parent_tool')).toBe(false);
    expect(() => host.enable('child')).toThrow(/父插件未启用/);
    // 父级禁用期间不允许登记新子插件（避免树在禁用态偷偷生长）
    expect(() => host.register(manifestOf('child2'), () => {}, { parentId: 'parent' })).toThrow(/父插件未启用/);

    host.enable('parent');
    expect(host.isEnabled('parent')).toBe(true);
    expect(host.isEnabled('child')).toBe(false);
    host.enable('child');
    await expect(host.invokeTool('child_tool')).resolves.toEqual({ ok: true, result: 'c' });
  });

  it('注册守卫：重复 id、父插件不存在、自引用父级、未知 id 均抛错', () => {
    const host = new PluginHost();
    host.register(manifestOf('alpha'), () => {});
    expect(() => host.register(manifestOf('alpha'), () => {})).toThrow(/重复注册/);
    expect(() => host.register(manifestOf('beta'), () => {}, { parentId: 'nope' })).toThrow(/父插件不存在/);
    expect(() => host.register(manifestOf('gamma'), () => {}, { parentId: 'gamma' })).toThrow(/自身为父级/);
    expect(() => host.enable('nope')).toThrow(/插件不存在/);
    expect(() => host.disable('nope')).toThrow(/插件不存在/);
  });

  it('setup 崩溃隔离：记录 errors、回滚半成品副作用，其它插件不受影响', async () => {
    const host = new PluginHost();
    let leaked = 0;
    host.register(manifestOf('broken'), (ctx) => {
      ctx.defineTool({ name: 'half_done', description: '', schema: emptyArgs(), execute: () => 1 });
      ctx.on('danmaku:*', () => {
        leaked++;
      });
      throw new Error('setup 炸了');
    });
    expect(host.isEnabled('broken')).toBe(false);
    expect(host.tools.has('half_done')).toBe(false);
    expect(host.errors.some((e) => e.id === 'broken' && e.phase === 'enable')).toBe(true);
    expect(host.errors.find((e) => e.id === 'broken')?.error).toContain('setup 炸了');
    host.emit('danmaku:line', 'x');
    expect(leaked).toBe(0);

    // 崩溃插件可重试（仍失败就再记一条），且不影响健康插件
    host.enable('broken');
    expect(host.errors.filter((e) => e.id === 'broken')).toHaveLength(2);
    host.register(manifestOf('healthy'), (ctx) => {
      ctx.defineTool({ name: 'ok_tool', description: '', schema: emptyArgs(), execute: () => 2 });
    });
    await expect(host.invokeTool('ok_tool')).resolves.toEqual({ ok: true, result: 2 });
  });

  it('工具 execute 异常经宿主调用被包装，宿主保持启用', async () => {
    const host = new PluginHost();
    host.register(manifestOf('alpha'), (ctx) => {
      ctx.defineTool({
        name: 'explode',
        description: '',
        schema: emptyArgs(),
        execute: () => {
          throw new Error('氨气泄漏');
        },
      });
    });
    await expect(host.invokeTool('explode')).resolves.toEqual({
      ok: false,
      error: '工具执行失败（explode）：氨气泄漏',
    });
    expect(host.list()[0]?.enabled).toBe(true);
  });

  it('清理器自身抛错只记 disable 错误，不阻断 disable；clearErrors 可清空', () => {
    const host = new PluginHost();
    host.register(manifestOf('alpha'), () => () => {
      throw new Error('清理失败');
    });
    expect(() => host.disable('alpha')).not.toThrow();
    expect(host.isEnabled('alpha')).toBe(false);
    expect(host.errors.some((e) => e.id === 'alpha' && e.phase === 'disable' && e.error === '清理失败')).toBe(true);
    host.clearErrors();
    expect(host.errors).toHaveLength(0);
  });

  it('清理器数组逆序释放；非 Error 抛出物同样入册', () => {
    const host = new PluginHost();
    const order: string[] = [];
    host.register(manifestOf('alpha'), () => [
      { dispose: () => order.push('first') },
      () => order.push('second'),
    ]);
    host.disable('alpha');
    expect(order).toEqual(['second', 'first']);
    host.register(manifestOf('beta'), () => () => {
      throw '清理字符串';
    });
    host.disable('beta');
    expect(host.errors).toContainEqual({ id: 'beta', error: '清理字符串', phase: 'disable' });
  });

  it('ctx.effect：enable 时立即执行，disable 时执行其返回的清理器', () => {
    const host = new PluginHost();
    const log: string[] = [];
    host.register(manifestOf('alpha'), (ctx) => {
      ctx.effect(() => {
        log.push('setup');
        return () => {
          log.push('cleanup');
        };
      });
      ctx.effect(() => {
        log.push('noop'); // 无返回值 = 无可逆副作用
      });
    });
    expect(log).toEqual(['setup', 'noop']);
    host.disable('alpha');
    expect(log).toEqual(['setup', 'noop', 'cleanup']);
  });

  it('ctx.once 幂等且随 disable 注销', () => {
    const host = new PluginHost();
    let hits = 0;
    host.register(manifestOf('alpha'), (ctx) => {
      ctx.once('gift:combo', () => {
        hits++;
      });
    });
    host.emit('gift:combo', 1);
    host.emit('gift:combo', 2);
    expect(hits).toBe(1);
    host.disable('alpha');
    host.emit('gift:combo', 3);
    expect(hits).toBe(1);
  });

  it('宿主级订阅与插件广播：on/once/emit 全链路贯通，工具经 ctx.emit 发布事件', async () => {
    const host = new PluginHost();
    const seen: string[] = [];
    host.on('danmaku:*', (payload) => seen.push(`host:${String(payload)}`));
    host.once('danmaku:focus', () => seen.push('once'));
    host.register(manifestOf('alpha'), (ctx) => {
      ctx.emit('danmaku:boot', 'boot');
      ctx.defineTool({
        name: 'broadcast',
        description: '',
        schema: z.object({ text: z.string() }),
        execute: (args, toolCtx) => {
          toolCtx.emit('danmaku:reply', args.text);
          return args.text;
        },
      });
    });
    expect(seen).toEqual(['host:boot']);
    host.emit('danmaku:focus', 'focus');
    expect(seen).toEqual(['host:boot', 'host:focus', 'once']);
    await expect(host.invokeTool('broadcast', { text: 'pong' })).resolves.toEqual({ ok: true, result: 'pong' });
    expect(seen).toEqual(['host:boot', 'host:focus', 'once', 'host:pong']);
  });

  it('插件监听器抛错隔离：记入 errors(phase=event)，同事件其它监听器照常收到', () => {
    const host = new PluginHost();
    const seen: string[] = [];
    host.register(manifestOf('bad-listener'), (ctx) => {
      ctx.on('crash:event', () => {
        throw new Error('监听器爆了');
      });
    });
    host.on('crash:event', () => seen.push('host-ok'));
    expect(() => host.emit('crash:event', null)).not.toThrow();
    expect(seen).toEqual(['host-ok']);
    expect(host.errors).toContainEqual({ id: 'bad-listener', error: '监听器爆了', phase: 'event' });
  });
});

describe('EventBus 通配与监听器隔离', () => {
  it('domain:* 前缀通配命中同域事件，不命中其它域；点号写法等价', () => {
    const bus = new EventBus();
    const hits: string[] = [];
    bus.on('stardew:*', (payload) => hits.push(String(payload)));
    expect(bus.emit('stardew:receipt', 'r1')).toBe(1);
    expect(bus.emit('stardew:state', 's1')).toBe(1);
    expect(bus.emit('danmaku:line', 'd1')).toBe(0);
    // 冒号通配不会误伤点号命名的事件（前缀包含分隔符，语义精确）
    expect(bus.emit('stardew.state', 'd0')).toBe(0);
    bus.on('danmaku.*', (payload) => hits.push(`dot:${String(payload)}`));
    bus.emit('danmaku.line', 'd2');
    expect(hits).toEqual(['r1', 's1', 'dot:d2']);
  });

  it('once 只触发一次；通配 * 全匹配；dispose 幂等', () => {
    const bus = new EventBus();
    let onceHits = 0;
    const onceSub = bus.once('*', () => {
      onceHits++;
    });
    expect(bus.emit('any:event', 1)).toBe(1);
    expect(bus.emit('any:event', 2)).toBe(0);
    expect(onceHits).toBe(1);
    onceSub.dispose();
    onceSub.dispose();

    let liveHits = 0;
    const sub = bus.on('stardew:*', () => {
      liveHits++;
    });
    bus.emit('stardew:receipt', 3);
    sub.dispose();
    sub.dispose();
    bus.emit('stardew:receipt', 4);
    expect(liveHits).toBe(1);
  });

  it('监听器抛错隔离：通知剩余监听器并回传肇事 owner', () => {
    const failures: string[] = [];
    const bus = new EventBus((ownerId) => failures.push(ownerId));
    const seen: string[] = [];
    bus.on(
      'x:*',
      () => {
        throw new Error('监听器炸了');
      },
      'bad',
    );
    bus.on('x:*', () => seen.push('ok'), 'good');
    expect(bus.emit('x:y', null)).toBe(2);
    expect(seen).toEqual(['ok']);
    expect(failures).toEqual(['bad']);
    expect(bus.size).toBe(2);
    expect(bus.removeByOwner('bad')).toBe(1);
    expect(bus.size).toBe(1);
    expect(bus.removeByOwner('bad')).toBe(0);
  });

  it('默认错误处理器静默吞错（裸 EventBus 可直接用）', () => {
    const bus = new EventBus();
    bus.on('boom', () => {
      throw new Error('x');
    });
    expect(() => bus.emit('boom', null)).not.toThrow();
  });
});

describe('dsh 兼容适配器', () => {
  it('normalizePluginId：scope/下划线/数字开头全部规范为合法 id', () => {
    expect(normalizePluginId('dsh-plugin-yushe')).toBe('dsh-plugin-yushe');
    expect(normalizePluginId('@dsh/Story_Board')).toBe('dsh-story-board');
    expect(normalizePluginId('1st-tool')).toBe('dsh-1st-tool');
    expect(normalizePluginId('***')).toBe('dsh-plugin');
  });

  it('adaptDshPlugin：manifest 标记 dshCompatible 并声明 tool 扩展点', () => {
    const dsh: DshLikePlugin = { name: 'Dsh_Sample', version: '0.3.0', description: '样例', apply: () => {} };
    const adapted = adaptDshPlugin(dsh);
    expect(adapted.id).toBe('dsh-sample');
    expect(adapted.manifest).toMatchObject({
      id: 'dsh-sample',
      name: 'Dsh_Sample',
      version: '0.3.0',
      description: '样例',
      icon: 'puzzle',
      extensions: ['tool'],
      permissions: [],
      dshCompatible: true,
    });
  });

  it('全生命周期：工具经宿主可调、事件透传、disable 注销工具并执行 effect 清理、re-enable 重建', async () => {
    const host = new PluginHost();
    const log = { effects: 0, cleanups: 0, received: [] as string[] };
    const fixture: DshLikePlugin = {
      name: 'dsh-yushe-fixture',
      apply(ctx: DshContext) {
        ctx.tool('greet_user', (args) => `你好，${String(args.who ?? '主人')}！`);
        ctx.on('danmaku:gift', (payload) => {
          log.received.push(JSON.stringify(payload));
        });
        ctx.effect(() => {
          log.effects++;
          return () => {
            log.cleanups++;
          };
        });
      },
    };
    const adapted = registerDshPlugin(host, fixture);
    expect(adapted.manifest.dshCompatible).toBe(true);
    expect(host.isEnabled('dsh-yushe-fixture')).toBe(true);
    // 外来 dsh 工具默认 policy=ask（审批优先，运行期安全锁）
    expect(host.tools.get('greet_user')?.policy).toBe('ask');

    await expect(host.invokeTool('greet_user', { who: '小鲸' })).resolves.toEqual({ ok: true, result: '你好，小鲸！' });
    await expect(host.invokeTool('greet_user')).resolves.toEqual({ ok: true, result: '你好，主人！' });
    host.emit('danmaku:gift', { user: '甲', count: 1 });
    expect(log.received).toEqual(['{"user":"甲","count":1}']);
    expect(log.effects).toBe(1);
    expect(log.cleanups).toBe(0);

    host.disable('dsh-yushe-fixture');
    expect(log.cleanups).toBe(1);
    expect(host.tools.has('greet_user')).toBe(false);
    host.emit('danmaku:gift', { user: '乙' });
    expect(log.received).toHaveLength(1);

    host.enable('dsh-yushe-fixture');
    expect(log.effects).toBe(2);
    await expect(host.invokeTool('greet_user', { who: '主人' })).resolves.toEqual({ ok: true, result: '你好，主人！' });
  });

  it('adaptDshPlugin 可覆盖图标/扩展点/权限声明与工具 policy', () => {
    const host = new PluginHost();
    const adapted = registerDshPlugin(
      host,
      { name: 'custom', apply: (ctx) => ctx.tool('noop_tool', () => 1) },
      {
        icon: 'fish',
        extensions: ['tool', 'aside.card'],
        permissions: [{ resource: 'tool:custom/', policy: 'deny' }],
        policy: 'allow',
      },
    );
    expect(adapted.manifest.icon).toBe('fish');
    expect(adapted.manifest.extensions).toEqual(['tool', 'aside.card']);
    expect(adapted.manifest.permissions).toEqual([{ resource: 'tool:custom/', policy: 'deny' }]);
    expect(host.tools.get('noop_tool')?.policy).toBe('allow');
  });
});

describe('PluginHost pet:control 注入（T-M6-49）', () => {
  it('声明 pet:control/allow 才注入 petApi；未声明或 deny 为 undefined', () => {
    const calls: string[] = [];
    const petApi = {
      state: async (agentId: string) => ({ agentId, sleeping: false }),
      say: async (agentId: string, text: string) => { calls.push(`${agentId}:${text}`); return { ok: true }; },
      action: async (agentId: string, actionState: string) => { calls.push(`${agentId}:${actionState}`); return { ok: true }; },
    };
    const host = new PluginHost({ petApiFor: (manifest) => (manifest.permissions.some((p) => p.resource === 'pet:control' && p.policy === 'allow') ? petApi : undefined) });
    let granted: unknown;
    let denied: unknown;
    host.register({ ...manifestOf('pet-plugin'), permissions: [{ resource: 'pet:control', policy: 'allow' }] }, (ctx) => { granted = ctx.petApi; });
    host.register({ ...manifestOf('plain-plugin'), permissions: [{ resource: 'pet:control', policy: 'deny' }] }, (ctx) => { denied = ctx.petApi; });
    expect(granted).toBe(petApi);
    expect(denied).toBeUndefined();
    void (petApi.say('default', '巡检完成')).then(() => expect(calls).toContain('default:巡检完成'));
  });
});
