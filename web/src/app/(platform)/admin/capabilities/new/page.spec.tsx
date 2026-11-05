import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import NewCapabilityPage from './page';

const routerPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock('./skill-form', () => ({
  SkillForm: ({ onCancel }: { onCancel: () => void }) => (
    <div>
      <p>2. 导入 Skills</p>
      <button type="button" onClick={onCancel}>取消</button>
    </div>
  ),
}));

vi.mock('@/features/contribution/contribution-create-dialog', () => ({
  ContributionCreateDialog: ({ open, mode, onSuccess }: { open: boolean; mode?: string; onSuccess?: (capability: { id: string }) => void }) => open ? <div>RPA 创建表单<button type="button" onClick={() => onSuccess?.({ id: 'rpa 1' })}>{mode}</button></div> : null,
}));

describe('新建能力页', () => {
  it('只展示已开发的 Skills 和 RPA 类型入口', () => {
    render(<NewCapabilityPage />);

    expect(screen.getByRole('button', { name: /Skills/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /RPA/ })).toBeInTheDocument();
    expect(screen.queryByText('Coze')).not.toBeInTheDocument();
    expect(screen.queryByText('Dify')).not.toBeInTheDocument();
    expect(screen.queryByText('n8n')).not.toBeInTheDocument();
    expect(screen.queryByText('OpenCode')).not.toBeInTheDocument();
  });

  it('选择 Skills 后显示导入表单', () => {
    render(<NewCapabilityPage />);
    fireEvent.click(screen.getByRole('button', { name: /Skills/ }));

    expect(screen.getByText('2. 导入 Skills')).toBeInTheDocument();
  });

  it('选择 RPA 后打开现有 RPA 创建表单', () => {
    render(<NewCapabilityPage />);
    fireEvent.click(screen.getByRole('button', { name: /RPA/ }));

    expect(screen.getByText('RPA 创建表单')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'platform-review' }));
    expect(routerPush).toHaveBeenCalledWith('/admin/contributions?selected=rpa%201');
  });
});
