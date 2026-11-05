import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authAccessor } from "@/lib/auth-store";
import { qk } from "@/lib/query-keys";

// ── Types ──────────────────────────────────────────────────────────────────

export interface Order {
  id: string;
  orderNo: string;
  totalAmount: number;
  status: "PENDING" | "PAID" | "CANCELED" | "FAILED";
  items: OrderItem[];
  createdAt: string;
  paidAt: string | null;
  orderType?: "EMPLOYEE" | "BUNDLE";
  bundleName?: string | null;
  bundlePriceCNY?: number | null;
  bundlePeriodMonths?: number | null;
  bundleId?: string | null;
}

export interface OrderItem {
  id: string;
  employeeName: string;
  employeeAvatar: string | null;
  unitPrice: number;
  periodMonths: number;
  quantity: number;
  subtotal: number;
  includedComputeCNY?: number;
  employeeVersion?: string | null;
}

export interface CreateOrderResponse {
  id: string;
  orderNo: string;
  totalAmount: number;
  items: OrderItem[];
}

type BalancePaymentResponse = Omit<Order, "items">;

type OrderApiResponse = Omit<Order, "totalAmount" | "items"> & {
  totalAmount: string | number;
  items: (Omit<OrderItem, "unitPrice" | "subtotal" | "employeeAvatar" | "includedComputeCNY"> & {
    unitPrice: string | number;
    purchaseAmountCNY?: string | number | null;
    includedComputeCNY: string | number;
    employee: { avatar: string | null } | null;
  })[];
};

function parseAmount(value: string | number): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim() === "") ||
    !Number.isFinite(Number(value))
  ) {
    throw new Error("订单金额数据异常，请重新查询");
  }
  return Number(value);
}

function normalizeOrder(order: OrderApiResponse): Order {
  return {
    ...order,
    totalAmount: parseAmount(order.totalAmount),
    items: order.items.map((item) => {
      const unitPrice = parseAmount(item.unitPrice);
      return {
        ...item,
        unitPrice,
        includedComputeCNY: parseAmount(item.includedComputeCNY),
        employeeAvatar: item.employee?.avatar ?? null,
        // Bundle line amounts are allocated from the bundle price and stored on the order item.
        subtotal: item.purchaseAmountCNY == null
          ? unitPrice * (item.periodMonths / 12) * item.quantity
          : parseAmount(item.purchaseAmountCNY),
      };
    }),
  };
}

export interface CreateDirectOrderDto {
  employeeId: string;
  periodMonths?: number;
}

export interface CreateBundleOrderDto {
  bundleId: string;
}

export interface AlipayPaymentResponse {
  paymentForm: string;
  orderId: string;
  orderNo: string;
}

export interface RechargeAlipayPaymentResponse {
  paymentForm: string;
  orderId: string;
  orderNo: string;
}

// ── API ────────────────────────────────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "/api";

async function createOrder(body?: {
  itemIds?: string[];
}): Promise<CreateOrderResponse> {
  const token = authAccessor.getToken();
  const res = await fetch(`${API_BASE}/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "Failed to create order");
  }
  return normalizeOrder(await res.json());
}

async function createDirectOrder(
  body: CreateDirectOrderDto,
): Promise<CreateOrderResponse> {
  const token = authAccessor.getToken();
  const res = await fetch(`${API_BASE}/orders/direct`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "Failed to create direct order");
  }
  return normalizeOrder(await res.json());
}

async function createBundleOrder(body: CreateBundleOrderDto): Promise<CreateOrderResponse> {
  const token = authAccessor.getToken();
  const res = await fetch(`${API_BASE}/orders/bundles`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "Failed to create bundle order");
  }
  return normalizeOrder(await res.json());
}

async function createAlipayPayment(
  orderId: string,
): Promise<AlipayPaymentResponse> {
  const token = authAccessor.getToken();
  const res = await fetch(`${API_BASE}/payment/alipay/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ orderId }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "Failed to create payment");
  }
  return res.json();
}

