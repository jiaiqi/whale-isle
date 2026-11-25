# 08 --- Digital Life、Browser/Computer Use、社交与记忆

## 1. Digital Life 定义

Digital Life Runtime
管理角色在鲸屿内外的持续活动：自主日程、内容探索、学习、兴趣形成、社交关系、创作计划、游戏经历和记忆整理。

它不是无边界的自动化循环。每个活动必须有目标、预算、权限、停止条件和审计记录。

## 2. Browser Use 与 Computer Use

### Browser Runtime

负责网页和浏览器上下文：搜索、导航、阅读、提取内容、截图、表单、上传和用户授权下的站点操作。

### Computer Runtime

负责桌面级操作：屏幕理解、鼠标键盘、应用切换、文件管理、桌面软件和 UI
Automation。

优先使用确定性 API/DOM/Accessibility。只有在缺乏结构化接口时才使用视觉
Computer Use。

候选：Playwright、Browser Use、Stagehand、Browser MCP、操作系统 UI
Automation。

不要同时让多个 Agent 争抢同一台电脑。使用
`ComputerUseLease`，同一设备只有一个前台控制者；用户输入优先级最高。

## 3. Browser Profile 与账号隔离

每个角色/账号使用独立 Browser Profile： - Cookie 隔离； - Local Storage
隔离； - 登录状态隔离； - 账号归属明确； - 凭证加密； - 撤销和过期管理。

不得将多个角色的账号 Cookie 混在一个浏览器配置中。

## 4. 社交平台适配

平台能力必须动态声明，不能假设每个平台都支持完整读写 API。

能力矩阵包括：搜索内容、读取公开内容、读取授权内容、字幕/弹幕、评论读取、点赞/收藏、关注、评论/回复、发布图文、发布视频、直播事件。

每个能力记录： - `official_api` / `browser_ui` /
`third_party_adapter`； - 许可和授权； - 账号类型； - 速率限制； -
地域； - 最近验证日期； - 风险级别。

### 平台边界

-   抖音、Bilibili、小红书的开放能力和审核政策不同；
-   国际版 TikTok 与国内抖音不是同一开放平台；
-   直播接口可能有申请限制；
-   小红书某些写入权限可能受限；
-   浏览器自动化不能绕过验证码、访问控制或平台反自动化机制。

实施时必须逐项检查官方开放平台文档，不以第三方项目能做为平台允许的证据。

## 5. Social Decision Engine

``` mermaid
flowchart TD
  SCHEDULE[Life Scheduler] --> DISCOVERY[Content Discovery]
  DISCOVERY --> UNDERSTAND[Content Understanding]
  UNDERSTAND --> INTEREST[Interest / Knowledge Update]
  INTEREST --> RELATION[Relationship Context]
  RELATION --> DECIDE[Social Decision]
  DECIDE --> POLICY[Policy / Permission Gate]
  POLICY --> ACTION[Approved Platform Action]
  ACTION --> EVENT[Record Event & Memory]
```

AI
不应该机械点赞或随机评论。应根据角色兴趣、内容理解、关系上下文和用户授权决定是否参与。

对外发布、评论、私信等写入行为应有明确授权和平台规则约束。默认先生成草稿，逐步开放有限自主操作。

## 6. 内容理解

视频/图文理解可组合官方字幕或用户授权媒体、音频转写、OCR、关键帧、多模态视觉理解、评论和讨论、来源与时间。

候选工具：FFmpeg、faster-whisper、PaddleOCR、OpenCV、PySceneDetect、多模态模型。

不能将绕过平台下载限制作为内容理解的前提。

## 7. 五类记忆

1.  Working Memory：当前任务、对话和上下文。
2.  Episodic Memory：发生过的事件。
3.  Semantic Memory：从事件中总结的知识。
4.  Relational Memory：人物关系和互动历史。
5.  Self Memory：角色形成的偏好、目标和自我叙事。

记忆保留来源、时间、置信度、重要性、最后回忆时间、用户固定状态和保留策略。

## 8. 遗忘机制

区分原始事件日志、主动回忆索引、摘要记忆、用户固定记忆和已过期/被删除记忆。

用户要求删除时，按数据保留策略处理原始来源和衍生索引。遗忘不应成为掩盖审计或逃避用户删除请求的手段。

AI 对不确定记忆应表达不确定，不能编造"我记得"。

## 9. 关系记忆

可记录首次认识时间、互动事件、共同兴趣、重要话题、关系置信度、最近互动和用户设置的屏蔽/边界。

不要根据少量互动推断敏感个人属性。对观众和社区用户只保存必要信息。

## 10. 自主生活调度

角色有日程、活动预算、休息窗口、内容主题、停止条件、用户勿扰时间、每日成本预算和网络/设备限制。

自主活动不能无限循环，也不能为了"像真人"而制造虚假活动或虚假社交。

## 11. 验收

-   每次平台操作可追溯到账号、权限和用户策略；
-   读写能力按平台单独配置；
-   账号和 Cookie 隔离；
-   记忆有来源和置信度；
-   用户可查看、纠正和删除记忆；
-   角色能够自然表达不确定；
-   自主任务可暂停、取消和限额；
-   平台限制变化能通过 Adapter Capability 状态体现。

## V2.1 增补：游戏知识记忆

游戏攻略知识与个人游戏经历应进入可检索的长期知识体系，但要与用户个人记忆、角色关系记忆区分。每个攻略条目记录来源、游戏版本、Mod 条件、适用范围、置信度、验证状态和反例。游戏经历记录 Agent 做过什么、观察到什么结果、哪些策略成功或失败。

检索到的攻略不应直接变成强制行为规则；Agent 必须结合当前游戏状态和目标判断适用性。详细方案见 `17-自主游戏智能与人机共玩系统.md`。
