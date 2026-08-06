-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('DETECTED', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "TxnStatus" AS ENUM ('PENDING', 'TAGGED', 'POSTED', 'DUPLICATE');

-- AlterTable
ALTER TABLE "JournalLine" ADD COLUMN     "costCentreId" TEXT;

-- CreateTable
CREATE TABLE "StatementImport" (
    "id" TEXT NOT NULL,
    "bankAccountId" TEXT,
    "entityId" TEXT,
    "fileName" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'DETECTED',
    "detectedVia" TEXT NOT NULL,
    "rawRows" JSONB NOT NULL,
    "headerSignature" TEXT NOT NULL,
    "closingBalance" DECIMAL(14,2),
    "rowsTotal" INTEGER NOT NULL DEFAULT 0,
    "rowsDuplicate" INTEGER NOT NULL DEFAULT 0,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatementImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatementTransaction" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "narration" TEXT NOT NULL,
    "reference" TEXT,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "balance" DECIMAL(14,2),
    "dedupeHash" TEXT NOT NULL,
    "status" "TxnStatus" NOT NULL DEFAULT 'PENDING',
    "headAccountId" TEXT,
    "nature" TEXT,
    "costCentreId" TEXT,
    "autoTagged" BOOLEAN NOT NULL DEFAULT false,
    "taggedById" TEXT,
    "taggedAt" TIMESTAMP(3),
    "docId" TEXT,
    "mirrorTxnId" TEXT,

    CONSTRAINT "StatementTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TagRule" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "headAccountId" TEXT NOT NULL,
    "nature" TEXT NOT NULL,
    "costCentreId" TEXT,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'learned',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TagRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostCentre" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostCentre_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatementMapping" (
    "id" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatementMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StatementImport_bankAccountId_idx" ON "StatementImport"("bankAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "StatementTransaction_docId_key" ON "StatementTransaction"("docId");

-- CreateIndex
CREATE UNIQUE INDEX "StatementTransaction_mirrorTxnId_key" ON "StatementTransaction"("mirrorTxnId");

-- CreateIndex
CREATE INDEX "StatementTransaction_entityId_status_idx" ON "StatementTransaction"("entityId", "status");

-- CreateIndex
CREATE INDEX "StatementTransaction_importId_idx" ON "StatementTransaction"("importId");

-- CreateIndex
CREATE UNIQUE INDEX "StatementTransaction_bankAccountId_dedupeHash_key" ON "StatementTransaction"("bankAccountId", "dedupeHash");

-- CreateIndex
CREATE UNIQUE INDEX "TagRule_entityId_pattern_key" ON "TagRule"("entityId", "pattern");

-- CreateIndex
CREATE UNIQUE INDEX "CostCentre_entityId_name_key" ON "CostCentre"("entityId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "StatementMapping_signature_key" ON "StatementMapping"("signature");

-- CreateIndex
CREATE INDEX "JournalLine_costCentreId_idx" ON "JournalLine"("costCentreId");

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_costCentreId_fkey" FOREIGN KEY ("costCentreId") REFERENCES "CostCentre"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementImport" ADD CONSTRAINT "StatementImport_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementTransaction" ADD CONSTRAINT "StatementTransaction_importId_fkey" FOREIGN KEY ("importId") REFERENCES "StatementImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
