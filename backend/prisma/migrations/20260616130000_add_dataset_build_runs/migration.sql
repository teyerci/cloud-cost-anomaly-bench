ALTER TABLE "DetectionRun"
ADD COLUMN "buildRunId" TEXT;

CREATE TABLE "DatasetBuildRun" (
  "id" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "focusFilePath" TEXT,
  "alibabaFilePath" TEXT,
  "seed" INTEGER NOT NULL DEFAULT 42,
  "numScenarios" INTEGER NOT NULL DEFAULT 50,
  "timeWindowHours" DOUBLE PRECISION,
  "minTimeWindowHours" DOUBLE PRECISION,
  "maxTimeWindowHours" DOUBLE PRECISION,
  "minBaselineCost" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "costMultiplierMin" DOUBLE PRECISION,
  "costMultiplierMax" DOUBLE PRECISION,
  "importedFocusRecords" INTEGER NOT NULL DEFAULT 0,
  "importedAlibabaEvents" INTEGER NOT NULL DEFAULT 0,
  "injectedScenarioCount" INTEGER NOT NULL DEFAULT 0,
  "injectedRecordCount" INTEGER NOT NULL DEFAULT 0,
  "hybridBillingRecordCount" INTEGER NOT NULL DEFAULT 0,
  "expectedRootCauseEventIds" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DatasetBuildRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DetectionRun_buildRunId_idx" ON "DetectionRun"("buildRunId");
CREATE INDEX "DatasetBuildRun_sourceType_createdAt_idx" ON "DatasetBuildRun"("sourceType", "createdAt");
