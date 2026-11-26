-- CreateTable
CREATE TABLE "compute_integration_executions" (
    "id" TEXT NOT NULL,
    "enterpriseId" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "credentialVersion" INTEGER NOT NULL,
    "remoteAccountId" TEXT NOT NULL,
    "computeRequestId" TEXT,
    "taskId" TEXT,
    "feeStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "billId" TEXT,
    "billVersion" INTEGER,
    "grossCny" DECIMAL(14,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compute_integration_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compute_integration_reconciliations" (
    "id" TEXT NOT NULL,
    "enterpriseId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "ledgerCursor" TEXT NOT NULL,
    "sequence" TEXT NOT NULL,
    "localBalanceCny" DECIMAL(14,6) NOT NULL,
    "remoteBalanceCny" DECIMAL(14,6) NOT NULL,
    "differenceCny" DECIMAL(15,6) NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compute_integration_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "compute_integration_executions_computeRequestId_key" ON "compute_integration_executions"("computeRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "compute_integration_executions_billId_key" ON "compute_integration_executions"("billId");

-- CreateIndex
CREATE INDEX "compute_integration_executions_enterpriseId_feeStatus_creat_idx" ON "compute_integration_executions"("enterpriseId", "feeStatus", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "compute_integration_executions_enterpriseId_kind_sourceRef_key" ON "compute_integration_executions"("enterpriseId", "kind", "sourceRef");

-- CreateIndex
CREATE UNIQUE INDEX "compute_integration_reconciliations_businessId_key" ON "compute_integration_reconciliations"("businessId");

-- CreateIndex
CREATE INDEX "compute_integration_reconciliations_enterpriseId_createdAt_idx" ON "compute_integration_reconciliations"("enterpriseId", "createdAt");
