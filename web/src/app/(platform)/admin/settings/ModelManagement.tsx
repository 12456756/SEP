"use client";

import { useState, useMemo } from "react";
import Image from "next/image";
import { RefreshCw, Play, Search } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/feedback";
import { toast } from "@/components/ui/toast";
import {
  usePlatformModels,
  useSyncModels,
  useUpdatePlatformModel,
  useTestModel,
} from "@/features/model/use-models";

// 厂商配置（图标路径和颜色）
// 优先使用 SVG 格式以减少文件大小
const VENDOR_CONFIG: Record<string, { logo: string; name: string }> = {
  OpenAI: { logo: "/vendors/openai.svg", name: "OpenAI" },
  Anthropic: { logo: "/vendors/anthropic.svg", name: "Anthropic" },
  Google: { logo: "/vendors/google.svg", name: "Google" },
  Meta: { logo: "/vendors/meta.svg", name: "Meta" },
  Minimax: { logo: "/vendors/minimax.png", name: "Minimax" },
  Zhipu: { logo: "/vendors/zhipu.png", name: "智谱AI" },
  DeepSeek: { logo: "/vendors/deepseek.png", name: "DeepSeek" },
  Moonshot: { logo: "/vendors/kimi.png", name: "月之暗面" },
  Grok: { logo: "/vendors/grok.png", name: "Grok" },
};

// 根据 modelId 推断厂商
function inferVendor(modelId: string): keyof typeof VENDOR_CONFIG | "Other" {
  if (modelId.startsWith("gpt-") || modelId.startsWith("o1-") || modelId.startsWith("text-")) {
    return "OpenAI";
  }
  if (modelId.startsWith("claude-")) return "Anthropic";
  if (modelId.startsWith("gemini-") || modelId.startsWith("palm-")) return "Google";
  if (modelId.startsWith("llama-")) return "Meta";
  if (modelId.startsWith("abab")) return "Minimax";
  if (modelId.startsWith("glm-")) return "Zhipu";
  if (modelId.startsWith("deepseek-")) return "DeepSeek";
  if (modelId.startsWith("moonshot-")) return "Moonshot";
  if (modelId.startsWith("grok-")) return "Grok";
  return "Other";
}

