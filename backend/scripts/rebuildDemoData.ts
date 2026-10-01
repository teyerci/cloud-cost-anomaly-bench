import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { resetAndRebuildDemoData } from "../src/services/demoDataService.js";

function readArg(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readNumberArg(name: string) {
  const value = readArg(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be numeric.`);
  return parsed;
}

async function main() {
  const focusFilePath = readArg("--focus") ?? "data/focus-sample/focus_sample_100000.csv";
  const alibabaFilePath = readArg("--alibaba") ?? "data/alibaba/openb_pod_list_default.csv";
  const seed = readNumberArg("--seed") ?? 42;
  const numScenarios = readNumberArg("--scenarios") ?? 50;
  const timeWindowHours = readNumberArg("--time-window-hours");
  const minBaselineCost = readNumberArg("--min-baseline-cost") ?? 1;
  const costMultiplierMin = readNumberArg("--cost-multiplier-min") ?? 3;
  const costMultiplierMax = readNumberArg("--cost-multiplier-max") ?? 6;
  const attributionSetting = readArg("--attribution-setting") === "oracle" ? "oracle" : "realistic";
  const distractorsPerScenario = readNumberArg("--distractors");
  const eventTimeJitterHours = readNumberArg("--event-jitter-hours");
  const dimensionNoiseRate = readNumberArg("--dimension-noise");
  const detector = readArg("--detector");
  const skipDetection = process.argv.includes("--skip-detection");
  const skipAttribution = process.argv.includes("--skip-attribution");

  const prisma = new PrismaClient();
  try {
    const result = await resetAndRebuildDemoData(prisma, {
      focusFilePath,
      alibabaFilePath,
      seed,
      numScenarios,
      timeWindowHours,
      minBaselineCost,
      costMultiplierMin,
      costMultiplierMax,
      attributionSetting,
      distractorsPerScenario,
      eventTimeJitterHours,
      dimensionNoiseRate,
      detectorOptions: detector === "ratio_rule" || detector === "robust_z" || detector === "isolation_forest"
        ? { detector }
        : undefined,
      runDetection: !skipDetection,
      runAttributionForTruePositives: !skipAttribution
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
