/**
 * 人格与记忆层出口。
 * 宿主（desktop-host）与 live-stream-hub 经本包调用三层人格引擎。
 */
export * from './persona-engine';
export { createReflexInterceptor, type ReflexInterceptor } from './reflex';
