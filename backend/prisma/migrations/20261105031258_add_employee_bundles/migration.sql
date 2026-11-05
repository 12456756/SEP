/*
  Warnings:

  - A unique constraint covering the columns `[fulfilledSubscriptionId]` on the table `order_items` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "EmployeeBundleStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('EMPLOYEE', 'BUNDLE');

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "employeeVersion" TEXT,
ADD COLUMN     "fulfilledSubscriptionId" TEXT,
ADD COLUMN     "purchaseAmountCNY" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "bundleId" TEXT,
ADD COLUMN     "bundleName" TEXT,
ADD COLUMN     "bundlePeriodMonths" INTEGER,
ADD COLUMN     "bundlePriceCNY" DECIMAL(12,2),
ADD COLUMN     "orderType" "OrderType" NOT NULL DEFAULT 'EMPLOYEE';

-- CreateTable
CREATE TABLE "employee_bundles" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "cover" TEXT,
    "status" "EmployeeBundleStatus" NOT NULL DEFAULT 'DRAFT',
    "priceCNY" DECIMAL(12,2) NOT NULL,
    "periodMonths" INTEGER NOT NULL DEFAULT 12,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_bundle_items" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodMonths" INTEGER NOT NULL DEFAULT 12,
    "includedComputeCNY" DECIMAL(12,2),

    CONSTRAINT "employee_bundle_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employee_bundles_code_key" ON "employee_bundles"("code");

-- CreateIndex
CREATE INDEX "employee_bundles_status_publishedAt_idx" ON "employee_bundles"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "employee_bundle_items_employeeId_idx" ON "employee_bundle_items"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_bundle_items_bundleId_employeeId_key" ON "employee_bundle_items"("bundleId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_fulfilledSubscriptionId_key" ON "order_items"("fulfilledSubscriptionId");

-- AddForeignKey
ALTER TABLE "employee_bundle_items" ADD CONSTRAINT "employee_bundle_items_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "employee_bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_bundle_items" ADD CONSTRAINT "employee_bundle_items_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "digital_employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "employee_bundles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
