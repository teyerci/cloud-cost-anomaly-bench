-- AlterTable
ALTER TABLE "DetectionRun" ADD COLUMN     "detector" TEXT NOT NULL DEFAULT 'isolation_forest',
ADD COLUMN     "robustZThreshold" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "DatasetBuildRun" ADD COLUMN     "attributionSetting" TEXT NOT NULL DEFAULT 'oracle',
ADD COLUMN     "distractorsPerScenario" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "eventTimeJitterHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "dimensionNoiseRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "distractorEventCount" INTEGER NOT NULL DEFAULT 0;
