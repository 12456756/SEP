-- CreateEnum
CREATE TYPE "ComputeIntegrationMode" AS ENUM ('LEGACY', 'PREPARING', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "ComputeIntegrationStatus" AS ENUM ('NOT_CONNECTED', 'PENDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "ComputeIntegrationJobStatus" AS ENUM ('BLOCKED', 'PENDING', 'RUNNING', 'SUCCEEDED');

-- CreateTable
CREATE TABLE "enterprise_compute_bindings" (
    "id" TEXT NOT NULL,
    "enterpriseId" TEXT NOT NULL,
    "remoteAccountId" TEXT,
    "registrationRef" TEXT NOT NULL,
    "mode" "ComputeIntegrationMode" NOT NULL DEFAULT 'LEGACY',
    "status" "ComputeIntegrationStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "lastErrorCode" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "ledgerCursor" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enterprise_compute_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enterprise_compute_credentials" (
    "id" TEXT NOT NULL,
    "enterpriseId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "remoteId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "maskedKey" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enterprise_compute_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compute_integration_jobs" (
    "id" TEXT NOT NULL,
    "enterpriseId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "ComputeIntegrationJobStatus" NOT NULL DEFAULT 'BLOCKED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compute_integration_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compute_integration_settlements" (
    "id" TEXT NOT NULL,
    "enterpriseId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "billVersion" INTEGER NOT NULL,
    "grossCny" DECIMAL(14,6) NOT NULL,
    "freeCny" DECIMAL(14,6) NOT NULL,
    "paidCny" DECIMAL(14,6) NOT NULL,
    "unpaidCny" DECIMAL(14,6) NOT NULL,
    "decisionHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNPAID',
    "remoteLedgerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compute_integration_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compute_integration_transfers" (
    "id" TEXT NOT NULL,
    "enterpriseId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amountCny" DECIMAL(14,6) NOT NULL,
    "fundingRef" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "remoteLedgerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compute_integration_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_compute_bindings_enterpriseId_key" ON "enterprise_compute_bindings"("enterpriseId");

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_compute_bindings_remoteAccountId_key" ON "enterprise_compute_bindings"("remoteAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_compute_bindings_registrationRef_key" ON "enterprise_compute_bindings"("registrationRef");

-- CreateIndex
CREATE INDEX "enterprise_compute_credentials_enterpriseId_kind_active_idx" ON "enterprise_compute_credentials"("enterpriseId", "kind", "active");

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_compute_credentials_enterpriseId_kind_version_key" ON "enterprise_compute_credentials"("enterpriseId", "kind", "version");

-- CreateIndex
CREATE UNIQUE INDEX "compute_integration_jobs_businessId_key" ON "compute_integration_jobs"("businessId");

-- CreateIndex
CREATE INDEX "compute_integration_jobs_status_nextRunAt_leaseUntil_idx" ON "compute_integration_jobs"("status", "nextRunAt", "leaseUntil");

-- CreateIndex
CREATE INDEX "compute_integration_jobs_enterpriseId_createdAt_idx" ON "compute_integration_jobs"("enterpriseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "compute_integration_settlements_executionId_key" ON "compute_integration_settlements"("executionId");

-- CreateIndex
CREATE UNIQUE INDEX "compute_integration_settlements_billId_key" ON "compute_integration_settlements"("billId");

-- CreateIndex
CREATE INDEX "compute_integration_settlements_enterpriseId_status_created_idx" ON "compute_integration_settlements"("enterpriseId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "compute_integration_transfers_businessId_key" ON "compute_integration_transfers"("businessId");

-- CreateIndex
CREATE INDEX "compute_integration_transfers_enterpriseId_status_createdAt_idx" ON "compute_integration_transfers"("enterpriseId", "status", "createdAt");
