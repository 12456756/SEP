-- AlterTable
ALTER TABLE "compute_integration_executions" ADD COLUMN     "baseUrl" TEXT,
ADD COLUMN     "dispatchStatus" TEXT NOT NULL DEFAULT 'PREPARED',
ADD COLUMN     "fundingContext" JSONB,
ADD COLUMN     "localUsageRecordId" TEXT;

-- AlterTable
ALTER TABLE "compute_integration_transfers" ADD COLUMN     "localApplied" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "walletAction" TEXT;

-- AlterTable
ALTER TABLE "compute_usage_records" ALTER COLUMN "inputPriceUsdPerMillion" DROP NOT NULL,
ALTER COLUMN "outputPriceUsdPerMillion" DROP NOT NULL,
ALTER COLUMN "usdToCnyRate" DROP NOT NULL;

-- AlterTable
ALTER TABLE "media_real_billing_reservations" ALTER COLUMN "usdToCnyRate" DROP NOT NULL;
