-- CreateTable
CREATE TABLE "skill_import_devices" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "keyFingerprint" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "clientVersion" TEXT NOT NULL,
    "scopeSummary" JSONB NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skill_import_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "skill_import_devices_userId_revokedAt_idx" ON "skill_import_devices"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "skill_import_devices_instanceId_userId_keyFingerprint_key" ON "skill_import_devices"("instanceId", "userId", "keyFingerprint");

-- AddForeignKey
ALTER TABLE "skill_import_devices" ADD CONSTRAINT "skill_import_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
