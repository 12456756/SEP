'use client';

import { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export interface EmployeeCapabilityOption {
  id: string;
  name: string;
  description?: string | null;
  type: string;
}

interface EmployeeCapabilityPickerProps {
  capabilities: EmployeeCapabilityOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  isLoading?: boolean;
  isError?: boolean;
}

const CAPABILITY_TYPES = ['AGENT', 'SKILL', 'RPA', 'AI_APP'];

export function EmployeeCapabilityPicker({ capabilities, selectedIds, onChange, isLoading, isError }: EmployeeCapabilityPickerProps) {
  const [search, setSearch] = useState('');
  const [type, setType] = useState('all');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleCapabilities = useMemo(() => capabilities.filter((capability) => {
    if (selectedOnly && !selectedIds.includes(capability.id)) return false;
    if (type !== 'all' && capability.type !== type) return false;
    if (!normalizedSearch) return true;
    return `${capability.name} ${capability.description ?? ''} ${capability.type}`.toLocaleLowerCase().includes(normalizedSearch);
  }), [capabilities, normalizedSearch, selectedIds, selectedOnly, type]);

  const toggle = (capabilityId: string, checked: boolean) => {
    onChange(checked
      ? selectedIds.includes(capabilityId) ? selectedIds : [...selectedIds, capabilityId]
      : selectedIds.filter((id) => id !== capabilityId));
  };

  return (
    <section className="space-y-3" aria-label="绑定能力">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-medium">绑定能力 *</h3>
          <p className="text-sm text-muted-foreground">选择此员工可以使用的能力，至少选择一个。</p>
        </div>
        <Badge variant="secondary" aria-live="polite">已选 {selectedIds.length}</Badge>
      </div>

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_160px_auto]">
        <div className="relative">
          <Search aria-hidden="true" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="搜索能力" placeholder="搜索名称、说明或类型" className="pl-9 pr-9" value={search} onChange={(event) => setSearch(event.target.value)} />
          {search && <Button type="button" variant="ghost" size="icon" aria-label="清除能力搜索" className="absolute right-1 top-1 h-8 w-8" onClick={() => setSearch('')}><X className="h-4 w-4" /></Button>}
        </div>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger aria-label="按能力类型筛选"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类型</SelectItem>
            {CAPABILITY_TYPES.map((capabilityType) => <SelectItem key={capabilityType} value={capabilityType}>{capabilityType}</SelectItem>)}
          </SelectContent>
        </Select>
        <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={selectedOnly} onChange={(event) => setSelectedOnly(event.target.checked)} />
          仅看已选
        </label>
      </div>

      <p className="text-xs text-muted-foreground">按选择顺序设置能力优先级，可在高级管理中调整。</p>

      {isLoading ? <div role="status" className="py-8 text-center text-sm text-muted-foreground">加载能力列表...</div>
        : isError ? <div role="alert" className="py-8 text-center text-sm text-destructive">能力列表加载失败，请刷新页面重试。</div>
          : capabilities.length === 0 ? <div role="status" className="py-8 text-center text-sm text-muted-foreground">暂无可用能力</div>
            : <div className="max-h-[55vh] overflow-y-auto overscroll-contain rounded-md border p-2 md:max-h-[480px]" aria-label="可绑定能力列表">
              {visibleCapabilities.length ? <div className="grid gap-2 sm:grid-cols-2">
                {visibleCapabilities.map((capability) => {
                  const checked = selectedIds.includes(capability.id);
                  return <label key={capability.id} className={cn('flex min-h-32 cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors', checked ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50')}>
                    <input type="checkbox" className="mt-1" checked={checked} onChange={(event) => toggle(capability.id, event.target.checked)} aria-label={capability.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{capability.name}</span>
                      <span className="mt-1 line-clamp-3 block break-words text-sm text-muted-foreground">{capability.description || '暂无说明'}</span>
                      <Badge variant="secondary" className="mt-2">{capability.type}</Badge>
                    </span>
                  </label>;
                })}
              </div> : <div role="status" className="py-8 text-center text-sm text-muted-foreground">没有匹配的能力。清除筛选后查看全部能力。</div>}
            </div>}

      {selectedIds.length === 0 && <p className="text-sm text-gdanger">* 请至少选择一个能力</p>}
    </section>
  );
}
