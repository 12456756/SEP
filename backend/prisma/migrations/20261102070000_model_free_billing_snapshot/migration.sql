-- AlterTable
ALTER TABLE "gateway_executions" ADD COLUMN     "billingSnapshot" JSONB;

-- AlterTable
ALTER TABLE "platform_models" ADD COLUMN     "isFree" BOOLEAN NOT NULL DEFAULT false;
