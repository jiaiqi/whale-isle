# 13 --- 现有 Whale Isle 仓库审计与迁移建议

## 1. 审计范围说明

本次会话曾对仓库 README、AGENTS、架构/产品/路线图/验证文档、部分 Harness
文件和 Stardew Mod
文件进行定点检查。这不是全仓逐文件审计，也不是完整构建和真实游戏运行测试。所有"已有能力"在正式迁移前必须由
Coding Agent 重新读取当前分支并执行测试确认。

仓库：<https://github.com/jiaiqi/whale-isle>

## 2. 已知工程基础

此前检查记录提到： - Electron + React Desktop Host； - pnpm Monorepo； -
shared protocol / Zod； - model gateway； - provider vault； - pet
renderer； - persona/memory 相关模块； - game bridge MCP； - plugin
kit； - agent harness / ACP client； - mock harness； - Stardew Avatar
Sync Mod； - Creative Studio 的部分素材生成/处理流程； -
AGENTS、VERIFY、ROADMAP、ARCHITECTURE 等项目文档。

这些模块是否仍与当前主分支一致，需要重新验证。

## 3. 建议保留

Electron + React 桌面宿主、pnpm Monorepo、类型化共享协议、Provider/Vault
基础能力、桌宠渲染基础、可复用的记忆和人格逻辑、游戏桥接和 MCP
基础、Plugin Kit、ACP Harness 基础、Mock Harness、Stardew Avatar Sync
可用实现、现有测试门禁和验证规范。

## 4. 建议重构

过度集中的 Host/Autodrive 编排；Persona、Memory、Emotion
的职责边界；Game Bridge 与 Game Runtime；Harness Provider
注册和会话生命周期；Creative Studio
从单一视频抠像流程扩展到多类型资产流水线；Provider
和模型配置；插件权限与执行隔离；文档中的领域命名和状态机。

## 5. 建议新增

Character Core、Embodiment API、Voice Identity、Singing Runtime、Media
Generation Gateway、Asset Registry、Game Embodiment Pipeline、Social
Life Runtime、Account Vault/Browser Profile Manager、Computer Use
Lease、Device Registry、Digital Life Scheduler、Policy Engine、Evolution
Engine、Replay/Evaluation System。

## 6. 可能需要重写

只有在确认以下情况后才重写： - 模块没有真实可用实现； -
代码与目标协议严重冲突； - 没有测试且无法补足； - 与核心领域强耦合； -
安全设计无法修补； - 依赖已经停止维护且无替代路径。

不能仅为目录美观重写已验证可用代码。

## 7. 已知问题线索

此前检查时发现路线图中可能存在文件开头声明一个 NEXT
工单，而后面旧列表仍把另一个工单标为 NEXT。对人类是文档不一致，对全自动
Agent 会造成错误执行。因此 V2-00 必须先建立唯一工单状态来源。

还需要检查： - Host 是否承担过多职责； - Stub 是否被文档误写为已完成； -
Mock 测试是否被误当成真实游戏/平台测试； - ACP 适配器是否真实支持各个
Harness； - 直播、点歌、语音是否有端到端闭环； - Asset License
是否覆盖实际素材； - Game Mod 是否经过当前游戏版本验证。

## 8. 迁移策略：Strangler Pattern

``` mermaid
flowchart TD
  V1[Existing Whale Isle] --> ADAPTER[Compatibility Adapters]
  ADAPTER --> V2[New V2 Domain Core]
  V2 --> NEW[New Features Use V2 APIs]
  V1 --> TEST[Regression Tests]
  NEW --> TEST
  TEST --> CUTOVER[Gradual Module Cutover]
  CUTOVER --> REMOVE[Remove Legacy Path After Evidence]
```

每个旧模块分成
Keep、Refactor、Replace、Retire。迁移必须有现状证据、新接口、数据迁移、回归测试、回滚方案和删除旧代码的条件。

## 9. V2-00 必须产出

1.  全仓目录和依赖图；
2.  关键模块调用链；
3.  实际测试清单；
4.  Stub/Mock/真实实现清单；
5.  第三方许可证清单；
6.  运行时架构图；
7.  唯一 Roadmap/Issue Source of Truth；
8.  Keep/Refactor/Rewrite/Retire 表；
9.  首批迁移工单；
10. 基线构建和测试报告。

## 10. 不应做的事

不要直接创建几十个空 Package；不要一次性重写所有
Host；不要删除现有测试；不要把 README
写了支持当作已实现；不要让新旧两套系统长期无边界并存；不要在没有数据迁移和回滚方案时改数据库结构。
