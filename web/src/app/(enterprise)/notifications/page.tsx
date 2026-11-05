'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Bell,
  Check,
  Trash2,
  ExternalLink,
  Settings2,
  BarChart2,
  ShieldAlert,
  CheckSquare,
  X,
  Search,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CenteredSpinner } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';
import {
  useNotifications,
  useUnreadCount,
  useMarkAsRead,
  useMarkAllAsRead,
  useClearRead,
  useDeleteNotification,
  type NotificationCategory,
  type NotificationSeverity,
} from '@/features/notifications/use-notifications';
import { useActiveAnnouncements } from '@/features/announcement/use-announcements';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

const CATEGORY_TABS: Array<{
  key: NotificationCategory | 'ALL';
  label: string;
  icon: React.ReactNode;
}> = [
  { key: 'ALL', label: '全部', icon: <Bell className="h-4 w-4" /> },
  { key: 'SYSTEM', label: '系统', icon: <Settings2 className="h-4 w-4" /> },
  { key: 'USAGE_ALERT', label: '用量预警', icon: <BarChart2 className="h-4 w-4" /> },
  { key: 'SECURITY', label: '安全', icon: <ShieldAlert className="h-4 w-4" /> },
  { key: 'APPROVAL', label: '审批', icon: <CheckSquare className="h-4 w-4" /> },
];

const SEVERITY_STYLES: Record<NotificationSeverity, string> = {
  INFO: 'text-gtext-primary',
  WARNING: 'text-warning',
  ERROR: 'text-danger',
};

const CATEGORY_BADGE: Record<NotificationCategory, { label: string; cls: string }> = {
  SYSTEM: { label: '系统', cls: 'bg-glass-3 text-gtext-secondary' },
  USAGE_ALERT: { label: '用量', cls: 'bg-warning/10 text-warning' },
  SECURITY: { label: '安全', cls: 'bg-danger/10 text-danger' },
  APPROVAL: { label: '审批', cls: 'bg-primary/10 text-primary' },
};

const ANNOUNCEMENT_TYPE_STYLES = {
  INFO: { bg: 'bg-blue-500/10', border: 'border-blue-500/20', text: 'text-blue-700 dark:text-blue-300', icon: 'text-blue-600' },
  WARNING: { bg: 'bg-yellow-500/10', border: 'border-yellow-500/20', text: 'text-yellow-700 dark:text-yellow-300', icon: 'text-yellow-600' },
  ERROR: { bg: 'bg-red-500/10', border: 'border-red-500/20', text: 'text-red-700 dark:text-red-300', icon: 'text-red-600' },
  SUCCESS: { bg: 'bg-green-500/10', border: 'border-green-500/20', text: 'text-green-700 dark:text-green-300', icon: 'text-green-600' },
};

const ANNOUNCEMENT_TYPE_ICONS = {
  INFO: Bell,
  WARNING: ShieldAlert,
  ERROR: ShieldAlert,
  SUCCESS: CheckSquare,
};

const PAGE_SIZE = 20;

