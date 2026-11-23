# 外部插件（T-M6-31）

Whale Isle 通过 `@workbench/plugin-kit` 装载用户本机的 dsh 形态插件；中控台「插件与权限」页可发现、启停、调用工具与查看错误。

## 目录约定

```
<userData>/plugins/<id>/
├── manifest.json   # 必须过 PluginManifestSchema（id 必须与目录名一致）
└── index.mjs       # ESM：export default { name, apply(ctx) }
```

- 可复制 `docs/examples/plugins/hello-whale/` 到上述目录直接试用。
- 默认**不启用**；在插件页打开开关后才会装载（设置持久化在 `userData/plugin-settings.json`）。
- 清单非法、id 与目录名不符、符号链接越界、缺少 `index.mjs` 都会被拒绝并在页面显示错误。

## ctx 能力面

| API | 作用 |
| --- | --- |
| `ctx.tool(name, handler)` | 注册工具；handler 参数与返回值均为普通对象 |
| `ctx.on(event, handler)` | 订阅总线事件（`autodrive:event` 等，支持 `domain:*` 通配） |
| `ctx.effect(fn)` | 立即执行 fn；其返回的清理函数在插件停用时调用 |
| `ctx.emit(event, payload)` | 向总线广播事件（插件之间只经总线通信） |

## 安全边界（如实说明）

- 插件是用户本机放置的**可信代码**：`index.mjs` 在 Electron 主进程 import，拥有主进程权限。Policy **不是 JS 沙箱**，不能约束插件代码本身。
- **装载期硬拒**：声明 `vault://*`（密钥单咽喉）或 `shell://*`（命令审批 UI 未接线）权限的插件不予装载。
- **工具调用期策略**：`allow` 直接执行；`ask`（dsh 兼容插件默认）需先用 `pluginApprove` 在本次会话授权；`deny` 永拒；`vault://*` 工具名硬拒。
- **崩溃隔离**：`apply` 抛错会回滚半成品工具/订阅，其它插件与宿主不受影响；工具异常统一返回 `{ok:false,error}`。
- 插件总线事件会推送到中控台（`plugin:event`），便于观察，不允许反向改写宿主状态。
