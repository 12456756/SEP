'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ChevronDown, ChevronUp, Package, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, Skeleton } from '@/components/ui/feedback';
import { toast } from '@/components/ui/toast';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAuthStore } from '@/lib/auth-store';
import { useCreateAlipayPayment, useCreateBundleOrder, usePayOrderWithBalance } from '@/features/order/use-order';
import { usePublishedEmployeeBundles, type EmployeeBundle } from '@/features/employee-bundle/use-employee-bundles';

const money = (value: string | number) => Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2 });

export default function MarketplaceBundlesPage() {
  const router = useRouter();
  const { token, hydrated, roleInEnterprise } = useAuthStore();
  const { data: bundles = [], isLoading, error } = usePublishedEmployeeBundles();
  const createOrder = useCreateBundleOrder();
  const createPayment = useCreateAlipayPayment();
  const payWithBalance = usePayOrderWithBalance();
  const [selectedBundle, setSelectedBundle] = useState<EmployeeBundle | null>(null);
  const [expandedBundles, setExpandedBundles] = useState<Set<string>>(() => new Set());
  const [paymentMethod, setPaymentMethod] = useState<'balance' | 'alipay'>('balance');
  const [pendingOrderId, setPendingOrderId] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  async function purchase() {
    if (!selectedBundle) return;
    if (!hydrated || !token) {
      router.push('/login?next=/marketplace/bundles');
      return;
    }
    if (roleInEnterprise !== 'ENTERPRISE_ADMIN') {
      toast.error('只有企业管理员可以购买员工套餐');
      return;
    }
    setProcessing(true);
    try {
      let orderId = pendingOrderId;
      if (!orderId) {
        const order = await createOrder.mutateAsync({ bundleId: selectedBundle.id });
        orderId = order.id;
        setPendingOrderId(orderId);
      }
      if (paymentMethod === 'balance') {
        await payWithBalance.mutateAsync(orderId);
        toast.success('套餐购买成功，员工订阅已生效');
        setSelectedBundle(null);
        setPendingOrderId(null);
        router.push(`/payment/result?orderId=${orderId}&status=success`);
      } else {
        const payment = await createPayment.mutateAsync(orderId);
        window.location.href = payment.paymentForm;
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '套餐下单失败');
    } finally {
      setProcessing(false);
    }
  }

  if (isLoading) return <div className="space-y-5"><Skeleton className="h-10 w-72" /><div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-96" />)}</div></div>;
  if (error) return <EmptyState title="套餐加载失败" description={error instanceof Error ? error.message : '请稍后重试'} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link href="/marketplace" className="inline-flex items-center gap-1 text-sm text-gtext-muted hover:text-foreground"><ArrowLeft className="h-4 w-4" />返回员工市场</Link>
          <h1 className="mt-3 text-3xl font-semibold">员工套餐</h1>
          <p className="mt-1 text-sm text-gtext-secondary">一次购买一组已上架员工，套餐内员工会分别加入企业订阅。</p>
        </div>
        <Badge variant="secondary" className="gap-1"><Sparkles className="h-3.5 w-3.5" />员工算力分别到账</Badge>
      </div>

      {bundles.length === 0 ? <EmptyState icon={<Package className="h-8 w-8" />} title="暂无已发布套餐" description="平台运营发布套餐后会显示在这里。" /> : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {bundles.map((bundle) => (
            <Card key={bundle.id} className="flex flex-col overflow-hidden">
              {bundle.cover ? <img src={bundle.cover} alt="" className="h-40 w-full object-cover" /> : <div className="flex h-40 items-center justify-center bg-gbrand/10"><Package className="h-12 w-12 text-gbrand-text" /></div>}
              <CardHeader className="pb-3"><div className="flex items-start justify-between gap-3"><div><CardTitle className="text-xl">{bundle.name}</CardTitle><p className="mt-1 text-xs text-gtext-muted">{bundle.code} · {bundle.periodMonths} 个月</p></div><Badge>{bundle.items.length} 位员工</Badge></div></CardHeader>
              <CardContent className="flex flex-1 flex-col gap-4 pt-0">
                {bundle.description && <p className="line-clamp-2 text-sm text-gtext-secondary">{bundle.description}</p>}
                <div className="space-y-2 border-y border-glassline py-3 text-sm">
                  {(expandedBundles.has(bundle.id) ? bundle.items : bundle.items.slice(0, 5)).map((item) => <div key={item.id} className="flex items-center gap-2"><Avatar name={item.employeeName} src={item.employeeAvatar} className="h-7 w-7" /><span className="min-w-0 flex-1 truncate">{item.employeeName}</span><span className="text-gtext-muted">¥{money(item.subtotal)}</span></div>)}
                  {bundle.items.length > 5 && <button
                    type="button"
                    aria-expanded={expandedBundles.has(bundle.id)}
                    onClick={() => setExpandedBundles((current) => {
                      const next = new Set(current);
                      if (next.has(bundle.id)) next.delete(bundle.id);
                      else next.add(bundle.id);
                      return next;
                    })}
                    className="inline-flex items-center gap-1 pt-1 text-xs font-medium text-gbrand-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gbrand/50"
                  >
                    {expandedBundles.has(bundle.id) ? <><ChevronUp className="h-3.5 w-3.5" />收起员工列表</> : <><ChevronDown className="h-3.5 w-3.5" />展开剩余 {bundle.items.length - 5} 位员工</>}
                  </button>}
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm"><div><p className="text-gtext-muted">员工原价合计</p><p className="mt-1 line-through">¥{money(bundle.originalAmountCNY)}</p></div><div><p className="text-gtext-muted">赠送算力</p><p className="mt-1 text-success">¥{money(bundle.totalComputeCNY)}</p></div></div>
                <div className="mt-auto flex items-end justify-between gap-3"><div><p className="text-xs text-gtext-muted">套餐价</p><p className="text-2xl font-semibold text-gbrand-text">¥{money(bundle.priceCNY)}</p>{Number(bundle.discountCNY) > 0 && <p className="text-xs text-success">立省 ¥{money(bundle.discountCNY)}</p>}</div><Button onClick={() => { setSelectedBundle(bundle); setPaymentMethod('balance'); setPendingOrderId(null); }} disabled={processing}>{processing ? '处理中…' : '购买套餐'}</Button></div>
                <p className="text-xs text-gtext-muted">购买后立即生效，套餐内员工订阅会一并创建。</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={Boolean(selectedBundle)} onOpenChange={(open) => { if (!open && !processing) { setSelectedBundle(null); setPendingOrderId(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认购买套餐</DialogTitle>
            <DialogDescription>支付成功后，套餐内员工会立即加入企业订阅，算力按员工分别发放。</DialogDescription>
          </DialogHeader>
          {selectedBundle && <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 border-y border-glassline py-3"><div><p className="font-medium">{selectedBundle.name}</p><p className="mt-1 text-sm text-gtext-muted">{selectedBundle.items.length} 位员工 · {selectedBundle.periodMonths} 个月</p></div><p className="shrink-0 text-xl font-semibold text-gbrand-text">¥{money(selectedBundle.priceCNY)}</p></div>
            <div className="max-h-48 space-y-2 overflow-auto">
              {selectedBundle.items.map((item) => <div key={item.id} className="flex items-center gap-2 text-sm"><Avatar name={item.employeeName} src={item.employeeAvatar} className="h-7 w-7" /><span className="min-w-0 flex-1 truncate">{item.employeeName}</span><span className="text-xs text-gtext-muted">算力 ¥{money(item.includedComputeCNY)}</span></div>)}
            </div>
            <div aria-label="支付方式" className="grid grid-cols-2 border-y border-glassline py-3">
              <button type="button" aria-pressed={paymentMethod === 'balance'} onClick={() => setPaymentMethod('balance')} className={`border-r border-glassline px-3 py-2 text-sm ${paymentMethod === 'balance' ? 'font-medium text-gbrand-text' : 'text-gtext-secondary'}`}>余额支付</button>
              <button type="button" aria-pressed={paymentMethod === 'alipay'} onClick={() => setPaymentMethod('alipay')} className={`px-3 py-2 text-sm ${paymentMethod === 'alipay' ? 'font-medium text-gbrand-text' : 'text-gtext-secondary'}`}>支付宝</button>
            </div>
            <p className="text-xs text-gtext-muted">套餐支付成功后，套餐内所有员工订阅会一并生效。</p>
          </div>}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setSelectedBundle(null); setPendingOrderId(null); }} disabled={processing}>取消</Button>
            <Button onClick={purchase} disabled={processing}>{processing ? '处理中…' : paymentMethod === 'balance' ? '确认并支付' : '前往支付宝'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
