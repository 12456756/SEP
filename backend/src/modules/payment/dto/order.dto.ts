import { z } from "zod";

/**
 * 从购物车创建订单
 */
export const CreateOrderFromCartDtoSchema = z.object({
  itemIds: z.array(z.string()).optional(), // 可选，指定购物车项ID，不传则为全部
  // 未来可扩展：优惠券、备注等
});

export type CreateOrderFromCartDto = z.infer<
  typeof CreateOrderFromCartDtoSchema
>;

/** 从员工市场直接创建订阅订单，不经过购物车。 */
export const CreateDirectOrderDtoSchema = z.object({
  employeeId: z.string().min(1),
  periodMonths: z.number().int().min(1).max(36).default(12),
});

export const CreateBundleOrderDtoSchema = z.object({
  bundleId: z.string().trim().min(1),
});

export type CreateBundleOrderDto = z.infer<typeof CreateBundleOrderDtoSchema>;

export type CreateDirectOrderDto = z.infer<typeof CreateDirectOrderDtoSchema>;

/**
 * 订单列表查询参数
 */
export const GetOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  status: z.enum(["PENDING", "PAID", "CLOSED", "REFUNDED"]).optional(),
  orderType: z.enum(["EMPLOYEE", "BUNDLE"]).optional(),
});

export type GetOrdersQuery = z.infer<typeof GetOrdersQuerySchema>;

/**
 * 支付宝支付参数
 */
export const AlipayPaymentDtoSchema = z.object({
  orderId: z.string(),
});

export type AlipayPaymentDto = z.infer<typeof AlipayPaymentDtoSchema>;
