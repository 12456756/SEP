'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Cpu, ChevronDown, Check, Lock } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useAvailableModels } from '@/features/enterprise-settings/use-model-config';

interface ModelSwitcherProps {
  conversationId: string;
  /** 会话当前模型；null 表示用员工默认 */
  currentModelId: string | null;
  /** 员工默认模型（会话未指定时的兜底显示） */
  employeeModelId?: string | null;
  /** 企业默认模型（员工未设置时的最终兜底） */
  enterpriseDefaultModel?: string | null;
  /** 员工模型策略；强制模式下忽略员工模板模型 */
  employeeModelPolicy?: 'FOLLOW_TEMPLATE' | 'FORCE_DEFAULT';
  /** 强制员工模型策略指定的统一模型 */
  employeeDefaultModel?: string | null;
  /** 企业 ID，用于拉取可用模型白名单 */
  enterpriseId: string;
  /** 企业配置的模型白名单；空数组 = 不限制 */
  allowedChatModels?: string[];
  /** 是否允许用户切换模型；false 时显示锁图标，禁止切换 */
  canSwitch?: boolean;
}

/**
 * 对话窗口顶部的模型切换下拉。
 * - canSwitch=false 时只读展示，不可切换。
 * - allowedChatModels 非空时仅展示白名单内的模型。
 */
export function ModelSwitcher({
  conversationId,
  currentModelId,
  employeeModelId,
  enterpriseDefaultModel,
  employeeModelPolicy = 'FOLLOW_TEMPLATE',
  employeeDefaultModel,
  enterpriseId,
  allowedChatModels = [],
  canSwitch = true,
}: ModelSwitcherProps) {
  const qc = useQueryClient();
  const { data: allModels, isLoading } = useAvailableModels(enterpriseId);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 应用白名单过滤：allowedChatModels 非空时只显示白名单内的模型
  const models =
    allowedChatModels.length > 0
      ? (allModels ?? []).filter((m) => allowedChatModels.includes(m.modelId))
      : (allModels ?? []);

  const switchModel = useMutation({
    mutationFn: (modelId: string) =>
      api.patch(`/conversations/${conversationId}/model`, { modelId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.conversation(conversationId) });
      setIsOpen(false);
    },
  });

  const policyDefault =
    employeeModelPolicy === 'FORCE_DEFAULT'
      ? employeeDefaultModel ?? enterpriseDefaultModel
      : enterpriseDefaultModel ?? employeeModelId;

  // 新会话已在服务端快照企业默认模型；旧会话的 null 值也优先展示企业默认，
  // 避免界面显示员工模板模型而实际请求又走另一套默认策略。
  const effective = canSwitch
    ? currentModelId ?? policyDefault ?? ''
    : enterpriseDefaultModel ?? employeeModelId ?? '';
  const currentModel = models.find((m) => m.modelId === effective);

  // 点击外部关闭下拉
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const formatContext = (length: number | null) => {
    if (!length) return '';
    if (length >= 1_000_000) return `${(length / 1_000_000).toFixed(1)}M`;
    if (length >= 1_000) return `${(length / 1_000).toFixed(0)}k`;
    return `${length}`;
  };

  // ── 锁定模式：管理员禁止用户切换 ──────────────────────────────────────────
  if (!canSwitch) {
    return (
      <div
        className="flex items-center gap-1.5 rounded border border-border bg-background px-2 py-1 text-xs text-fg-muted"
        title="管理员已锁定模型，不可切换"
      >
        <Lock className="h-3.5 w-3.5 text-fg-subtle" />
        <span>{(currentModel?.label ?? effective) || '默认模型'}</span>
      </div>
    );
  }

  // ── 正常下拉模式 ──────────────────────────────────────────────────────────
  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={isLoading || switchModel.isPending}
        className="flex items-center gap-1.5 rounded border border-border bg-background px-2 py-1 text-xs text-fg-muted hover:bg-bg-subtle focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
        title="切换该会话使用的模型"
      >
        <Cpu className="h-3.5 w-3.5 text-fg-subtle" />
        <span>{(currentModel?.label ?? effective) || '加载中...'}</span>
        <ChevronDown className="h-3 w-3 text-fg-subtle" />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full z-50 mt-1 w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-border bg-background shadow-lg">
          <div className="max-h-96 overflow-y-auto">
            {isLoading && (
              <div className="px-3 py-2 text-xs text-fg-muted">加载模型...</div>
            )}
            {!isLoading && models.length === 0 && (
              <div className="px-3 py-2 text-xs text-fg-muted">暂无可用模型</div>
            )}
            {models.map((model) => {
              const isActive = model.modelId === effective;
              return (
                <button
                  key={model.modelId}
                  onClick={() => switchModel.mutate(model.modelId)}
                  disabled={switchModel.isPending}
                  className={`w-full px-3 py-2 text-left hover:bg-bg-subtle focus:bg-bg-subtle focus:outline-none disabled:opacity-60 ${
                    isActive ? 'bg-bg-subtle' : ''
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="mb-0.5 flex items-center gap-1.5">
                        <span className="text-xs font-medium text-fg">
                          {model.label}
                        </span>
                        {isActive && <Check className="h-3 w-3 shrink-0 text-primary" />}
                      </div>
                      {model.vendor && (
                        <div className="mb-1 text-[10px] text-fg-muted">
                          {model.vendor}
                          {model.category && ` · ${model.category}`}
                        </div>
                      )}
                      {model.description && (
                        <div className="mb-1 line-clamp-2 text-[10px] text-fg-subtle">
                          {model.description}
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-3 text-[10px] text-fg-muted">
                        {model.contextLength && (
                          <span title="上下文长度">
                            📄 {formatContext(model.contextLength)}
                          </span>
                        )}
                        <span className={model.isFree ? 'font-medium text-emerald-600' : 'font-medium text-fg-muted'}>
                          {model.billingMultiplier === null
                            ? model.discountLabel
                            : `${model.billingMultiplier} 倍率 · ${model.discountLabel}`}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
