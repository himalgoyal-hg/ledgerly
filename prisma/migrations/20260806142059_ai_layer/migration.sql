-- AlterTable
ALTER TABLE "StatementImport" ADD COLUMN     "parsedVia" TEXT NOT NULL DEFAULT 'heuristic';

-- AlterTable
ALTER TABLE "StatementTransaction" ADD COLUMN     "aiConfidence" DECIMAL(4,3),
ADD COLUMN     "aiCostCentreId" TEXT,
ADD COLUMN     "aiHeadAccountId" TEXT,
ADD COLUMN     "aiNature" TEXT,
ADD COLUMN     "aiReason" TEXT,
ADD COLUMN     "aiSuggestedAt" TIMESTAMP(3),
ADD COLUMN     "tagSource" TEXT;

-- CreateTable
CREATE TABLE "AiCall" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "kind" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiCall_createdAt_idx" ON "AiCall"("createdAt");

-- CreateIndex
CREATE INDEX "AiCall_entityId_kind_idx" ON "AiCall"("entityId", "kind");
