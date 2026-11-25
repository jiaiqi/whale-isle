# 10 --- Whale Isle Evolution Engine：自主研发与持续进化系统

## 1. 定位

Evolution Engine 是独立于 Whale Isle Runtime
的研发控制系统，负责发现问题、归纳用户反馈、分析日志和回放、创建开发任务、规划改动、调用
Coding Agent、管理 Git Worktree、运行测试、独立审查、创建
PR、构建发布候选、分阶段部署和回滚。

它不等于某个 Coding Harness，也不应绑定 DeepSeek、ZCode、Codex 或
Claude。

## 2. 为什么独立部署

生产程序可能正在直播或游戏。直接让运行中的角色修改自身代码，会造成进程不稳定、数据库破坏、生产代码与工作状态不一致、权限系统被改坏和无法回滚。

因此： - Runtime 只产生经过脱敏的诊断事件； - Evolution Engine
在独立工作区开发； - 通过 PR/Release Candidate 交付； -
生产部署按发布策略执行。

建议独立仓库 `whale-isle-dev`，或至少独立部署单元。

## 3. 架构

``` mermaid
flowchart TD
  RUNTIME[Whale Isle Runtime] --> TELEMETRY[Telemetry / Bug Reports]
  TELEMETRY --> TRIAGE[Issue Triage Agent]
  TRIAGE --> PLAN[Planner / Architect]
  PLAN --> WORKTREE[Git Worktree Manager]
  WORKTREE --> CODER[Coding Agent Adapter]
  CODER --> TEST[Test Runner]
  TEST --> REVIEW[Independent Review Agent]
  REVIEW --> GATE[Policy / Quality Gate]
  GATE --> PR[Pull Request]
  PR --> APPROVAL[Approval Policy]
  APPROVAL --> RELEASE[Release Candidate]
  RELEASE --> DEPLOY[Staged Deployment]
  DEPLOY --> MONITOR[Post-release Monitoring]
  MONITOR --> RUNTIME
```

## 4. 关键组件

Issue Detector、Feedback Collector、Replay/Trace Collector、Product
Analyst、Architect Agent、Task Planner、Coding Agent Adapters、Worktree
Manager、Test Runner、Simulation Runner、Security Scanner、License
Scanner、Independent Reviewer、PR Manager、Release Manager、Rollback
Manager。

## 5. 运行时问题反馈

用户可以在游戏或直播中标记"这里有问题"。

系统收集： - 用户描述； - 软件版本； - 模块版本； - 时间窗口； -
脱敏日志； - 操作回执； - 相关事件 ID； - 可选截图/录屏（明确授权）； -
游戏状态快照； - 复现步骤。

不要默认把观众个人信息、私信、Cookie、API Key 或完整聊天记录传给研发
Agent。

## 6. 复现与回放

为关键系统建立 Replay：游戏动作、直播事件、语音队列、插件调用、Provider
请求元数据、错误和状态变化。

回放尽可能使用脱敏事件和 Mock
Provider，不重放真实支付、账号写入、发布、私信等外部副作用。

## 7. 自动开发流程

1.  识别问题；
2.  去重；
3.  评估影响；
4.  生成 Issue；
5.  查找相关代码和测试；
6.  制定实现计划；
7.  创建独立 Worktree/分支；
8.  调用 Coding Agent；
9.  运行格式、类型、单测、集成测试；
10. 运行回放和回归；
11. 安全与许可证扫描；
12. 独立 Review Agent 审查；
13. 生成 PR；
14. 根据策略审批；
15. 构建 Release Candidate；
16. 小范围部署；
17. 观察指标；
18. 成功后扩大部署；
19. 异常则回滚。

## 8. 自主等级

-   L1：发现异常、报告；
-   L2：定位、提出方案、生成测试；
-   L3：修改代码、运行测试、创建 PR；
-   L4：自动合并低风险改动；
-   L5：正式发布和高权限系统变更。

建议默认 L1-L3 自动；L4 仅对低风险、明确规则、完整测试的变更；L5
需要明确发布授权或人工审批。

## 9. 直播期间持续开发

可以在直播期间分析问题、写代码、跑测试和创建 PR。

不建议在直播期间直接热替换核心代码。可允许受 Schema
校验、可回滚的安全配置热更新；代码级更新安排维护窗口或直播结束后发布。

紧急故障优先停止故障插件、回退配置、切换备用 Provider
或回滚上一稳定版本。

## 10. 评估系统

每个功能定义任务成功率、失败率、延迟、成本、资源使用、用户反馈和安全错误率。

示例： - 游戏：任务成功率、错误动作、资源冲突； -
语音：首包延迟、打断成功率、播放失败； -
直播：事件漏失、重复、回应延迟； - 记忆：回忆准确率、错误记忆率； -
桌宠：掉帧、崩溃、动画切换延迟； -
资产：导出成功率、兼容率、授权门禁错误。

## 11. 不允许的行为

-   不得直接在生产工作目录改代码；
-   不得跳过测试伪造通过；
-   不得自动修改安全策略并自行批准；
-   不得把用户秘密写入日志或 Prompt；
-   不得删除审计记录；
-   不得自行扩大账号和工具权限；
-   不得把"模型认为完成"作为验收；
-   不得无审批发布高风险变更。

## 12. 验收

Evolution Engine 能够在隔离环境中从 Bug Report 创建任务、创建
Worktree、调用至少一个 Coding Agent、运行测试、生成差异和报告、创建
PR；失败时停止且不触碰生产运行目录和生产秘密。
