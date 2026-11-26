-- CreateTable
CREATE TABLE "compute_balance_sync_states" (
    "id" TEXT NOT NULL,
    "enterpriseId" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL DEFAULT 0,
    "baselineSequence" BIGINT NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastPolledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compute_balance_sync_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compute_balance_events" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "enterpriseId" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "origin" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "deltaCny" DECIMAL(24,6) NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "appliedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compute_balance_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "compute_balance_sync_states_enterpriseId_key" ON "compute_balance_sync_states"("enterpriseId");

-- CreateIndex
CREATE UNIQUE INDEX "compute_balance_events_eventId_key" ON "compute_balance_events"("eventId");

-- CreateIndex
CREATE INDEX "compute_balance_events_status_acknowledgedAt_createdAt_idx" ON "compute_balance_events"("status", "acknowledgedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "compute_balance_events_enterpriseId_sequence_key" ON "compute_balance_events"("enterpriseId", "sequence");
