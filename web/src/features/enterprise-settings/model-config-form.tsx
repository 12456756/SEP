'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2 } from 'lucide-react';
import { ModelWhitelistPicker } from './model-whitelist-picker';
import type { EnterpriseModelConfig, PlatformModel } from './use-model-config';
import type {
  UpdateEnterpriseModelConfigDto,
  EmployeeModelPolicy,
} from '@/lib/types';

/** Radix Select 不接受空字符串，用哨兵表示跟随企业默认。 */
const FOLLOW_ENTERPRISE = '__enterprise__';

interface ModelConfigFormProps {
  config: EnterpriseModelConfig;
  availableModels: PlatformModel[];
  onSave: (dto: UpdateEnterpriseModelConfigDto) => void;
  isSaving: boolean;
  readOnly?: boolean;
}

/** 表单内部状态。`plannerModel` 用哨兵表示跟随企业默认。 */
type FormState = {
  defaultChatModel: string;
  allowedChatModels: string[];
  allowUserSwitchModel: boolean;
  employeeModelPolicy: EmployeeModelPolicy;
  employeeDefaultModel: string | null;
  plannerModel: string;
};

function toFormState(config: EnterpriseModelConfig): FormState {
  return {
    defaultChatModel: config.defaultChatModel,
    allowedChatModels: config.allowedChatModels,
    allowUserSwitchModel: config.allowUserSwitchModel,
    employeeModelPolicy: config.employeeModelPolicy,
    employeeDefaultModel: config.employeeDefaultModel,
    plannerModel: config.plannerModel ?? FOLLOW_ENTERPRISE,
  };
}

/**
 * 模型配置表单。
 *
 * 三个 Tab：会话模型 / 员工模型 / 编排模型。知识库处理参数由平台统一维护。
 *
 * 「预算控制」已删除（2026-09-05）：它的拦截读的是对话链路早已不写的
 * compute_transactions，告警读的 cost_daily_rollups 在本地与生产都是 0 行，
 * 且从来没有企业设过预算 —— 一个按下去什么都不会发生的开关。花钱管控由
 * 「算力余额」页的三层承担（企业钱包 / 订阅赠送算力 / 成员算力额度）。
 */
