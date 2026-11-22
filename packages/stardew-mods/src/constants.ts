/**
 * T-M6-06 SMAPI 目录约定常量（单一事实源）。
 *
 * 设计来源（SMAPI 官方目录语义）：SMAPI 扫描 Mods 目录时，只把「一层子目录下存在
 * manifest.json」的文件夹当作 Mod 装载；社区与官方文档通用的禁用手段就是把
 * manifest.json 改名为 manifest.json.disabled（SMAPI 找不到 manifest 即跳过）。
 * 因此本包所有子模块共享同一组文件名常量，避免字符串散落导致行为漂移。
 */

/** SMAPI 约定的 manifest 文件名（启用态） */
export const MOD_MANIFEST_FILE = 'manifest.json';
/** 禁用态：manifest 改名追加 .disabled 后缀 */
export const DISABLED_MANIFEST_FILE = `${MOD_MANIFEST_FILE}.disabled`;
/** 两个形态同时存在 = 用户手工改名留下的半状态，SMAPI 装载 enabled 那个但语义可疑 */
export const MANIFEST_CONFLICT_ERROR = 'manifest.json 与 manifest.json.disabled 同时存在，请手动处理';
/** SMAPI 本体 manifest 的 UniqueID（用于从 Mod 列表回填 SMAPI 版本号） */
export const SMAPI_UNIQUE_ID = 'Pathoschild.SMAPI';
