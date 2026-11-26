import type { ComputeIntegrationView } from 'shared/compute-integration.dto';

export const statusLabels = { NOT_CONNECTED: '未开通', PENDING: '开户中', READY: '已开通', FAILED: '开户失败' };
export function connectionStatusLabel(value: ComputeIntegrationView) {
  return value.status === 'READY' && value.mode !== 'ENTERPRISE' ? '连接初始化中' : statusLabels[value.status];
}
export const kindLabels = { chat: '对话', image: '图片', video: '视频' };

export function ConnectionStatus({ value, showCredentials = true }: { value: ComputeIntegrationView; showCredentials?: boolean }) {
  const outstanding = value.funds && (value.funds.generationPaused || Number(value.funds.localUnpaidCny) > 0 || Number(value.funds.syncShortfallCny) > 0);
  return <dl className="divide-y divide-border text-sm">
    {(value.mode !== 'ENTERPRISE' || value.status !== 'READY' || !value.connected) && <div role="status" className="py-3 text-amber-700 dark:text-amber-400">
      {value.mode !== 'ENTERPRISE' ? value.status === 'READY' ? '企业算力连接正在初始化，后台将自动完成'
        : '企业算力尚未开通，开户完成后即可调用模型'
        : '企业算力连接暂不可用，请联系平台管理员检查连接'}
    </div>}
    {outstanding && <div role="status" className="py-3 text-amber-700 dark:text-amber-400">存在未结清费用或待处理余额事件，新增生成暂缓；请补足资金或等待原账务同步完成</div>}
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 py-3"><dt className="text-muted-foreground">调用方式</dt><dd>企业专属 Key</dd></div>
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 py-3"><dt className="text-muted-foreground">开户状态</dt><dd>{connectionStatusLabel(value)}</dd></div>
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 py-3"><dt className="text-muted-foreground">算力账号</dt><dd className="break-all">{value.remoteAccountId ?? '尚未绑定'}</dd></div>
    {value.funds && <>
      <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 py-3"><dt className="text-muted-foreground">企业算力总余额</dt><dd className="break-all">¥{value.funds.totalBalanceCny}</dd></div>
      <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 py-3"><dt className="text-muted-foreground">未分配算力</dt><dd className="break-all">¥{value.funds.unallocatedCny}</dd></div>
      <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 py-3"><dt className="text-muted-foreground">成员算力合计</dt><dd className="break-all">¥{value.funds.memberBalanceCny}</dd></div>
      <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 py-3"><dt className="text-muted-foreground">待远端结算</dt><dd className="break-all">¥{value.funds.pendingSettlementCny}</dd></div>
      <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 py-3"><dt className="text-muted-foreground">本地未结清费用</dt><dd className="break-all">¥{value.funds.localUnpaidCny}</dd></div>
      <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 py-3"><dt className="text-muted-foreground">同步资金缺口</dt><dd className="break-all">¥{value.funds.syncShortfallCny}</dd></div>
      {value.funds.remoteAvailableCny !== null && <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 py-3"><dt className="text-muted-foreground">算力侧同步快照</dt><dd className="break-all">可用 ¥{value.funds.remoteAvailableCny} · 冻结 ¥{value.funds.remoteFrozenCny} · 流水 {value.funds.sequence}</dd></div>}
    </>}
    {showCredentials && value.credentials.map(key => <div key={key.kind} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 py-3">
      <dt className="text-muted-foreground">{kindLabels[key.kind]}凭证</dt><dd className="break-all">{key.configured ? `${key.maskedKey} · v${key.version}` : '未配置'}</dd>
    </div>)}
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 py-3"><dt className="text-muted-foreground">最近同步</dt><dd>{value.lastSyncedAt ? new Date(value.lastSyncedAt).toLocaleString() : '暂无'}</dd></div>
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 py-3"><dt className="text-muted-foreground">待同步操作</dt><dd>{value.pendingJobs}</dd></div>
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 py-3"><dt className="text-muted-foreground">最近对账</dt><dd>{value.lastReconciliation
      ? `${value.lastReconciliation.status === 'MATCHED' ? '一致' : '存在差异'} · ¥${value.lastReconciliation.differenceCny}` : '尚未核对'}</dd></div>
    {value.lastErrorMessage && <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 py-3"><dt className="text-muted-foreground">同步异常</dt><dd className="break-words text-amber-700 dark:text-amber-400">{value.lastErrorMessage}</dd></div>}
  </dl>;
}
