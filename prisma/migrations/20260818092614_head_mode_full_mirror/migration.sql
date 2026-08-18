-- AlterTable
ALTER TABLE "HeadMode" ADD COLUMN     "bankBudget" DECIMAL(14,2),
ADD COLUMN     "cashBudget" DECIMAL(14,2),
ADD COLUMN     "dayNote" TEXT,
ADD COLUMN     "frequency" TEXT,
ADD COLUMN     "nature" TEXT;
