-- AlterTable
ALTER TABLE "employee_bundles" ADD COLUMN     "autoExcludeEmployeeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "autoIncludeAll" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoIncludeCategories" "EmployeeCategory"[] DEFAULT ARRAY[]::"EmployeeCategory"[];