export default function NotificationsPage() {
  const [activeTab, setActiveTab] = useState<NotificationCategory | 'ALL'>('ALL');
  const [offset, setOffset] = useState(0);
  const [dismissedAnnouncements, setDismissedAnnouncements] = useState<Set<string>>(new Set());
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [keyword, setKeyword] = useState('');

  const category = activeTab === 'ALL' ? undefined : activeTab;

  const { data, isLoading } = useNotifications(PAGE_SIZE, offset, category, unreadOnly, keyword);
  const { data: unreadData } = useUnreadCount(category);
  const { data: announcements } = useActiveAnnouncements();
  const markAsRead = useMarkAsRead();
  const markAllAsRead = useMarkAllAsRead();
  const clearRead = useClearRead();
  const deleteNotif = useDeleteNotification();

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const unreadCount = unreadData?.count ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const visibleAnnouncements = (announcements ?? []).filter(
    (a) => !dismissedAnnouncements.has(a.id)
  );

  const handleTabChange = (tab: NotificationCategory | 'ALL') => {
    setActiveTab(tab);
    setOffset(0);
  };

  const handleDismissAnnouncement = (id: string) => {
    setDismissedAnnouncements((prev) => new Set([...prev, id]));
  };

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">通知中心</h1>
          <p className="mt-1 text-sm text-fg-muted">
            {unreadCount > 0 ? (
              <span className="text-warning">{unreadCount} 条未读</span>
            ) : (
              '暂无未读通知'
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => markAllAsRead.mutate(category)}
              disabled={markAllAsRead.isPending}
            >
              <Check className="h-4 w-4" />
              全部已读
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => clearRead.mutate(category)}
            disabled={clearRead.isPending}
          >
            <Trash2 className="h-4 w-4" />
            清空已读
          </Button>
        </div>
      </div>

      {/* Category tabs */}
      <div className="flex gap-1 rounded-glass-sm border border-glassline bg-glass-1 p-1">
        {CATEGORY_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => handleTabChange(tab.key)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors',
              activeTab === tab.key
                ? 'bg-primary text-white shadow-sm'
                : 'text-gtext-secondary hover:bg-glass-2 hover:text-gtext-primary',
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" /><Input value={keyword} onChange={(e) => { setKeyword(e.target.value); setOffset(0); }} placeholder="搜索通知标题或内容" className="pl-9" /></div>
        <label className="flex items-center gap-2 text-sm text-gtext-secondary"><Switch checked={unreadOnly} onCheckedChange={(checked) => { setUnreadOnly(checked); setOffset(0); }} />仅看未读</label>
      </div>

      {/* Announcements Section */}
      {visibleAnnouncements.length > 0 && (
        <Card>
          <div className="space-y-3 p-4">
            <h2 className="text-sm font-semibold text-gtext-primary">系统公告</h2>
            {visibleAnnouncements.map((announcement) => (
              <AnnouncementCard
                key={announcement.id}
                announcement={announcement}
                onDismiss={handleDismissAnnouncement}
              />
            ))}
          </div>
        </Card>
      )}

      {/* Notification list */}
      <Card>
        {isLoading ? (
          <div className="py-16">
            <CenteredSpinner label="加载中…" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-gtext-muted">
            <Bell className="mb-3 h-10 w-10 opacity-20" />
            <p className="text-sm">暂无通知</p>
          </div>
        ) : (
          <div className="divide-y divide-glassline">
            {items.map((notif) => {
              const titleColor = notif.severity
                ? SEVERITY_STYLES[notif.severity]
                : 'text-gtext-primary';
              const badge = notif.category ? CATEGORY_BADGE[notif.category] : null;

              return (
                <div
                  key={notif.id}
                  className={cn(
                    'group flex items-start gap-3 px-5 py-4 transition-colors hover:bg-glass-2',
                    !notif.read && 'bg-glass-2/40',
                  )}
                >
                  {/* Unread dot */}
                  <div className="mt-2 shrink-0">
                    <div
                      className={cn(
                        'h-2 w-2 rounded-full',
                        !notif.read ? 'bg-primary' : 'bg-transparent',
                      )}
                    />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className={cn('text-sm font-medium', titleColor)}>
                        {notif.title}
                      </h4>
                      {badge && (
                        <span className={cn('rounded px-1.5 py-0.5 text-xs', badge.cls)}>
                          {badge.label}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-gtext-secondary">{notif.message}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-4">
                      <span className="text-xs text-gtext-muted">
                        {formatDistanceToNow(new Date(notif.createdAt), {
                          addSuffix: true,
                          locale: zhCN,
                        })}
                      </span>
                      {notif.actionUrl && (
                        <Link
                          href={notif.actionUrl}
                          className="flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          <ExternalLink className="h-3 w-3" />
                          查看详情
                        </Link>
                      )}
                    </div>
                  </div>

                  {/* Action buttons (appear on hover) */}
                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    {!notif.read && (
                      <button
                        onClick={() => markAsRead.mutate(notif.id)}
                        className="rounded p-1.5 text-gtext-muted hover:bg-glass-3 hover:text-gtext-primary"
                        title="标记已读"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      onClick={() => deleteNotif.mutate(notif.id)}
                      className="rounded p-1.5 text-gtext-muted hover:bg-danger/10 hover:text-danger"
                      title="删除"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-glassline px-5 py-3">
            <span className="text-sm text-gtext-muted">
              第 {currentPage} / {totalPages} 页，共 {total} 条
            </span>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                上一页
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                下一页
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

interface AnnouncementCardProps {
  announcement: {
    id: string;
    title: string;
    content: string;
    type: 'INFO' | 'WARNING' | 'ERROR' | 'SUCCESS';
  };
  onDismiss: (id: string) => void;
}

function AnnouncementCard({ announcement, onDismiss }: AnnouncementCardProps) {
  const styles = ANNOUNCEMENT_TYPE_STYLES[announcement.type];
  const Icon = ANNOUNCEMENT_TYPE_ICONS[announcement.type];

  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border p-3',
        styles.bg,
        styles.border,
        styles.text
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0 mt-0.5', styles.icon)} />
      <div className="min-w-0 flex-1">
        <h4 className="text-sm font-semibold">{announcement.title}</h4>
        <p className="mt-0.5 text-sm opacity-90">{announcement.content}</p>
      </div>
      <button
        onClick={() => onDismiss(announcement.id)}
        className="shrink-0 rounded p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
        aria-label="关闭"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
