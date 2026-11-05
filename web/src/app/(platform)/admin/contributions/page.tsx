"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileCode2,
  LockKeyhole,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CenteredSpinner, EmptyState } from "@/components/ui/feedback";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import type { ContributionCapability } from "@/lib/types";
import {
  usePlatformContribution,
  usePlatformContributionQueue,
  usePlatformContributionReview,
  type PlatformQueueStatus,
} from "@/features/contribution/use-contribution-admin";
import { common } from "@/locales/zh-CN";

const tabs: Array<{ value: PlatformQueueStatus; label: string }> = [
  { value: "PENDING_REVIEW", label: common.status.pendingReview },
  { value: "APPROVED", label: "已收录" },
  { value: "REJECTED", label: "已驳回" },
];

export default function AdminContributionsPage() {
  const [status, setStatus] = useState<PlatformQueueStatus>("PENDING_REVIEW");
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [requestedId] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("selected") ?? "";
  });
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const queue = usePlatformContributionQueue(status, page, pageSize, search);
  const items = queue.data?.items ?? [];
  const filtered = items;

  const totalPages = Math.max(1, Math.ceil((queue.data?.total ?? 0) / pageSize));

  useEffect(() => {
    setPage(1);
  }, [status, search]);

  useEffect(() => {
    setSelectedId((current) => {
      // Deep links from the capability catalog may point to an item on a later
      // server page. Keep that id so the detail pane can load it directly.
      if (requestedId && status === "PENDING_REVIEW") {
        return requestedId;
      }
      if (current && filtered.some((item) => item.id === current)) {
        return current;
      }
      return filtered[0]?.id ?? "";
    });
  }, [filtered, requestedId, status]);

  return (
    <div className="flex h-[calc(100vh-64px)] min-h-[680px] flex-col overflow-hidden">
      <header className="shrink-0 border-b border-glassline px-6 py-5">
        <p className="text-xs font-semibold uppercase text-gbrand-text">
          Platform Contribution Review
        </p>
        <div className="mt-1 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gtext-primary">
              能力投稿审核
            </h1>
            <p className="mt-1 text-sm text-gtext-muted">
              只处理已获企业管理员授权的公开投稿，企业私有草稿不会进入此队列。
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-md border border-ginfo/30 bg-ginfo/10 px-3 py-2 text-xs text-ginfo">
            <LockKeyhole className="h-4 w-4" />
            企业私有内容受隔离保护
          </div>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 xl:grid-cols-[380px_minmax(0,1fr)]">
        <aside className="min-h-0 border-b border-glassline bg-glass-1 xl:border-b-0 xl:border-r">
          <div className="space-y-3 border-b border-glassline p-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gtext-muted" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索投稿、企业或描述"
                className="h-10 w-full rounded-md border border-glassline bg-glass-2 pl-9 pr-3 text-sm text-gtext-primary outline-none placeholder:text-gtext-muted focus:border-glassline-brand"
              />
            </div>
            <div className="grid grid-cols-3 gap-1 rounded-md border border-glassline bg-glass-2 p-1">
              {tabs.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => setStatus(tab.value)}
                  className={cn(
                    "rounded-sm px-2 py-2 text-xs transition-colors",
                    status === tab.value
                      ? "bg-solid-raised text-gtext-primary"
                      : "text-gtext-muted hover:text-gtext-primary",
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex h-[calc(100%-117px)] min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto p-2 scroll-thin">
            {queue.isLoading ? (
              <CenteredSpinner label="加载投稿队列..." />
            ) : queue.isError ? (
              <EmptyState title="队列加载失败" description="请稍后重试。" />
            ) : filtered.length ? (
              filtered.map((item) => (
                <QueueItem
                  key={item.id}
                  item={item}
                  active={item.id === selectedId}
                  onClick={() => setSelectedId(item.id)}
                />
              ))
            ) : (
              <EmptyState
                title="暂无投稿"
                description="当前状态没有匹配的能力投稿。"
              />
            )}
            </div>
            {queue.data && totalPages > 1 && (
              <div className="flex shrink-0 items-center justify-between gap-2 border-t border-glassline px-3 py-2 text-xs text-gtext-muted">
                <span>共 {queue.data.total} 条 · 第 {page} / {totalPages} 页</span>
                <div className="flex gap-1">
                  <Button
                    variant="glass"
                    size="icon"
                    className="h-7 w-7"
                    aria-label="上一页"
                    disabled={page <= 1 || queue.isFetching}
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="glass"
                    size="icon"
                    className="h-7 w-7"
                    aria-label="下一页"
                    disabled={page >= totalPages || queue.isFetching}
                    onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        </aside>
        <main className="min-h-0 overflow-hidden bg-glass-0">
          {selectedId ? (
            <ContributionReviewDetail id={selectedId} status={status} />
          ) : (
            <EmptyState
              icon={<FileCode2 className="h-10 w-10" />}
              title="选择一个投稿"
              description="查看企业审核、自动校验和公开内容后再做决定。"
            />
          )}
        </main>
      </div>
    </div>
  );
}

function QueueItem({
  item,
  active,
  onClick,
}: {
  item: ContributionCapability & { platformSubmittedAt: string | null };
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-contribution-id={item.id}
      className={cn(
        "mb-1 w-full rounded-md border p-3 text-left transition-colors",
        active
          ? "border-glassline-brand bg-glass-accent-2"
          : "border-transparent hover:border-glassline hover:bg-glass-2",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "grid h-10 w-10 shrink-0 place-items-center rounded-md border",
            item.type === "AGENT"
              ? "border-ginfo/35 bg-ginfo/15 text-ginfo"
              : "border-gbrand-ring bg-gbrand/15 text-gbrand-text",
          )}
        >
          {item.type === "AGENT" ? (
            <Bot className="h-4 w-4" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold text-gtext-primary">
              {item.name}
            </span>
            <Badge variant="glass-warning">待审</Badge>
          </span>
          <span className="mt-1 line-clamp-2 text-xs leading-5 text-gtext-muted">
            {item.description}
          </span>
          <span className="mt-2 flex items-center gap-2 text-xs text-gtext-muted">
            <span>{item.enterprise?.name || "个人投稿"}</span>
            <span>·</span>
            <span>{item.type}</span>
          </span>
        </span>
      </div>
    </button>
  );
}

function ContributionReviewDetail({
  id,
  status,
}: {
  id: string;
  status: PlatformQueueStatus;
}) {
  const detail = usePlatformContribution(id);
  const review = usePlatformContributionReview();
  const [comment, setComment] = useState("");
  if (detail.isLoading) return <CenteredSpinner label="加载投稿详情..." />;
  if (detail.isError || !detail.data)
    return (
      <EmptyState title="投稿详情加载失败" description="请重新选择投稿。" />
    );
  const item = detail.data;
  const version = item.skillVersions?.[0];
  const rpaVersion = item.rpaVersions?.[0];
  const validation =
    item.type === "RPA"
      ? rpaVersion?.validationResult
      : version?.validationResult;
  const canReview =
    status === "PENDING_REVIEW" &&
    item.platformReviewStatus === "PENDING_REVIEW";
  const decide = (decision: "APPROVE" | "REJECT") => {
    const reason = comment.trim();
    if (decision === "REJECT" && !reason) {
      toast.error("驳回时请填写原因");
      return;
    }
    review.mutate(
      { id, decision, comment: reason || undefined },
      {
        onSuccess: () => {
          toast.success(
            decision === "APPROVE" ? "投稿已收录为平台公共能力" : "投稿已驳回",
          );
          setComment("");
        },
        onError: (error) =>
          toast.error(error instanceof Error ? error.message : "审核失败"),
      },
    );
  };
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto scroll-thin">
      <header className="shrink-0 border-b border-glassline p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="mb-2 flex flex-wrap gap-2">
              <Badge variant={item.type === "AGENT" ? "glass-info" : "glass"}>
                {item.type}
              </Badge>
              <Badge
                variant={
                  item.platformReviewStatus === "APPROVED"
                    ? "glass-success"
                    : item.platformReviewStatus === "REJECTED"
                      ? "glass-danger"
                      : "glass-warning"
                }
              >
                {item.platformReviewStatus === "APPROVED"
                  ? "已收录"
                  : item.platformReviewStatus === "REJECTED"
                    ? "已驳回"
                    : "待平台审核"}
              </Badge>
              <Badge variant="glass">
                {item.enterprise?.name || "个人投稿"}
              </Badge>
            </div>
            <h2 className="text-2xl font-semibold text-gtext-primary">
              {item.name}
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-gtext-secondary">
              {item.description}
            </p>
          </div>
          {canReview && (
            <div className="flex shrink-0 gap-2">
              <Button
                variant="glass"
                loading={review.isPending}
                onClick={() => decide("REJECT")}
              >
                <X className="h-4 w-4" />
                驳回
              </Button>
              <Button
                variant="glass-primary"
                loading={review.isPending}
                onClick={() => decide("APPROVE")}
              >
                <Check className="h-4 w-4" />
                通过并收录
              </Button>
            </div>
          )}
        </div>
      </header>
      <div className="grid gap-4 p-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <section className="rounded-md border border-glassline bg-glass-1 p-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gtext-primary">
              <CheckCircle2 className="h-4 w-4 text-gsuccess" />
              审核参与者
            </h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Person
                label="贡献者"
                value={item.contributor.name || item.contributor.email}
              />
              <Person
                label="企业审核人"
                value={
                  item.enterpriseReviewedBy?.name ||
                  item.enterpriseReviewedBy?.email ||
                  "未记录"
                }
              />
              <Person
                label="投稿授权人"
                value={
                  item.platformSubmittedBy?.name ||
                  item.platformSubmittedBy?.email ||
                  "未记录"
                }
              />
            </div>
          </section>
          <section className="rounded-md border border-glassline bg-glass-1 p-5">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-gtext-primary">
                <AlertTriangle className="h-4 w-4 text-gwarning" />
                自动校验
              </h3>
              {validation ? (
                <Badge
                  className={
                    validation.valid
                      ? "border-gsuccess/30 bg-gsuccess/15 text-gsuccess"
                      : "border-gdanger/30 bg-gdanger/15 text-gdanger"
                  }
                >
                  {validation.valid ? "校验通过" : "校验失败"}
                </Badge>
              ) : (
                <Badge variant="glass">未生成</Badge>
              )}
            </div>
            {validation ? (
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {validation.checks?.map((check) => (
                  <div
                    key={check.code}
                    className="flex items-center gap-2 rounded border border-glassline bg-glass-2 px-3 py-2 text-xs"
                  >
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full",
                        check.passed ? "bg-gsuccess" : "bg-gdanger",
                      )}
                    />
                    {check.message}
                  </div>
                ))}
                {validation.issues?.map((issue) => (
                  <div
                    key={issue.code}
                    className="rounded border border-gdanger/20 bg-gdanger/10 px-3 py-2 text-xs text-gdanger"
                  >
                    {issue.message}
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-xs text-gtext-muted">
                此投稿没有可展示的自动校验记录。
              </p>
            )}
          </section>
          {version && (
            <section className="rounded-md border border-glassline bg-glass-1 p-5">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-gtext-primary">
                  <FileCode2 className="h-4 w-4 text-gbrand-text" />
                  投稿版本 v{version.version}
                </h3>
                <span className="text-xs text-gtext-muted">
                  {version.changeSummary || "无变更说明"}
                </span>
              </div>
              <pre className="mt-4 max-h-[360px] overflow-auto whitespace-pre-wrap rounded-md border border-glassline bg-solid-deep p-4 text-xs leading-6 text-gtext-secondary scroll-thin">
                {version.content}
              </pre>
            </section>
          )}
          {item.type === "RPA" && rpaVersion && (
            <section className="rounded-md border border-glassline bg-glass-1 p-5">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-gtext-primary">
                <FileCode2 className="h-4 w-4 text-gbrand-text" />
                RPA 下载包 v{rpaVersion.version}
              </h3>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <Person
                  label="平台"
                  value={
                    item.rpaConfig?.platform === "SHIZAI" ? "实在智能" : "影刀"
                  }
                />
                <Person
                  label="文件数"
                  value={`${rpaVersion.packageFileCount} 个`}
                />
                <Person
                  label="压缩包大小"
                  value={`${(rpaVersion.packageBytes / 1024 / 1024).toFixed(2)} MB`}
                />
                <Person label="SHA-256" value={rpaVersion.packageSha256} />
              </div>
              <div className="mt-4 rounded border border-glassline bg-glass-2 p-3">
                <p className="text-xs text-gtext-muted">使用与环境说明</p>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-gtext-secondary">
                  {rpaVersion.configDoc}
                </p>
              </div>
              <p className="mt-3 text-xs text-gwarning">
                平台仅做静态检查，不执行 ZIP 内脚本或流程。
              </p>
            </section>
          )}
          {item.type === "AGENT" && (
            <section className="rounded-md border border-glassline bg-glass-1 p-5">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-gtext-primary">
                <Bot className="h-4 w-4 text-ginfo" />
                Agent 接入信息
              </h3>
              <div className="mt-3 space-y-2 text-sm">
                <Person
                  label="平台"
                  value={item.agentConfig?.platform || "未配置"}
                />
                <Person
                  label="Bot ID"
                  value={item.agentConfig?.botId || "未配置"}
                />
                <Person
                  label="工作流地址"
                  value={item.agentConfig?.workflowUrl || "未配置"}
                />
              </div>
            </section>
          )}
        </div>
        <aside className="space-y-4">
          <section className="rounded-md border border-glassline bg-glass-1 p-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gtext-primary">
              <Clock3 className="h-4 w-4 text-gwarning" />
              投稿时间线
            </h3>
            <div className="mt-4 space-y-4 text-sm">
              <TimelineRow
                label="企业审核"
                value={
                  item.enterpriseReviewStatus === "APPROVED"
                    ? "已通过"
                    : item.enterpriseReviewStatus
                }
              />
              <TimelineRow
                label="平台授权"
                value={item.platformSubmittedBy ? "已授权" : "未记录"}
              />
              <TimelineRow
                label="平台审核"
                value={
                  item.platformReviewStatus === "PENDING_REVIEW"
                    ? "待处理"
                    : item.platformReviewStatus
                }
              />
            </div>
          </section>
          {canReview && (
            <section className="rounded-md border border-gwarning/30 bg-gwarning/10 p-5">
              <p className="text-xs font-medium text-gwarning">审核备注</p>
              <Textarea
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="通过可填写说明，驳回必须填写原因"
                className="mt-2 min-h-28 border-gwarning/30 bg-glass-1"
              />
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function Person({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-gtext-muted">{label}</p>
      <p
        className="mt-1 truncate text-sm font-medium text-gtext-primary"
        title={value}
      >
        {value}
      </p>
    </div>
  );
}
function TimelineRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-glassline pb-3 last:border-b-0 last:pb-0">
      <span className="text-gtext-muted">{label}</span>
      <span className="font-medium text-gtext-primary">{value}</span>
    </div>
  );
}
