import { BadRequestException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { MAX_BUNDLE_COVER_SIZE, type BundleCopyDraftDto } from '../../shared/employee-bundle.dto';
import { EmployeeCopyDraftService } from '../admin/employee-copy-draft.service';
import { validateUploadedFile } from '../upload/file-validator';
import { StorageService } from '../upload/storage/storage.service';

const COVER_FILENAME = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(png|jpg|jpeg|webp)$/;

@Injectable()
export class EmployeeBundleEditorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly copyDraft: EmployeeCopyDraftService,
    private readonly storage: StorageService,
  ) {}

  async generateDescription(input: BundleCopyDraftDto) {
    const employees = await this.prisma.digitalEmployee.findMany({
      where: { id: { in: input.employeeIds }, status: 'APPROVED' },
      select: {
        id: true, name: true, description: true, industry: true, position: true,
        bindings: {
          where: { enabled: true, capability: { status: 'APPROVED' } },
          take: 25, orderBy: { id: 'asc' },
          select: { capability: { select: { name: true, description: true } } },
        },
      },
    });
    if (employees.length !== input.employeeIds.length) {
      throw new BadRequestException('所选员工不存在或尚未上架，请刷新后重试');
    }
    const byId = new Map(employees.map((employee) => [employee.id, employee]));
    // Bound model context while retaining every selected employee and representative capabilities.
    const perEmployeeBudget = Math.floor(40000 / employees.length);
    return this.copyDraft.generateBundle({
      name: input.name,
      employees: input.employeeIds.map((id) => {
        const employee = byId.get(id)!;
        const capabilities = employee.bindings.slice(0, 5).map(({ capability }) => ({
          name: capability.name.slice(0, 120),
          description: capability.description.slice(0, Math.floor(perEmployeeBudget / 10)),
        }));
        return {
          name: employee.name.slice(0, 120),
          description: employee.description.slice(0, Math.min(2000, Math.floor(perEmployeeBudget / 2))),
          industry: employee.industry.slice(0, 100),
          position: employee.position.slice(0, 100),
          capabilities,
        };
      }),
    });
  }

  async uploadCover(file?: Express.Multer.File) {
    if (!file?.buffer?.length) throw new BadRequestException('请选择套餐封面图片');
    if (file.buffer.length > MAX_BUNDLE_COVER_SIZE || file.size > MAX_BUNDLE_COVER_SIZE) {
      throw new PayloadTooLargeException('套餐封面不能超过 5MB');
    }
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extname(file.originalname).toLowerCase())) {
      throw new BadRequestException('套餐封面仅支持 PNG、JPEG、WebP 图片');
    }
    const validated = validateUploadedFile({ ...file, size: file.buffer.length });
    const filename = `${randomUUID()}.${validated.ext}`;
    await this.storage.put({ key: `bundle-covers/${filename}`, buffer: file.buffer, mime: validated.mime, filename });
    return { cover: `/api/market/bundles/covers/${filename}` };
  }

  async readCover(filename: string) {
    if (!COVER_FILENAME.test(filename)) throw new NotFoundException('套餐封面不存在');
    const buffer = await this.storage.get(`bundle-covers/${filename}`);
    const extension = extname(filename);
    return { buffer, mime: extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg' };
  }
}
