'use client';

import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import type { PlatformModel } from './use-model-config';

interface ModelWhitelistPickerProps {
  models: PlatformModel[];
  selectedModels: string[];
  onChange: (modelIds: string[]) => void;
  disabled?: boolean;
}

/** 价格列为空是常态（元数据待同步），此时不渲染价格标签而不是显示 ¥0.00。 */
function priceLabel(value: string | null, suffix: string): string | null {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return `¥${n.toFixed(2)}/1M ${suffix}`;
}

function contextLabel(contextLength: number | null): string | null {
  if (!contextLength) return null;
  return contextLength >= 1000
    ? `${Math.round(contextLength / 1000)}K 上下文`
    : `${contextLength} 上下文`;
}

/**
 * 模型白名单多选器。
 *
 * 展示模型名称、单价、上下文长度 —— 这些元数据在 platform_models 里
 * 目前大多为 null，缺失时整块标签不渲染。
 */
export function ModelWhitelistPicker({
  models,
  selectedModels,
  onChange,
  disabled = false,
}: ModelWhitelistPickerProps) {
  const allSelected =
    models.length > 0 && models.every((m) => selectedModels.includes(m.modelId));

  const toggle = (modelId: string, checked: boolean) => {
    onChange(
      checked
        ? [...selectedModels, modelId]
        : selectedModels.filter((id) => id !== modelId),
    );
  };

  if (models.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        本企业对话 Key 暂无可用模型。
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {selectedModels.length === 0
            ? '未限制（全部可用）'
            : `已选 ${selectedModels.length} / ${models.length}`}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className="text-sm text-primary hover:underline disabled:opacity-50 disabled:hover:no-underline"
            disabled={disabled || allSelected}
            onClick={() => onChange(models.map((m) => m.modelId))}
          >
            全选
          </button>
          <span className="text-sm text-muted-foreground">·</span>
          <button
            type="button"
            className="text-sm text-primary hover:underline disabled:opacity-50 disabled:hover:no-underline"
            disabled={disabled || selectedModels.length === 0}
            onClick={() => onChange([])}
          >
            清空
          </button>
        </div>
      </div>

      {models.map((model) => {
        const tags = [
          priceLabel(model.pricingInputPer1M, '输入'),
          priceLabel(model.pricingOutputPer1M, '输出'),
          contextLabel(model.contextLength),
        ].filter((t): t is string => t !== null);

        return (
          <div
            key={model.modelId}
            className="flex items-start gap-3 rounded-lg border border-border bg-background p-3 hover:bg-muted/50"
          >
            <Checkbox
              id={`wl-${model.modelId}`}
              checked={selectedModels.includes(model.modelId)}
              onCheckedChange={(checked) => toggle(model.modelId, checked === true)}
              disabled={disabled}
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1">
              <Label
                htmlFor={`wl-${model.modelId}`}
                className="cursor-pointer font-medium"
              >
                {model.label}
              </Label>
              {(model.vendor || tags.length > 0) && (
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {model.vendor && <Badge variant="glass">{model.vendor}</Badge>}
                  {tags.map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                </div>
              )}
              {model.description && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {model.description}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
