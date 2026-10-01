ALTER TABLE "DatasetBuildRun"
ADD COLUMN "runDetection" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "runAttributionForTruePositives" BOOLEAN NOT NULL DEFAULT false;
