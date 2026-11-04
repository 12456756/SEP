'use client';

import { useState } from 'react';
import { KeyRound, Plus, Pencil, Trash2, Users, AlertTriangle } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CenteredSpinner, EmptyState } from '@/components/ui/feedback';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { useAuthStore } from '@/lib/auth-store';
import { ApiError } from '@/lib/api-client';
import { member, common } from '@/locales/zh-CN';
import {
  useMembers,
  useDepartments,
  useCreateMember,
  useUpdateMember,
  useDeleteMember,
  useInvitations,
} from '@/features/enterprise/use-enterprise';
import { InvitationPanel } from '@/features/enterprise/invitation-panel';
import { flattenDepts } from '@/features/enterprise/flatten-depts';
import { MemberStats } from '@/features/enterprise/member-stats';
import { MemberEmployeeGrantPanel } from '@/features/enterprise/member-employee-grant-panel';
import type { EnterpriseMember, OffboardResult } from '@/lib/types';

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 w-full max-w-sm rounded-xl border border-border bg-background shadow-lg">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h3 className="text-base font-semibold">{title}</h3>
          <button onClick={onClose} className="text-fg-muted hover:text-foreground">✕</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

const ROLE_LABEL: Record<string, string> = {
  ENTERPRISE_ADMIN: '企业管理员',
  DEPT_MANAGER: '部门负责人',
  MEMBER: '普通成员',
};

