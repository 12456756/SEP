'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Download, ExternalLink, Loader2, MonitorUp, RefreshCw, ScanSearch, ShieldCheck, Trash2, UploadCloud, X } from 'lucide-react';
import { CLIENT_RELEASE } from '@/config/client-releases';
import { safeClientDeepLink, useSkillImport } from './use-skill-import';
import type { SkillImportArtifact } from './types';

type Props = {
  onArtifact: (artifact: SkillImportArtifact | null) => void;
  onZipFile: (file: File) => void;
  zipBusy: boolean;
  zipError: string | null;
  zipArtifact: { filename: string; fileCount: number; totalSize: number; sha256: string; warnings?: Array<{ code: string; message: string }> } | null;
};
const labels = { 'waiting-client': '等待客户端', pairing: '等待设备确认', ready: '等待扫描', scanning: '正在扫描', results: '扫描完成', previewing: '正在读取预览', packaging: '正在打包', uploading: '正在上传', uploaded: '已上传，待创建', cancelled: '已取消', expired: '会话已过期', failed: '导入失败' };

export function SkillImportPanel({ onArtifact, onZipFile, zipBusy, zipError, zipArtifact }: Props) {
  const [source, setSource] = useState('client');
  const flow = useSkillImport(onArtifact);
  const { session, preview, selected } = flow;
  const operation = flow.operation.data?.operation;
  const importing = flow.selection.isPending || (!!flow.operationId && !operation) || operation?.status === 'pending' || operation?.status === 'processing';
  const deepLink = session ? safeClientDeepLink(session) : null;
  const candidates = flow.candidates.data?.pages.flatMap((page) => page.items) ?? [];
  const devices = flow.devices.data?.pages.flatMap((page) => page.items) ?? [];
  const scanAvailable = flow.config.data?.enabled === true && !flow.config.isError;
  const warnings = [...(selected?.warnings ?? []), ...(preview?.warnings ?? [])];
  const switchSource = (value: string) => { if (value === source) return; setSource(value); void flow.cancel(); };
  return (
    <Card>
      <CardHeader><CardTitle>2. 导入 Skills</CardTitle></CardHeader>
      <CardContent className="min-w-0 space-y-4">
        <Tabs value={source} onValueChange={switchSource}>
          <TabsList className="max-w-full">
            <TabsTrigger value="client" disabled={zipBusy}><MonitorUp className="mr-2 h-4 w-4" />本机扫描</TabsTrigger>
            <TabsTrigger value="zip" disabled={zipBusy}><UploadCloud className="mr-2 h-4 w-4" />ZIP 上传</TabsTrigger>
          </TabsList>
          <TabsContent value="client" className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3 border-b pb-4">
              <div className="space-y-2">
                <Label htmlFor="scan-scope">扫描范围</Label>
                <select id="scan-scope" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={flow.scope} disabled={zipBusy || flow.active || flow.create.isPending} onChange={(event) => flow.setScope(event.target.value as typeof flow.scope)}>
                  <option value="user">用户级 Skills</option><option value="project">项目级 Skills</option><option value="all">用户级和项目级</option>
                </select>
                <p role="status" className="text-sm text-muted-foreground">{session ? labels[flow.expired ? 'expired' : session.status] : '等待开始扫描'}</p>
                {session?.progress && <p className="text-xs text-muted-foreground">{session.progress.completed}{session.progress.total ? ` / ${session.progress.total}` : ''}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                {session && <Button type="button" variant="outline" disabled={zipBusy} onClick={() => void flow.cancel()}><X className="mr-2 h-4 w-4" />取消扫描</Button>}
                <Button type="button" onClick={() => void flow.start()} disabled={!scanAvailable || zipBusy || flow.create.isPending || flow.config.isFetching || importing}>
                  {flow.create.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : session ? <RefreshCw className="mr-2 h-4 w-4" /> : <ScanSearch className="mr-2 h-4 w-4" />}{session ? '重新扫描' : '扫描本机'}
                </Button>
              </div>
            </div>
            {flow.config.isPending ? <p className="text-sm text-muted-foreground">正在读取扫描配置</p> : flow.config.isError ? <div className="space-y-2"><p role="alert" className="text-sm text-amber-700">扫描配置加载失败，请使用 ZIP 上传</p><Button type="button" variant="outline" onClick={() => void flow.config.refetch()} disabled={flow.config.isFetching}><RefreshCw className="mr-2 h-4 w-4" />重试读取配置</Button></div> : !scanAvailable && <p role="status" className="text-sm text-muted-foreground">本机扫描暂未开放，请使用 ZIP 上传</p>}
            {session && deepLink && flow.active && <Button type="button" variant="outline" onClick={() => { window.location.href = deepLink; }}><ExternalLink className="mr-2 h-4 w-4" />打开 SEP 客户端</Button>}
            {session?.pairings.map((pairing) => <div key={pairing.pairingId} className="space-y-2 rounded-md border p-3 text-sm">
              <p className="font-medium">{pairing.label} · {pairing.platform} · {pairing.clientVersion}</p>
              <p>配对码：<strong className="font-mono text-lg">{pairing.shortCode}</strong></p>
              <p className="break-all text-xs text-muted-foreground">设备指纹：{pairing.keyFingerprint}</p>
              <Button type="button" variant="outline" disabled={pairing.webConfirmed || flow.confirm.isPending || !flow.active || Date.parse(pairing.expiresAt) <= flow.now} onClick={() => void flow.confirmDevice({ pairingId: pairing.pairingId, keyFingerprint: pairing.keyFingerprint, shortCode: pairing.shortCode })}><ShieldCheck className="mr-2 h-4 w-4" />{pairing.webConfirmed ? '网页已确认，等待客户端' : '与客户端一致，确认设备'}</Button>
            </div>)}
            {flow.error && <p role="alert" className="break-words text-sm text-red-600">{flow.error}</p>}
            {(flow.candidates.data || flow.candidates.isFetching) && <div className="grid min-w-0 gap-4 lg:grid-cols-2">
              <div className="min-w-0 space-y-3">
                <div className="flex gap-2"><Input aria-label="搜索技能" maxLength={160} placeholder="搜索名称或描述" value={flow.search} disabled={importing} onChange={(event) => flow.setSearch(event.target.value)} /><Input aria-label="筛选 Agent" maxLength={96} placeholder="Agent 来源" value={flow.source} disabled={importing} onChange={(event) => flow.setSource(event.target.value)} /></div>
                <div className="max-h-96 space-y-2 overflow-auto">
                  {candidates.map((candidate) => <button type="button" key={candidate.candidateId} disabled={zipBusy || candidate.availability === 'blocked' || importing || !flow.active} onClick={() => void flow.choose(candidate)} className={`w-full rounded-md border p-3 text-left disabled:opacity-50 ${selected?.candidateId === candidate.candidateId ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}`}>
                    <p className="break-words font-medium">{candidate.name}</p><p className="text-xs text-muted-foreground">{candidate.sources.join(' / ')} · {candidate.scope === 'user' ? '用户级' : '项目级'}</p>
                    {candidate.description && <p className="mt-1 line-clamp-2 break-words text-sm text-muted-foreground">{candidate.description}</p>}
                    {candidate.locations.map((location) => <p key={`${location.rootId}:${location.relativePath}`} className="mt-1 break-all text-xs text-muted-foreground">{location.rootLabel}/{location.relativePath}</p>)}
                    {candidate.warnings.map((warning) => <p key={warning.code} className="mt-1 break-words text-xs text-amber-700">{warning.message}</p>)}
                  </button>)}
                  {!candidates.length && !flow.candidates.isFetching && <p className="py-6 text-center text-sm text-muted-foreground">暂无匹配技能</p>}
                  {flow.candidates.isFetching && <Loader2 aria-label="正在读取技能" className="h-4 w-4 animate-spin" />}
                </div>
                {flow.candidates.hasNextPage && <Button type="button" variant="outline" disabled={flow.candidates.isFetchingNextPage} onClick={() => void flow.candidates.fetchNextPage()}>加载更多</Button>}
              </div>
              <div className="min-w-0 space-y-3 border-l pl-4">
                {preview ? <>
                  <p className="break-words font-medium">{selected?.name}</p><Textarea aria-label="SKILL.md 预览" readOnly value={preview.content} rows={10} className="font-mono text-xs" />
                  <p className="text-xs text-muted-foreground">{preview.fileCount} 个文件 · 解压后 {(preview.totalUncompressedBytes / 1024).toFixed(1)} KB · 打包预计 {(preview.estimatedPackageBytes / 1024).toFixed(1)} KB</p>
                  <details><summary className="cursor-pointer text-sm">文件清单（{flow.allFiles.length}/{preview.fileCount}）</summary><ul className="mt-2 max-h-40 overflow-auto text-xs text-muted-foreground">{flow.allFiles.map((file) => <li className="break-all py-1" key={file.relativePath}>{file.relativePath} · {file.bytes} B</li>)}</ul></details>
                  {!flow.filesReady && <p className="text-sm text-muted-foreground">正在读取完整文件清单</p>}
                  {warnings.map((warning, index) => <p key={`${warning.code}:${index}`} className="break-words text-sm text-amber-700">{warning.message}</p>)}
                  {flow.snapshotExpired && <p className="text-sm text-red-600">预览已过期，请重新选择技能</p>}
                  {!flow.operationId && <Button type="button" onClick={() => void flow.select()} disabled={!flow.active || !flow.filesReady || flow.snapshotExpired || warnings.some((warning) => warning.severity === 'blocking') || importing}>导入所选技能</Button>}
                </> : <p className="text-sm text-muted-foreground">{flow.previewFailed ? '预览失败，请重新选择技能' : flow.requestPreview.isPending || selected ? '正在读取技能预览' : '选择技能后查看预览'}</p>}
                {flow.operationId && !operation && <div className="space-y-2"><p role="status" className="text-sm text-muted-foreground">正在确认导入状态</p>{flow.operation.isError && <Button type="button" variant="outline" disabled={flow.operation.isFetching} onClick={() => void flow.operation.refetch()}><RefreshCw className="mr-2 h-4 w-4" />查询导入结果</Button>}{flow.selectionUnknown && flow.operation.error instanceof Error && <Button type="button" variant="outline" disabled={flow.selection.isPending || !flow.active || flow.snapshotExpired} onClick={() => void flow.select()}>重试同一导入请求</Button>}</div>}
                {operation && <div role="status" className="space-y-2 text-sm"><p>{operation.status === 'succeeded' ? '已上传，请确认能力信息后创建' : operation.status === 'failed' ? `导入失败：${operation.errorCode ?? '未知错误'}` : '正在打包并上传'}</p>{operation.status === 'failed' && operation.retryable && <><p className="text-muted-foreground">请在 SEP 客户端重试上传</p><Button type="button" variant="outline" disabled={flow.operation.isFetching} onClick={() => void flow.operation.refetch()}><RefreshCw className="mr-2 h-4 w-4" />查询上传状态</Button></>}</div>}
              </div>
            </div>}
            <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">安装 SEP 客户端</summary><div className="mt-2 flex flex-wrap gap-3">{CLIENT_RELEASE.artifacts.filter((artifact) => artifact.url).map((artifact) => <a className="inline-flex items-center gap-1 text-primary underline underline-offset-4" key={artifact.platform} href={artifact.url!}><Download className="h-4 w-4" />{artifact.label}</a>)}</div></details>
            <p className="text-xs text-muted-foreground">公开下载版本：v{CLIENT_RELEASE.version}{flow.config.data ? `；本机扫描要求 v${flow.config.data.minClientVersion} 或更高版本` : '；本机扫描需要包含 Skills 扫描模块的版本'}。版本不支持时请使用 ZIP 上传。</p>
            {scanAvailable && <details className="text-sm" onToggle={(event) => flow.setShowDevices(event.currentTarget.open)}><summary className="cursor-pointer text-muted-foreground">已授权设备</summary><div className="mt-2 space-y-2">{devices.map((device) => <div className="flex items-center justify-between gap-2 border-b py-2" key={device.deviceId}><div className="min-w-0"><p>{device.label} · {device.platform}</p><p className="break-all text-xs text-muted-foreground">{device.keyFingerprint}</p></div><Button type="button" variant="ghost" size="icon" title={`撤销 ${device.label}`} aria-label={`撤销 ${device.label}`} disabled={flow.revoke.isPending} onClick={() => flow.revokeDevice(device.deviceId)}><Trash2 className="h-4 w-4" /></Button></div>)}{flow.devices.data && devices.length === 0 && <p className="text-muted-foreground">暂无已授权设备</p>}{flow.devices.hasNextPage && <Button type="button" variant="outline" disabled={flow.devices.isFetchingNextPage} onClick={() => void flow.devices.fetchNextPage()}>加载更多设备</Button>}{flow.devices.isError && <p role="alert" className="text-red-600">读取设备失败</p>}{flow.revoke.isError && <p role="alert" className="text-red-600">撤销设备失败，请重试</p>}</div></details>}
          </TabsContent>
          <TabsContent value="zip" className="space-y-3">
            <div className="space-y-2"><Label htmlFor="file">Zip 文件（必须包含 SKILL.md）</Label><Input id="file" type="file" accept=".zip,application/zip" disabled={zipBusy} onChange={(event) => { const file = event.target.files?.[0]; if (file) onZipFile(file); event.target.value = ''; }} /></div>
            {zipBusy && <Loader2 aria-label="正在上传" className="h-5 w-5 animate-spin text-muted-foreground" />}
          </TabsContent>
        </Tabs>
        {zipError && <p role="alert" className="text-sm text-red-600">{zipError}</p>}
        {zipArtifact && <div className="space-y-1 border-t pt-3 text-sm text-muted-foreground"><p className="break-all">文件: {zipArtifact.filename}</p><p>文件数: {zipArtifact.fileCount}</p><p>大小: {(zipArtifact.totalSize / 1024).toFixed(2)} KB</p><p>SHA256: {zipArtifact.sha256.slice(0, 16)}...</p>{!!zipArtifact.warnings?.length && <ul aria-label="导入提示" className="list-inside list-disc space-y-1 break-words">{Array.from(new Set(zipArtifact.warnings.map((warning) => warning.message))).map((warning) => <li key={warning}>{warning}</li>)}</ul>}</div>}
      </CardContent>
    </Card>
  );
}
