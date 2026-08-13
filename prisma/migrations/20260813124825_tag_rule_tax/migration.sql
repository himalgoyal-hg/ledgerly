-- AlterTable
ALTER TABLE "TagRule" ADD COLUMN     "counterpartyGstin" TEXT,
ADD COLUMN     "deducteePan" TEXT,
ADD COLUMN     "gstRate" DECIMAL(5,2),
ADD COLUMN     "gstType" TEXT,
ADD COLUMN     "hsn" TEXT,
ADD COLUMN     "tdsRate" DECIMAL(5,2),
ADD COLUMN     "tdsSection" TEXT;
