export * from './mcp-client';
export * from './adapter';
export * from './action-lock';
export * from './control-lease';
export * from './planner';
export * from './rule-schedule';
export * from './seed-table';
export * from './metrics';
export * from './autodrive';
export * from './llm-planner';
export * from './state-hints';
export * from './team-blackboard';
export * from './huddle-orchestrator';
export * from './coop-runtime';
// M7：侧向导入触发两条泳道的适配器自注册（GameAdapterRegistry）
import './terraria-adapter';
import './dst-adapter';
