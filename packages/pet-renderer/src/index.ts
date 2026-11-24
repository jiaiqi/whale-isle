/**
 * 渲染抽象层出口。
 * 渲染进程请只 import 本包接口；真实 DOM 视频工厂在 apps/desktop-host（T-M1-02）。
 */
export * from './types';
export * from './squash';
export { WebmVideoRenderer, computeFootlineLayout, pickAmbient, type WebmRendererOptions } from './webm-renderer';
export { SpritesheetRenderer, spriteFrameIndex, spriteFrameRect, type SpriteAudioController, type SpriteMetaLoader, type SpriteSurfaceFactory, type SpritesheetRendererOptions } from './spritesheet-renderer';
export { PoseSkinRenderer, type PoseImageFactory, type PoseImageHandle, type PoseSkinRendererOptions } from './pose-skin';
export { poseEffectOffsets, poseEffectSvg, type PoseEffectKind } from './pose-effects';
