-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Budget_entityId_year_idx" ON "Budget"("entityId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_entityId_accountId_year_month_key" ON "Budget"("entityId", "accountId", "year", "month");
