/**
 * @workbench/stardew-mods —— T-M6-06 星露谷 SMAPI Mod 管理核心纯逻辑（零外部依赖）：
 * manifest 宽容解析 + Mods 目录扫描 + 启停改名 + 从解压目录安装 + 平台默认路径猜测。
 *
 * 设计来源：SMAPI 的「一个 Mod 一个目录 + manifest.json 开关」目录约定；
 * 本包只依赖 node:fs / node:path 与 shared-protocol 的 Zod 契约类型，
 * 不直接接触 Electron / SQLite / 网络，宿主负责把结果落盘与广播。
 */
export * from './constants';
export * from './fs-util';
export * from './manifest';
export * from './paths';
export * from './scan';
export * from './toggle';
export * from './install';
