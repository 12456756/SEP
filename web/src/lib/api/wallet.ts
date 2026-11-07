import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api-client';

// ── Types ──────────────────────────────────────────────────────────────────

export interface WalletBalance {
  balance: string; // Prisma Decimal 序列化为字符串
  frozenAmount: string;
  /** 余额里已划入「算力专款」的部分：订阅等非算力支出不可挪用 */
  computeReservedCNY: string;
  /** 余额里可用于订阅等其他支出的部分 = balance - computeReservedCNY */
  spendableCNY: string;
  totalDeposit: string;
  totalConsume: string;
  totalRefund: string;
}

export interface WalletTransaction {
  id: string;
  walletId: string;
  type: 'DEPOSIT' | 'CONSUME' | 'REFUND' | 'COMPUTE_RESERVE' | 'COMPUTE_RELEASE';
  amount: string; // Prisma Decimal 序列化为字符串
  balanceBefore: string;
  balanceAfter: string;
  relatedType?: 'subscription' | 'compute' | 'deposit_refund';
  relatedId?: string;
  paymentMethod?: string;
  paymentOrderId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  createdBy?: string;
}

export interface TransactionListResponse {
  items: WalletTransaction[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface TransactionFilters {
  type?: WalletTransaction['type'];
  page?: number;
  limit?: number;
}

// ── Hooks ──────────────────────────────────────────────────────────────────

/**
 * 获取企业钱包余额和统计
 */
export function useWalletBalance() {
  return useQuery<WalletBalance>({
    queryKey: ['wallet', 'balance'],
    queryFn: () => api.get<WalletBalance>('/wallet/balance'),
  });
}

/**
 * 获取钱包交易记录
 */
export function useWalletTransactions(filters: TransactionFilters = {}) {
  const params = new URLSearchParams();
  if (filters.type) params.set('type', filters.type);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));

  const queryString = params.toString();
  const path = `/wallet/transactions${queryString ? `?${queryString}` : ''}`;

  return useQuery<TransactionListResponse>({
    queryKey: ['wallet', 'transactions', filters],
    queryFn: () => api.get<TransactionListResponse>(path),
  });
}

/**
 * 创建充值订单（返回支付 URL）
 */
export function useCreateRechargeOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (amount: number) =>
      api.post<{ orderId: string; payUrl: string }>('/wallet/recharge', { amount }),
    onSuccess: () => {
      // 充值订单创建后，余额还没变，但可以预刷新交易列表
      queryClient.invalidateQueries({ queryKey: ['wallet', 'transactions'] });
    },
  });
}
