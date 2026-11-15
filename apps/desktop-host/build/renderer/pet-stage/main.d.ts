import { type Bounds } from './drag-throw';
interface PetStageBridge {
    ready: boolean;
    setPassthrough(state: 'passthrough' | 'interactive'): Promise<boolean>;
    getState(): Promise<'passthrough' | 'interactive'>;
    screenBounds(): Promise<Bounds>;
    mousePoint(): Promise<{
        x: number;
        y: number;
    }>;
    winPosition(): Promise<[number, number] | null>;
    dragTo(x: number, y: number): Promise<[number, number] | null>;
    appMeta(): Promise<{
        transparent: boolean;
        frame: boolean;
        alwaysOnTop: boolean;
        skipTaskbar: boolean;
        testMode: boolean;
    }>;
    forceAlpha?(alpha: number): Promise<boolean>;
    onTestAlpha?(handler: (alpha: number) => void): void;
}
declare global {
    interface Window {
        petStage: PetStageBridge;
    }
}
export {};
//# sourceMappingURL=main.d.ts.map