export function ModelConfigForm({
  config,
  availableModels,
  onSave,
  isSaving,
  readOnly = false,
}: ModelConfigFormProps) {
  const initial = useMemo(() => toFormState(config), [config]);
  const [form, setForm] = useState<FormState>(initial);
  const [activeTab, setActiveTab] = useState('chat');

  const patch = (next: Partial<FormState>) => setForm((f) => ({ ...f, ...next }));

  const isDirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(initial),
    [form, initial],
  );

  // PlatformModel.category 目前几乎全为 null（同步任务还没补元数据），
  // 所以「非 embedding 即可用于会话」比「category === 'chat'」更贴近现实，
  // 否则白名单会是空列表。
  const chatModels = useMemo(
    () => availableModels.filter((m) => m.category !== 'embedding'),
    [availableModels],
  );
  const labelOf = (modelId: string) =>
    availableModels.find((m) => m.modelId === modelId)?.label ?? modelId;
  const selectedIds = [...new Set([form.defaultChatModel, ...form.allowedChatModels,
    ...(form.employeeModelPolicy === 'FORCE_DEFAULT' && form.employeeDefaultModel ? [form.employeeDefaultModel] : []),
    ...(form.plannerModel !== FOLLOW_ENTERPRISE ? [form.plannerModel] : [])])].filter(Boolean);
  const unavailableIds = selectedIds.filter(id => !chatModels.some(model => model.modelId === id));

  return (
    <div className="space-y-6">
      {unavailableIds.length > 0 && <p role="alert" className="break-all text-sm text-amber-700 dark:text-amber-400">当前不可用的已选模型：{unavailableIds.join('、')}</p>}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="chat">会话模型</TabsTrigger>
          <TabsTrigger value="employee">员工模型</TabsTrigger>
          <TabsTrigger value="planner">编排模型</TabsTrigger>
        </TabsList>

        {/* ── Tab 1: 会话模型 ─────────────────────────────────────────── */}
        <TabsContent value="chat" className="mt-4 space-y-6">
          <section className="space-y-4 rounded-lg border border-border bg-card p-6">
            <div>
              <h3 className="text-lg font-semibold">默认会话模型</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                成员发起新会话时使用的默认模型
              </p>
            </div>
            <div className="space-y-2">
              <Label>模型</Label>
              <Select
                value={form.defaultChatModel}
                onValueChange={(v) => patch({ defaultChatModel: v })}
                disabled={readOnly}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectContent>
                  {chatModels.map((m) => (
                    <SelectItem key={m.modelId} value={m.modelId}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.allowedChatModels.length > 0 &&
                !form.allowedChatModels.includes(form.defaultChatModel) && (
                  <p className="text-xs text-amber-600 dark:text-amber-500">
                    默认模型不在白名单内，保存后成员将无法使用它。
                  </p>
                )}
            </div>
          </section>

          <section className="space-y-4 rounded-lg border border-border bg-card p-6">
            <div>
              <h3 className="text-lg font-semibold">可用模型白名单</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                成员在会话中可切换的模型范围。留空表示允许本企业对话 Key 下的全部可用模型。
              </p>
            </div>
            <ModelWhitelistPicker
              models={chatModels}
              selectedModels={form.allowedChatModels}
              onChange={(ids) => patch({ allowedChatModels: ids })}
              disabled={readOnly}
            />
          </section>

          <section className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-6">
            <div className="space-y-1">
              <Label htmlFor="allow-switch" className="cursor-pointer font-medium">
                允许成员自行切换模型
              </Label>
              <p className="text-sm text-muted-foreground">
                关闭后，成员会话强制使用默认模型，聊天界面不再显示模型选择器
              </p>
            </div>
            <Switch
              id="allow-switch"
              checked={form.allowUserSwitchModel}
              onCheckedChange={(v) => patch({ allowUserSwitchModel: v })}
              disabled={readOnly}
            />
          </section>
        </TabsContent>

        {/* ── Tab 2: 员工模型 ───────────────────────────────────────── */}
        <TabsContent value="employee" className="mt-4 space-y-6">
          <section className="space-y-4 rounded-lg border border-border bg-card p-6">
            <div>
              <h3 className="text-lg font-semibold">硅基员工模型策略</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                决定硅基员工执行任务时使用哪个模型
              </p>
            </div>
            <div className="space-y-2">
              <Label>策略</Label>
              <Select
                value={form.employeeModelPolicy}
                onValueChange={(v) =>
                  patch({ employeeModelPolicy: v as EmployeeModelPolicy })
                }
                disabled={readOnly}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="FOLLOW_TEMPLATE">
                    跟随员工模板（推荐）
                  </SelectItem>
                  <SelectItem value="FORCE_DEFAULT">强制使用指定模型</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {form.employeeModelPolicy === 'FOLLOW_TEMPLATE'
                  ? `员工使用自身模板配置的模型，未配置时回退到「${labelOf(form.defaultChatModel)}」。`
                  : '忽略员工模板配置，所有员工统一使用下方指定的模型。'}
              </p>
            </div>

            {form.employeeModelPolicy === 'FORCE_DEFAULT' && (
              <div className="space-y-2">
                <Label>指定模型</Label>
                <Select
                  value={form.employeeDefaultModel ?? form.defaultChatModel}
                  onValueChange={(v) => patch({ employeeDefaultModel: v })}
                  disabled={readOnly}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="选择模型" />
                  </SelectTrigger>
                  <SelectContent>
                    {chatModels.map((m) => (
                      <SelectItem key={m.modelId} value={m.modelId}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  建议选择支持 function calling 的模型，否则员工无法调用工具。
                </p>
              </div>
            )}
          </section>
        </TabsContent>

        {/* ── Tab 3: 编排模型 ─────────────────────────────────────────── */}
        <TabsContent value="planner" className="mt-4 space-y-6">
          <section className="space-y-4 rounded-lg border border-border bg-card p-6">
            <div>
              <h3 className="text-lg font-semibold">编排与分析模型</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                「工作安排」的任务拆解、迭代建议、交付物生成共用这个模型。它和会话模型
                分开设：这三件事要把大段上下文塞进提示词并输出结构化结果，成员感知不到
                延迟；会话相反，要的是快。
              </p>
            </div>
            <div className="space-y-2">
              <Label>模型</Label>
              <Select
                value={form.plannerModel}
                onValueChange={(v) => patch({ plannerModel: v })}
                disabled={readOnly}
              >
                <SelectTrigger>
                  <SelectValue placeholder="跟随企业默认" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={FOLLOW_ENTERPRISE}>跟随企业默认</SelectItem>
                  {chatModels.map((m) => (
                    <SelectItem key={m.modelId} value={m.modelId}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                必须支持 function calling 且能稳定输出 JSON —— 规划失败最常见的原因就是
                模型没按格式返回。选完建议去「工作安排」实际跑一次验证。
              </p>
            </div>
          </section>
        </TabsContent>
      </Tabs>

      {!readOnly && (
        <div className="flex items-center justify-end gap-3">
          {isDirty && (
            <span className="text-sm text-muted-foreground">有未保存的修改</span>
          )}
          <Button
            variant="ghost"
            onClick={() => setForm(initial)}
            disabled={!isDirty || isSaving}
          >
            重置
          </Button>
          <Button
            onClick={() =>
              onSave({
                ...form,
                // 哨兵值不落库；null 表示跟随企业默认。
                plannerModel:
                  form.plannerModel === FOLLOW_ENTERPRISE ? null : form.plannerModel,
              })
            }
            disabled={!isDirty || isSaving}
          >
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            保存配置
          </Button>
        </div>
      )}
    </div>
  );
}
