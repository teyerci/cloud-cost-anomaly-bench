-- Injection details move from the billing row's raw source to the label.
ALTER TABLE "GroundTruthLabel" ADD COLUMN "metadata" JSONB;
