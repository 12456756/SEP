import { z } from 'zod';

/** 通知中心支持的筛选分类。 */
export const NotificationCategorySchema = z.enum([
  'SYSTEM',
  'USAGE_ALERT',
  'SECURITY',
  'APPROVAL',
]);

export type NotificationCategory = z.infer<typeof NotificationCategorySchema>;

/**
 * 查询参数中的布尔值来自 URL，不能直接使用 z.coerce.boolean()：
 * z.coerce.boolean() 会把字符串 "false" 也转换成 true。
 */
const QueryBooleanSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === '') return false;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  },
  z.boolean(),
);

export const NotificationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  category: NotificationCategorySchema.optional(),
  unreadOnly: QueryBooleanSchema,
  keyword: z.string().trim().max(200).optional(),
});

export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>;

export const NotificationCategoryQuerySchema = z.object({
  category: NotificationCategorySchema.optional(),
});

export type NotificationCategoryQuery = z.infer<
  typeof NotificationCategoryQuerySchema
>;
