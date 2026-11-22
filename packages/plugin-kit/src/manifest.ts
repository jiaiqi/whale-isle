/**
 * 插件清单契约（dsh-plugin-yushe 三层结构思想重写，非源码复制）：
 * manifest.json 是插件对工作台的唯一声明面——扩展点声明 Shell 挂载位置，
 * permissions 声明 policy 资源前缀，dshCompatible 标记经 bridge 适配的外来插件。
 * 单一事实源铁律：清单字段只在此处用 Zod 定义，宿主/Shell/插件不得各写一套。
 */
import { z } from 'zod';

/**
 * Shell 侧扩展点白名单（ARCHITECTURE §3.2）：
 * 插件只能挂到这些位置，不允许私自开辟新挂载点（未知扩展点直接校验失败）。
 */
export const PLUGIN_EXTENSIONS = [
  'sidebar.item', // 侧栏条目
  'panel.route', // 主面板路由
  'aside.card', // 右栏卡片
  'pet.animation', // 桌宠动作片段
  'pet.line', // 桌宠台词/口头禅
  'overlay.widget', // OBS 透明图层挂件
  'tool', // 纯后台工具（LLM/UI 同源调用）
] as const;

export const PluginExtensionSchema = z.enum(PLUGIN_EXTENSIONS);
export type PluginExtension = z.infer<typeof PluginExtensionSchema>;

/** policy 三态（对齐 ARCHITECTURE §3.2 权限执行点：deny 硬拒 / ask 审批 / allow 放行） */
export const PolicyLevelSchema = z.enum(['allow', 'ask', 'deny']);
export type PolicyLevel = z.infer<typeof PolicyLevelSchema>;

/** 权限声明：resource 为 policy 资源前缀（如 'fs:plugins/'、'tool:stardew/'） */
export const PluginPermissionSchema = z.object({
  resource: z.string(),
  policy: PolicyLevelSchema,
});
export type PluginPermission = z.infer<typeof PluginPermissionSchema>;

export const PluginManifestSchema = z.object({
  /** 插件 id：kebab-case 且必须以小写字母开头（同时用作目录名与工具命名空间前缀） */
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, '插件 id 必须为 kebab-case（小写字母开头，仅含 a-z0-9-）'),
  name: z.string(),
  version: z.string(),
  description: z.string().default(''),
  /** lucide 图标名（Shell 侧按名字取图标，缺省拼图） */
  icon: z.string().default('puzzle'),
  /** 扩展点声明：插件向工作台注册什么 */
  extensions: z.array(PluginExtensionSchema).default([]),
  /** 权限声明（policy 资源前缀） */
  permissions: z.array(PluginPermissionSchema).default([]),
  /** dsh 兼容标记：经 dsh-bridge 适配的外来插件为 true */
  dshCompatible: z.boolean().default(false),
});

/** 校验后的清单（默认值已填充） */
export type PluginManifest = z.output<typeof PluginManifestSchema>;
/** 声明侧清单（默认值可省略，供插件作者书写） */
export type PluginManifestInput = z.input<typeof PluginManifestSchema>;

/** 校验外部不可信清单（manifest.json 读盘后一律先过这里，禁止裸 JSON 直入容器） */
export function parsePluginManifest(input: unknown): PluginManifest {
  return PluginManifestSchema.parse(input);
}

/** 是否声明了某个扩展点（Shell 按扩展点分发挂载，避免各页面重复 includes 判空） */
export function hasExtension(manifest: PluginManifest, extension: PluginExtension): boolean {
  return manifest.extensions.includes(extension);
}