async function createRechargeAlipayPayment(
  orderNo: string,
): Promise<RechargeAlipayPaymentResponse> {
  const token = authAccessor.getToken();
  const res = await fetch(`${API_BASE}/payment/alipay/recharge/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ orderNo }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "Failed to create recharge payment");
  }
  return res.json();
}

async function fetchOrder(orderId: string): Promise<Order> {
  const token = authAccessor.getToken();
  const res = await fetch(`${API_BASE}/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "Failed to fetch order");
  }
  return normalizeOrder(await res.json());
}

async function fetchOrders(): Promise<Order[]> {
  const token = authAccessor.getToken();
  const res = await fetch(`${API_BASE}/orders`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || "Failed to fetch orders");
  }
  const data: { orders: OrderApiResponse[] } = await res.json();
  return data.orders.map(normalizeOrder);
}

// ── Hooks ──────────────────────────────────────────────────────────────────

export function useCreateOrder() {
  return useMutation({
    mutationFn: createOrder,
  });
}

export function useCreateDirectOrder() {
  return useMutation({ mutationFn: createDirectOrder });
}

export function useCreateBundleOrder() {
  return useMutation({ mutationFn: createBundleOrder });
}

export function useCreateAlipayPayment() {
  return useMutation({
    mutationFn: createAlipayPayment,
  });
}

export function usePayOrderWithBalance() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (orderId: string): Promise<BalancePaymentResponse> => {
      const token = authAccessor.getToken();
      const res = await fetch(`${API_BASE}/payment/balance/pay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ orderId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to pay order with balance");
      }
      const payment = await res.json();
      return { ...payment, totalAmount: parseAmount(payment.totalAmount) };
    },
    onSuccess: (_, orderId) => {
      queryClient.invalidateQueries({ queryKey: ["order", orderId] });
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["cart"] });
      queryClient.invalidateQueries({ queryKey: qk.subscriptions });
      queryClient.invalidateQueries({ queryKey: qk.subscribedEmployees });
      queryClient.invalidateQueries({ queryKey: qk.myEmployees });
    },
  });
}

export function useCreateRechargeAlipayPayment() {
  return useMutation({
    mutationFn: createRechargeAlipayPayment,
  });
}

export function useOrder(orderId: string | null) {
  return useQuery({
    queryKey: ["order", orderId],
    queryFn: () => fetchOrder(orderId!),
    enabled: !!orderId,
    staleTime: 10_000,
  });
}

/**
 * 支付结果页专用：订单未支付时自动轮询。
 *
 * 与 useOrder 的区别是 staleTime 归零且带 refetchInterval——
 * 否则 10 秒缓存会让轮询拿到的一直是同一份旧数据。
 */
export function usePollingOrder(orderId: string | null) {
  return useQuery({
    queryKey: ["order", orderId],
    queryFn: () => fetchOrder(orderId!),
    enabled: !!orderId,
    staleTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "PENDING" ? 2000 : false;
    },
  });
}

/**
 * 主动向支付宝核对订阅订单状态（兜底）。
 *
 * 异步通知可能丢失，导致用户已付款但订阅始终不生效。
 * 结果页在 PENDING 时定期调用它，把这种情况救回来。
 */
export function useReconcileOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (orderId: string) => {
      const token = authAccessor.getToken();
      const res = await fetch(`${API_BASE}/payment/alipay/reconcile`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ orderId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to reconcile order");
      }
      return res.json() as Promise<{ status: string; reconciled: boolean }>;
    },
    onSuccess: (result, orderId) => {
      if (result.reconciled) {
        queryClient.invalidateQueries({ queryKey: ["order", orderId] });
        queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
      }
    },
  });
}

export function useOrders() {
  return useQuery({
    queryKey: ["orders"],
    queryFn: fetchOrders,
    staleTime: 30_000,
  });
}
