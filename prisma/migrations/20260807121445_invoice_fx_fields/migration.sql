-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "amountFx" DECIMAL(14,2),
ADD COLUMN     "bankCharges" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN     "firc" TEXT,
ADD COLUMN     "fxRate" DECIMAL(9,4);
