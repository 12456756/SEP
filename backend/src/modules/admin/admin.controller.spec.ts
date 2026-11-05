import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { AdminController } from './admin.controller';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

function parseBody(method: keyof AdminController, body: unknown) {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, AdminController, method) as Record<string, {
    pipes: unknown[];
  }>;
  const pipe = Object.values(args).flatMap((arg) => arg.pipes).find((value) => value instanceof ZodValidationPipe) as ZodValidationPipe;
  return pipe.transform(body);
}

describe('AdminController shared form contracts', () => {
  it.each(['createEmployee', 'updateEmployee'] as const)('%s accepts optional and platform avatar paths with short descriptions', (method) => {
    for (const avatar of [undefined, '', '   ', '/assets/employees/silicon/frontend-engineer.webp', 'https://example.com/avatar.webp']) {
      const parsed = parseBody(method, { name: '测试员工', description: '短描述', avatar, includedComputeCNY: null });
      expect(parsed.description).toBe('短描述');
      expect(parsed.avatar).toBe(avatar?.trim() ? avatar : undefined);
      expect(parsed.includedComputeCNY).toBeNull();
    }
  });

  it.each(['createEmployee', 'updateEmployee'] as const)('%s rejects invalid avatars', (method) => {
    for (const avatar of ['javascript:alert(1)', '/assets/other.webp', 'https://user:pass@example.com/avatar.webp']) {
      expect(() => parseBody(method, { name: '测试员工', avatar })).toThrow(BadRequestException);
    }
  });

  it.each(['createEmployee', 'updateEmployee'] as const)('%s accepts employee names longer than 100 characters', (method) => {
    const name = '员'.repeat(101);
    expect(parseBody(method, { name })).toMatchObject({ name });
  });

  it.each(['createEmployee', 'updateEmployee'] as const)('%s preserves optional description and enforces its 2000 limit', (method) => {
    expect(parseBody(method, { name: '测试员工' })).not.toHaveProperty('description');
    expect(parseBody(method, { name: '测试员工', description: 'x'.repeat(2000) }).description).toHaveLength(2000);
    expect(() => parseBody(method, { name: '测试员工', description: 'x'.repeat(2001) })).toThrow(BadRequestException);
    if (method === 'createEmployee') {
      expect(() => parseBody(method, { name: '测试员工', description: ' \n ' })).toThrow(BadRequestException);
    }
  });

  it('allows clearing an employee description while updating, but still enforces the length limit', () => {
    expect(parseBody('updateEmployee', { name: '抖音市场分析师_硅进', description: '   ' }))
      .toMatchObject({ name: '抖音市场分析师_硅进', description: '' });
    expect(() => parseBody('updateEmployee', { description: 'x'.repeat(2001) })).toThrow(BadRequestException);
  });

  it.each(['createCapabilityAdmin', 'updateCapabilityAdmin'] as const)('%s accepts short descriptions and the 100/2000 budget', (method) => {
    expect(parseBody(method, { name: '测试能力', description: ' 短描述 ', type: 'SKILL' }).description).toBe('短描述');
    const values = { name: 'a'.repeat(100), description: 'x'.repeat(2000), type: 'SKILL' };
    expect(parseBody(method, values)).toMatchObject(values);
    for (const invalid of [
      { ...values, name: 'a'.repeat(101) },
      { ...values, name: '   ' },
      { ...values, description: 'x'.repeat(2001) },
      { ...values, description: ' \n ' },
    ]) {
      expect(() => parseBody(method, invalid)).toThrow(BadRequestException);
    }
  });

  it('partial employee updates leave avatar absent and preserve explicit zero gift', () => {
    const service = { updateEmployee: jest.fn() };
    const controller = new AdminController(service as never, {} as never, {} as never);
    const body = parseBody('updateEmployee', { includedComputeCNY: 0 });
    expect(body).not.toHaveProperty('avatar');
    expect(body).not.toHaveProperty('description');
    controller.updateEmployee('employee-1', body, { user: { id: 'admin-1' } });
    expect(service.updateEmployee).toHaveBeenCalledWith('employee-1', { includedComputeCNY: 0 }, 'admin-1');
  });

  it('accepts optional capability changes in the employee update request', () => {
    expect(parseBody('updateEmployee', { name: '更新员工', capabilityIds: ['cap-1'] }))
      .toMatchObject({ name: '更新员工', capabilityIds: ['cap-1'] });
    expect(parseBody('updateEmployee', { name: '仅修改资料' })).not.toHaveProperty('capabilityIds');
    expect(() => parseBody('updateEmployee', { capabilityIds: [] })).toThrow(BadRequestException);
  });

  it('forwards normalized avatar and short employee description without changing the approval flow', () => {
    const service = { createEmployee: jest.fn(), approveEmployee: jest.fn(), updateEmployee: jest.fn() };
    const controller = new AdminController(service as never, {} as never, {} as never);
    const request = { user: { id: 'admin-1' } };
    const body = parseBody('createEmployee', { name: '测试员工', description: '短描述', avatar: '' });
    controller.createEmployee(body, request);
    expect(service.createEmployee).toHaveBeenCalledWith(expect.objectContaining({ avatar: undefined, description: '短描述', operatorId: 'admin-1' }));
    controller.approveEmployee('employee-1', { note: '审核通过' }, request);
    expect(service.approveEmployee).toHaveBeenCalledWith('employee-1', 'admin-1', '审核通过');
  });
});
