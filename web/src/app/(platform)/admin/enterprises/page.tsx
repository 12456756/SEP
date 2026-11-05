'use client';

import { Building2, ChevronLeft, ChevronRight, ExternalLink, Lock } from 'lucide-react';
import { useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton, EmptyState } from '@/components/ui/feedback';
import { useAdminEnterpriseList } from '@/features/admin/use-admin';

export default function EnterprisesPage() {
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const { data, isLoading, isFetching, isError, error } = useAdminEnterpriseList(page, pageSize);
  const enterprises = data?.data ?? [];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">企业管理</h1>
        {data && (
          <span className="text-sm text-fg-muted">共 {data.total} 家企业</span>
        )}
      </div>

      <Card variant="solid">
        <CardHeader>
          <CardTitle>全部企业</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-5">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : isError ? (
            <div className="px-5 py-8">
              <EmptyState
                icon={<Building2 className="h-8 w-8" />}
                title="加载失败"
                description={error?.message || '无法加载企业列表，请稍后重试。'}
                action={
                  <Button size="sm" onClick={() => window.location.reload()}>
                    刷新页面
                  </Button>
                }
              />
            </div>
          ) : enterprises.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-fg-subtle">
              <Building2 className="mx-auto mb-2 h-8 w-8 opacity-30" />
              暂无企业注册
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-fg-muted">
                  <th className="px-5 py-2 text-left font-medium">企业名称</th>
                  <th className="px-5 py-2 text-left font-medium">企业简介</th>
                  <th className="px-5 py-2 text-left font-medium">算力余额</th>
                  <th className="px-5 py-2 text-left font-medium">成员数</th>
                  <th className="px-5 py-2 text-left font-medium">订阅数</th>
                  <th className="px-5 py-2 text-left font-medium">状态</th>
                  <th className="px-5 py-2 text-left font-medium">注册时间</th>
                  <th className="px-5 py-2 text-center font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {enterprises.map((ent) => {
                  // 钱包余额（元）。旧代码读的是 ent.computeAccount?.balance ——
                  // 那是已废弃字段，演示租户在这里会显示 ¥0 并被标成低余额警告。
                  const balance = ent.balance ?? 0;
                  const isSuspended = ent.suspended;

                  return (
                    <tr
                      key={ent.id}
                      className="border-b border-border last:border-0 odd:bg-muted/20 transition-colors hover:bg-muted/40"
                    >
                      <td className="px-5 py-3">
                        <Link
                          href={`/admin/enterprises/${ent.id}`}
                          className="flex items-center gap-2 hover:text-primary transition-colors"
                        >
                          <Building2 className="h-4 w-4 shrink-0 text-fg-subtle" />
                          <span className="font-medium">{ent.name}</span>
                        </Link>
                      </td>
                      <td className="px-5 py-3 text-fg-muted">{ent.description || '-'}</td>
                      <td className="px-5 py-3">
                        <span className={balance < 100 ? 'text-warning font-medium' : 'text-fg-muted'}>
                          ¥{balance.toFixed(2)}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-fg-muted">{ent.memberCount}</td>
                      <td className="px-5 py-3 text-fg-muted">{ent.subscriptionCount}</td>
                      <td className="px-5 py-3">
                        {isSuspended ? (
                          <Badge className="bg-danger text-white">
                            <Lock className="mr-1 h-3 w-3" />
                            已冻结
                          </Badge>
                        ) : (
                          <Badge className="bg-success/10 text-success">正常</Badge>
                        )}
                      </td>
                      <td className="px-5 py-3 text-fg-muted">
                        {new Date(ent.createdAt).toLocaleDateString('zh-CN')}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center justify-center gap-2">
                          <Link href={`/admin/enterprises/${ent.id}`}>
                            <Button variant="outline" size="sm">
                              <ExternalLink className="h-3.5 w-3.5 mr-1" />
                              查看详情
                            </Button>
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {data && data.totalPages > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3 text-sm text-fg-muted">
              <span>第 {data.page} / {data.totalPages} 页</span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1 || isFetching}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  <ChevronLeft className="h-4 w-4" />
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= data.totalPages || isFetching}
                  onClick={() => setPage((current) => Math.min(data.totalPages, current + 1))}
                >
                  下一页
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
