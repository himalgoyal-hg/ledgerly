-- CreateEnum
CREATE TYPE "ReimbursementKind" AS ENUM ('CLAIM', 'ADVANCE');

-- AlterTable
ALTER TABLE "Reimbursement" ADD COLUMN     "kind" "ReimbursementKind" NOT NULL DEFAULT 'CLAIM';
