-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "country" TEXT,
ADD COLUMN     "creditDate" DATE,
ADD COLUMN     "providerFees" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "realizedInr" DECIMAL(14,2),
ADD COLUMN     "receivedFx" DECIMAL(14,2),
ALTER COLUMN "incomeAccountId" DROP NOT NULL;
