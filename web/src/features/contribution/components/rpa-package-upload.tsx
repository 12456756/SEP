'use client';

import { useRef } from 'react';
import { FileArchive, Loader2, RotateCcw, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useUploadRpaPackage } from '../use-contributions';
import type { RpaPackageParseResult } from '../../../../../backend/src/shared';

export function RpaPackageUpload({ value, onChange }: { value: RpaPackageParseResult | null; onChange: (value: RpaPackageParseResult | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const upload = useUploadRpaPackage();
  const choose = async (file?: File) => {
    if (!file) return;
    if (!/\.(?:zip|tar|tgz|tar\.gz)$/i.test(file.name)) { toast.error('请选择 ZIP、TAR、TAR.GZ 或 TGZ 文件'); return; }
    try { onChange(await upload.mutateAsync(file)); }
    catch (error) { toast.error(error instanceof Error ? error.message : 'RPA 包上传失败'); }
    finally { if (input.current) input.current.value = ''; }
  };

  return value ? (
    <div className="flex items-center justify-between gap-3 rounded-glass-lg border border-glassline bg-glass-1 p-4">
      <div className="flex min-w-0 items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-glass-md border border-glassline-brand bg-gbrand/10 text-gbrand-text"><FileArchive className="h-4 w-4" /></span><div className="min-w-0"><p className="truncate text-sm font-medium text-gtext-primary">{value.filename}</p><p className="mt-1 text-xs text-gtext-muted">{value.fileCount} 个文件 · {formatBytes(value.totalBytes)} · SHA256 {value.sha256.slice(0, 12)}</p></div></div>
      <Button variant="glass" size="sm" onClick={() => onChange(null)}><RotateCcw className="h-3.5 w-3.5" />更换</Button>
    </div>
  ) : (
    <div>
      <input ref={input} type="file" accept=".zip,.tar,.tar.gz,.tgz,application/zip,application/gzip,application/x-tar" className="sr-only" onChange={(event) => void choose(event.currentTarget.files?.[0])} />
      <button type="button" disabled={upload.isPending} onClick={() => input.current?.click()} className="flex min-h-40 w-full flex-col items-center justify-center gap-2 rounded-glass-lg border border-dashed border-glassline-brand bg-gbrand/5 p-6 text-center hover:bg-gbrand/10 disabled:opacity-60">
        <span className="grid h-11 w-11 place-items-center rounded-glass-lg border border-glassline-brand bg-gbrand/10 text-gbrand-text">{upload.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}</span>
        <span className="text-sm font-medium text-gtext-primary">{upload.isPending ? '正在检查压缩包…' : '点击选择 RPA 压缩包'}</span>
        <span className="max-w-md text-xs leading-5 text-gtext-muted">支持 ZIP、TAR、TAR.GZ 和 TGZ，最大 50MB。平台会检查压缩包结构，不会执行其中任何文件；审核通过后其他用户可下载。</span>
      </button>
    </div>
  );
}

function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
