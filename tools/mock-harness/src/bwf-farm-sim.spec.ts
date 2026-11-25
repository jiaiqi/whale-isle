/** 农场仿真（T-M6-69）：工具语义 / get_state 格式 / 换日结算 / 天气与换季 / 累晕与 2:00 遣返。 */
import { describe, expect, it } from 'vitest';
import { BwfMcpClient } from '@workbench/game-bridge-mcp';
import { SIM_SEED_TABLE, simSeedForSeason, startBwfFarmSim, type FarmSimHandle } from './bwf-farm-sim';

async function withSim(
  options: Parameters<typeof startBwfFarmSim>[0],
  run: (sim: FarmSimHandle, client: BwfMcpClient) => Promise<void>,
): Promise<void> {
  const sim = await startBwfFarmSim(options);
  try {
    await run(sim, new BwfMcpClient(sim.endpoint));
  } finally {
    await sim.close();
  }
}

type CallResult = Awaited<ReturnType<BwfMcpClient['callTool']>>;

async function call(client: BwfMcpClient, tool: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  return client.callTool(tool, args);
}

async function text(client: BwfMcpClient, tool: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await call(client, tool, args);
  if (result.kind !== 'ok') throw new Error(`${tool} → ${result.kind}`);
  return result.text;
}

describe('bwf-farm-sim 世界状态与 get_state 格式', () => {
  it('真机同格式：基本状态/当前界面/位置/背包/作物段（只在农场出现）', async () => {
    await withSim({ year: 1, season: '春', day: 16, money: 640, tilled: 4, strawberry: 2 }, async (sim, client) => {
      const home = await text(client, 'get_state');
      expect(home).toContain('## 基本状态');
      expect(home).toContain('时间：第1年春16日 06:00（Tue），天气：');
      expect(home).toContain('金钱：640g  体力：270/270  生命：100/100');
      expect(home).toContain('## 当前界面\n无（可以自由行动）');
      expect(home).toContain('地点：FarmHouse（农舍），室内');
      expect(home).toContain('邮箱里有 1 封未读信件');
      expect(home).toContain('0: 斧头');
      expect(home).toContain('背包空位：');
      expect(home).not.toContain('## 作物'); // 作物段只报当前地点
      const farm = await text(client, 'travel_to', { location: 'Farm' });
      expect(farm).toContain('已到达');
      const atFarm = await text(client, 'get_state');
      expect(atFarm).toContain('## 作物（本地点全部）');
      expect(atFarm).toContain('（农场概况：共 2 株作物，需浇水 0，可收获 2）');
      expect(atFarm).toContain('农田：共 6 格耕地：作物 2，空 4');
      expect(sim.snapshot()).toMatchObject({ location: 'Farm', crops: 2, harvestable: 2, emptyTilled: 4 });
    });
  });

  it('周几按星露谷规则（第 1 天周一）；冬天只会下雪或晴；种子表冬季为空', async () => {
    await withSim({ year: 1, season: '冬', day: 7 }, async (_sim, client) => {
      const state = await text(client, 'get_state');
      expect(state).toContain('（Sun）');
      expect(state).toMatch(/天气：(雪|晴)/);
      expect(simSeedForSeason('冬')).toBeNull();
      expect(SIM_SEED_TABLE).toHaveLength(3);
    });
  });
});

