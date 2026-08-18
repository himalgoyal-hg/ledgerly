-- CreateTable
CREATE TABLE "HeadMode" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "modeBank" TEXT,
    "modeCc" TEXT,
    "expenseType" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HeadMode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HeadMode_category_key" ON "HeadMode"("category");
