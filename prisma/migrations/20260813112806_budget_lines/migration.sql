-- CreateTable
CREATE TABLE "BudgetLine" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "headAccountId" TEXT,
    "label" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "onMonth" TEXT,
    "expenseType" TEXT,
    "taxTreatment" TEXT,
    "dayNote" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BudgetLine_source_archivedAt_idx" ON "BudgetLine"("source", "archivedAt");
