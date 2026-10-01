CREATE TABLE "DetectionRun" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "contamination" DOUBLE PRECISION NOT NULL,
    "nEstimators" INTEGER NOT NULL,
    "maxSamples" TEXT NOT NULL,
    "randomState" INTEGER NOT NULL,
    "calibrationUsed" BOOLEAN NOT NULL DEFAULT false,
    "selectedThreshold" DOUBLE PRECISION,
    "thresholdPercentile" DOUBLE PRECISION,
    "scoreDistribution" JSONB,
    "labeledAnomalies" INTEGER NOT NULL DEFAULT 0,
    "detectedAnomalies" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DetectionRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DetectionRun_sourceType_createdAt_idx"
ON "DetectionRun"("sourceType", "createdAt");