export default function MembersPage() {
  const { roleInEnterprise } = useAuthStore();
  const isAdmin = roleInEnterprise === 'ENTERPRISE_ADMIN';

  const { data: members = [], isLoading } = useMembers();
  const { data: depts = [] } = useDepartments();
  // 邀请数只在管理员视角下取 —— 普通成员没有 /enterprise/invitations 权限，
  // 拉了只会得到 403 并污染错误提示
  const { data: invitations = [] } = useInvitations(undefined, { enabled: isAdmin });
  const createMember = useCreateMember();
  const updateMember = useUpdateMember();
  const deleteMember = useDeleteMember();

  // 扁平化部门列表（用于下拉）
  const flatDepts = flattenDepts(depts);

  const pendingInvites = invitations.filter((i) => i.status === 'PENDING').length;

  const [tab, setTab] = useState<'members' | 'invitations'>('members');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<EnterpriseMember | null>(null);
  const [removing, setRemoving] = useState<EnterpriseMember | null>(null);
  const [granting, setGranting] = useState<EnterpriseMember | null>(null);
  /**
   * 移出后的处置结果。单独留一份 state 而非只弹 toast：
   * vacatedDepartments 非空意味着有部门失去了负责人 ——
   * 那是需要管理员补指派的动作，一闪而过的 toast 藏不住这件事。
   */
  const [offboarded, setOffboarded] = useState<
    (OffboardResult & { name: string }) | null
  >(null);

  // 新建表单
  const [newForm, setNewForm] = useState({
    email: '', name: '', role: 'MEMBER' as 'ENTERPRISE_ADMIN' | 'MEMBER',
    departmentId: '', position: '',
  });

  // 编辑表单
  const [editForm, setEditForm] = useState({
    role: 'MEMBER' as 'ENTERPRISE_ADMIN' | 'MEMBER',
    departmentId: '' as string | null,
    position: '' as string | null,
  });

  const handleAdd = () => {
    if (!newForm.email) return;
    createMember.mutate(
      {
        email: newForm.email,
        name: newForm.name || undefined,
        role: newForm.role,
        departmentId: newForm.departmentId || undefined,
        position: newForm.position || undefined,
      },
      {
        onSuccess: () => {
          toast.success('成员已添加');
          setAdding(false);
          setNewForm({ email: '', name: '', role: 'MEMBER', departmentId: '', position: '' });
        },
        onError: (e) => toast.error(e instanceof ApiError ? e.message : '添加失败'),
      },
    );
  };

  const handleEdit = () => {
    if (!editing) return;
    updateMember.mutate(
      {
        id: editing.id,
        role: editForm.role,
        departmentId: editForm.departmentId || null,
        position: editForm.position || null,
      },
      {
        onSuccess: () => { toast.success('已更新'); setEditing(null); },
        onError: (e) => toast.error(e instanceof ApiError ? e.message : '更新失败'),
      },
    );
  };

  const handleRemove = () => {
    if (!removing) return;
    const name = removing.user.name || removing.user.email;
    deleteMember.mutate(removing.id, {
      onSuccess: (result) => {
        setRemoving(null);
        // 有部门失去负责人时留在弹窗里让管理员补指派，
        // 否则一条 toast 收尾即可
        if (result.vacatedDepartments.length > 0) {
          setOffboarded({ ...result, name });
        } else {
          toast.success(
            result.reclaimedGrants > 0
              ? `已移出 ${name}，回收 ${result.reclaimedGrants} 个硅基员工席位`
              : `已移出 ${name}`,
          );
        }
      },
      onError: (e) => toast.error(e instanceof ApiError ? e.message : '移出失败'),
    });
  };

  if (isLoading) return <MembersSkeleton />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{member.list}</h1>
          <p className="mt-1 text-sm text-fg-muted">企业成员管理</p>
        </div>
        {isAdmin && tab === 'members' && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" /> 直接添加
          </Button>
        )}
      </div>

      {members.length > 0 && <MemberStats members={members} />}

      {isAdmin && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'members' | 'invitations')}>
          <TabsList>
            <TabsTrigger value="members">成员 {members.length}</TabsTrigger>
            <TabsTrigger value="invitations">
              邀请{pendingInvites > 0 ? ` ${pendingInvites}` : ''}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      {tab === 'invitations' && isAdmin ? (
        <InvitationPanel depts={depts} />
      ) : members.length === 0 ? (
        <EmptyState icon={<Users className="h-8 w-8" />} title="还没有成员" />
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-background shadow-sm overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>成员</TableHead>
                  <TableHead>角色</TableHead>
                  <TableHead>部门</TableHead>
                  <TableHead>职位</TableHead>
                  {isAdmin && <TableHead className="w-[100px]" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar
                          name={m.user.name || m.user.email}
                          src={m.user.avatar}
                          className="h-9 w-9 shrink-0 text-xs shadow-sm"
                        />
                        <div>
                          <p className="font-medium text-foreground">{m.user.name || '—'}</p>
                          <p className="text-xs text-fg-muted">{m.user.email}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge className={
                        m.role === 'ENTERPRISE_ADMIN'
                          ? 'bg-primary/10 text-primary shadow-sm'
                          : 'bg-muted text-fg-muted'
                      }>
                        {ROLE_LABEL[m.role] ?? m.role}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-fg-muted">
                      {m.department
                        ? m.department.parent
                          ? `${m.department.parent.name} > ${m.department.name}`
                          : m.department.name
                        : '—'}
                    </TableCell>
                    <TableCell className="text-sm text-fg-muted">{m.position ?? '—'}</TableCell>
                    {isAdmin && (
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <button
                            title="授权硅基员工"
                            aria-label={`为 ${m.user.name || m.user.email} 授权硅基员工`}
                            onClick={() => setGranting(m)}
                            className="rounded p-2 text-fg-muted transition-colors hover:bg-primary/10 hover:text-primary"
                          >
                            <KeyRound className="h-4 w-4" />
                          </button>
                          <button
                            title="编辑"
                            onClick={() => {
                              setEditing(m);
                              setEditForm({
                                role: (m.role === 'ENTERPRISE_ADMIN' ? 'ENTERPRISE_ADMIN' : 'MEMBER'),
                                departmentId: m.department?.id ?? null,
                                position: m.position,
                              });
                            }}
                            className="rounded p-2 text-fg-muted transition-colors hover:bg-muted hover:text-foreground"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            title="移出企业"
                            onClick={() => setRemoving(m)}
                            className="rounded p-2 text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* 添加成员 */}
      {adding && (
        <Modal title="添加成员" onClose={() => setAdding(false)}>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium">邮箱 *</label>
              <Input
                type="email"
                placeholder="member@company.com"
                value={newForm.email}
                onChange={(e) => setNewForm((f) => ({ ...f, email: e.target.value }))}
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">姓名</label>
              <Input
                placeholder="可选"
                value={newForm.name}
                onChange={(e) => setNewForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">角色</label>
              <select
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
                value={newForm.role}
                onChange={(e) => setNewForm((f) => ({ ...f, role: e.target.value as 'ENTERPRISE_ADMIN' | 'MEMBER' }))}
              >
                <option value="MEMBER">普通成员</option>
                <option value="ENTERPRISE_ADMIN">企业管理员</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">部门</label>
              <select
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
                value={newForm.departmentId}
                onChange={(e) => setNewForm((f) => ({ ...f, departmentId: e.target.value }))}
              >
                <option value="">不分配部门</option>
                {flatDepts.map((d) => (
                  <option key={d.id} value={d.id}>{d.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">职位</label>
              <Input
                placeholder="可选，如：高级工程师"
                value={newForm.position}
                onChange={(e) => setNewForm((f) => ({ ...f, position: e.target.value }))}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>取消</Button>
              <Button
                size="sm"
                onClick={handleAdd}
                disabled={createMember.isPending || !newForm.email}
              >
                添加
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* 编辑角色/部门/职位 */}
      {editing && (
        <Modal
          title={`编辑成员 · ${editing.user.name || editing.user.email}`}
          onClose={() => setEditing(null)}
        >
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium">角色</label>
              <select
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
                value={editForm.role}
                onChange={(e) => setEditForm((f) => ({ ...f, role: e.target.value as 'ENTERPRISE_ADMIN' | 'MEMBER' }))}
              >
                <option value="MEMBER">普通成员</option>
                <option value="ENTERPRISE_ADMIN">企业管理员</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">部门</label>
              <select
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
                value={editForm.departmentId ?? ''}
                onChange={(e) => setEditForm((f) => ({ ...f, departmentId: e.target.value || null }))}
              >
                <option value="">不分配部门</option>
                {flatDepts.map((d) => (
                  <option key={d.id} value={d.id}>{d.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">职位</label>
              <Input
                placeholder="如：高级工程师"
                value={editForm.position ?? ''}
                onChange={(e) => setEditForm((f) => ({ ...f, position: e.target.value || null }))}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>取消</Button>
              <Button size="sm" onClick={handleEdit} disabled={updateMember.isPending}>
                保存
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* 移出确认 */}
      {removing && (
        <Modal title="移出企业" onClose={() => setRemoving(null)}>
          <div className="space-y-4">
            <p className="text-sm text-fg-muted">
              确定将{' '}
              <span className="font-medium text-foreground">
                {removing.user.name || removing.user.email}
              </span>{' '}
              从企业移出？
            </p>
            {/* 说清「回收什么、留下什么」——
                管理员最担心的是"移出会不会把资料一起带走" */}
            <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3 text-xs">
              <div>
                <p className="font-medium text-foreground">会立即回收</p>
                <p className="mt-0.5 text-fg-muted">
                  其个人的硅基员工席位、${common.status.pendingApproval}的申请；若其为部门负责人，该部门将暂时空缺。
                </p>
              </div>
              <div>
                <p className="font-medium text-foreground">保留在企业</p>
                <p className="mt-0.5 text-fg-muted">
                  知识库、技能配置、工作记录与审批历史全部留下，其 User 账号也保留。
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setRemoving(null)}>取消</Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleRemove}
                disabled={deleteMember.isPending}
              >
                确认移出
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* 移出后：部门失去负责人，需管理员补指派 */}
      {offboarded && (
        <Modal title="已移出，有部门待指派负责人" onClose={() => setOffboarded(null)}>
          <div className="space-y-4">
            <p className="text-sm text-fg-muted">
              <span className="font-medium text-foreground">{offboarded.name}</span>{' '}
              已移出企业
              {offboarded.reclaimedGrants > 0 &&
                `，回收 ${offboarded.reclaimedGrants} 个硅基员工席位`}
              {offboarded.canceledRequests > 0 &&
                `，取消 ${offboarded.canceledRequests} 条${common.status.pendingApproval}申请`}
              。
            </p>
            <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <div className="text-xs">
                <p className="font-medium text-foreground">
                  以下部门当前没有负责人，请到「部门管理」重新指派：
                </p>
                <ul className="mt-1.5 space-y-0.5 text-fg-muted">
                  {offboarded.vacatedDepartments.map((d) => (
                    <li key={d.id}>· {d.name}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setOffboarded(null)}>
                知道了
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {granting && (
        <MemberEmployeeGrantPanel member={granting} onClose={() => setGranting(null)} />
      )}
    </div>
  );
}

function MembersSkeleton() {
  return (
    <div className="space-y-6">
      {/* Header skeleton */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <div className="h-8 w-32 animate-pulse rounded-md bg-muted" />
          <div className="h-4 w-40 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="h-9 w-24 animate-pulse rounded-md bg-muted" />
      </div>

      {/* Stats skeleton */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-32 animate-pulse rounded-lg border border-border bg-muted/30"
          />
        ))}
      </div>

      {/* Table skeleton */}
      <div className="rounded-lg border border-border bg-background shadow-sm overflow-hidden">
        <div className="border-b border-border bg-muted/40 px-4 py-3">
          <div className="flex gap-4">
            <div className="h-4 w-16 animate-pulse rounded bg-muted" />
            <div className="h-4 w-16 animate-pulse rounded bg-muted" />
            <div className="h-4 w-16 animate-pulse rounded bg-muted" />
            <div className="h-4 w-16 animate-pulse rounded bg-muted" />
          </div>
        </div>
        <div className="divide-y divide-border">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="px-4 py-3.5 flex items-center gap-4">
              <div className="h-9 w-9 animate-pulse rounded-full bg-muted" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-24 animate-pulse rounded bg-muted" />
                <div className="h-3 w-32 animate-pulse rounded bg-muted" />
              </div>
              <div className="h-6 w-20 animate-pulse rounded bg-muted" />
              <div className="h-6 w-16 animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

