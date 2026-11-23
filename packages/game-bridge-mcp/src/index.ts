export * from './mcp-client';
export * from './adapter';
export * from './action-lock';
export * from './planner';
export * from './metrics';
export * from './autodrive';
export * from './llm-planner';
export * from './team-blackboard';
export * from './huddle-orchestrator';
// M7：侧向导入触发两条泳道的适配器自注册（GameAdapterRegistry）
import './terraria-adapter';
import './dst-adapter';
