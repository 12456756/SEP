import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PaymentModeSchema, type PaymentMode } from 'shared';

export async function readPaymentMode(
  db: Pick<Prisma.TransactionClient, 'enterpriseMember'>, enterpriseId: string, userId: string,
): Promise<PaymentMode> {
  const member = await db.enterpriseMember.findUnique({
    where: { userId_enterpriseId: { userId, enterpriseId } }, select: { paymentMode: true },
  });
  if (!member) throw new ForbiddenException('你已不属于该企业');
  return PaymentModeSchema.parse(member.paymentMode);
}
