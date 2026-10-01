ALTER TABLE "BillingRecord" ADD COLUMN "isInjectedAnomaly" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BillingRecord" ADD COLUMN "anomalyType" TEXT;
ALTER TABLE "BillingRecord" ADD COLUMN "expectedRootCause" TEXT;
