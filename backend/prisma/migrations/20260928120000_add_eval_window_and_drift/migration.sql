-- AlterTable
ALTER TABLE "DetectionRun" ADD COLUMN     "postFilter" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "alertBudget" INTEGER,
ADD COLUMN     "evalWindowFrom" TIMESTAMP(3),
ADD COLUMN     "evalWindowTo" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DatasetBuildRun" ADD COLUMN     "injectionFrom" TIMESTAMP(3),
ADD COLUMN     "injectionTo" TIMESTAMP(3),
ADD COLUMN     "driftFraction" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "driftWindowHours" DOUBLE PRECISION;
