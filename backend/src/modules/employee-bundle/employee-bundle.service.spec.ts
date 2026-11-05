import { BadRequestException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { EmployeeBundleService } from './employee-bundle.service';

describe('EmployeeBundleService', () => {
  let service: EmployeeBundleService;
  let prisma: any;
  let fulfillment: any;

  beforeEach(() => {
    prisma = {
      employeeBundle: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      digitalEmployee: { findMany: jest.fn() },
      $transaction: jest.fn(),
    };
    fulfillment = {
      resolveGiftCNY: jest.fn(async (override: unknown, annual: Decimal) =>
        override == null ? annual.mul(0.1).toNumber() : Number(override)),
    };
    service = new EmployeeBundleService(prisma, fulfillment);
  });

  it('rejects duplicate employees in a bundle before creating records', async () => {
    await expect(service.create({
      code: 'TEAM',
      name: 'Team bundle',
      priceCNY: 100,
      periodMonths: 12,
      items: [{ employeeId: 'employee-1' }, { employeeId: 'employee-1' }],
    })).rejects.toThrow(BadRequestException);

    expect(prisma.employeeBundle.create).not.toHaveBeenCalled();
  });

  it('generates a bundle code when creating without one', async () => {
    prisma.digitalEmployee.findMany.mockResolvedValue([{
      id: 'employee-1', name: 'Sales', status: 'APPROVED', annualPriceCNY: new Decimal(500),
    }]);
    prisma.employeeBundle.create.mockImplementation(async ({ data }: any) => ({
      id: 'bundle-1',
      code: data.code,
      name: data.name,
      description: data.description ?? null,
      cover: data.cover ?? null,
      status: 'DRAFT',
      priceCNY: new Decimal(data.priceCNY),
      periodMonths: data.periodMonths,
      publishedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [],
    }));

    await service.create({
      name: 'Team bundle',
      priceCNY: 100,
      periodMonths: 12,
      items: [{ employeeId: 'employee-1' }],
    });

    expect(prisma.employeeBundle.create.mock.calls[0][0].data.code).toMatch(/^BUNDLE-[0-9a-f-]{36}$/i);
  });

  it('expands category rules to include employees approved after bundle creation', async () => {
    const bundle = {
      id: 'bundle-1', code: 'TEAM', name: 'Team bundle', description: null, cover: null,
      status: 'PUBLISHED', priceCNY: new Decimal(100), periodMonths: 12,
      autoIncludeAll: false, autoIncludeCategories: ['TECH'], autoExcludeEmployeeIds: [],
      publishedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
      items: [],
    };
    prisma.employeeBundle.findMany.mockResolvedValue([bundle]);
    prisma.digitalEmployee.findMany.mockResolvedValue([{
      id: 'new-tech', name: 'New Tech', avatar: null, version: '1.0.0',
      annualPriceCNY: new Decimal(500), includedComputeCNY: null, status: 'APPROVED',
      functionalCategory: 'TECH',
    }]);

    const [view] = await service.listPublished();

    expect(view.items.map((item: any) => item.employeeId)).toEqual(['new-tech']);
    expect(view.autoIncludeCategories).toEqual(['TECH']);
  });

  it('shows listed total, manual bundle price, discount, and employee-level compute grants', async () => {
    prisma.employeeBundle.findMany.mockResolvedValue([{
      id: 'bundle-1',
      code: 'TEAM',
      name: 'Team bundle',
      description: null,
      cover: null,
      status: 'PUBLISHED',
      priceCNY: new Decimal(800),
      periodMonths: 12,
      publishedAt: new Date('2026-01-01T00:00:00Z'),
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      items: [
        {
          id: 'item-1', bundleId: 'bundle-1', employeeId: 'employee-1', periodMonths: 12,
          includedComputeCNY: null,
          employee: { id: 'employee-1', name: 'Sales', avatar: null, version: '1.0.0', annualPriceCNY: new Decimal(500), includedComputeCNY: null },
        },
        {
          id: 'item-2', bundleId: 'bundle-1', employeeId: 'employee-2', periodMonths: 12,
          includedComputeCNY: new Decimal(25),
          employee: { id: 'employee-2', name: 'Support', avatar: null, version: '1.1.0', annualPriceCNY: new Decimal(500), includedComputeCNY: null },
        },
      ],
    }]);

    const [bundle] = await service.listPublished();

    expect(bundle).toMatchObject({
      priceCNY: '800.00',
      originalAmountCNY: '1000.00',
      discountCNY: '200.00',
      totalComputeCNY: '75.00',
    });
    expect(bundle.items.map((item) => item.includedComputeCNY)).toEqual(['50.00', '25.00']);
  });
});
