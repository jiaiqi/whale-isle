/**
 * Whale Isle V2 — 模型网关多模态消息契约（V2-P3-04 · REQ-LIFE-01 / REQ-SOC-01）
 * 将网关消息 content 从纯文本扩展为 text/image parts，供 Digital Life L1 内容理解管线
 * （页面截图 / 封面图 → 多模态模型）与后续多模态对话复用。
 * 安全边界：契约只约束形状与上限；图片一律按不可信数据处理（提示词注入不提权），
 * 凭据脱敏、路由与供应商格式映射在 model-gateway 实现（V2-P3-04B）。
 */
import { z } from 'zod';

/** 单张图片 base64 字符上限（≈4.5MB 二进制），防止超大截图打爆上下文与配额 */
export const CHAT_IMAGE_BASE64_MAX_CHARS = 6_000_000;
/** 单条消息 parts 上限 */
export const CHAT_MESSAGE_MAX_PARTS = 8;

export const ChatImageMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp']);
export type ChatImageMime = z.infer<typeof ChatImageMimeSchema>;

export const ChatImageSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('base64'),
    mime: ChatImageMimeSchema,
    dataBase64: z.string().min(1).max(CHAT_IMAGE_BASE64_MAX_CHARS),
  }),
  z.object({
    kind: z.literal('url'),
    url: z.string().url().max(2048),
  }),
]);
export type ChatImageSource = z.infer<typeof ChatImageSourceSchema>;

export const ChatContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(32_000) }),
  z.object({ type: z.literal('image'), source: ChatImageSourceSchema }),
]);
export type ChatContentPart = z.infer<typeof ChatContentPartSchema>;

/** 纯文本字符串（兼容存量调用）或有序 parts 列表 */
export const ChatMessageContentSchema = z.union([
  z.string().max(64_000),
  z.array(ChatContentPartSchema).min(1).max(CHAT_MESSAGE_MAX_PARTS),
]);
export type ChatMessageContent = z.infer<typeof ChatMessageContentSchema>;

export const GatewayChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: ChatMessageContentSchema,
});
export type GatewayChatMessage = z.infer<typeof GatewayChatMessageSchema>;
