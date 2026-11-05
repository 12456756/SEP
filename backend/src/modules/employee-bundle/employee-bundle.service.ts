import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EmployeeBundleStatus, Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionFulfillmentService } from '../subscription-fulfillment/subscription-fulfillment.service';
import type { CreateEmployeeBundleDto, UpdateEmployeeBundleDto } from './employee-bundle.dto';

type BundleWithItems = Prisma.EmployeeBundleGetPayload<{
  include: { items: { include: { employee: true } } };
}>;

@Injectable()
export class EmployeeBundleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfillment: SubscriptionFulfillmentService,
  ) {}

  async listPublished() {
    const bundles = await this.prisma.employeeBundle.findMany({
      where: { status: EmployeeBundleStatus.PUBLISHED },
      include: { items: { include: { employee: true }, orderBy: { id: 'asc' } } },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
    });
    return Promise.all(bundles.map((bundle) => this.toView(bundle)));
  }

  async getPublished(id: string) {
    const bundle = await this.findForView(id, EmployeeBundleStatus.PUBLISHED);
    return this.toView(bundle);
  }

  async listAdmin(status?: EmployeeBundleStatus) {
    const bundles = await this.prisma.employeeBundle.findMany({
      where: status ? { status } : undefined,
      include: { items: { include: { employee: true }, orderBy: { id: 'asc' } } },
      orderBy: { updatedAt: 'desc' },
    });
    return Promise.all(bundles.map((bundle) => this.toView(bundle)));
  }

  async getAdmin(id: string) {
    return this.toView(await this.findForView(id));
  }

  async create(dto: CreateEmployeeBundleDto) {
    await this.validateBundleInput({
      code: dto.code,
      name: dto.name,
      priceCNY: dto.priceCNY,
      periodMonths: dto.periodMonths,
      items: dto.items.map((item) => ({
        employeeId: item.employeeId,
        periodMonths: item.periodMonths,
        includedComputeCNY: item.includedComputeCNY,
      })),
    });
    const existing = await this.prisma.employeeBundle.findUnique({ where: { code: dto.code } });
    if (existing) throw new ConflictException('套餐编码已存在');

    const bundle = await this.prisma.employeeBundle.create({
      data: {
        code: dto.code,
        name: dto.name,
        description: dto.description,
        cover: dto.cover,
        priceCNY: dto.priceCNY,
        periodMonths: dto.periodMonths,
        items: {
          create: dto.items.map((item) => ({
                employeeId: item.employeeId!,
            periodMonths: item.periodMonths ?? dto.periodMonths ?? 12,
            includedComputeCNY: item.includedComputeCNY,
          })),
        },
      },
      include: { items: { include: { employee: true }, orderBy: { id: 'asc' } } },
    });
    return this.toView(bundle);
  }

  async update(id: string, dto: UpdateEmployeeBundleDto) {
    const current = await this.findForView(id);
    if (current.status === EmployeeBundleStatus.PUBLISHED) {
      throw new BadRequestException('已发布套餐不能直接修改，请先下架');
    }
    if (dto.items || dto.priceCNY !== undefined || dto.periodMonths !== undefined) {
      await this.validateBundleInput({
        code: dto.code ?? current.code,
        name: dto.name ?? current.name,
        priceCNY: dto.priceCNY ?? current.priceCNY.toNumber(),
        periodMonths: dto.periodMonths ?? current.periodMonths,
        items: dto.items?.map((item) => ({
          employeeId: item.employeeId!,
          periodMonths: item.periodMonths,
          includedComputeCNY: item.includedComputeCNY,
        })) ?? current.items.map((item) => ({
          employeeId: item.employeeId,
          periodMonths: item.periodMonths,
          includedComputeCNY: item.includedComputeCNY?.toNumber() ?? null,
        })),
      });
    }
    if (dto.code && dto.code !== current.code) {
      const sameCode = await this.prisma.employeeBundle.findUnique({ where: { code: dto.code } });
      if (sameCode) throw new ConflictException('套餐编码已存在');
    }

    return this.prisma.$transaction(async (tx) => {
      if (dto.items) {
        await tx.employeeBundleItem.deleteMany({ where: { bundleId: id } });
      }
      const updated = await tx.employeeBundle.update({
        where: { id },
        data: {
          ...(dto.code !== undefined && { code: dto.code }),
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.description !== undefined && { description: dto.description }),
          ...(dto.cover !== undefined && { cover: dto.cover }),
          ...(dto.priceCNY !== undefined && { priceCNY: dto.priceCNY }),
          ...(dto.periodMonths !== undefined && { periodMonths: dto.periodMonths }),
          ...(dto.items && {
            items: {
              create: dto.items.map((item) => ({
                employeeId: item.employeeId,
                periodMonths: item.periodMonths ?? dto.periodMonths ?? current.periodMonths,
                includedComputeCNY: item.includedComputeCNY,
              })),
            },
          }),
        },
        include: { items: { include: { employee: true }, orderBy: { id: 'asc' } } },
      });
      return this.toView(updated);
    });
  }

  async publish(id: string) {
    const bundle = await this.findForView(id);
    if (bundle.items.length === 0) throw new BadRequestException('套餐至少需要一名员工');
    await this.validateEmployees(bundle.items.map((item) => item.employee));
    if (bundle.priceCNY.lessThanOrEqualTo(0)) throw new BadRequestException('套餐价格必须大于 0');
    return this.prisma.employeeBundle.update({
      where: { id },
      data: { status: EmployeeBundleStatus.PUBLISHED, publishedAt: new Date() },
      include: { items: { include: { employee: true }, orderBy: { id: 'asc' } } },
    }).then((value) => this.toView(value));
  }

  async archive(id: string) {
    await this.findForView(id);
    return this.prisma.employeeBundle.update({
      where: { id },
      data: { status: EmployeeBundleStatus.ARCHIVED },
    });
  }

  async getForPurchase(id: string): Promise<BundleWithItems> {
    return this.findForView(id, EmployeeBundleStatus.PUBLISHED);
  }

  async resolveGiftCNY(item: BundleWithItems['items'][number]) {
    return item.includedComputeCNY === null
      ? this.fulfillment.resolveGiftCNY(item.employee.includedComputeCNY, item.employee.annualPriceCNY)
      : item.includedComputeCNY.toNumber();
  }

  private async validateBundleInput(input: {
    code: string;
    name: string;
    priceCNY: number;
    periodMonths: number;
    items: Array<{ employeeId: string; periodMonths?: number; includedComputeCNY?: number | null }>;
  }) {
    if (input.priceCNY <= 0) throw new BadRequestException('套餐价格必须大于 0');
    const employeeIds = input.items.map((item) => item.employeeId);
    if (new Set(employeeIds).size !== employeeIds.length) throw new BadRequestException('套餐不能重复包含同一员工');
    const employees = await this.prisma.digitalEmployee.findMany({ where: { id: { in: employeeIds } } });
    if (employees.length !== employeeIds.length) throw new NotFoundException('套餐包含的员工不存在');
    await this.validateEmployees(employees);
  }

  private async validateEmployees(employees: Array<{ id: string; name: string; status: string; annualPriceCNY: Prisma.Decimal | null }>) {
    const invalid = employees.filter((employee) => employee.status !== 'APPROVED');
    if (invalid.length > 0) throw new BadRequestException(`套餐包含未上架员工：${invalid.map((item) => item.name).join('、')}`);
    const withoutPrice = employees.filter((employee) => !employee.annualPriceCNY || employee.annualPriceCNY.lessThanOrEqualTo(0));
    if (withoutPrice.length > 0) throw new BadRequestException(`套餐包含未设置有效价格的员工：${withoutPrice.map((item) => item.name).join('、')}`);
  }

  private async findForView(id: string, status?: EmployeeBundleStatus): Promise<BundleWithItems> {
    const bundle = await this.prisma.employeeBundle.findFirst({
      where: { id, ...(status ? { status } : {}) },
      include: { items: { include: { employee: true }, orderBy: { id: 'asc' } } },
    });
    if (!bundle) throw new NotFoundException('套餐不存在或未上架');
    return bundle;
  }

  private async toView(bundle: BundleWithItems) {
    const items = await Promise.all(bundle.items.map(async (item) => {
      const unitPrice = item.employee.annualPriceCNY ?? new Decimal(0);
      const periodMonths = item.periodMonths || bundle.periodMonths;
      const subtotal = unitPrice.mul(new Decimal(periodMonths).div(12));
      const includedComputeCNY = await this.resolveGiftCNY(item);
      return {
        id: item.id,
        employeeId: item.employeeId,
        employeeName: item.employee.name,
        employeeAvatar: item.employee.avatar,
        employeeVersion: item.employee.version,
        unitPrice: unitPrice.toFixed(2),
        periodMonths,
        subtotal: subtotal.toFixed(2),
        includedComputeCNY: includedComputeCNY.toFixed(2),
      };
    }));
    const originalAmount = items.reduce((sum, item) => sum.plus(item.subtotal), new Decimal(0));
    const discount = Decimal.max(originalAmount.sub(bundle.priceCNY), new Decimal(0));
    const totalCompute = items.reduce((sum, item) => sum.plus(item.includedComputeCNY), new Decimal(0));
    return {
      id: bundle.id,
      code: bundle.code,
      name: bundle.name,
      description: bundle.description,
      cover: bundle.cover,
      status: bundle.status,
      priceCNY: bundle.priceCNY.toFixed(2),
      periodMonths: bundle.periodMonths,
      originalAmountCNY: originalAmount.toFixed(2),
      discountCNY: discount.toFixed(2),
      totalComputeCNY: totalCompute.toFixed(2),
      publishedAt: bundle.publishedAt,
      createdAt: bundle.createdAt,
      updatedAt: bundle.updatedAt,
      items,
    };
  }
}
