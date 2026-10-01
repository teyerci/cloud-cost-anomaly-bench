ALTER TABLE "InfrastructureEvent"
ADD COLUMN "sourceType" TEXT NOT NULL DEFAULT 'synthetic';

ALTER TABLE "AnomalyResult"
ADD COLUMN "sourceType" TEXT NOT NULL DEFAULT 'synthetic';

CREATE TABLE "GroundTruthLabel" (
    "id" TEXT NOT NULL,
    "billingRecordId" TEXT,
    "anomalyWindowStart" TIMESTAMP(3) NOT NULL,
    "anomalyWindowEnd" TIMESTAMP(3) NOT NULL,
    "expectedRootCauseType" TEXT NOT NULL,
    "expectedEventId" TEXT,
    "expectedEventType" TEXT NOT NULL,
    "sourceDataset" TEXT NOT NULL DEFAULT 'hybrid_synthesized',
    "explanation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GroundTruthLabel_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InfrastructureEvent_sourceType_idx" ON "InfrastructureEvent"("sourceType");
CREATE INDEX "AnomalyResult_sourceType_idx" ON "AnomalyResult"("sourceType");
CREATE INDEX "GroundTruthLabel_billingRecordId_idx" ON "GroundTruthLabel"("billingRecordId");
CREATE INDEX "GroundTruthLabel_expectedEventId_idx" ON "GroundTruthLabel"("expectedEventId");
CREATE INDEX "GroundTruthLabel_sourceDataset_idx" ON "GroundTruthLabel"("sourceDataset");
CREATE INDEX "GroundTruthLabel_anomalyWindowStart_anomalyWindowEnd_idx"
ON "GroundTruthLabel"("anomalyWindowStart", "anomalyWindowEnd");

ALTER TABLE "GroundTruthLabel"
ADD CONSTRAINT "GroundTruthLabel_billingRecordId_fkey"
FOREIGN KEY ("billingRecordId") REFERENCES "BillingRecord"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GroundTruthLabel"
ADD CONSTRAINT "GroundTruthLabel_expectedEventId_fkey"
FOREIGN KEY ("expectedEventId") REFERENCES "InfrastructureEvent"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
