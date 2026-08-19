-- AlterTable
ALTER TABLE "CashEntry" ADD COLUMN     "separateReport" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "JournalLine" ADD COLUMN     "separateReport" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "StatementTransaction" ADD COLUMN     "separateReport" BOOLEAN NOT NULL DEFAULT false;
