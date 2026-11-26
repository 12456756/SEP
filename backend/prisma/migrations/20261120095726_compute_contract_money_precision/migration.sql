-- AlterTable
ALTER TABLE "compute_integration_executions" ALTER COLUMN "grossCny" SET DATA TYPE DECIMAL(24,6);

-- AlterTable
ALTER TABLE "compute_integration_reconciliations" ALTER COLUMN "localBalanceCny" SET DATA TYPE DECIMAL(24,6),
ALTER COLUMN "remoteBalanceCny" SET DATA TYPE DECIMAL(24,6),
ALTER COLUMN "differenceCny" SET DATA TYPE DECIMAL(25,6);

-- AlterTable
ALTER TABLE "compute_integration_settlements" ALTER COLUMN "grossCny" SET DATA TYPE DECIMAL(24,6),
ALTER COLUMN "freeCny" SET DATA TYPE DECIMAL(24,6),
ALTER COLUMN "paidCny" SET DATA TYPE DECIMAL(24,6),
ALTER COLUMN "unpaidCny" SET DATA TYPE DECIMAL(24,6);

-- AlterTable
ALTER TABLE "compute_integration_transfers" ALTER COLUMN "amountCny" SET DATA TYPE DECIMAL(24,6);
