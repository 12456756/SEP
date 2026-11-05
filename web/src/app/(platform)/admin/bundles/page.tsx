'use client';

import { useMemo, useRef, useState } from 'react';
import { Archive, Edit2, ImagePlus, Package, Plus, Rocket, Search, Sparkles, Trash2, X } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, Skeleton } from '@/components/ui/feedback';
import { toast } from '@/components/ui/toast';
import { adminApi } from '@/features/admin/admin-api';
import type { EmployeeListItem } from '@/features/admin/admin-api';
import { useQuery } from '@tanstack/react-query';
import { EMPLOYEE_CATEGORIES, type EmployeeCategory } from '@/lib/employee-categories';
import { CreateEmployeeBundleDtoSchema, MAX_BUNDLE_COVER_SIZE } from 'shared/employee-bundle.dto';
import {
  useAdminEmployeeBundles,
  useArchiveEmployeeBundle,
  useCreateEmployeeBundle,
  usePublishEmployeeBundle,
  useUpdateEmployeeBundle,
  useGenerateBundleDescription,
  useUploadBundleCover,
  type BundleInput,
  type EmployeeBundle,
  type EmployeeBundleStatus,
} from '@/features/employee-bundle/use-employee-bundles';

const money = (value: string | number) => Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2 });
const statusLabel: Record<EmployeeBundleStatus, string> = { DRAFT: '草稿', PUBLISHED: '已发布', ARCHIVED: '已下架' };

const blank = (): BundleInput => ({ name: '', description: '', priceCNY: 0, periodMonths: 12, items: [], autoIncludeAll: false, autoIncludeCategories: [], autoExcludeEmployeeIds: [] });

