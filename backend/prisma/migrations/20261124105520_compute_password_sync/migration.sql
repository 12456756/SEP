-- CreateTable
CREATE TABLE "compute_password_syncs" (
    "id" TEXT NOT NULL,
    "enterpriseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "encryptedPasswordHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compute_password_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "compute_password_syncs_enterpriseId_key" ON "compute_password_syncs"("enterpriseId");

-- CreateIndex
CREATE INDEX "compute_password_syncs_status_nextRunAt_idx" ON "compute_password_syncs"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "compute_password_syncs_userId_idx" ON "compute_password_syncs"("userId");
