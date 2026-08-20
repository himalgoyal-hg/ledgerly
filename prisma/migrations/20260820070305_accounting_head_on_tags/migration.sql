-- AlterTable
ALTER TABLE "CashEntry" ADD COLUMN     "accountingHeadId" TEXT;

-- AlterTable
ALTER TABLE "JournalLine" ADD COLUMN     "accountingHeadId" TEXT;

-- AlterTable
ALTER TABLE "StatementTransaction" ADD COLUMN     "accountingHeadId" TEXT;
