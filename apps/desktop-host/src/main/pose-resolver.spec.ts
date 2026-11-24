/** 姿态回退与工作事件映射（T-M6-53）。 */
import { describe, expect, it } from 'vitest';
import { poseForWorkEvent, resolvePose } from './pose-resolver';

const AVAILABLE = ['idle', 'writing', 'listening', 'proud', 'pout', 'sorry', 'pat'];

describe('resolvePose', () => {
  it('已有姿态直接命中', () => {
    expect(resolvePose('writing', AVAILABLE)).toMatchObject({ pose: 'writing', fallback: false });
  });

  it('compact → writing、asking → listening、corrected → sorry', () => {
    expect(resolvePose('compact', AVAILABLE)).toMatchObject({ pose: 'writing', fallback: true });
    expect(resolvePose('asking', AVAILABLE)).toMatchObject({ pose: 'listening', fallback: true });
    expect(resolvePose('corrected', AVAILABLE)).toMatchObject({ pose: 'sorry', fallback: true });
  });

  it('未知姿态回退 idle；无 idle 时回退首个可用；空集如实标记', () => {
    expect(resolvePose('fest_midautumn', AVAILABLE)).toMatchObject({ pose: 'idle', fallback: true });
    expect(resolvePose('fest_midautumn', ['writing', 'pout'])).toMatchObject({ pose: 'writing', fallback: true });
    expect(resolvePose('idle', [])).toMatchObject({ fallback: true, reason: '角色没有任何姿态素材' });
  });

  it('映射目标缺失时继续回退 idle（不返回不存在的姿态）', () => {
    expect(resolvePose('compact', ['idle', 'proud'])).toMatchObject({ pose: 'idle', fallback: true });
  });

  it('busy/swamped 命中 CrossPet 左右变体，不误回退 idle', () => {
    expect(resolvePose('busy', ['idle', 'busy_left', 'busy_right'])).toMatchObject({ pose: 'busy_left', fallback: true });
    expect(resolvePose('swamped', ['idle', 'swamped_right'])).toMatchObject({ pose: 'swamped_right', fallback: true });
    expect(resolvePose('busy', ['idle'])).toMatchObject({ pose: 'idle', fallback: true });
  });
});

describe('poseForWorkEvent', () => {
  it('start→listening、stop→bye；工具名关键字映射 compact/asking/delegating/writing', () => {
    expect(poseForWorkEvent({ kind: 'start' })).toBe('listening');
    expect(poseForWorkEvent({ kind: 'stop' })).toBe('bye');
    expect(poseForWorkEvent({ kind: 'tool', toolName: 'CompactContext' })).toBe('compact');
    expect(poseForWorkEvent({ kind: 'tool', toolName: 'AskUserQuestion' })).toBe('asking');
    expect(poseForWorkEvent({ kind: 'tool', toolName: 'Task: delegate' })).toBe('delegating');
    expect(poseForWorkEvent({ kind: 'tool', toolName: 'Read' })).toBe('writing');
  });

  it('结构化 asking/compact/error 优先于工具名推断', () => {
    expect(poseForWorkEvent({ kind: 'asking' })).toBe('asking');
    expect(poseForWorkEvent({ kind: 'compact' })).toBe('compact');
    expect(poseForWorkEvent({ kind: 'error' })).toBe('oops');
    expect(poseForWorkEvent({ kind: 'asking', toolName: 'Read' })).toBe('asking');
  });
});
