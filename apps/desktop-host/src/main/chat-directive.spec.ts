/**
 * 对话→游戏指令解析单测（T-M6-17）：关键词直译 / 疑问防误触发 / LLM 输出三态（接单/闲聊/越权拒收）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildDirectiveSystemPrompt,
  buildDirectiveUserPrompt,
  parseDirectiveResponse,
  resolveKeywordDirective,
  STARDEW_DIRECTIVE_PROFILE,
  type DirectiveProfile,
} from './chat-directive';

describe('resolveKeywordDirective（确定性直译）', () => {
  it('高频指令全命中且带正确参数', () => {
    const beach = resolveKeywordDirective('先去海滩钓鱼吧');
    expect(beach).toMatchObject({ tool: 'travel_to', args: { location: 'Beach' } });
    expect(beach?.intent).toContain('主人指令');
    expect(resolveKeywordDirective('钓鱼')).toMatchObject({ tool: 'fish' });
    expect(resolveKeywordDirective('先回家')).toMatchObject({ tool: 'travel_to', args: { location: 'FarmHouse' } });
    expect(resolveKeywordDirective('去社区中心看看')).toMatchObject({ tool: 'travel_to', args: { location: 'CommunityCenter' } });
    expect(resolveKeywordDirective('整理一下背包')).toMatchObject({ tool: 'tidy_backpack' });
    expect(resolveKeywordDirective('去矿洞'))?.toMatchObject({ tool: 'travel_to', args: { location: 'Mine' } });
    expect(resolveKeywordDirective('睡觉吧')).toMatchObject({ tool: 'sleep' });
    expect(resolveKeywordDirective('浇水')).toMatchObject({ tool: 'water_crops' });
    expect(resolveKeywordDirective('读一下信')).toMatchObject({ tool: 'read_mail' });
    expect(resolveKeywordDirective('看看任务板')).toMatchObject({ tool: 'quest_board' });
  });

  it('疑问/回忆绝不接单（「昨天在海滩钓鱼了吗」不能跑去钓鱼）', () => {
    expect(resolveKeywordDirective('你昨天在海滩钓鱼了吗？')).toBeNull();
    expect(resolveKeywordDirective('上次去农场是什么时候')).toBeNull();
    expect(resolveKeywordDirective('有没有钓到鱼呢？')).toBeNull();
    expect(resolveKeywordDirective('为什么不去矿洞')).toBeNull();
    expect(resolveKeywordDirective('今天钓了多少条')).toBeNull();
  });

  it('闲聊不命中 → null（交给 LLM 层复核）', () => {
    expect(resolveKeywordDirective('你真可爱')).toBeNull();
    expect(resolveKeywordDirective('今天天气不错')).toBeNull();
  });
});

describe('parseDirectiveResponse（LLM 输出三态）', () => {
  it('合法动作 → 接单（source=llm）', () => {
    const d = parseDirectiveResponse('{"tool":"give_gift","args":{"npc":"罗宾","item":"丢失的斧子"},"intent":"把斧子还给罗宾"}');
    expect(d).toMatchObject({ tool: 'give_gift', args: { npc: '罗宾', item: '丢失的斧子' }, source: 'llm' });
  });

  it('闲聊（空 tool）/ 越权工具 / 坏输出 → 一律 null', () => {
    expect(parseDirectiveResponse('{"tool":"","args":{},"intent":""}')).toBeNull();
    expect(parseDirectiveResponse('{"tool":"exec_shell","args":{"cmd":"rm"},"intent":"x"}')).toBeNull();
    expect(parseDirectiveResponse('哎呀我只是一条咸鱼不输出 JSON')).toBeNull();
  });

  it('user 提示带游戏状态节选（有状态才能填对参数）', () => {
    const prompt = buildDirectiveUserPrompt('把斧子还给罗宾', { raw: '## 背包\n0: 丢失的斧子\n## 人物\n罗宾' });
    expect(prompt).toContain('把斧子还给罗宾');
    expect(prompt).toContain('## 背包');
  });
});

describe('DirectiveProfile（M7 多游戏指令档案）', () => {
  const fakeProfile: DirectiveProfile = {
    gameName: '泰拉瑞亚',
    keywords: [
      { directive: { tool: 'mine', args: { target: 'copper' }, intent: '挖矿', source: 'keyword' }, re: /挖矿|挖铜/ },
    ],
    toolDoc: '挖掘：mine {"target":"copper|stone"}',
    whitelist: new Set(['mine', 'get_state']),
  };

  it('默认档案保持星露谷行为；新档案使用自己的关键词表与游戏名', () => {
    expect(STARDEW_DIRECTIVE_PROFILE.gameName).toBe('星露谷物语');
    expect(resolveKeywordDirective('去海滩')).toMatchObject({ tool: 'travel_to' });
    expect(resolveKeywordDirective('挖铜矿', fakeProfile)).toMatchObject({ tool: 'mine', args: { target: 'copper' } });
    expect(resolveKeywordDirective('去海滩', fakeProfile)).toBeNull();
  });

  it('system prompt 注入档案的游戏名与工具文档；越权工具按档案白名单拒收', () => {
    expect(buildDirectiveSystemPrompt(fakeProfile)).toContain('《泰拉瑞亚》');
    expect(buildDirectiveSystemPrompt(fakeProfile)).toContain('mine {"target":"copper|stone"}');
    expect(buildDirectiveSystemPrompt()).toContain('《星露谷物语》');
    expect(parseDirectiveResponse('{"tool":"mine","args":{"target":"copper"},"intent":"挖"}', fakeProfile)?.tool).toBe('mine');
    expect(parseDirectiveResponse('{"tool":"fish","args":{},"intent":"钓鱼"}', fakeProfile)).toBeNull();
  });
});
