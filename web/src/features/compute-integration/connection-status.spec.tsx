import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ConnectionStatus } from './connection-status';
import type { ComputeIntegrationView } from 'shared/compute-integration.dto';

const value: ComputeIntegrationView = { enterpriseId: 'ent1', enterpriseName: '企业', remoteAccountId: null, mode: 'LEGACY',
  status: 'NOT_CONNECTED', connected: false, credentials: ['chat', 'image', 'video'].map(kind => ({
    kind: kind as 'chat' | 'image' | 'video', configured: false, maskedKey: null, version: null,
  })), lastErrorCode: null, lastErrorMessage: null, lastSyncedAt: null, ledgerCursor: null, pendingJobs: 0 };

describe('Enterprise connection status', () => {
  it('shows the real disconnected state without implying successful provisioning', () => {
    render(<ConnectionStatus value={value} />);
    expect(screen.getByText('未开通')).toBeInTheDocument();
    expect(screen.getByText('企业专属 Key')).toBeInTheDocument();
    expect(screen.queryByText('原平台连接')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('开户完成后即可调用模型');
    expect(screen.getAllByText('未配置')).toHaveLength(3);
    expect(screen.queryByText('凭证就绪')).not.toBeInTheDocument();
  });
  it('shows automatic initialization without requiring an administrator to activate credentials', () => {
    render(<ConnectionStatus value={{ ...value, mode: 'PREPARING', status: 'READY', connected: true }} />);
    expect(screen.getByText('连接初始化中')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('后台将自动完成');
    expect(screen.queryByText(/待.*启用/)).not.toBeInTheDocument();
  });
  it('shows a successfully provisioned and connected enterprise as ready to use', () => {
    render(<ConnectionStatus value={{ ...value, mode: 'ENTERPRISE', status: 'READY', connected: true }} />);
    expect(screen.getByText('已开通')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it('shows only masked credential metadata and a useful error', () => {
    render(<ConnectionStatus value={{ ...value, lastErrorMessage: '算力平台接口尚未接通', credentials: [{ kind: 'chat', configured: true, maskedKey: '****1234', version: 2 }] }} />);
    expect(screen.getByText('****1234 · v2')).toBeInTheDocument();
    expect(screen.getByText('算力平台接口尚未接通')).toBeInTheDocument();
  });
});
