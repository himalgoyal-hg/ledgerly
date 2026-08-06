-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CashEntryKind" AS ENUM ('RECEIPT', 'PAYMENT', 'TRANSFER', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "BillStatus" AS ENUM ('PENDING', 'PAID');

-- CreateEnum
CREATE TYPE "Recurrence" AS ENUM ('NONE', 'MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "PayrollType" AS ENUM ('SALARY', 'CONSULTANT');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('OPEN', 'PARTIAL', 'SETTLED');

-- AlterTable
ALTER TABLE "Entity" ADD COLUMN     "invoicePrefix" TEXT NOT NULL DEFAULT 'INV',
ADD COLUMN     "nextInvoiceNumber" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "Reimbursement" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "link" TEXT,
    "remarks" TEXT,
    "status" "ClaimStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "expenseAccountId" TEXT,
    "costCentreId" TEXT,
    "docId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reimbursement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashEntry" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "kind" "CashEntryKind" NOT NULL,
    "date" DATE NOT NULL,
    "locationId" TEXT NOT NULL,
    "toLocationId" TEXT,
    "headAccountId" TEXT,
    "costCentreId" TEXT,
    "inflow" BOOLEAN NOT NULL DEFAULT false,
    "amount" DECIMAL(14,2) NOT NULL,
    "remarks" TEXT,
    "reason" TEXT,
    "docId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bill" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "billType" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "billDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "renewalDate" DATE,
    "link" TEXT,
    "remarks" TEXT,
    "recurrence" "Recurrence" NOT NULL DEFAULT 'NONE',
    "expenseAccountId" TEXT NOT NULL,
    "costCentreId" TEXT,
    "status" "BillStatus" NOT NULL DEFAULT 'PENDING',
    "entryDocId" TEXT,
    "paymentDocId" TEXT,
    "paidAt" TIMESTAMP(3),
    "seriesId" TEXT,
    "periodKey" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryPerson" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PayrollType" NOT NULL,
    "team" TEXT,
    "costCentreId" TEXT,
    "monthlyGross" DECIMAL(14,2) NOT NULL,
    "tdsSection" TEXT NOT NULL,
    "tdsRate" DECIMAL(5,2) NOT NULL,
    "payableAccountId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalaryPerson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryRun" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'DRAFT',
    "docId" TEXT,
    "paymentDocId" TEXT,
    "approvedById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalaryRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryRunLine" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "gross" DECIMAL(14,2) NOT NULL,
    "tds" DECIMAL(14,2) NOT NULL,
    "net" DECIMAL(14,2) NOT NULL,
    "costCentreId" TEXT,

    CONSTRAINT "SalaryRunLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceTask" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(14,2),
    "dueDate" DATE NOT NULL,
    "recurrence" "Recurrence" NOT NULL DEFAULT 'NONE',
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "notes" TEXT,
    "seriesId" TEXT,
    "periodKey" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "customer" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "narration" TEXT,
    "incomeAccountId" TEXT NOT NULL,
    "costCentreId" TEXT,
    "debtorAccountId" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "docId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoicePayment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "docId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoicePayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Reimbursement_docId_key" ON "Reimbursement"("docId");

-- CreateIndex
CREATE INDEX "Reimbursement_entityId_status_idx" ON "Reimbursement"("entityId", "status");

-- CreateIndex
CREATE INDEX "Reimbursement_memberId_idx" ON "Reimbursement"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "CashEntry_docId_key" ON "CashEntry"("docId");

-- CreateIndex
CREATE INDEX "CashEntry_entityId_date_idx" ON "CashEntry"("entityId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Bill_entryDocId_key" ON "Bill"("entryDocId");

-- CreateIndex
CREATE UNIQUE INDEX "Bill_paymentDocId_key" ON "Bill"("paymentDocId");

-- CreateIndex
CREATE INDEX "Bill_entityId_status_dueDate_idx" ON "Bill"("entityId", "status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "Bill_seriesId_periodKey_key" ON "Bill"("seriesId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryPerson_entityId_name_key" ON "SalaryPerson"("entityId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryRun_docId_key" ON "SalaryRun"("docId");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryRun_paymentDocId_key" ON "SalaryRun"("paymentDocId");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryRun_entityId_year_month_key" ON "SalaryRun"("entityId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryRunLine_runId_personId_key" ON "SalaryRunLine"("runId", "personId");

-- CreateIndex
CREATE INDEX "FinanceTask_entityId_status_dueDate_idx" ON "FinanceTask"("entityId", "status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceTask_seriesId_periodKey_key" ON "FinanceTask"("seriesId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_docId_key" ON "Invoice"("docId");

-- CreateIndex
CREATE INDEX "Invoice_entityId_status_idx" ON "Invoice"("entityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_entityId_number_key" ON "Invoice"("entityId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "InvoicePayment_docId_key" ON "InvoicePayment"("docId");

-- AddForeignKey
ALTER TABLE "SalaryRunLine" ADD CONSTRAINT "SalaryRunLine_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SalaryRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