export default function AdminBundlesPage() {
  const [status, setStatus] = useState<EmployeeBundleStatus | undefined>();
  const [editing, setEditing] = useState<EmployeeBundle | null>(null);
  const [form, setForm] = useState<BundleInput>(blank);
  const [formOpen, setFormOpen] = useState(false);
  const [category, setCategory] = useState('ALL');
  const [search, setSearch] = useState('');
  const [generatedModel, setGeneratedModel] = useState('');
  const formSession = useRef(0);
  const draftContext = useRef('');
  draftContext.current = JSON.stringify([form.name, form.items, form.description]);
  const { data: bundles = [], isLoading, error } = useAdminEmployeeBundles(status);
  const employeesQuery = useQuery({
    queryKey: ['admin', 'employees', 'bundle-picker'],
    queryFn: async () => {
      const firstPage = await adminApi.listEmployees({ status: 'APPROVED', page: 1, pageSize: 100, sortBy: 'name', sortOrder: 'asc' });
      const remainingPages = await Promise.all(Array.from(
        { length: Math.max(firstPage.totalPages - 1, 0) },
        (_, index) => adminApi.listEmployees({ status: 'APPROVED', page: index + 2, pageSize: 100, sortBy: 'name', sortOrder: 'asc' }),
      ));
      return [firstPage, ...remainingPages].flatMap((page) => page.data);
    },
  });
  const employees = employeesQuery.data ?? [];
  const create = useCreateEmployeeBundle();
  const update = useUpdateEmployeeBundle();
  const publish = usePublishEmployeeBundle();
  const archive = useArchiveEmployeeBundle();
  const generateDescription = useGenerateBundleDescription();
  const uploadCover = useUploadBundleCover();
  const saving = create.isPending || update.isPending;

  const selectedEmployees = useMemo(() => {
    const excluded = new Set(form.autoExcludeEmployeeIds ?? []);
    return new Set([
      ...form.items.map((item) => item.employeeId),
      ...employees.filter((employee) => !excluded.has(employee.id) && (
        form.autoIncludeAll || form.autoIncludeCategories?.includes(employee.functionalCategory as EmployeeCategory)
      )).map((employee) => employee.id),
    ]);
  }, [employees, form.autoExcludeEmployeeIds, form.autoIncludeAll, form.autoIncludeCategories, form.items]);
  const filteredEmployees = employees.filter((employee) =>
    (category === 'ALL' || (category === 'OTHER' ? !EMPLOYEE_CATEGORIES.some((item) => item.value === employee.functionalCategory) : employee.functionalCategory === category))
    && `${employee.name} ${employee.position ?? ''}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const filteredSelectedCount = filteredEmployees.filter((employee) => selectedEmployees.has(employee.id)).length;

  function resetEditor() {
    formSession.current += 1;
    setCategory('ALL');
    setSearch('');
    setGeneratedModel('');
    generateDescription.reset();
    uploadCover.reset();
  }

  function closeEditor() {
    resetEditor();
    setEditing(null);
    setForm(blank());
    setFormOpen(false);
  }

  function openCreate() {
    resetEditor();
    setEditing(null);
    setForm(blank());
    setFormOpen(true);
  }

  function openEdit(bundle: EmployeeBundle) {
    resetEditor();
    setEditing(bundle);
    setFormOpen(true);
    setForm({
      name: bundle.name,
      description: bundle.description ?? '',
      cover: bundle.cover ?? undefined,
      priceCNY: Number(bundle.priceCNY),
      periodMonths: bundle.periodMonths,
      autoIncludeAll: bundle.autoIncludeAll ?? false,
      autoIncludeCategories: bundle.autoIncludeCategories ?? [],
      autoExcludeEmployeeIds: bundle.autoExcludeEmployeeIds ?? [],
      items: bundle.items.map((item) => ({ employeeId: item.employeeId, periodMonths: item.periodMonths })),
    });
  }

  function toggleEmployee(employeeId: string) {
    setForm((current) => ({
      ...current,
      autoExcludeEmployeeIds: current.items.some((item) => item.employeeId === employeeId)
        ? [...new Set([...(current.autoExcludeEmployeeIds ?? []), employeeId])]
        : (current.autoExcludeEmployeeIds ?? []).filter((id) => id !== employeeId),
      items: current.items.some((item) => item.employeeId === employeeId)
        ? current.items.filter((item) => item.employeeId !== employeeId)
        : [...current.items, { employeeId, periodMonths: current.periodMonths }],
    }));
  }

  function toggleFilteredEmployees() {
    const ids = new Set(filteredEmployees.map((employee) => employee.id));
    const allSelected = filteredSelectedCount === filteredEmployees.length;
    const additions = filteredEmployees.filter((employee) => !selectedEmployees.has(employee.id));
    setForm((current) => {
      let autoIncludeAll = current.autoIncludeAll ?? false;
      let autoIncludeCategories = current.autoIncludeCategories ?? [];
      if (!search.trim() && category === 'ALL') {
        autoIncludeAll = !allSelected;
        autoIncludeCategories = [];
      } else if (!search.trim() && category !== 'OTHER') {
        const selectedCategory = category as EmployeeCategory;
        if (allSelected) {
          autoIncludeCategories = (autoIncludeAll ? EMPLOYEE_CATEGORIES.map((item) => item.value) : autoIncludeCategories)
            .filter((value) => value !== selectedCategory);
          autoIncludeAll = false;
        } else if (!autoIncludeAll) {
          autoIncludeCategories = [...new Set([...autoIncludeCategories, selectedCategory])];
        }
      }
      return { ...current, autoIncludeAll, autoIncludeCategories,
        autoExcludeEmployeeIds: allSelected
          ? [...new Set([...(current.autoExcludeEmployeeIds ?? []), ...ids])]
          : (current.autoExcludeEmployeeIds ?? []).filter((id) => !ids.has(id)),
        items: allSelected
          ? current.items.filter((item) => !ids.has(item.employeeId))
          : [...current.items, ...additions.map((employee) => ({ employeeId: employee.id, periodMonths: current.periodMonths }))],
      };
    });
  }

  async function generateDraft() {
    const input = { name: form.name.trim(), employeeIds: form.items.map((item) => item.employeeId) };
    const session = formSession.current;
    const context = draftContext.current;
    try {
      const result = await generateDescription.mutateAsync(input);
      if (session !== formSession.current) return;
      if (context !== draftContext.current) {
        toast.error('套餐内容已修改，请重新生成说明');
        return;
      }
      setForm((current) => ({ ...current, description: result.draft }));
      setGeneratedModel(result.modelId);
    } catch (error) {
      if (session === formSession.current) toast.error(error instanceof Error ? error.message : '套餐说明生成失败');
    }
  }

  async function uploadImage(file: File) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > MAX_BUNDLE_COVER_SIZE) {
      toast.error('请选择 5MB 以内的 PNG、JPEG 或 WebP 图片');
      return;
    }
    const session = formSession.current;
    try {
      const result = await uploadCover.mutateAsync(file);
      if (session === formSession.current) setForm((current) => ({ ...current, cover: result.cover }));
    } catch (error) {
      if (session === formSession.current) toast.error(error instanceof Error ? error.message : '封面上传失败');
    }
  }

  async function save() {
    const parsed = CreateEmployeeBundleDtoSchema.safeParse(form);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? '请检查套餐信息');
      return;
    }
    try {
      if (editing) await update.mutateAsync({ id: editing.id, input: parsed.data });
      else await create.mutateAsync(parsed.data);
      toast.success(editing ? '套餐已更新' : '套餐草稿已创建');
      closeEditor();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    }
  }

  async function runAction(action: () => Promise<unknown>, success: string) {
    try { await action(); toast.success(success); }
    catch (error) { toast.error(error instanceof Error ? error.message : '操作失败'); }
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div><h1 className="text-2xl font-semibold">员工套餐</h1><p className="mt-1 text-sm text-gtext-muted">管理固定员工组合、套餐价格和市场发布状态。</p></div>
        <Button onClick={openCreate} disabled={saving}><Plus className="mr-2 h-4 w-4" />新建套餐</Button>
      </header>

      {formOpen ? (
        <section className="space-y-5 border-y border-glassline py-5" aria-label="套餐编辑">
            <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">{editing ? '编辑套餐草稿' : '新建套餐'}</h2><Button variant="ghost" size="icon" aria-label="关闭编辑" disabled={saving} onClick={closeEditor}><X className="h-4 w-4" /></Button></div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <label className="space-y-1.5 text-sm">套餐名称<Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} /></label>
              <label className="space-y-1.5 text-sm">套餐价格（元）<Input type="number" min="0.01" step="0.01" value={form.priceCNY || ''} onChange={(e) => setForm({ ...form, priceCNY: Number(e.target.value) })} /></label>
              <label className="space-y-1.5 text-sm">默认周期（月）<Input type="number" min="1" max="36" value={form.periodMonths} onChange={(e) => setForm({ ...form, periodMonths: Number(e.target.value) })} /></label>
              <div className="space-y-1.5 text-sm sm:col-span-2 lg:col-span-3">
                <div className="flex flex-wrap items-center justify-between gap-2"><label htmlFor="bundle-description">套餐说明</label><Button variant="outline" size="sm" onClick={generateDraft} loading={generateDescription.isPending} disabled={saving || !form.name.trim() || form.items.length === 0}><Sparkles className="mr-1.5 h-4 w-4" />AI 生成说明</Button></div>
                <Textarea id="bundle-description" value={form.description ?? ''} onChange={(e) => { setForm({ ...form, description: e.target.value }); setGeneratedModel(''); }} rows={4} maxLength={5000} />
                {generatedModel && <p className="break-all text-xs text-gtext-muted">当前生成模型：{generatedModel}</p>}
              </div>
              <div className="space-y-2 text-sm sm:col-span-2 lg:col-span-3">
                <p>套餐封面（可选）</p>
                <div className="flex flex-wrap items-center gap-4">
                  {form.cover && <img src={form.cover} alt="套餐封面预览" className="aspect-video w-48 max-w-full rounded border border-glassline object-cover" />}
                  <div className="space-y-2"><div className="flex flex-wrap items-center gap-2">
                    <label className={`inline-flex cursor-pointer items-center gap-2 rounded border border-glassline px-3 py-2 text-sm ${uploadCover.isPending || saving ? 'pointer-events-none opacity-50' : 'hover:bg-glass-1'}`}>
                      <ImagePlus className="h-4 w-4" />{uploadCover.isPending ? '上传中…' : form.cover ? '更换封面' : '上传封面'}
                      <input aria-label="上传套餐封面" type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" disabled={uploadCover.isPending || saving} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void uploadImage(file); }} />
                    </label>
                    {form.cover && <Button variant="ghost" size="icon" aria-label="移除封面" title="移除封面" disabled={uploadCover.isPending || saving} onClick={() => setForm((current) => ({ ...current, cover: null }))}><Trash2 className="h-4 w-4" /></Button>}
                  </div><p className="text-xs text-gtext-muted">PNG、JPEG、WebP，最大 5MB</p></div>
                </div>
              </div>
            </div>
            <div className="space-y-2"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold">套餐员工</h3><span className="text-xs text-gtext-muted">已选 {form.items.length} 位</span></div>
              <div className="flex flex-wrap items-center gap-3">
                <select aria-label="员工分类" value={category} onChange={(event) => setCategory(event.target.value)} className="h-10 max-w-full rounded border border-glassline bg-glass-1 px-3 text-sm">
                  <option value="ALL">全部分类（{employees.length}）</option>
                  {EMPLOYEE_CATEGORIES.map((item) => <option key={item.value} value={item.value}>{item.label}（{employees.filter((employee) => employee.functionalCategory === item.value).length}）</option>)}
                  {employees.some((employee) => !EMPLOYEE_CATEGORIES.some((item) => item.value === employee.functionalCategory)) && <option value="OTHER">未分类</option>}
                </select>
                <div className="relative min-w-0 flex-1 basis-48"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-gtext-muted" /><Input aria-label="搜索员工" placeholder="搜索员工名称或岗位" value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" /></div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 py-1">
                <label className="flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" aria-label="全选当前结果" className="h-4 w-4 accent-[var(--gbrand-text)]" checked={filteredEmployees.length > 0 && filteredSelectedCount === filteredEmployees.length} ref={(element) => { if (element) element.indeterminate = filteredSelectedCount > 0 && filteredSelectedCount < filteredEmployees.length; }} disabled={filteredEmployees.length === 0} onChange={toggleFilteredEmployees} />全选当前结果（{filteredEmployees.length}）</label>
                <Button variant="ghost" size="sm" disabled={form.items.length === 0 && !form.autoIncludeAll && !form.autoIncludeCategories?.length} onClick={() => setForm((current) => ({ ...current, items: [], autoIncludeAll: false, autoIncludeCategories: [], autoExcludeEmployeeIds: [] }))}>清空已选</Button>
              </div>
              {(form.autoIncludeAll || !!form.autoIncludeCategories?.length) && <div className="flex flex-wrap gap-2" aria-label="自动加入范围">
                {(form.autoIncludeAll ? [{ value: 'ALL', label: '全部员工' }] : EMPLOYEE_CATEGORIES.filter((item) => form.autoIncludeCategories?.includes(item.value))).map((scope) => <span key={scope.value} className="inline-flex items-center gap-1 rounded border border-glassline px-2 py-1 text-xs">自动加入：{scope.label}<Button variant="ghost" size="icon" className="h-5 w-5" aria-label={`取消自动加入${scope.label}`} title={`取消自动加入${scope.label}`} onClick={() => setForm((current) => ({ ...current, autoIncludeAll: scope.value === 'ALL' ? false : current.autoIncludeAll, autoIncludeCategories: current.autoIncludeCategories?.filter((value) => value !== scope.value) }))}><X className="h-3 w-3" /></Button></span>)}
              </div>}
              {employeesQuery.isLoading ? <Skeleton className="h-20" /> : employeesQuery.error ? <p className="text-sm text-danger">员工列表加载失败</p> : filteredEmployees.length === 0 ? <p className="py-6 text-center text-sm text-gtext-muted">{employees.length ? '没有符合条件的员工' : '暂无已审核上架员工。'}</p> : <div className="grid max-h-80 gap-2 overflow-auto sm:grid-cols-2">{filteredEmployees.map((employee) => <EmployeeChoice key={employee.id} employee={employee} selected={selectedEmployees.has(employee.id)} onToggle={() => toggleEmployee(employee.id)} />)}</div>}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-glassline pt-4"><p className="text-sm text-gtext-muted">已选员工原价约 ¥{money(employees.filter((employee) => selectedEmployees.has(employee.id)).reduce((total, employee) => total + Number(employee.annualPriceCNY ?? 0) * (form.items.find((item) => item.employeeId === employee.id)?.periodMonths ?? form.periodMonths) / 12, 0))}</p><div className="flex gap-2"><Button variant="outline" disabled={saving} onClick={closeEditor}>取消</Button><Button onClick={save} disabled={saving || uploadCover.isPending || generateDescription.isPending || form.items.length === 0 || !form.name.trim() || form.priceCNY <= 0}>{saving ? '保存中…' : '保存草稿'}</Button></div></div>
        </section>
      ) : null}

      <div className="flex gap-1 border-b border-glassline">{([undefined, 'DRAFT', 'PUBLISHED', 'ARCHIVED'] as const).map((value) => <button key={value ?? 'ALL'} onClick={() => setStatus(value)} className={`border-b-2 px-4 py-2 text-sm ${status === value ? 'border-gbrand-text font-medium text-gbrand-text' : 'border-transparent text-gtext-muted hover:text-gtext-primary'}`}>{value ? statusLabel[value] : '全部套餐'}</button>)}</div>
      {isLoading ? <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}</div> : error ? <EmptyState title="套餐列表加载失败" description={error instanceof Error ? error.message : '请稍后重试'} /> : bundles.length === 0 ? <EmptyState icon={<Package className="h-8 w-8" />} title="没有符合条件的套餐" description="创建套餐草稿后，可预览金额并发布到市场。" /> : (
        <div className="divide-y divide-glassline border-y border-glassline">
          {bundles.map((bundle) => <article key={bundle.id} className="grid gap-4 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{bundle.name}</h2><Badge variant={bundle.status === 'PUBLISHED' ? 'default' : 'secondary'}>{statusLabel[bundle.status]}</Badge><span className="text-xs text-gtext-muted">{bundle.code}</span></div><div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-gtext-secondary"><span>{bundle.items.length} 位员工</span><span>原价 ¥{money(bundle.originalAmountCNY)}</span><span>套餐 ¥{money(bundle.priceCNY)}</span><span>算力 ¥{money(bundle.totalComputeCNY)}</span></div><div className="mt-3 flex flex-wrap gap-2">{bundle.items.map((item) => <span key={item.id} className="inline-flex items-center gap-1.5 rounded border border-glassline px-2 py-1 text-xs"><Avatar name={item.employeeName} src={item.employeeAvatar} className="h-5 w-5" />{item.employeeName}</span>)}</div></div><div className="flex gap-2">{bundle.status !== 'PUBLISHED' && <Button variant="outline" size="sm" onClick={() => openEdit(bundle)}><Edit2 className="mr-1.5 h-3.5 w-3.5" />编辑</Button>}{bundle.status !== 'PUBLISHED' && <Button size="sm" onClick={() => runAction(() => publish.mutateAsync(bundle.id), '套餐已发布')}><Rocket className="mr-1.5 h-3.5 w-3.5" />发布</Button>}{bundle.status === 'PUBLISHED' && <Button variant="outline" size="sm" onClick={() => runAction(() => archive.mutateAsync(bundle.id), '套餐已下架')}><Archive className="mr-1.5 h-3.5 w-3.5" />下架</Button>}</div></article>)}
        </div>
      )}
    </div>
  );
}

function EmployeeChoice({ employee, selected, onToggle }: { employee: EmployeeListItem; selected: boolean; onToggle: () => void }) {
  return <label className={`flex cursor-pointer items-center gap-3 rounded border p-3 transition-colors ${selected ? 'border-gbrand-text bg-gbrand/5' : 'border-glassline hover:bg-glass-1'}`}><input type="checkbox" checked={selected} onChange={onToggle} className="h-4 w-4 accent-[var(--gbrand-text)]" /><Avatar name={employee.name} src={employee.avatar} className="h-9 w-9" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{employee.name}</span><span className="text-xs text-gtext-muted">{employee.position}</span></span><span className="shrink-0 text-sm">¥{money(employee.annualPriceCNY ?? 0)}/年</span></label>;
}
