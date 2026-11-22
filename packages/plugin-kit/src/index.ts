/**
 * @workbench/plugin-kit —— T-M6-03 dsh 插件兼容层（零外部依赖，仅 zod 参数契约）：
 * manifest 契约 + defineTool/registry + 零依赖插件容器（Cordis 语义）+ dsh 适配器。
 * 单一事实源：本包是插件系统唯一 API 面，Shell/main 层不得绕过它直接操作插件。
 */
export * from './disposable';
export * from './manifest';
export * from './define-tool';
export * from './event-bus';
export * from './plugin-host';
export * from './dsh-bridge';
