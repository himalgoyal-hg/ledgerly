-- CreateTable
CREATE TABLE "FinanceMonth" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,

    CONSTRAINT "FinanceMonth_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinanceMonth_month_key" ON "FinanceMonth"("month");
