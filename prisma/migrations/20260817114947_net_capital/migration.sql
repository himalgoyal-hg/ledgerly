-- CreateTable
CREATE TABLE "NetCapitalLine" (
    "id" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "taxStatus" TEXT,
    "amountNew" DECIMAL(14,2),
    "amountTotal" DECIMAL(14,2),
    "synergy" DECIMAL(14,2),
    "fyFigure" DECIMAL(14,2),
    "remaining" DECIMAL(14,2),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NetCapitalLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NetCapitalLine_section_idx" ON "NetCapitalLine"("section");
