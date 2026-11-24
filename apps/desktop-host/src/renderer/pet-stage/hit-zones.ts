/**
 * 剪影部位分区点击（T-M6-64，纯函数）。
 *
 * 按角色可见高度比例分区（0=头顶，1=脚底）：
 *   - 0–0.35  head  → 摸头
 *   - 0.35–0.55 face → 戳脸
 *   - 0.55–1   body → 挠痒/戳肚子
 * 指针落在包围盒外时夹到最近档（点头顶上方仍算摸头），绝不返回越界区。
 */
export type HitZone = 'head' | 'face' | 'body';

export const HIT_ZONE_HEAD_END = 0.35;
export const HIT_ZONE_FACE_END = 0.55;

export function resolveHitZone(localY: number, bboxTop: number, bboxBottom: number): HitZone {
  const height = bboxBottom - bboxTop;
  if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(localY)) return 'body';
  const ratio = Math.max(0, Math.min(1, (localY - bboxTop) / height));
  if (ratio < HIT_ZONE_HEAD_END) return 'head';
  if (ratio < HIT_ZONE_FACE_END) return 'face';
  return 'body';
}
