-- AlterTable
ALTER TABLE "conversation_sessions" ADD COLUMN     "enterpriseId" TEXT;

-- CreateTable
CREATE TABLE "enterprise_deletion_jobs" (
    "id" TEXT NOT NULL,
    "enterpriseId" TEXT NOT NULL,
    "enterpriseName" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "phase" TEXT NOT NULL DEFAULT 'PREPARE',
    "snapshot" JSONB NOT NULL,
    "manifest" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "error" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enterprise_deletion_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_deletion_jobs_enterpriseId_key" ON "enterprise_deletion_jobs"("enterpriseId");

-- CreateIndex
CREATE INDEX "enterprise_deletion_jobs_status_leaseUntil_createdAt_idx" ON "enterprise_deletion_jobs"("status", "leaseUntil", "createdAt");

-- CreateIndex
CREATE INDEX "conversation_sessions_enterpriseId_createdAt_idx" ON "conversation_sessions"("enterpriseId", "createdAt");
