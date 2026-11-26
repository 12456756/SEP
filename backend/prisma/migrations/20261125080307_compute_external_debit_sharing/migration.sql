-- AlterTable
ALTER TABLE "compute_balance_events" ADD COLUMN     "allocation" JSONB,
ADD COLUMN     "outstandingCny" DECIMAL(24,6) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "compute_balance_sync_states" ADD COLUMN     "remoteAvailableCny" DECIMAL(24,6),
ADD COLUMN     "remoteFrozenCny" DECIMAL(24,6);
