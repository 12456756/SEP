-- AlterTable
ALTER TABLE "compute_integration_jobs" ADD COLUMN     "lastErrorMessage" TEXT,
ADD COLUMN     "requestPayload" JSONB;

-- AlterTable
ALTER TABLE "enterprise_compute_bindings" ADD COLUMN     "lastErrorMessage" TEXT;
