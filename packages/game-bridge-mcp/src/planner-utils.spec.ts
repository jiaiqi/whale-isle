/**
 * RulePlanner 纯解析工具的边界分支回归（Gate 3 覆盖率余量）。
 *
 * 这些是规则规划器的「眼睛」：解析错一格、漏掉一个【留着】，
 * 真机上就是卖错东西或满包卡死。每个用例对应 planner.ts 里一个真实分支，
 * 输入按 BWF 状态文本的真实格式构造（序号行、`x数量`、`【留着】` 标签、文字地图）。
 */
import { describe, expect, it } from 'vitest';
import {
  countWood,
  findBuyBackpackSpot,
  findFreeTile,
  hasChestItem,
  hasFishingRod,
  listEdibleItems,
  listShippableItems,
  parseBackpackUpgrade,
  pickAnyNonEssential,
  pickChestSacrifice,
  pickEdible,
  pickFurnitureToPlace,
  pickRenewableReserved,
  pickTrash,
  pickTrashableFallback,
} from './planner';

const bag = (...lines: string[]): string => `## 背包\n${lines.join('\n')}\n## 其他`;

describe('背包解析工具的边界分支', () => {
  it('listShippableItems：值钱线索排最前，工具/种子/箱子被排除', () => {
    const items = listShippableItems(bag(
      '1: 斧头',
      '2: 防风草种子 x5',
      '3: 普通石头 x10',
      '4: 沙丁鱼 x3',
      '5: 木箱',
    ));
    expect(items[0]).toBe('沙丁鱼');
    expect(items).toContain('普通石头');
    expect(items).not.toContain('斧头');
    expect(items).not.toContain('防风草种子');
    // 现状如实记录：NON_SELLABLE 只排除「箱子」两字，「木箱」不在排除表内（与 hasChestItem 的宝箱识别不对称）
    expect(items).toContain('木箱');
  });

  it('pickEdible / listEdibleItems：跳过【留着】的任务物品，空包返回 null', () => {
    const raw = bag('1: 烤土豆 [可食用 +50 体力]', '2: 红莓酱 [可食用 +30 体力]【留着】');
    expect(pickEdible(raw)).toBe('烤土豆');
    expect(listEdibleItems(raw)).toEqual(['烤土豆']);
    expect(pickEdible(bag('1: 斧头'))).toBeNull();
  });

  it('pickTrash：挑真垃圾且跳过【留着】，全是工具时返回 null', () => {
    expect(pickTrash(bag('1: 报纸', '2: 竹鱼竿'))).toBe('报纸');
    expect(pickTrash(bag('1: 破眼镜【留着】', '2: 竹鱼竿'))).toBeNull();
  });

  it('pickAnyNonEssential：跳过可食用与工具，rejected 集合生效', () => {
    const raw = bag('1: 普通石头 x10', '2: 烤土豆 [可食用]', '3: 锄头');
    expect(pickAnyNonEssential(raw)).toBe('普通石头');
    expect(pickAnyNonEssential(raw, new Set(['普通石头']))).toBeNull();
  });

  it('pickTrashableFallback：只挑不值钱消耗品，后匹配覆盖前匹配（如实记录遍历语义）', () => {
    const raw = bag('1: 鱼饵 x20', '2: 锄头', '3: 防风草种子 x3');
    // 遍历全程 candidate 被后命中的行覆盖：种子在鱼饵之后 → 取种子
    expect(pickTrashableFallback(raw)).toBe('防风草种子');
    expect(pickTrashableFallback(raw, new Set(['防风草种子']))).toBe('鱼饵');
    expect(pickTrashableFallback(raw, new Set(['鱼饵', '防风草种子']))).toBeNull();
  });

  it('pickFurnitureToPlace：识别家具、跳过可食用与工具', () => {
    const raw = bag('1: 木桌', '2: 烤土豆 [可食用]', '3: 锄头');
    expect(pickFurnitureToPlace(raw)).toBe('木桌');
    expect(pickFurnitureToPlace(bag('1: 锄头'))).toBeNull();
  });

  it('pickChestSacrifice：石头类优先于垃圾类，木材/可食用/家具绝不动', () => {
    const stoneFirst = bag('1: 木材 x22', '2: 报纸', '3: 石头 x15', '4: 烤土豆 [可食用]', '5: 木桌');
    expect(pickChestSacrifice(stoneFirst)).toBe('石头');
    const trashOnly = bag('1: 木材 x22', '2: 报纸', '3: 锄头');
    expect(pickChestSacrifice(trashOnly)).toBe('报纸');
    expect(pickChestSacrifice(bag('1: 木材 x22', '2: 锄头'))).toBeNull();
  });

  it('pickRenewableReserved：可食用预留走 eat，贝壳类走 trash，木材石头不碰', () => {
    const edibleKeep = bag('1: 沙丁鱼 [可食用 +30 体力]【留着】', '2: 木材 x22');
    expect(pickRenewableReserved(edibleKeep)).toEqual({ item: '沙丁鱼', mode: 'eat' });
    const shellKeep = bag('1: 牡蛎【留着】', '2: 石头 x5');
    expect(pickRenewableReserved(shellKeep)).toEqual({ item: '牡蛎', mode: 'trash' });
    expect(pickRenewableReserved(bag('1: 木材 x22【留着】', '2: 石头 x5【留着】'))).toBeNull();
    expect(pickRenewableReserved(bag('1: 沙丁鱼 [可食用 +30 体力]'))).toBeNull();
  });

  it('countWood：x数量、无数量默认 1、无木材为 0', () => {
    expect(countWood(bag('1: 木材 x22'))).toBe(22);
    expect(countWood(bag('1: 木材'))).toBe(1);
    expect(countWood(bag('1: 石头 x5'))).toBe(0);
  });

  it('hasChestItem：识别「宝箱」，【留着】的箱子不占用判断', () => {
    expect(hasChestItem(bag('1: 宝箱'))).toBe(true);
    expect(hasChestItem(bag('1: 宝箱【留着】'))).toBe(false);
    expect(hasChestItem(bag('1: 锄头'))).toBe(false);
  });

  it('hasFishingRod：有竿 true、没竿 false、没有背包段 null（未知不阻断）', () => {
    expect(hasFishingRod(bag('1: 竹鱼竿'))).toBe(true);
    expect(hasFishingRod(bag('1: 锄头'))).toBe(false);
    expect(hasFishingRod('## 状态\n没有背包段')).toBeNull();
  });

  it('parseBackpackUpgrade / findBuyBackpackSpot：能解析、缺信息时返回 null', () => {
    expect(parseBackpackUpgrade('背包扩到 24 格：2000g')).toEqual({ capacity: 24, cost: 2000 });
    expect(parseBackpackUpgrade('没有扩容提示')).toBeNull();
    expect(findBuyBackpackSpot('[BuyBackpack] [interact]：(7,18)')).toEqual({ x: 7, y: 18 });
    expect(findBuyBackpackSpot('普通对话')).toBeNull();
  });

  it('findFreeTile：按左上角坐标找最近空地，缺头或缺地图返回 null', () => {
    const raw = [
      '左上角坐标=(10,20)',
      '## 文字地图',
      '20 T#.',
      '21 .P.',
    ].join('\n');
    expect(findFreeTile(raw, 11, 21)).toEqual({ x: 10, y: 21 });
    expect(findFreeTile('没有坐标头\n## 文字地图\n0 ..', 0, 0)).toBeNull();
    expect(findFreeTile('左上角坐标=(10,20)\n没有地图', 10, 20)).toBeNull();
  });
});