export default function ModelManagement() {
  const [hasSynced, setHasSynced] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const { data: models, refetch } = usePlatformModels(hasSynced);
  const sync = useSyncModels();
  const updateModel = useUpdatePlatformModel();
  const testModel = useTestModel();

  const [searchQuery, setSearchQuery] = useState("");
  const [vendorFilter, setVendorFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // 历史记录保留在平台，管理列表只显示本次同步仍在上游的模型。
  const upstreamModels = useMemo(
    () => hasSynced ? models?.filter((model) => !model.isStale) ?? [] : [],
    [hasSynced, models],
  );

  // 筛选逻辑
  const filteredModels = useMemo(() => {
    return upstreamModels.filter((model) => {
      const vendor = inferVendor(model.modelId);

      // 搜索过滤
      if (searchQuery && !model.modelId.toLowerCase().includes(searchQuery.toLowerCase()) &&
          !model.label.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false;
      }

      // 厂商过滤
      if (vendorFilter !== "all" && vendor !== vendorFilter) {
        return false;
      }

      // 状态过滤
      if (statusFilter === "enabled" && !model.enabled) return false;
      if (statusFilter === "disabled" && model.enabled) return false;

      return true;
    });
  }, [upstreamModels, searchQuery, vendorFilter, statusFilter]);

  // 获取所有厂商列表
  const vendors = useMemo(() => {
    const vendorSet = new Set(upstreamModels.map((m) => inferVendor(m.modelId)));
    return Array.from(vendorSet).sort();
  }, [upstreamModels]);

  const handleSync = async () => {
    setIsSyncing(true);
    setHasSynced(false);
    setSyncError("");
    try {
      const r = await sync.mutateAsync();
      // 等最新列表加载完成后再展示，避免把缓存中的历史全集闪回页面。
      await refetch({ throwOnError: true });
      setSearchQuery("");
      setVendorFilter("all");
      setStatusFilter("all");
      setHasSynced(true);
      toast.success(
        `同步完成：上游 ${r.upstreamTotal} 个 · 新增 ${r.added} · 恢复 ${r.restored} · 失效 ${r.staled}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "请稍后重试";
      setSyncError(`同步失败：${message}`);
      toast.error(`同步失败：${message}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const toggle = async (id: string, enabled: boolean, label: string) => {
    try {
      await updateModel.mutateAsync({ id, enabled });
      toast.success(`${label} 已${enabled ? "启用" : "禁用"}`);
    } catch (err) {
      toast.error(`操作失败：${(err as Error).message}`);
    }
  };

  const toggleFree = async (id: string, isFree: boolean, label: string) => {
    try {
      await updateModel.mutateAsync({ id, isFree });
      toast.success(`${label} 活动免费已${isFree ? "开启" : "关闭"}`);
    } catch (err) {
      toast.error(`操作失败：${(err as Error).message}`);
    }
  };

  const handleTest = async (modelId: string, label: string) => {
    try {
      const result = await testModel.mutateAsync(modelId);
      toast.success(`${label} 测试成功\n响应: ${result.response}\n延迟: ${result.latency}ms`);
    } catch (err) {
      toast.error(`${label} 测试失败：${(err as Error).message}`);
    }
  };

  return (
    <div className="space-y-4">
      {/* 操作栏 */}
      <Card variant="solid">
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-fg-base">上游会话模型</h2>
              <p className="mt-1 text-sm text-fg-muted">同步后仅显示上游当前支持的模型；开启活动免费后由平台承担模型费用，关闭后恢复正常中转倍率。</p>
            </div>
            <Button variant="primary" onClick={handleSync} disabled={isSyncing}>
              <RefreshCw className={`h-4 w-4 ${isSyncing ? "animate-spin" : ""}`} />
              {isSyncing ? "同步中..." : "同步上游"}
            </Button>
          </div>
          {syncError && <p role="alert" className="mt-3 break-words text-sm text-danger">{syncError}</p>}
          {hasSynced && <div className="mt-4 flex flex-wrap items-center gap-3">
            {/* 搜索框 */}
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" />
              <Input
                aria-label="搜索上游模型"
                placeholder="搜索模型名称或ID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>

            {/* 厂商筛选 */}
            <select
              aria-label="筛选厂商"
              value={vendorFilter}
              onChange={(e) => setVendorFilter(e.target.value)}
              className="px-3 py-2 border border-border rounded-md bg-bg-base text-sm"
            >
              <option value="all">全部厂商</option>
              {vendors.map((v) => (
                <option key={v} value={v}>
                  {VENDOR_CONFIG[v]?.name || v}
                </option>
              ))}
            </select>

            {/* 状态筛选 */}
            <select
              aria-label="筛选启用状态"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-3 py-2 border border-border rounded-md bg-bg-base text-sm"
            >
              <option value="all">全部状态</option>
              <option value="enabled">已启用</option>
              <option value="disabled">已禁用</option>
            </select>
          </div>}
        </CardContent>
      </Card>

      {isSyncing ? (
        <div role="status" aria-label="正在同步上游模型" className="space-y-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-36 w-full" />
        </div>
      ) : !hasSynced ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center">
          <p className="text-sm font-medium text-fg-base">尚未同步上游模型</p>
          <p className="mt-2 text-sm text-fg-muted">点击「同步上游」获取当前支持的模型列表。</p>
        </div>
      ) : <Card variant="solid">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-bg-subtle border-b border-border">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-fg-muted">
                    厂商
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-fg-muted">
                    模型ID
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-fg-muted">
                    显示名称
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-fg-muted">
                    状态
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-fg-muted">
                    启用
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-fg-muted">
                    活动免费
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-fg-muted">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredModels.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-fg-muted">
                      {searchQuery || vendorFilter !== "all" || statusFilter !== "all"
                        ? "没有符合条件的模型"
                        : "上游暂未返回模型，可稍后重新同步"}
                    </td>
                  </tr>
                ) : (
                  filteredModels.map((model) => {
                    const vendor = inferVendor(model.modelId);
                    const vendorInfo = VENDOR_CONFIG[vendor];

                    return (
                      <tr key={model.id} className="hover:bg-bg-subtle transition-colors">
                        {/* 厂商图标 */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {vendorInfo ? (
                              <Image
                                src={vendorInfo.logo}
                                alt={vendorInfo.name}
                                width={24}
                                height={24}
                                className="rounded"
                              />
                            ) : (
                              <div className="w-6 h-6 bg-bg-subtle rounded flex items-center justify-center text-xs text-fg-muted">
                                ?
                              </div>
                            )}
                            <span className="text-sm text-fg-muted">
                              {vendorInfo?.name || vendor}
                            </span>
                          </div>
                        </td>

                        {/* 模型ID */}
                        <td className="px-4 py-3">
                          <code className="text-xs text-fg-base">{model.modelId}</code>
                        </td>

                        {/* 显示名称 */}
                        <td className="px-4 py-3 text-sm text-fg-base">
                          {model.label}
                        </td>

                        {/* 状态标签 */}
                        <td className="px-4 py-3 text-center">
                          <div className="flex items-center justify-center gap-1.5">
                            {!model.hasPricing && (
                              <Badge className="bg-warning/10 text-warning text-xs">
                                保底计费
                              </Badge>
                            )}
                          </div>
                        </td>

                        {/* 启用开关 */}
                        <td className="px-4 py-3 text-center">
                          <input
                            type="checkbox"
                            aria-label={`启用 ${model.label}`}
                            className="h-4 w-4 cursor-pointer accent-primary"
                            checked={model.enabled}
                            disabled={model.isStale || updateModel.isPending}
                            onChange={(e) =>
                              toggle(model.id, e.target.checked, model.label)
                            }
                          />
                        </td>

                        {/* 活动免费开关 */}
                        <td className="px-4 py-3 text-center">
                          <input
                            type="checkbox"
                            aria-label={`活动免费 ${model.label}`}
                            className="h-4 w-4 cursor-pointer accent-primary"
                            checked={model.isFree}
                            disabled={model.isStale || updateModel.isPending}
                            onChange={(e) =>
                              toggleFree(model.id, e.target.checked, model.label)
                            }
                          />
                        </td>

                        {/* 操作 */}
                        <td className="px-4 py-3 text-center">
                          {model.enabled && !model.isStale && (
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`测试 ${model.label}`}
                              disabled={testModel.isPending}
                              onClick={() => handleTest(model.id, model.label)}
                            >
                              <Play className="h-3 w-3" />
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* 统计信息 */}
          {filteredModels.length > 0 && (
            <div className="px-4 py-3 border-t border-border bg-bg-subtle text-xs text-fg-muted">
              显示 {filteredModels.length} / {upstreamModels.length} 个上游模型
            </div>
          )}
        </CardContent>
      </Card>}
    </div>
  );
}
