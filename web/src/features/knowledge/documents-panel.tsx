'use client';

import { useRef, useState } from 'react';
import { Eye, History, RefreshCw, Trash2, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CenteredSpinner } from '@/components/ui/feedback';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { ApiError } from '@/lib/api-client';
import type { KnowledgeBase, KnowledgeDocument, KnowledgeLimits, KnowledgeProcessingStatus } from '@/lib/types';
import { documentOperation, isDocumentAccessError, useDocuments, useDeleteDocument, type DocumentOperation } from './use-documents';
import { useReprocessDocument } from './use-knowledge-test';
import { DocumentUploader, formatKnowledgeBytes } from './document-uploader';
import { DocumentPreview } from './document-preview';
import { DocumentVersionDetails } from './document-version-details';
import { DocumentVersionsDialog } from './document-versions-dialog';
import { KnowledgeError, KnowledgeIconButton, KnowledgePagination, knowledgeError } from './knowledge-ui';
import { Input } from '@/components/ui/input';

const statuses: Record<KnowledgeProcessingStatus, string> = { PENDING: '排队中', PROCESSING: '处理中', READY: '可用', FAILED: '处理失败' };

export function DocumentsPanel({ knowledgeBase, limits }: { knowledgeBase: KnowledgeBase; limits: KnowledgeLimits }) {
  const documents = useDocuments(knowledgeBase.id);
  const reprocess = useReprocessDocument(knowledgeBase.id);
  const remove = useDeleteDocument(knowledgeBase.id);
  const [filter, setFilter] = useState('ALL');
  const [keyword, setKeyword] = useState('');
  const [searchableOnly, setSearchableOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState<{ id: string; versionId: string | null } | null>(null);
  const [versionsId, setVersionsId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<(DocumentOperation & { originalName: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const retries = useRef(new Map<string, DocumentOperation>());
  const retryBusy = useRef(false);
  const deleteBusy = useRef(false);
  const rows = documents.data ?? [];
  const filtered = rows.filter((doc) => (filter === 'ALL' || doc.status === filter) && (!keyword.trim() || doc.originalName.toLowerCase().includes(keyword.trim().toLowerCase())) && (!searchableOnly || doc.searchable));
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / 20)));

  async function retry(doc: KnowledgeDocument) {
    if (retryBusy.current) return;
    retryBusy.current = true;
    setError(null);
    let operation = retries.current.get(doc.id);
    if (!operation) {
      operation = documentOperation(doc); retries.current.set(doc.id, operation);
    }
    try {
      await reprocess.mutateAsync(operation);
      retries.current.delete(doc.id);
    } catch (cause) {
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 412)) {
        retries.current.delete(doc.id);
        setError('文档状态或版本已更新，列表已刷新，请重新确认是否重试。');
      } else setError(knowledgeError(cause));
    } finally { retryBusy.current = false; }
  }

  async function confirmDelete() {
    if (!deleting || deleteBusy.current) return;
    deleteBusy.current = true;
    setDeleteError(null);
    try { await remove.mutateAsync(deleting); setDeleting(null); } catch (cause) {
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 412)) {
        setDeleting(null); setError('文档状态或版本已更新，列表已刷新，请重新确认删除。');
      } else setDeleteError(knowledgeError(cause));
    } finally { deleteBusy.current = false; }
  }

  if (isDocumentAccessError(documents.error)) return <KnowledgeError error={documents.error} retry={() => { void documents.refetch(); }} />;

  return <div className="min-w-0 space-y-4">
    {knowledgeBase.permissions.canUpload && <DocumentUploader knowledgeBaseId={knowledgeBase.id} limits={limits} />}
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-2"><div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" /><Input value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} placeholder="搜索文档名称" className="pl-9" /></div><label className="flex items-center gap-2 text-sm">处理状态
      <select aria-label="文档状态" value={filter} onChange={(event) => { setFilter(event.target.value); setPage(1); }} className="h-9 rounded-md border border-glassline bg-background px-3">
        <option value="ALL">全部状态</option>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={searchableOnly} onChange={(e) => { setSearchableOnly(e.target.checked); setPage(1); }} />仅可检索</label></div><p className="text-xs text-gtext-muted">显示最新版本状态，有待处理任务时自动更新</p></div>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {documents.isError ? <KnowledgeError error={documents.error} retry={() => { void documents.refetch(); }} /> : !documents.data ? <CenteredSpinner label="加载文档…" /> : <>
      <div className="min-w-0 rounded-lg border border-glassline"><Table className="min-w-[800px] table-fixed"><TableHeader><TableRow>
        <TableHead className="w-[40%]">文档与版本</TableHead><TableHead className="w-24">大小</TableHead><TableHead className="w-44">最新版本状态</TableHead><TableHead className="w-28">上传日期</TableHead><TableHead className="w-36 text-right">操作</TableHead>
      </TableRow></TableHeader><TableBody>
        {filtered.slice((currentPage - 1) * 20, currentPage * 20).map((doc) => <TableRow key={doc.id}>
          <TableCell><p className="break-all font-medium">{doc.originalName}</p>
            <p className="mt-1 text-xs text-gtext-muted">生效版本：{doc.activeVersion ? `v${doc.activeVersion.version}` : '暂无'} · 最新版本：{doc.latestVersion ? `v${doc.latestVersion.version}` : '暂无'}</p>
            {doc.searchable && doc.activeVersionId !== doc.latestVersionId && <p className="mt-1 text-xs text-gtext-muted">生效版本仍可检索和预览</p>}
          </TableCell>
          <TableCell className="text-gtext-muted">{formatKnowledgeBytes(doc.fileSize)}</TableCell>
          <TableCell><Badge variant={doc.status === 'READY' ? 'glass-success' : doc.status === 'FAILED' ? 'glass-danger' : 'glass-info'}>{statuses[doc.status]}</Badge><DocumentVersionDetails version={doc.latestVersion} /></TableCell>
          <TableCell className="text-gtext-muted">{new Date(doc.createdAt).toLocaleDateString('zh-CN')}</TableCell>
          <TableCell><div className="flex justify-end gap-1">
            <KnowledgeIconButton label={`预览 ${doc.originalName}`} icon={Eye} disabled={!doc.searchable} onClick={() => setPreview({ id: doc.id, versionId: doc.activeVersionId })} />
            <KnowledgeIconButton label={`${knowledgeBase.permissions.canUpload ? '上传新版或查看版本' : '查看版本'} ${doc.originalName}`} icon={History} onClick={() => setVersionsId(doc.id)} />
            {knowledgeBase.permissions.canManage && doc.permissions?.canReprocess !== false && doc.status === 'FAILED' && (!doc.latestVersionId || doc.latestVersion?.retryable) && <KnowledgeIconButton label={`重试 ${doc.originalName}`} icon={RefreshCw} disabled={reprocess.isPending} onClick={() => { void retry(doc); }} />}
            {knowledgeBase.permissions.canManage && doc.permissions?.canDelete !== false && <KnowledgeIconButton label={`删除 ${doc.originalName}`} icon={Trash2} danger disabled={remove.isPending} onClick={() => { setDeleting({ ...documentOperation(doc), originalName: doc.originalName }); setDeleteError(null); }} />}
          </div></TableCell>
        </TableRow>)}
        {!filtered.length && <TableRow><TableCell colSpan={5} className="py-12 text-center text-gtext-muted">{filter === 'ALL' ? '暂无文档，请上传企业资料。' : '没有符合当前状态的文档。'}</TableCell></TableRow>}
      </TableBody></Table></div>
      <KnowledgePagination page={currentPage} pageSize={20} total={filtered.length} onPage={setPage} />
    </>}
    <DocumentPreview knowledgeBaseId={knowledgeBase.id} documentId={preview?.id ?? null} versionId={preview?.versionId} onClose={() => setPreview(null)} />
    <DocumentVersionsDialog knowledgeBaseId={knowledgeBase.id} document={rows.find((doc) => doc.id === versionsId) ?? null} limits={limits} canUpload={knowledgeBase.permissions.canUpload} onClose={() => setVersionsId(null)} />
    <Dialog open={!!deleting} onOpenChange={(open) => !open && !remove.isPending && setDeleting(null)}><DialogContent><DialogHeader><DialogTitle>删除文档</DialogTitle><DialogDescription className="break-all">确定删除「{deleting?.originalName}」？删除后将无法继续检索此文档。</DialogDescription></DialogHeader>
      {deleteError && <p role="alert" className="text-sm text-danger">{deleteError}</p>}
      <div className="flex justify-end gap-2"><Button variant="outline" disabled={remove.isPending} onClick={() => setDeleting(null)}>取消</Button><Button variant="danger" disabled={remove.isPending} onClick={confirmDelete}>{remove.isPending ? '删除中…' : '确认删除'}</Button></div>
    </DialogContent></Dialog>
  </div>;
}
