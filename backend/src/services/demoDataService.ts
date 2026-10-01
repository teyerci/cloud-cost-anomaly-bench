import { Prisma, PrismaClient } from "@prisma/client";
import { importAlibabaTraceCsv } from "./alibabaTraceImportService.js";
import { runAnomalyDetection, type DetectorOptions } from "./anomalyService.js";
import { evaluateCurrentRun } from "./evaluationService.js";
import { importFocusCsv } from "./focusImportService.js";
import { buildHybridDataset, type AttributionSetting, type HybridBuildOptions } from "./hybridDatasetService.js";

export type DemoRebuildOptions = {
  focusFilePath?: string;
  alibabaFilePath?: string;
  seed?: number;
  numScenarios?: number;
  timeWindowHours?: number;
  minTimeWindowHours?: number;
  maxTimeWindowHours?: number;
  minBaselineCost?: number;
  costMultiplierMin?: number;
  costMultiplierMax?: number;
  runDetection?: boolean;
  runAttributionForTruePositives?: boolean;
  attributionSetting?: AttributionSetting;
  distractorsPerScenario?: number;
  eventTimeJitterHours?: number;
  dimensionNoiseRate?: number;
  injectionFrom?: Date | string;
  injectionTo?: Date | string;
  driftFraction?: number;
  driftWindowHours?: number;
  minIncidentGapHours?: number;
  detectorOptions?: DetectorOptions;
};

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const demoBillingSources = ["synthetic", "focus", "hybrid_synthesized"];
const demoEventSources = ["synthetic", "alibaba_trace", "hybrid_synthesized"];

