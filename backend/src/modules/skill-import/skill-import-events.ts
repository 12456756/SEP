import { BadRequestException, ConflictException } from '@nestjs/common';
import { SkillImportEvent } from 'shared';
import { ImportCommand, ImportPreview, ImportSession } from './skill-import-state';

function reject(code: string, message: string): never { throw new ConflictException({ code, message }); }

function ensureFiles(preview: ImportPreview): boolean {
  const result = preview.result!;
  const paths = new Set<string>(); let total = 0;
  for (const file of preview.files) {
    if (paths.has(file.relativePath)) reject('PREVIEW_INVALID', '预览文件清单包含重复路径');
    paths.add(file.relativePath); total += file.bytes;
  }
  if (preview.files.length > result.fileCount || total > result.totalUncompressedBytes) reject('PREVIEW_INVALID', '预览文件清单超过声明的数量或大小');
  if (preview.nextClientCursor === null) {
    if (preview.files.length !== result.fileCount || total !== result.totalUncompressedBytes) reject('PREVIEW_INVALID', '预览文件清单尚不完整');
    preview.status = 'ready';
    return true;
  }
  return false;
}

function commandFor(session: ImportSession, event: SkillImportEvent): ImportCommand {
  const command = session.commands.find((item) => item.commandId === event.commandId);
  if (!command) reject('COMMAND_INVALID', '事件不属于已下发的命令');
  return command;
}

// Returns ignored for stale/idempotent events, while the caller still acknowledges their sequence.
export function applyImportEvent(session: ImportSession, event: SkillImportEvent): boolean {
  const command = commandFor(session, event);
  if (command.type === 'preview' && session.preview?.commandId !== command.commandId) return true;
  if (command.completed) return true;
  switch (event.type) {
    case 'command-started': {
      if (event.payload.type !== command.type) reject('COMMAND_INVALID', '事件命令类型不匹配');
      if (command.started || command.completed) return true;
      command.started = true;
      if (command.type === 'scan') { session.status = 'scanning'; session.scanStartedAt = Date.now(); }
      return false;
    }
    case 'progress': {
      const expected = command.type === 'scan' ? 'scanning' : command.type === 'preview' ? 'previewing' : 'packaging';
      if (event.payload.phase !== expected && !(command.type === 'package-selected' && event.payload.phase === 'uploading')) reject('COMMAND_INVALID', '进度阶段不匹配');
      if (event.payload.total !== undefined && event.payload.completed > event.payload.total) throw new BadRequestException({ code: 'EVENT_INVALID', message: '进度超过总量' });
      if (session.progress?.phase === event.payload.phase && session.progress.completed >= event.payload.completed) return true;
      session.progress = event.payload;
      return false;
    }
    case 'candidates': {
      if (command.type !== 'scan' || session.scanComplete) reject('COMMAND_INVALID', '候选批次不属于进行中的扫描');
      if (Buffer.byteLength(JSON.stringify(event)) > 1024 * 1024) throw new BadRequestException({ code: 'REQUEST_BODY_TOO_LARGE', message: '候选摘要批次不能超过 1MiB' });
      let changed = event.payload.final;
      for (const candidate of event.payload.items) {
        if (candidate.locations.some((location) => !session.acceptedScope?.rootIds.includes(location.rootId))) reject('SCOPE_MISMATCH', '候选引用了未授权目录');
        if (session.scope !== 'all' && candidate.scope !== session.scope) reject('SCOPE_MISMATCH', '候选不属于获准扫描范围');
        const index = session.candidates.findIndex((item) => item.candidateId === candidate.candidateId);
        if (index === -1) { session.candidates.push(candidate); changed = true; }
        else if (session.candidates[index].revision < candidate.revision) { session.candidates[index] = candidate; changed = true; }
        else if (JSON.stringify(session.candidates[index]) !== JSON.stringify(candidate)) reject('CANDIDATE_CHANGED', '候选版本不允许回退或更改');
      }
      if (session.candidates.length > 5000) throw new BadRequestException({ code: 'CANDIDATE_LIMIT_REACHED', message: '候选数量超过 5000' });
      if (event.payload.final) { session.scanComplete = true; session.status = 'results'; }
      return !changed;
    }
    case 'preview': {
      if (command.type !== 'preview') reject('COMMAND_INVALID', '预览不属于预览命令');
      const preview = session.preview!; const result = event.payload;
      if (preview.requestId !== result.requestId || preview.candidateId !== result.candidateId) reject('PREVIEW_INVALID', '预览请求信息不匹配');
      if (preview.status !== 'pending' || preview.result) return true;
      if (Date.now() >= preview.deadline || Date.now() >= Date.parse(result.expiresAt) || Date.parse(result.expiresAt) > Math.min(Date.parse(session.expiresAt), Date.now() + 5 * 60_000)) reject('SNAPSHOT_EXPIRED', '预览快照有效期不合法');
      const candidate = session.candidates.find((item) => item.candidateId === result.candidateId);
      if (!candidate || candidate.revision !== preview.revision || candidate.treeHash && candidate.treeHash !== result.treeHash) reject('CANDIDATE_CHANGED', '预览候选已变化');
      preview.result = result; preview.files = result.files; preview.nextClientCursor = result.nextFilesCursor;
      if (ensureFiles(preview)) session.status = 'results';
      return false;
    }
    case 'files': {
      if (command.type !== 'preview') reject('COMMAND_INVALID', '文件清单不属于预览命令');
      const preview = session.preview!; const page = event.payload;
      if (!preview.result || preview.requestId !== page.requestId || preview.candidateId !== page.candidateId || preview.result.snapshotId !== page.snapshotId) reject('SNAPSHOT_EXPIRED', '文件清单快照不匹配');
      if (preview.status !== 'pending' || preview.nextClientCursor !== page.cursor || preview.usedCursors.includes(page.cursor)) reject('CURSOR_INVALID', '文件批次顺序不连续');
      if (page.nextFilesCursor === page.cursor || page.nextFilesCursor && preview.usedCursors.includes(page.nextFilesCursor)) reject('CURSOR_INVALID', '文件批次游标重复');
      preview.files.push(...page.files); preview.usedCursors.push(page.cursor); preview.nextClientCursor = page.nextFilesCursor;
      if (ensureFiles(preview)) session.status = 'results';
      return false;
    }
    case 'command-completed': {
      if (event.payload.type !== command.type) reject('COMMAND_INVALID', '完成事件命令类型不匹配');
      if (command.completed) return true;
      if (command.type === 'scan' && !session.scanComplete) reject('EVENT_INVALID', '扫描完成前必须提交最后候选批次');
      if (command.type === 'preview' && session.preview?.status !== 'ready') reject('PREVIEW_INVALID', '预览完成前必须提交全部文件清单');
      command.completed = true;
      if (command.type === 'package-selected') {
        if (!session.operation || session.operation.status !== 'pending') reject('OPERATION_CONFLICT', '导入操作状态不允许完成打包');
        session.status = 'uploading';
      }
      return false;
    }
    case 'error': {
      command.completed = true;
      if (command.type === 'preview' && session.preview) {
        session.preview.status = 'failed'; session.preview.errorCode = event.payload.code; session.preview.result = null; session.preview.files = []; session.status = 'results';
      } else if (command.type === 'package-selected' && session.operation) {
        session.operation.status = 'failed'; session.operation.errorCode = event.payload.code;
        // A client packaging error has no immutable ZIP to retry; a fresh session is required.
        session.operation.retryable = false;
      } else { session.status = 'failed'; session.epoch += 1; session.closed = true; }
      return false;
    }
  }
}
