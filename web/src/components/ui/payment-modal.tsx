'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { X, Wallet, Loader2, CheckCircle2, ArrowRight, CreditCard } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Z_CLASS } from '@/lib/z-index';

// ─── types ────────────────────────────────────────────────────────────────────

interface PaymentModalProps {
  open: boolean;
  emp: { name: string; price?: number | null };
  subscribing: boolean;
  /** 订阅成功时由父组件设为 true，弹窗切换到引导界面 */
  succeeded?: boolean;
  onConfirm: (method: 'balance' | 'alipay') => void;
  onClose: () => void;
}

type PaymentMethod = 'balance' | 'alipay';

// ─── success screen ───────────────────────────────────────────────────────────

function SuccessScreen({
  empName,
  onClose,
}: {
  empName: string;
  onClose: () => void;
}) {
  const router = useRouter();

  function goToEmployees() {
    onClose();
    router.push('/my-employees');
  }

  return (
    <div className="flex flex-col items-center gap-5 py-4 text-center">
      {/* icon */}
      <div className="flex h-16 w-16 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10">
        <CheckCircle2 className="h-8 w-8 text-emerald-400" />
      </div>

      {/* title */}
      <div className="space-y-1.5">
        <h2 className="text-xl font-semibold text-gtext-primary">雇佣成功！</h2>
        <p className="text-sm text-gtext-secondary">
          <span className="font-medium text-gtext-primary">「{empName}」</span>{' '}
          已加入你的员工列表
        </p>
      </div>

      {/* hint */}
      <p className="max-w-xs rounded-glass-lg border border-glassline bg-glass-2 px-4 py-3 text-xs text-gtext-muted leading-relaxed">
        接下来，企业管理员可以在「雇佣管理」中把 TA 授权给部门或成员使用。
      </p>

      {/* CTAs */}
      <div className="flex w-full flex-col gap-2.5">
        <Button
          variant="glass-primary"
          size="sm"
          className="w-full"
          onClick={goToEmployees}
        >
          去我的员工
          <ArrowRight className="ml-1.5 h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={onClose}
        >
          继续逛市场
        </Button>
      </div>
    </div>
  );
}

// ─── main component ───────────────────────────────────────────────────────────

export function PaymentModal({
  open,
  emp,
  subscribing,
  succeeded = false,
  onConfirm,
  onClose,
}: PaymentModalProps) {
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('balance');
  const canConfirm = emp.price != null && Number.isFinite(Number(emp.price)) && Number(emp.price) >= 0;
  const isFree = canConfirm && Number(emp.price) === 0;

  if (!open) return null;

  function handleConfirm() {
    if (!canConfirm || subscribing) return;
    onConfirm(isFree ? 'balance' : paymentMethod);
  }

  return (
    <>
      {/* backdrop */}
      <div
        className={cn('fixed inset-0 bg-black/60 backdrop-blur-sm', Z_CLASS.dialog)}
        onClick={succeeded ? undefined : onClose}
        aria-hidden="true"
      />

      {/* modal */}
      <div className={cn('fixed inset-0 flex items-center justify-center p-4', Z_CLASS.dialog)}>
        <div
          className={cn(
            'glass-card relative w-full max-w-md space-y-5 p-6',
            'animate-in fade-in-0 zoom-in-95 duration-200',
          )}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="payment-modal-title"
        >
          {/* close button — hidden on success screen (CTAs replace it) */}
          {!succeeded && (
            <button
              onClick={onClose}
              disabled={subscribing}
              className="absolute right-4 top-4 rounded-glass-md p-1.5 text-gtext-muted transition-colors hover:bg-glass-2 hover:text-gtext-primary disabled:pointer-events-none"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          )}

          {/* ── success screen ── */}
          {succeeded ? (
            <SuccessScreen empName={emp.name} onClose={onClose} />
          ) : (
            <>
              {/* header */}
              <div className="pr-8">
                <h2
                  id="payment-modal-title"
                  className="text-lg font-semibold text-gtext-primary"
                >
                  确认雇佣
                </h2>
                <p className="mt-1 text-sm text-gtext-secondary">
                  雇佣后可授权给部门与成员
                </p>
              </div>

              {/* employee + price */}
              <div className="rounded-glass-lg border border-glassline bg-glass-2 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gtext-primary">
                      {emp.name}
                    </p>
                    <p className="mt-0.5 text-xs text-gtext-muted">硅基员工</p>
                  </div>
                  <div className="text-right">
                    {!canConfirm ? (
                      <span className="text-sm text-gtext-muted">暂未定价</span>
                    ) : isFree ? (
                      <span className="text-base font-semibold text-emerald-400">
                        免费
                      </span>
                    ) : (
                      <>
                        <p className="text-lg font-semibold text-gtext-primary">
                          ¥{emp.price?.toLocaleString()}
                        </p>
                        <p className="text-xs text-gtext-muted">每年</p>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* payment method */}
              {canConfirm && !isFree && (
                <div>
                  <p className="mb-3 text-sm font-medium text-gtext-primary">
                    支付方式
                  </p>
                  <div className="space-y-2.5">
                    {/* 余额支付 */}
                    <button
                      type="button"
                      onClick={() => setPaymentMethod('balance')}
                      className={cn(
                        'w-full rounded-glass-lg border p-3 transition-all',
                        paymentMethod === 'balance'
                          ? 'border-glassline-brand bg-gbrand/10'
                          : 'border-glassline bg-glass-2 hover:border-glassline-brand/50',
                      )}
                    >
                      <div className="flex items-center gap-2.5">
                        <Wallet className="h-4 w-4 text-gtext-secondary" />
                        <span className="text-sm text-gtext-primary">余额支付</span>
                        {paymentMethod === 'balance' && (
                          <div className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-gbrand-text">
                            <CheckCircle2 className="h-3.5 w-3.5 text-white" />
                          </div>
                        )}
                      </div>
                    </button>

                    {/* 支付宝 */}
                    <button
                      type="button"
                      onClick={() => setPaymentMethod('alipay')}
                      className={cn(
                        'w-full rounded-glass-lg border p-3 transition-all',
                        paymentMethod === 'alipay'
                          ? 'border-glassline-brand bg-gbrand/10'
                          : 'border-glassline bg-glass-2 hover:border-glassline-brand/50',
                      )}
                    >
                      <div className="flex items-center gap-2.5">
                        <CreditCard className="h-4 w-4 text-gtext-secondary" />
                        <span className="text-sm text-gtext-primary">支付宝</span>
                        {paymentMethod === 'alipay' && (
                          <div className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-gbrand-text">
                            <CheckCircle2 className="h-3.5 w-3.5 text-white" />
                          </div>
                        )}
                      </div>
                    </button>
                  </div>
                </div>
              )}

              {/* footer */}
              <div className="flex items-center justify-end gap-3 border-t border-glassline pt-4">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onClose}
                  disabled={subscribing}
                >
                  取消
                </Button>
                <Button
                  variant="glass-primary"
                  size="sm"
                  onClick={handleConfirm}
                  disabled={!canConfirm || subscribing}
                  className="min-w-[120px]"
                >
                  {subscribing ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      处理中...
                    </>
                  ) : !canConfirm ? (
                    '暂不可订阅'
                  ) : isFree ? (
                    '免费雇佣'
                  ) : paymentMethod === 'alipay' ? (
                    '前往支付宝支付'
                  ) : (
                    '确认支付'
                  )}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
