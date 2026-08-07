-- AlterEnum
ALTER TYPE "Recurrence" ADD VALUE 'HALF_YEARLY';

-- AlterTable
ALTER TABLE "Bill" ADD COLUMN     "insuredFor" TEXT,
ADD COLUMN     "insuredValue" DECIMAL(14,2),
ADD COLUMN     "policyNumber" TEXT;

-- AlterTable
ALTER TABLE "Budget" ADD COLUMN     "frequency" TEXT NOT NULL DEFAULT 'MONTHLY';
