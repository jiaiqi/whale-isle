import type { DiningProfilePreset, ModelProviderConfig, WorkbenchRoleSlot } from '@workbench/shared-protocol';
import type { DirectorStore } from '@workbench/local-store/dexie';
interface AppProps {
    profiles: DiningProfilePreset[];
    slotLabels: Record<WorkbenchRoleSlot, string>;
    providers: ModelProviderConfig[];
    store: DirectorStore;
    storeKey: string;
}
export declare function App({ profiles, slotLabels, providers, store, storeKey }: AppProps): React.JSX.Element;
export {};
//# sourceMappingURL=App.d.ts.map