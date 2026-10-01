ALTER TABLE "BillingRecord" ALTER COLUMN "resourceId" DROP NOT NULL;
ALTER TABLE "BillingRecord" ADD COLUMN "sourceType" TEXT NOT NULL DEFAULT 'synthetic';
ALTER TABLE "BillingRecord" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "BillingRecord" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "BillingRecord" ADD COLUMN "rawSource" JSONB;

CREATE INDEX "BillingRecord_sourceType_idx" ON "BillingRecord"("sourceType");
