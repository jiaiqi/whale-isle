/** 网关层公共类型（宿主/路由共用） */
import type { ModelProviderConfig } from '@workbench/shared-protocol';

export interface ProviderKeyring {
  /** providerId → 真实 Key（仅内存持有） */
  keys: Record<string, string>;
}

export type ProviderCatalog = ModelProviderConfig[];
