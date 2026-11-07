'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useWalletTransactions, type TransactionFilters } from '@/lib/api/wallet';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { ArrowUpCircle, ArrowDownCircle, RotateCw, Receipt } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

export function WalletTransactionList() {
  const [filters, setFilters] = useState<TransactionFilters>({
    page: 1,
    limit: 20,
  });

  const { data, isLoading, error } = useWalletTransactions(filters);

  const handleTypeFilter = (type: string) => {
    setFilters((prev) => ({
      ...prev,
      type: type === 'all' ? undefined : (type as TransactionFilters['type']),
      page: 1,
    }));
  };

  const handlePageChange = (newPage: number) => {
    setFilters((prev) => ({ ...prev, page: newPage }));
  };

  if (isLoading) {
    return (
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5" />
            交易记录
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse flex gap-4">
                <div className="h-12 w-12 bg-gray-200 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-gray-200 rounded w-1/3" />
                  <div className="h-3 bg-gray-100 rounded w-1/4" />
                </div>
                <div className="text-right space-y-2">
                  <div className="h-5 bg-gray-200 rounded w-24 ml-auto" />
                  <div className="h-3 bg-gray-100 rounded w-20 ml-auto" />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="border-danger/30 bg-danger/5 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-danger">
            <Receipt className="h-5 w-5" />
            加载失败
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-fg-muted">
            {error instanceof Error ? error.message : '获取交易记录失败'}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex items-center gap-2 text-xl">
            <Receipt className="h-5 w-5 text-primary" />
            交易记录
          </CardTitle>
          <Select
            value={filters.type || 'all'}
            onValueChange={handleTypeFilter}
          >
            <SelectTrigger className="w-full sm:w-40 shadow-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类型</SelectItem>
              <SelectItem value="DEPOSIT">充值</SelectItem>
              <SelectItem value="CONSUME">消费</SelectItem>
              <SelectItem value="REFUND">退款</SelectItem>
              <SelectItem value="COMPUTE_RESERVE">划入算力专款</SelectItem>
              <SelectItem value="COMPUTE_RELEASE">退回企业钱包</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {data.items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/30 py-12 text-center">
            <Receipt className="mx-auto h-10 w-10 text-fg-disabled" />
            <p className="mt-3 text-sm font-medium text-fg-secondary">暂无交易记录</p>
            <p className="mt-1 text-xs text-fg-muted">
              {filters.type ? '当前筛选条件下没有记录' : '还没有任何交易'}
            </p>
          </div>
        ) : (
          <>
            <div className="divide-y divide-border rounded-lg border border-border bg-background">
              {data.items.map((tx) => (
                <TransactionItem key={tx.id} transaction={tx} />
              ))}
            </div>

            {/* 分页 */}
            {data.totalPages > 1 && (
              <div className="flex flex-col gap-3 mt-6 pt-4 border-t sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-fg-muted">
                  第 <span className="font-medium text-foreground">{data.page}</span> / {data.totalPages} 页，共{' '}
                  <span className="font-medium text-foreground">{data.total}</span> 条记录
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={data.page === 1}
                    onClick={() => handlePageChange(data.page - 1)}
                    className="shadow-sm"
                  >
                    上一页
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={data.page === data.totalPages}
                    onClick={() => handlePageChange(data.page + 1)}
                    className="shadow-sm"
                  >
                    下一页
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TransactionItem({ transaction }: { transaction: any }) {
  const isNeutral = transaction.type === 'COMPUTE_RESERVE';
  const isPositive = transaction.type === 'DEPOSIT' || transaction.type === 'COMPUTE_RELEASE' ||
    (transaction.type === 'REFUND' && Number(transaction.amount) > 0);

  const Icon =
    transaction.type === 'DEPOSIT' ? ArrowUpCircle :
    transaction.type === 'REFUND' || transaction.type === 'COMPUTE_RELEASE' ? RotateCw :
    ArrowDownCircle;

  const colorClass = isPositive ? 'text-success' : isNeutral ? 'text-primary' : 'text-danger';
  const bgClass = isPositive ? 'bg-success/10' : isNeutral ? 'bg-primary/10' : 'bg-danger/10';

  const typeLabel: Record<string, string> = {
    DEPOSIT: '充值',
    CONSUME: '消费',
    REFUND: '退款',
    COMPUTE_RESERVE: '划入算力专款',
    COMPUTE_RELEASE: '退回企业钱包',
  };
  const label = typeLabel[transaction.type] || transaction.type;

  return (
    <div className="flex items-center gap-4 px-4 py-4 transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-muted/30">
      <span className={cn(
        'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg shadow-sm',
        bgClass
      )}>
        <Icon className={cn('h-5 w-5', colorClass)} />
      </span>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">
          {transaction.description || label}
        </p>
        <div className="flex items-center gap-2 mt-1 text-xs text-fg-muted">
          <span>
            {format(new Date(transaction.createdAt), 'yyyy-MM-dd HH:mm', {
              locale: zhCN,
            })}
          </span>
          {transaction.relatedType && (
            <>
              <span>·</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                {transaction.relatedType === 'subscription' ? '订阅' : transaction.relatedType === 'deposit_refund' ? '充值退款' : '算力'}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="text-right shrink-0">
        <p className={cn('text-base font-bold tabular-nums', colorClass)}>
          {isPositive ? '+' : isNeutral ? '' : '−'}¥{Math.abs(Number(transaction.amount)).toFixed(2)}
        </p>
        <p className="text-xs text-fg-muted mt-1">
          余额 ¥{Number(transaction.balanceAfter).toFixed(2)}
        </p>
      </div>
    </div>
  );
}
