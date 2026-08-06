-- AlterTable
ALTER TABLE "Bill" ADD COLUMN     "gstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "gstRate" DECIMAL(5,2),
ADD COLUMN     "gstType" TEXT,
ADD COLUMN     "hsn" TEXT,
ADD COLUMN     "tdsAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "tdsRate" DECIMAL(5,2),
ADD COLUMN     "tdsSection" TEXT,
ADD COLUMN     "vendorGstin" TEXT,
ADD COLUMN     "vendorPan" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "customerGstin" TEXT,
ADD COLUMN     "gstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "gstRate" DECIMAL(5,2),
ADD COLUMN     "gstType" TEXT,
ADD COLUMN     "hsn" TEXT;

-- AlterTable
ALTER TABLE "StatementTransaction" ADD COLUMN     "counterpartyGstin" TEXT,
ADD COLUMN     "deducteePan" TEXT,
ADD COLUMN     "gstRate" DECIMAL(5,2),
ADD COLUMN     "gstType" TEXT,
ADD COLUMN     "hsn" TEXT,
ADD COLUMN     "tdsRate" DECIMAL(5,2),
ADD COLUMN     "tdsSection" TEXT;

-- CreateTable
CREATE TABLE "TaxLine" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "direction" TEXT NOT NULL,
    "party" TEXT,
    "gstType" TEXT,
    "gstRate" DECIMAL(5,2),
    "hsn" TEXT,
    "counterpartyGstin" TEXT,
    "taxableValue" DECIMAL(14,2) NOT NULL,
    "gstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tdsSection" TEXT,
    "tdsRate" DECIMAL(5,2),
    "deducteePan" TEXT,
    "tdsAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaxLine_docId_key" ON "TaxLine"("docId");

-- CreateIndex
CREATE INDEX "TaxLine_entityId_date_idx" ON "TaxLine"("entityId", "date");
