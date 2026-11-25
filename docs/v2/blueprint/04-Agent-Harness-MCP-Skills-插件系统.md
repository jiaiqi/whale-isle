# 04 --- Agent、Harness、MCP、Skills 与插件系统

## 1. 目标

鲸屿是开放 Agent 平台，不绑定单一模型或 Harness。

采用：**统一能力内核 + 标准协议 + Harness Adapter + Plugin Runtime +
Policy Engine。**

## 2. MCP 双向支持

### MCP Client

鲸屿连接外部 MCP Server，发现和调用
Tools、Resources、Prompts，以及协议版本支持的 Sampling/Elicitation
等能力。支持本地 STDIO 和 Streamable HTTP，并处理授权和远程连接。

### MCP Server

鲸屿可将受控能力提供给外部 Harness： - 查询角色状态； -
查询授权范围内的记忆； - 请求桌宠动作； - 查询游戏状态； -
请求舞台动作； - 查询素材； - 查询模型配置（不返回秘密）； -
查询任务状态。

MCP 入口必须经过授权、审计和权限过滤。连接 MCP
不代表自动获得完整本地权限。

规范：<https://modelcontextprotocol.io/>

## 3. Agent Skills

兼容 Agent Skills 开放规范。Skill 通常包含 `SKILL.md`，以及可选
references、scripts 和 assets。

``` text
skills/
├── stardew-cooperation/
│   ├── SKILL.md
│   └── references/
├── character-asset-generation/
│   ├── SKILL.md
│   └── references/
├── livestream-performance/
│   ├── SKILL.md
│   └── scripts/
└── social-content-research/
    ├── SKILL.md
    └── references/
```

Registry 能力： - 安装、卸载、更新、版本锁定； - 搜索和分类； -
依赖检查； - 权限声明； - 来源和 License 记录； - 安全扫描； -
启用范围（全局/角色/任务）； - 兼容性检查； - 用户自定义 Skill。

Skill 是操作说明，不是权限凭证。Skill
中写"访问账号"不代表它自动获得账号权限。

规范：<https://agentskills.io/>

## 4. Harness 适配

候选 Harness：Codex、Claude Code、OpenCode、Gemini
CLI、Pi、OpenHands，以及其他实现 ACP/MCP 或可控 CLI 接口的 Agent。

接入等级： 1. 协议级：MCP、ACP； 2. 配置级：导入/导出模型、MCP、Skill
配置； 3. 执行级：作为隔离 Worker 执行任务； 4.
深度集成：会话状态、工具权限、事件、成本和取消机制。

不能宣称某 Harness 已支持，除非有真实适配器和集成测试。

ACP：<https://agentclientprotocol.com/>

## 5. Provider Registry

Provider 不仅用于 LLM，还要区分： - LLM Provider； - Image Generation
Provider； - 3D Generation Provider； - TTS Provider； - Singing/SVC
Provider； - Embedding/Reranker Provider； - Browser Provider； -
Harness Provider； - Quota Provider。

每个 Provider 声明能力、认证方式、地域、成本、限制和测试状态。

## 6. Plugin Manifest

``` json
{
  "id": "example.plugin",
  "name": "Example Plugin",
  "version": "1.0.0",
  "apiVersion": "1",
  "entrypoint": "dist/index.js",
  "permissions": ["character.read", "asset.read"],
  "capabilities": ["tool", "event-handler"]
}
```

权限必须最小化。安装插件时展示权限、来源、版本和许可证。

## 7. 插件隔离

-   可信内置模块可使用进程内接口；
-   第三方插件优先独立 Worker/进程；
-   网络、文件、账号访问通过 Broker；
-   插件崩溃不能拖垮桌宠主进程；
-   每个插件有超时、资源限制、日志和健康状态；
-   插件升级可回滚。

## 8. 工具权限模型

工具按风险分级： - Read：读取公开/已授权数据； -
Prepare：生成草稿、计划或待执行动作； - Reversible Write：可撤销操作； -
External Write：对外发布、评论、发送； -
Sensitive：私信、删除、账号设置、支付等。

用户可授予有限自主规则，但不得绕过平台规则或账号权限。

## 9. Harness 与角色身份解耦

角色"小莓"可以由鲸屿内置 Agent Runtime 驱动，开发任务交给
Codex，代码审查交给 Claude，研究任务交给 OpenCode。外部 Harness
返回任务结果，不接管角色身份、人格和长期记忆。

## 10. 配置管理

-   API Key 进入系统凭证库；
-   Provider 配置可导入/导出，但默认剔除秘密；
-   模型别名、默认模型、回退模型和成本预算分开配置；
-   支持按任务类型路由模型；
-   额度查询是 Provider Adapter，不假设所有服务都提供官方额度接口；
-   无法可靠读取额度时显示"未知/不可查询"，不能编造余额。