function numberOption(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function hybridOptions(options: DemoRebuildOptions, buildRunId?: string): HybridBuildOptions {
  return {
    focusSourceType: "focus",
    seed: Math.floor(numberOption(options.seed, 42)),
    numScenarios: Math.floor(numberOption(options.numScenarios, 50)),
    timeWindowHours: typeof options.timeWindowHours === "number" ? options.timeWindowHours : undefined,
    minTimeWindowHours: typeof options.minTimeWindowHours === "number" ? options.minTimeWindowHours : undefined,
    maxTimeWindowHours: typeof options.maxTimeWindowHours === "number" ? options.maxTimeWindowHours : undefined,
    minBaselineCost: numberOption(options.minBaselineCost, 1),
    costMultiplierMin: typeof options.costMultiplierMin === "number" ? options.costMultiplierMin : undefined,
    costMultiplierMax: typeof options.costMultiplierMax === "number" ? options.costMultiplierMax : undefined,
    attributionSetting: options.attributionSetting === "oracle" ? "oracle" : "realistic",
    distractorsPerScenario: optionalNumber(options.distractorsPerScenario),
    eventTimeJitterHours: optionalNumber(options.eventTimeJitterHours),
    dimensionNoiseRate: optionalNumber(options.dimensionNoiseRate),
    injectionFrom: options.injectionFrom,
    injectionTo: options.injectionTo,
    driftFraction: optionalNumber(options.driftFraction),
    driftWindowHours: optionalNumber(options.driftWindowHours),
    minIncidentGapHours: optionalNumber(options.minIncidentGapHours),
    buildRunId
  };
}

function metricsFromEvaluation(evaluation: Awaited<ReturnType<typeof evaluateCurrentRun>>) {
  return {
    precision: evaluation.precision ?? null,
    recall: evaluation.recall ?? null,
    f1Score: evaluation.f1Score ?? null,
    f1: evaluation.f1Score ?? null,
    tp: evaluation.confusionMatrix?.truePositives ?? null,
    fp: evaluation.confusionMatrix?.falsePositives ?? null,
    fn: evaluation.confusionMatrix?.falseNegatives ?? null,
    tn: evaluation.confusionMatrix?.trueNegatives ?? null
  };
}

export async function clearGeneratedDemoData(prisma: PrismaClient) {
  await prisma.$transaction([
    prisma.rootCauseCandidate.deleteMany(),
    prisma.anomalyResult.deleteMany(),
    prisma.groundTruthLabel.deleteMany({
      where: { sourceDataset: { in: ["hybrid_synthesized", "synthetic"] } }
    }),
    prisma.detectionRun.deleteMany({
      where: { sourceType: { in: demoBillingSources } }
    }),
    prisma.datasetBuildRun.deleteMany({
      where: { sourceType: { in: demoBillingSources } }
    }),
    prisma.infrastructureEvent.deleteMany({
      where: { sourceType: { in: demoEventSources } }
    }),
    prisma.billingRecord.deleteMany({
      where: { sourceType: { in: demoBillingSources } }
    })
  ]);
  return { status: "ok", clearedSources: { billing: demoBillingSources, events: demoEventSources } };
}

export async function clearHybridGeneratedData(prisma: PrismaClient) {
  await prisma.$transaction([
    prisma.rootCauseCandidate.deleteMany({
      where: { anomalyResult: { billingRecord: { sourceType: "hybrid_synthesized" } } }
    }),
    prisma.anomalyResult.deleteMany({
      where: { billingRecord: { sourceType: "hybrid_synthesized" } }
    }),
    prisma.groundTruthLabel.deleteMany({ where: { sourceDataset: "hybrid_synthesized" } }),
    prisma.detectionRun.deleteMany({ where: { sourceType: "hybrid_synthesized" } }),
    prisma.datasetBuildRun.deleteMany({ where: { sourceType: "hybrid_synthesized" } }),
    prisma.infrastructureEvent.deleteMany({ where: { sourceType: "hybrid_synthesized" } }),
    prisma.billingRecord.deleteMany({ where: { sourceType: "hybrid_synthesized" } })
  ]);
}

export async function rebuildHybridDemoData(prisma: PrismaClient, options: DemoRebuildOptions = {}) {
  await clearHybridGeneratedData(prisma);
  const seed = Math.floor(numberOption(options.seed, 42));
  const buildRun = await prisma.datasetBuildRun.create({
    data: {
      sourceType: "hybrid_synthesized",
      focusFilePath: options.focusFilePath,
      alibabaFilePath: options.alibabaFilePath,
      seed,
      numScenarios: Math.floor(numberOption(options.numScenarios, 50)),
      timeWindowHours: typeof options.timeWindowHours === "number" ? options.timeWindowHours : undefined,
      minTimeWindowHours: typeof options.minTimeWindowHours === "number" ? options.minTimeWindowHours : undefined,
      maxTimeWindowHours: typeof options.maxTimeWindowHours === "number" ? options.maxTimeWindowHours : undefined,
      minBaselineCost: numberOption(options.minBaselineCost, 1),
      costMultiplierMin: numberOption(options.costMultiplierMin, 3),
      costMultiplierMax: numberOption(options.costMultiplierMax, 6),
      runDetection: Boolean(options.runDetection),
      runAttributionForTruePositives: Boolean(options.runAttributionForTruePositives)
    }
  });

  const hybrid = await buildHybridDataset(prisma, hybridOptions(options, buildRun.id));
  const expectedIds = hybrid.expectedRootCauseEventIds ?? [];
  const updatedRun = await prisma.datasetBuildRun.update({
    where: { id: buildRun.id },
    data: {
      minTimeWindowHours: hybrid.minTimeWindowHours,
      maxTimeWindowHours: hybrid.maxTimeWindowHours,
      timeWindowHours: hybrid.timeWindowHours,
      importedFocusRecords: await prisma.billingRecord.count({ where: { sourceType: "focus" } }),
      importedAlibabaEvents: await prisma.infrastructureEvent.count({ where: { sourceType: "alibaba_trace" } }),
      injectedScenarioCount: hybrid.injectedScenarios,
      injectedRecordCount: hybrid.injectedRecords,
      hybridBillingRecordCount: hybrid.baselineRecords,
      expectedRootCauseEventIds: expectedIds as Prisma.InputJsonValue,
      attributionSetting: hybrid.attributionSetting,
      distractorsPerScenario: hybrid.distractorsPerScenario,
      eventTimeJitterHours: hybrid.eventTimeJitterHours,
      dimensionNoiseRate: hybrid.dimensionNoiseRate,
      distractorEventCount: hybrid.distractorEvents,
      injectionFrom: hybrid.injectionFrom,
      injectionTo: hybrid.injectionTo,
      driftFraction: hybrid.driftFraction,
      driftWindowHours: hybrid.driftFraction > 0 ? hybrid.driftWindowHours : null
    }
  });

  return { buildRun: updatedRun, hybrid };
}

export async function resetAndRebuildDemoData(prisma: PrismaClient, options: DemoRebuildOptions) {
  if (!options.focusFilePath) throw new Error("focusFilePath is required.");
  if (!options.alibabaFilePath) throw new Error("alibabaFilePath is required.");

  await clearGeneratedDemoData(prisma);
  const focusImport = await importFocusCsv(prisma, options.focusFilePath);
  const alibabaImport = await importAlibabaTraceCsv(prisma, options.alibabaFilePath);
  const { buildRun, hybrid } = await rebuildHybridDemoData(prisma, options);

  let detectionRunId: string | null = null;
  let metrics: ReturnType<typeof metricsFromEvaluation> | null = null;
  if (options.runDetection) {
    await runAnomalyDetection(prisma, "hybrid_synthesized", {
      ...options.detectorOptions,
      attributionMode: options.runAttributionForTruePositives ? "true_positives" : "none",
      buildRunId: buildRun.id
    });
    const detectionRun = await prisma.detectionRun.findFirst({
      where: { sourceType: "hybrid_synthesized", buildRunId: buildRun.id },
      orderBy: { createdAt: "desc" }
    });
    detectionRunId = detectionRun?.id ?? null;
    metrics = metricsFromEvaluation(await evaluateCurrentRun(prisma, "hybrid_synthesized"));
  }

  return {
    status: "ok",
    buildRunId: buildRun.id,
    seed: buildRun.seed,
    numScenarios: buildRun.numScenarios,
    timeWindowHours: hybrid.timeWindowHours,
    minBaselineCost: buildRun.minBaselineCost,
    costMultiplierMin: buildRun.costMultiplierMin ?? hybrid.costMultiplierRange[0],
    costMultiplierMax: buildRun.costMultiplierMax ?? hybrid.costMultiplierRange[1],
    runDetection: Boolean(options.runDetection),
    runAttributionForTruePositives: Boolean(options.runAttributionForTruePositives),
    focusImportedRows: focusImport.insertedRows,
    alibabaImportedEvents: alibabaImport.insertedEvents,
    hybridBillingRecords: hybrid.baselineRecords,
    injectedScenarios: hybrid.injectedScenarios,
    attributionSetting: hybrid.attributionSetting,
    distractorEvents: hybrid.distractorEvents,
    labeledInjectedRecords: hybrid.injectedRecords,
    injectedRecords: hybrid.injectedRecords,
    expectedRootCauseEventIds: hybrid.expectedRootCauseEventIds,
    detectionRunId,
    metrics
  };
}

export async function getLastDatasetBuildRun(prisma: PrismaClient) {
  return prisma.datasetBuildRun.findFirst({
    where: { sourceType: "hybrid_synthesized" },
    orderBy: { createdAt: "desc" }
  });
}
