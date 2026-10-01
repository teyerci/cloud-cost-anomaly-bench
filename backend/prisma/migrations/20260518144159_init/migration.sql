-- CreateTable
CREATE TABLE "BillingRecord" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "account" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "cost" DOUBLE PRECISION NOT NULL,
    "usageQuantity" DOUBLE PRECISION NOT NULL,
    "tags" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InfrastructureEvent" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "eventType" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "resourceId" TEXT,
    "description" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InfrastructureEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnomalyResult" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "billingRecordId" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "severity" TEXT NOT NULL,
    "expectedCost" DOUBLE PRECISION NOT NULL,
    "actualCost" DOUBLE PRECISION NOT NULL,
    "explanation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnomalyResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RootCauseCandidate" (
    "id" TEXT NOT NULL,
    "anomalyResultId" TEXT NOT NULL,
    "infrastructureEventId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "signals" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RootCauseCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillingRecord_timestamp_idx" ON "BillingRecord"("timestamp");

-- CreateIndex
CREATE INDEX "BillingRecord_service_region_account_idx" ON "BillingRecord"("service", "region", "account");

-- CreateIndex
CREATE INDEX "InfrastructureEvent_timestamp_idx" ON "InfrastructureEvent"("timestamp");

-- CreateIndex
CREATE INDEX "InfrastructureEvent_eventType_idx" ON "InfrastructureEvent"("eventType");

-- CreateIndex
CREATE INDEX "InfrastructureEvent_service_region_account_idx" ON "InfrastructureEvent"("service", "region", "account");

-- CreateIndex
CREATE INDEX "AnomalyResult_timestamp_idx" ON "AnomalyResult"("timestamp");

-- CreateIndex
CREATE INDEX "AnomalyResult_severity_idx" ON "AnomalyResult"("severity");

-- CreateIndex
CREATE INDEX "RootCauseCandidate_anomalyResultId_idx" ON "RootCauseCandidate"("anomalyResultId");

-- CreateIndex
CREATE INDEX "RootCauseCandidate_score_idx" ON "RootCauseCandidate"("score");

-- AddForeignKey
ALTER TABLE "AnomalyResult" ADD CONSTRAINT "AnomalyResult_billingRecordId_fkey" FOREIGN KEY ("billingRecordId") REFERENCES "BillingRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RootCauseCandidate" ADD CONSTRAINT "RootCauseCandidate_anomalyResultId_fkey" FOREIGN KEY ("anomalyResultId") REFERENCES "AnomalyResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RootCauseCandidate" ADD CONSTRAINT "RootCauseCandidate_infrastructureEventId_fkey" FOREIGN KEY ("infrastructureEventId") REFERENCES "InfrastructureEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
