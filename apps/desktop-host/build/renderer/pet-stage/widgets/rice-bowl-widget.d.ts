/**
 * 赛博饭碗挂件（T-M1-05）：右上角 🍚 + 余量进度条；
 * 低于 15%（persona-brain 饥饿线）切换"饿瘪"配色，与 hungry_lazy 状态对齐。
 */
export interface RiceBowlWidget {
    setRatio(ratio: number): void;
    ratio(): number;
}
export declare function mountRiceBowlWidget(stage: HTMLElement): RiceBowlWidget;
//# sourceMappingURL=rice-bowl-widget.d.ts.map