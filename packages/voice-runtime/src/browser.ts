/**
 * `@workbench/voice-runtime/browser` —— 渲染进程（浏览器环境）安全入口。
 *
 * 为什么需要它：director（中控台）只要「选哪家商业 TTS」这一个纯函数与几个常量，
 * 但包的桶入口 `index.ts` 会把 `audio-mixer`（node:crypto）、`local-engine`（node:fs/path）、
 * `performance`（node:crypto）一起拖进浏览器包，esbuild 直接构建失败。
 *
 * 本入口只导出**零 Node 依赖**的模块：口型包络（纯计算）与 VoiceProvider/Router（只用 fetch）。
 * 新增导出前先确认它不 import 任何 `node:*`，否则渲染进程会再次构建失败。
 */
export * from './lip-sync';
export * from './providers';
