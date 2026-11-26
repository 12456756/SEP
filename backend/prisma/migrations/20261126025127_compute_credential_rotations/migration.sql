-- CreateTable
CREATE TABLE "compute_credential_rotations" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "enterpriseId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "expectedVersion" INTEGER NOT NULL,
    "oldCredentialId" TEXT NOT NULL,
    "oldRemoteId" TEXT NOT NULL,
    "newCredentialId" TEXT,
    "remoteAccountId" TEXT NOT NULL,
    "encryptionKeyId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "openSlot" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compute_credential_rotations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "compute_credential_rotations_operationId_key" ON "compute_credential_rotations"("operationId");

-- CreateIndex
CREATE INDEX "compute_credential_rotations_status_nextRunAt_idx" ON "compute_credential_rotations"("status", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "compute_credential_rotations_enterpriseId_kind_openSlot_key" ON "compute_credential_rotations"("enterpriseId", "kind", "openSlot");
