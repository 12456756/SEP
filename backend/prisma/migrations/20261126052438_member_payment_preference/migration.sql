-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('AUTO', 'ENTERPRISE_ONLY', 'PERSONAL_ONLY');

-- AlterTable
ALTER TABLE "enterprise_members" ADD COLUMN     "paymentMode" "PaymentMode" NOT NULL DEFAULT 'AUTO';