describe('bwf-farm-sim 工具语义', () => {
  it('读信/等待/整理/清地/未知工具', async () => {
    await withSim({ mailPerDay: 2 }, async (_sim, client) => {
      expect(await text(client, 'read_mail')).toContain('读完 2 封信');
      expect(await text(client, 'read_mail')).toContain('没有未读信件');
      expect(await text(client, 'wait', { minutes: 30 })).toContain('等待');
      expect(await text(client, 'wait')).toContain('等待');
      expect(await text(client, 'tidy_backpack')).toContain('整理');
      expect(await text(client, 'list_chests')).toContain('还没有箱子');
      expect(await text(client, 'clear_area')).toContain('清理');
      const unknown = await call(client, 'no_such_tool');
      expect(unknown.kind === 'ok' && unknown.isError).toBe(true);
      const badTravel = await call(client, 'travel_to', { location: 'Moon' });
      expect(badTravel.kind === 'ok' && badTravel.isError).toBe(true);
    });
  });

  it('浇水/收获：地点校验、无作物提示、重复收获作物留在地里', async () => {
    await withSim({ tilled: 2, strawberry: 3 }, async (sim, client) => {
      const farWater = await call(client, 'water_crops');
      expect(farWater.kind === 'ok' && farWater.isError).toBe(true);
      await text(client, 'travel_to', { location: 'Farm' });
      // 初始草莓已浇水 → 无需要浇水的作物
      expect(await text(client, 'water_crops')).toContain('没有需要浇水');
      const harvested = await text(client, 'harvest_crops');
      expect(harvested).toContain('草莓 x3');
      expect(sim.snapshot().bag.find((stack) => stack.name === '草莓')?.count).toBe(3);
      // 草莓是重复收获：地块保留，进入再生长
      expect(sim.snapshot().crops).toBe(3);
      expect(await text(client, 'harvest_crops')).toContain('没有可收获');
    });
  });

  it('出货/购买：钱、季节、营业时间、商店界面校验', async () => {
    await withSim({ day: 16, minutes: 10 * 60, money: 640, tilled: 4 }, async (sim, client) => {
      const missing = await call(client, 'ship_items', { item: '鲈鱼' });
      expect(missing.kind === 'ok' && missing.isError).toBe(true);
      await text(client, 'travel_to', { location: 'Farm' });
      await text(client, 'harvest_crops');
      // 没草莓可收，手工走正常出货：先买种子再卖？——直接买种验证购买分支
      await text(client, 'travel_to', { location: 'SeedShop' });
      expect(await text(client, 'open_shop')).toContain('打开了');
      expect(await text(client, 'buy', { item: '防风草种子', count: 2 })).toContain('花了 40g');
      expect(sim.snapshot().money).toBe(600);
      expect(sim.snapshot().menu).toContain('商店');
      expect(await text(client, 'close_menu')).toContain('已关闭');
      // 背包里没有的东西不能卖
      const noItem = await call(client, 'ship_items', { item: '防风草' });
      expect(noItem.kind === 'ok' && noItem.isError).toBe(true);
    });
  });

  it('购买失败分支：没开商店界面 / 非当季 / 钱不够 / 周三不营业', async () => {
    await withSim({ day: 16, money: 640, tilled: 4 }, async (_sim, client) => {
      const noMenu = await call(client, 'buy', { item: '防风草种子', count: 1 });
      expect(noMenu.kind === 'ok' && noMenu.isError).toBe(true);
      await text(client, 'travel_to', { location: 'SeedShop' });
      await text(client, 'open_shop');
      const offSeason = await call(client, 'buy', { item: '辣椒种子', count: 1 });
      expect(offSeason.kind === 'ok' && offSeason.isError).toBe(true);
      const unknown = await call(client, 'buy', { item: '钻石', count: 1 });
      expect(unknown.kind === 'ok' && unknown.isError).toBe(true);
      const poor = await call(client, 'buy', { item: '防风草种子', count: 60 });
      expect(poor.kind === 'ok' && poor.isError).toBe(true);
    });
    // 周三：杂货店休息
    await withSim({ day: 17, minutes: 10 * 60 }, async (_sim, client) => {
      const atHome = await call(client, 'open_shop');
      expect(atHome.kind === 'ok' && atHome.isError).toBe(true);
      await text(client, 'travel_to', { location: 'SeedShop' });
      const state = await text(client, 'get_state');
      expect(state).toContain('周三休息');
      const closed = await call(client, 'open_shop');
      expect(closed.kind === 'ok' && closed.isError).toBe(true);
    });
  });

  it('播种/开垦：空地、种子、季节成熟期与开垦上限', async () => {
    await withSim({ tilled: 2, strawberry: 0, money: 640, minutes: 10 * 60 }, async (sim, client) => {
      const away = await call(client, 'plant_seeds', { seed: '防风草种子', max: 2 });
      expect(away.kind === 'ok' && away.isError).toBe(true);
      await text(client, 'travel_to', { location: 'Farm' });
      const noSeed = await call(client, 'plant_seeds', { seed: '防风草种子', max: 2 });
      expect(noSeed.kind === 'ok' && noSeed.isError).toBe(true);
      const unknownSeed = await call(client, 'plant_seeds', { seed: '仙人掌种子', max: 1 });
      expect(unknownSeed.kind === 'ok' && unknownSeed.isError).toBe(true);
      // 买 2 份种子再种
      await text(client, 'travel_to', { location: 'SeedShop' });
      await text(client, 'open_shop');
      await text(client, 'buy', { item: '防风草种子', count: 2 });
      await text(client, 'travel_to', { location: 'Farm' });
      expect(await text(client, 'plant_seeds', { seed: '防风草种子', max: 2 })).toContain('种下了 2 株');
      expect(sim.snapshot()).toMatchObject({ emptyTilled: 0, crops: 2 });
      const noRoom = await call(client, 'plant_seeds', { seed: '防风草种子', max: 1 });
      expect(noRoom.kind === 'ok' && noRoom.isError).toBe(true);
      const awayTill = await call(client, 'travel_to', { location: 'Town' }).then(() => call(client, 'till_area', { count: 3 }));
      expect(awayTill.kind === 'ok' && awayTill.isError).toBe(true);
      await text(client, 'travel_to', { location: 'Farm' });
      expect(await text(client, 'till_area', { count: 3 })).toContain('开垦了 3 格');
      expect(sim.snapshot().emptyTilled).toBe(3);
    });
    // 季末成熟不了：游戏本身不拦购买，但「今天该不该买」的机会判定必须是 false（日程据此记 N/A）
    await withSim({ day: 26, minutes: 10 * 60, tilled: 2 }, async (sim, client) => {
      await text(client, 'travel_to', { location: 'SeedShop' });
      await text(client, 'open_shop');
      const late = await call(client, 'buy', { item: '防风草种子', count: 1 });
      expect(late.kind === 'ok' && late.isError).toBe(false);
      expect(sim.currentDay().opportunity.buySeeds).toBe(false);
    });
    // 开垦上限：没有更多可开垦的地（成功但不改状态）
    await withSim({ tilled: 3, strawberry: 0, arableCap: 3 }, async (sim, client) => {
      await text(client, 'travel_to', { location: 'Farm' });
      expect(await text(client, 'till_area', { count: 5 })).toContain('没有更多可开垦');
      expect(sim.snapshot().tilled).toBe(3);
    });
  });

  it('钓鱼/采集/吃东西：地点、鱼竿、鱼获与体力恢复', async () => {
    await withSim({ tilled: 0, strawberry: 0 }, async (sim, client) => {
      const awayFish = await call(client, 'fish', { casts: 3 });
      expect(awayFish.kind === 'ok' && awayFish.isError).toBe(true);
      await text(client, 'travel_to', { location: 'Beach' });
      const caught = await text(client, 'fish', { casts: 3 });
      expect(caught).toContain('钓到');
      expect(sim.snapshot().bag.some((stack) => stack.name === '沙丁鱼' || stack.name === '鲷鱼')).toBe(true);
      const awayForage = await call(client, 'forage');
      expect(awayForage.kind === 'ok' && awayForage.isError).toBe(true);
      await text(client, 'travel_to', { location: 'Town' });
      expect(await text(client, 'forage')).toContain('韭葱');
      const noFood = await call(client, 'eat', { item: '煎蛋' });
      expect(noFood.kind === 'ok' && noFood.isError).toBe(true);
      const ate = await text(client, 'eat', { item: '韭葱' });
      expect(ate).toContain('恢复了体力');
    });
  });
});

