'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Search, ShieldCheck, UserRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { CenteredSpinner, EmptyState } from '@/components/ui/feedback';
import {
  useAdminAuthUsers,
  type AdminAuthUser,
} from '@/features/admin/use-admin-auth';

export default function AdminAuthUsersPage() {
  const [keyword, setKeyword] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const users = useAdminAuthUsers({ keyword: query, status, page, pageSize });

  if (users.isLoading) return <CenteredSpinner />;
  if (users.isError)
    return (
      <EmptyState
        title="认证用户加载失败"
        description="请稍后重试或检查管理员会话。"
      />
    );
  const data = users.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-fg-muted">平台管理 / 认证中心</p>
          <h1 className="mt-1 text-2xl font-semibold">认证用户</h1>
          <p className="mt-1 text-sm text-fg-muted">
            查看认证状态、第三方身份、有效会话和安全事件。
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <ShieldCheck className="h-4 w-4" />
          仅平台管理员可操作
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-wrap gap-3 p-4">
          <div className="relative min-w-[260px] flex-1">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-fg-muted" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setPage(1);
                  setQuery(keyword);
                }
              }}
              placeholder="搜索邮箱或姓名"
              className="pl-9"
            />
          </div>
          <select
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value);
            }}
            className="h-10 rounded-md border border-glassline bg-glass-1 px-3 text-sm"
          >
            <option value="">全部状态</option>
            <option value="ACTIVE">正常</option>
            <option value="DISABLED">已禁用</option>
            <option value="CLOSURE_PENDING">注销待生效</option>
            <option value="CLOSED">已注销</option>
          </select>
          <Button variant="outline" onClick={() => { setPage(1); setQuery(keyword); }}>
            搜索
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>用户列表（{data?.total ?? 0}）</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {!data?.items.length ? (
            <EmptyState
              title="暂无用户"
              description="没有符合条件的认证用户。"
            />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-glassline text-left text-fg-muted">
                  <th className="p-4">用户</th>
                  <th className="p-4">状态</th>
                  <th className="p-4">登录方式</th>
                  <th className="p-4">邮箱</th>
                  <th className="p-4">创建时间</th>
                  <th className="p-4 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((user) => (
                  <tr
                    key={user.id}
                    className="border-b border-glassline/60 last:border-0"
                  >
                    <td className="p-4">
                      <Link
                        href={`/admin/auth-users/${user.id}`}
                        className="flex items-center gap-3 hover:text-primary"
                      >
                        <UserRound className="h-4 w-4 text-fg-muted" />
                        <span>
                          <span className="block font-medium">
                            {user.name || '未命名用户'}
                          </span>
                          <span className="text-xs text-fg-muted">
                            {user.id}
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td className="p-4">
                      <StatusBadge status={user.status} />
                    </td>
                    <td className="p-4 text-fg-muted">
                      密码{' '}
                      {user.identityCount > 0
                        ? `· 第三方 ${user.identityCount}`
                        : ''}
                    </td>
                    <td className="p-4">{user.email}</td>
                    <td className="p-4 text-fg-muted">
                      {new Date(user.createdAt).toLocaleString('zh-CN')}
                    </td>
                    <td className="p-4 text-right">
                      <Link href={`/admin/auth-users/${user.id}`}>
                        <Button size="sm" variant="outline">
                          查看
                        </Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data && data.totalPages > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-glassline px-4 py-3 text-sm text-fg-muted">
              <span>共 {data.total} 条，第 {data.page} / {data.totalPages} 页</span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1 || users.isFetching} onClick={() => setPage((current) => Math.max(1, current - 1))}>
                  <ChevronLeft className="h-4 w-4" />
                  上一页
                </Button>
                <Button variant="outline" size="sm" disabled={page >= data.totalPages || users.isFetching} onClick={() => setPage((current) => Math.min(data!.totalPages, current + 1))}>
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

function StatusBadge({ status }: { status: AdminAuthUser['status'] }) {
  if (status === 'DISABLED')
    return <Badge variant="glass-danger">已禁用</Badge>;
  if (status === 'CLOSURE_PENDING')
    return <Badge variant="glass-warning">注销待生效</Badge>;
  if (status === 'CLOSED') return <Badge variant="glass-danger">已注销</Badge>;
  return <Badge>正常</Badge>;
}
