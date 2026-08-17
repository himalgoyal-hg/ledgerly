-- CreateTable
CREATE TABLE "FinanceTask" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "account" TEXT,
    "dueDay" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceTaskCell" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceTaskCell_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FinanceTaskCell_month_idx" ON "FinanceTaskCell"("month");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceTaskCell_taskId_month_key" ON "FinanceTaskCell"("taskId", "month");

-- AddForeignKey
ALTER TABLE "FinanceTaskCell" ADD CONSTRAINT "FinanceTaskCell_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "FinanceTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