describe('bwf-farm-sim 换日 / 天气 / 换季 / 极端情况', () => {
  it('sleep：结算出货、恢复体力、次日 06:00 农舍醒来、新邮件到', async () => {
    await withSim({ money: 500, tilled: 2, strawberry: 2 }, async (sim, client) => {
      await text(client, 'travel_to', { location: 'Farm' });
      await text(client, 'harvest_crops');
      await text(client, 'ship_items', { item: '草莓', count: 2 });
      const pending = sim.snapshot().pendingShipping;
      expect(pending).toBeGreaterThan(0);
      await text(client, 'sleep');
      const snap = sim.snapshot();
      expect(snap.money).toBe(500 + pending);
      expect(snap).toMatchObject({ day: 17, minutes: 6 * 60, location: 'FarmHouse', stamina: 270, unreadMail: 2 });
      expect(sim.days).toHaveLength(1);
      expect(sim.days[0]?.loop.sleptBefore2am).toBe(true);
      expect(sim.days[0]?.moneyEnd).toBe(500 + pending);
    });
  });

  it('雨天：作物自动喝饱、浇水项自动完成（不需要 water_crops）', async () => {
    await withSim({ weatherPlan: ['下雨', '晴'], tilled: 0, strawberry: 2 }, async (sim, client) => {
      const state = await text(client, 'get_state');
      expect(state).toContain('天气：下雨');
      expect(sim.snapshot().needsWater).toBe(0);
      await text(client, 'sleep');
      expect(sim.days[0]?.loop.water).toBe(true);
      expect(sim.days[0]?.opportunity.water).toBe(false);
    });
  });

  it('换季：春 28 → 夏 1，非当季作物枯萎（地块保留）', async () => {
    await withSim({ season: '春', day: 28, tilled: 2, strawberry: 2 }, async (sim, client) => {
      expect(sim.snapshot().crops).toBe(2);
      await text(client, 'sleep');
      expect(sim.snapshot()).toMatchObject({ season: '夏', day: 1, crops: 0, emptyTilled: 4 });
    });
  });

  it('凌晨 2:00 强制结束并扣 100g', async () => {
    await withSim({ money: 640 }, async (sim, client) => {
      const result = await text(client, 'wait', { minutes: 20 * 60 });
      expect(result).toContain('凌晨 2:00');
      expect(sim.days[0]?.forcedHome2am).toBe(true);
      expect(sim.snapshot().money).toBe(540);
      expect(sim.snapshot().day).toBe(17);
    });
  });

  it('体力耗尽 → 累晕回家并扣 100g', async () => {
    await withSim({ money: 640, stamina: 4, tilled: 0, strawberry: 3 }, async (sim, client) => {
      await text(client, 'travel_to', { location: 'Farm' });
      const result = await text(client, 'harvest_crops');
      expect(result).toContain('累晕');
      expect(sim.days[0]?.passedOut).toBe(true);
      expect(sim.snapshot().day).toBe(17);
    });
  });

  it('冬 28 → 第 2 年春 1（跨年换季）', async () => {
    await withSim({ year: 1, season: '冬', day: 28, tilled: 1, strawberry: 0 }, async (sim, client) => {
      await text(client, 'sleep');
      expect(sim.snapshot()).toMatchObject({ year: 2, season: '春', day: 1 });
    });
  });

  it('背包满时收获失败（不静默吞掉收获物）', async () => {
    // 4 个工具 + 20 件杂物 = 24 格满
    const junk: Record<string, number> = {};
    for (let i = 0; i < 20; i += 1) junk[`杂物${String(i)}`] = 1;
    await withSim({ tilled: 0, strawberry: 2, extraItems: junk }, async (sim, client) => {
      await text(client, 'travel_to', { location: 'Farm' });
      const full = await call(client, 'harvest_crops');
      expect(full.kind === 'ok' && full.isError).toBe(true);
      expect(sim.snapshot().freeSlots).toBe(0);
    });
  });

  it('仿真不支持的天气计划/未知季节也能稳定输出', async () => {
    await withSim({ season: '春', day: 1, weatherPlan: [] }, async (_sim, client) => {
      expect(await text(client, 'get_state')).toContain('明天天气：');
    });
  });
});
