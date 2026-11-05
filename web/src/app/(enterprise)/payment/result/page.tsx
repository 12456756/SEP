'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle2, XCircle, Loader2, ArrowRight, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { usePollingOrder, useReconcileOrder } from '@/features/order/use-order';

export default function PaymentResultPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const orderId = searchParams.get('orderId');

  const { data: order, isLoading, isError, error, refetch, isFetching } = usePollingOrder(orderId);
  const reconcile = useReconcileOrder();

  // 兜底对账：订单仍为 PENDING 时，每 5 秒主动向支付宝核对一次真实交易状态。
  // 异步通知一旦丢失，仅靠轮询本地状态会永远停在 PENDING。
  useEffect(() => {
    if (!orderId || order?.status !== 'PENDING') return;

    const timer = setInterval(() => {
      if (!reconcile.isPending) {
        reconcile.mutate(orderId);
      }
    }, 5000);

    return () => clearInterval(timer);
    // reconcile 为 mutation 实例，引用稳定，无需纳入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, order?.status]);

  if (!orderId) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <Card className="glass-card w-full max-w-md">
          <CardContent className="py-12">
            <div className="flex flex-col items-center gap-4">
              <XCircle className="h-12 w-12 text-destructive" />
              <p className="text-sm text-gtext-secondary">缺少订单号</p>
              <Button onClick={() => router.push('/orders')}>返回订单列表</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isError && !order) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <Card className="glass-card w-full max-w-md">
          <CardContent className="py-12">
            <div className="flex flex-col items-center gap-4">
              <XCircle className="h-12 w-12 text-destructive" />
              <p className="text-sm text-gtext-secondary">{error.message}</p>
              <Button onClick={() => void refetch()} disabled={isFetching}>
                <RotateCw className="mr-2 h-4 w-4" />
                重新查询
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading || !order) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <Card className="glass-card w-full max-w-md">
          <CardContent className="py-12">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="h-12 w-12 animate-spin text-gbrand-text" />
              <p className="text-sm text-gtext-secondary">正在查询支付结果...</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isPaid = order.status === 'PAID';
  const isFailed = order.status === 'FAILED';
  const isPending = order.status === 'PENDING';
  const marketReturnPath = order.orderType === 'BUNDLE' ? '/marketplace/bundles' : '/cart';

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <Card className="glass-card">
        <CardContent className="py-12">
          <div className="flex flex-col items-center gap-6">
            {/* 状态图标 */}
            {isPaid && (
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-success/15">
                <CheckCircle2 className="h-12 w-12 text-success" />
              </div>
            )}
            {isFailed && (
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-destructive/15">
                <XCircle className="h-12 w-12 text-destructive" />
              </div>
            )}
            {isPending && (
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gbrand-text/15">
                <Loader2 className="h-12 w-12 animate-spin text-gbrand-text" />
              </div>
            )}

            {/* 标题和描述 */}
            <div className="text-center">
              <h1 className="text-2xl font-semibold text-gtext-primary">
                {isPaid && '支付成功'}
                {isFailed && '支付失败'}
                {isPending && '等待支付'}
              </h1>
              <p className="mt-2 text-sm text-gtext-secondary">
                {isPaid && '订单已完成支付，订阅即将生效'}
                {isFailed && '支付未完成，请重试'}
                {isPending && '正在等待支付确认，请稍候...'}
              </p>
            </div>

            {/* 订单信息 */}
            <div className="w-full space-y-3 rounded-lg border border-glassline bg-glass-1 p-4">
              <div className="flex justify-between text-sm">
                <span className="text-gtext-secondary">订单号</span>
                <span className="font-mono text-gtext-primary">{order.orderNo}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gtext-secondary">订单类型</span>
                <span className="text-gtext-primary">{order.orderType === 'BUNDLE' ? '员工套餐' : '员工订阅'}</span>
              </div>
              {order.orderType === 'BUNDLE' && order.bundleName && (
                <div className="flex justify-between text-sm">
                  <span className="text-gtext-secondary">套餐名称</span>
                  <span className="text-gtext-primary">{order.bundleName}</span>
                </div>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-gtext-secondary">订单金额</span>
                <span className="font-semibold text-gtext-primary">
                  ¥{order.totalAmount.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gtext-secondary">订单状态</span>
                <span
                  className={`font-medium ${
                    isPaid
                      ? 'text-success'
                      : isFailed
                        ? 'text-destructive'
                        : 'text-gtext-muted'
                  }`}
                >
                  {isPaid && '已支付'}
                  {isFailed && '支付失败'}
                  {isPending && '待支付'}
                </span>
              </div>
              {order.paidAt && (
                <div className="flex justify-between text-sm">
                  <span className="text-gtext-secondary">支付时间</span>
                  <span className="text-gtext-primary">
                    {new Date(order.paidAt).toLocaleString('zh-CN')}
                  </span>
                </div>
              )}
            </div>

            {/* 操作按钮 */}
            <div className="flex w-full gap-3">
              {isPaid && (
                <>
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => router.push('/subscriptions')}
                  >
                    查看订阅
                  </Button>
                  <Button
                    variant="primary"
                    className="flex-1"
                    onClick={() => router.push('/my-employees')}
                  >
                    开始使用
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </>
              )}
              {isFailed && (
                <>
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => router.push(marketReturnPath)}
                  >
                    返回购物车
                  </Button>
                  <Button
                    variant="primary"
                    className="flex-1"
                    onClick={() => router.push(order.orderType === 'BUNDLE' ? '/marketplace/bundles' : '/checkout')}
                  >
                    重新支付
                  </Button>
                </>
              )}
              {isPending && (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => router.push(marketReturnPath)}
                >
                  返回购物车
                </Button>
              )}
            </div>

            {isPending && (
              <p className="text-xs text-gtext-muted">
                页面将自动刷新支付状态，请勿关闭
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 订单商品列表 */}
      {order.items && order.items.length > 0 && (
        <Card className="glass-card">
          <CardContent className="p-5">
            <h2 className="mb-4 font-semibold text-gtext-primary">{order.orderType === 'BUNDLE' ? '套餐内员工' : '订单商品'}</h2>
            <div className="space-y-3">
              {order.items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between rounded-lg bg-glass-1 p-3"
                >
                  <div className="flex items-center gap-3">
                    {item.employeeAvatar && (
                      <img
                        src={item.employeeAvatar}
                        alt={item.employeeName}
                        className="h-10 w-10 rounded-full"
                      />
                    )}
                    <div>
                      <div className="text-sm font-medium text-gtext-primary">
                        {item.employeeName}
                      </div>
                      <div className="text-xs text-gtext-secondary">
                        {item.quantity} 位 × {item.periodMonths} 个月
                      </div>
                      {item.includedComputeCNY !== undefined && (
                        <div className="text-xs text-gtext-muted">赠送算力 ¥{item.includedComputeCNY.toLocaleString('zh-CN')}</div>
                      )}
                    </div>
                  </div>
                  <div className="text-sm font-semibold text-gtext-primary">
                    ¥{item.subtotal.toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
