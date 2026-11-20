"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ShoppingCart,
  ArrowLeft,
  CreditCard,
  Loader2,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/feedback";
import { toast } from "@/components/ui/toast";
import { useCart } from "@/features/cart/use-cart";
import {
  useCreateOrder,
  useCreateAlipayPayment,
  usePayOrderWithBalance,
} from "@/features/order/use-order";
import { cn } from "@/lib/utils";

type PaymentMethod = "balance" | "alipay";

export default function CheckoutPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: cart, isLoading: cartLoading } = useCart();
  const createOrder = useCreateOrder();
  const createPayment = useCreateAlipayPayment();
  const payWithBalance = usePayOrderWithBalance();

  const [isProcessing, setIsProcessing] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("balance");

  // 获取选中的商品ID列表
  const selectedItemIds = searchParams.get("items")?.split(",").filter(Boolean);
  const checkoutItems = cart?.items.filter((item) => !selectedItemIds?.length || selectedItemIds.includes(item.id)) ?? [];
  const totalAmount = checkoutItems.reduce((sum, item) => sum + item.subtotal, 0);
  const totalIncludedCompute = checkoutItems.reduce((sum, item) => sum + item.includedComputeCNY, 0);
  const isFree = checkoutItems.length > 0 && totalAmount === 0;

  useEffect(() => {
    // 如果购物车为空，重定向回购物车页
    if (!cartLoading && (!cart || cart.items.length === 0)) {
      toast.error("购物车是空的");
      router.push("/cart");
    }
  }, [cart, cartLoading, router]);

  const handlePay = async () => {
    if (!cart || cart.items.length === 0) return;

    setIsProcessing(true);

    try {
      // 1. 创建订单（传递选中的商品ID）
      const orderResult = await createOrder.mutateAsync(
        selectedItemIds && selectedItemIds.length > 0
          ? { itemIds: selectedItemIds }
          : undefined,
      );
      toast.success(`订单创建成功：${orderResult.orderNo}`);

      if (orderResult.totalAmount === 0 || paymentMethod === "balance") {
        await payWithBalance.mutateAsync(orderResult.id);
        toast.success(orderResult.totalAmount === 0 ? "免费雇佣成功！" : "支付成功！");
        router.push(`/payment/result?orderId=${orderResult.id}&status=success`);
      } else {
        // 2. 发起支付宝支付
        const paymentResult = await createPayment.mutateAsync(orderResult.id);
        // 3. 跳转到支付宝支付页面
        window.location.href = paymentResult.paymentForm;
      }
    } catch (err) {
      toast.error((err as Error).message);
      setIsProcessing(false);
    }
  };

  if (cartLoading) {
    return (
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <Card>
          <CardContent className="py-12">
            <div className="flex items-center justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-gbrand-text border-t-transparent" />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!cart || cart.items.length === 0) {
    return null; // 重定向已在 useEffect 处理
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      {/* 页头 */}
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/cart")}
          disabled={isProcessing}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          返回购物车
        </Button>
        <div>
          <h1 className="text-2xl font-semibold text-gtext-primary">
            确认订单
          </h1>
          <p className="mt-1 text-sm text-gtext-secondary">
            {isFree ? "请确认免费雇佣的员工" : "请确认订单信息，然后选择支付方式"}
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* 订单详情 */}
        <div className="space-y-4 lg:col-span-2">
          {/* 商品列表 */}
          <Card className="glass-card">
            <CardHeader className="border-b border-glassline">
              <h2 className="text-lg font-semibold text-gtext-primary">
                订单商品 ({checkoutItems.length})
              </h2>
            </CardHeader>
            <CardContent className="divide-y divide-glassline p-0">
              {checkoutItems.map((item) => (
                <div key={item.id} className="flex gap-4 p-5">
                  <Avatar
                    name={item.employeeName}
                    src={item.employeeAvatar}
                    className="h-14 w-14 shrink-0 ring-2 ring-white/15"
                  />
                  <div className="min-w-0 flex-1">
                    <h3 className="font-medium text-gtext-primary">
                      {item.employeeName}
                    </h3>
                    {/* 收敛后一员工一雇佣关系，没有数量维度 */}
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gtext-secondary">
                      <span>¥{item.unitPrice.toLocaleString()} / 年</span>
                      <span>×</span>
                      <span>{item.periodMonths} 个月</span>
                    </div>
                    <div className="mt-1 text-xs text-gtext-muted">
                      含 ¥{item.includedComputeCNY.toLocaleString()} 算力
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-semibold text-gbrand-text">
                      ¥{item.subtotal.toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* 支付方式 */}
          {!isFree && <Card className="glass-card">
            <CardHeader className="border-b border-glassline">
              <h2 className="text-lg font-semibold text-gtext-primary">
                支付方式
              </h2>
            </CardHeader>
            <CardContent className="p-5">
              <div className="flex items-center gap-4 rounded-lg border-2 border-gbrand-text/30 bg-gbrand-text/5 p-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gbrand-text/15">
                  <CreditCard className="h-6 w-6 text-gbrand-text" />
                </div>
                <div className="flex-1">
                  <div className="font-medium text-gtext-primary">支付宝</div>
                  <div className="text-sm text-gtext-secondary">
                    安全快捷的在线支付
                  </div>
                </div>
                <Badge className="bg-gbrand-text/15 text-gbrand-text">
                  推荐
                </Badge>
              </div>
            </CardContent>
          </Card>}
        </div>

        {/* 订单汇总 */}
        <div className="lg:col-span-1">
          <Card className="glass-card sticky top-6">
            <CardHeader className="border-b border-glassline">
              <h2 className="text-lg font-semibold text-gtext-primary">
                订单汇总
              </h2>
            </CardHeader>
            <CardContent className="space-y-4 p-5">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-gtext-secondary">商品总数</span>
                  <span className="font-medium text-gtext-primary">
                    {checkoutItems.length}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gtext-secondary">商品金额</span>
                  <span className="font-medium text-gtext-primary">
                    ¥{totalAmount.toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gtext-secondary">赠送算力</span>
                  <span className="font-medium text-success">
                    ¥{totalIncludedCompute.toLocaleString()}
                  </span>
                </div>
              </div>

              <div className="border-t border-glassline pt-4">
                <div className="flex justify-between">
                  <span className="text-base font-medium text-gtext-primary">
                    应付总额
                  </span>
                  <span className="text-2xl font-bold text-gbrand-text">
                    ¥{totalAmount.toLocaleString()}
                  </span>
                </div>
              </div>

              {/* 支付方式选择 */}
              {!isFree && <div className="space-y-3 border-t border-glassline pt-4">
                <h3 className="text-sm font-medium text-gtext-primary">
                  选择支付方式
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setPaymentMethod("balance")}
                    className={cn(
                      "flex items-center gap-3 rounded-glass-lg border p-4 transition-all",
                      paymentMethod === "balance"
                        ? "border-gbrand-border bg-gbrand/10"
                        : "border-glassline bg-glass-1 hover:bg-glass-2",
                    )}
                  >
                    <Wallet
                      className={cn(
                        "h-5 w-5",
                        paymentMethod === "balance"
                          ? "text-gbrand-text"
                          : "text-gtext-muted",
                      )}
                    />
                    <div className="flex-1 text-left">
                      <p
                        className={cn(
                          "text-sm font-medium",
                          paymentMethod === "balance"
                            ? "text-gbrand-text"
                            : "text-gtext-primary",
                        )}
                      >
                        余额支付
                      </p>
                    </div>
                  </button>

                  <button
                    onClick={() => setPaymentMethod("alipay")}
                    className={cn(
                      "flex items-center gap-3 rounded-glass-lg border p-4 transition-all",
                      paymentMethod === "alipay"
                        ? "border-gbrand-border bg-gbrand/10"
                        : "border-glassline bg-glass-1 hover:bg-glass-2",
                    )}
                  >
                    <CreditCard
                      className={cn(
                        "h-5 w-5",
                        paymentMethod === "alipay"
                          ? "text-gbrand-text"
                          : "text-gtext-muted",
                      )}
                    />
                    <div className="flex-1 text-left">
                      <p
                        className={cn(
                          "text-sm font-medium",
                          paymentMethod === "alipay"
                            ? "text-gbrand-text"
                            : "text-gtext-primary",
                        )}
                      >
                        支付宝
                      </p>
                    </div>
                  </button>
                </div>
              </div>}

              <Button
                variant="primary"
                size="lg"
                className="w-full"
                onClick={handlePay}
                disabled={isProcessing}
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    处理中...
                  </>
                ) : (
                  <>
                    {paymentMethod === "balance" ? (
                      <Wallet className="mr-2 h-4 w-4" />
                    ) : (
                      <CreditCard className="mr-2 h-4 w-4" />
                    )}
                    {isFree ? "免费雇佣" : "立即支付"}
                  </>
                )}
              </Button>

              <p className="text-center text-xs text-gtext-muted">
                点击「{isFree ? "免费雇佣" : "立即支付"}」即表示同意服务条款
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
