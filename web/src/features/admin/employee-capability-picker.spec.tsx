import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EmployeeCapabilityPicker } from './employee-capability-picker';

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true });

const capabilities = [
  { id: 'market', name: '市场分析', description: '分析品类与竞品趋势', type: 'SKILL' },
  { id: 'mail', name: '邮件助手', description: '起草和整理邮件', type: 'AI_APP' },
  { id: 'browser', name: '网页搜索', description: '搜索公开网页', type: 'AGENT' },
];

describe('EmployeeCapabilityPicker', () => {
  it('searches names and descriptions without dropping hidden selections', () => {
    const onChange = vi.fn();
    render(<EmployeeCapabilityPicker capabilities={capabilities} selectedIds={['market', 'mail']} onChange={onChange} />);

    fireEvent.change(screen.getByRole('textbox', { name: '搜索能力' }), { target: { value: '竞品' } });
    const list = screen.getByLabelText('可绑定能力列表');
    expect(within(list).getByText('市场分析')).toBeInTheDocument();
    expect(within(list).queryByText('邮件助手')).not.toBeInTheDocument();
    expect(screen.getByText('已选 2')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('仅看已选'));
    expect(within(list).getByText('市场分析')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('filters by type and adds newly selected capability to the end', async () => {
    const onChange = vi.fn();
    render(<EmployeeCapabilityPicker capabilities={capabilities} selectedIds={['market']} onChange={onChange} />);

    fireEvent.click(screen.getByRole('combobox', { name: '按能力类型筛选' }));
    fireEvent.click(await screen.findByRole('option', { name: 'AI_APP' }));
    const list = screen.getByLabelText('可绑定能力列表');
    expect(within(list).getByText('邮件助手')).toBeInTheDocument();
    expect(within(list).queryByText('市场分析')).not.toBeInTheDocument();

    fireEvent.click(within(list).getByRole('checkbox', { name: '邮件助手' }));
    expect(onChange).toHaveBeenCalledWith(['market', 'mail']);
  });

  it('provides a bounded scrolling region and reports empty search results', () => {
    render(<EmployeeCapabilityPicker capabilities={capabilities} selectedIds={[]} onChange={vi.fn()} />);
    const list = screen.getByLabelText('可绑定能力列表');
    expect(list.className).toContain('overflow-y-auto');
    expect(list.className).toContain('max-h-[55vh]');

    fireEvent.change(screen.getByRole('textbox', { name: '搜索能力' }), { target: { value: '不存在' } });
    expect(within(list).getByRole('status')).toHaveTextContent('没有匹配的能力');
  });
});
