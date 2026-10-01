import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Prisma, PrismaClient } from "@prisma/client";
import type { BillingRecord } from "@prisma/client";
import { compareBillingRecords } from "./billingOrder.js";
import { runRootCauseAttribution } from "./rootCauseService.js";

const execFileAsync = promisify(execFile);

type BillingFeatureRecord = {
  id: string;
  timestamp: string;
  cost: number;
  logCost: number;
  usageQuantity: number;
  serviceIndex: number;
  regionIndex: number;
  accountIndex: number;
  projectIndex: number;
  hourOfDay: number;
  dayOfWeek: number;
  isWeekend: number;
  sourceIndex: number;
  previousCost: number;
  costDelta: number;
  costDeltaPercent: number;
  absoluteCostDelta: number;
  relativeCostDelta: number;
  rollingMean3: number;
  rollingMean7: number;
  rollingStd7: number;
  rollingMedian7: number;
  rollingMinPositive7: number;
  rollingMax7: number;
  costToRollingMean7: number;
  costToRollingMedian7: number;
  costToRollingMinPositive7: number;
  rollingPercentileRank: number;
  groupCostShareAtTimestamp: number;
  serviceCostShareAtTimestamp: number;
  isLowImpactCandidate: number;
  robustZScore: number;
  historyCount: number;
  // Seasonal-naive references for the seasonal rule: the same series' cost 24 h and 168 h earlier (0 if absent).
  costPrev24h: number;
  costPrev168h: number;
  isGroundTruth: boolean;
  inEvalWindow: boolean;
};

type IsolationForestResult = {
  id: string;
  isAnomaly: boolean;
  score: number;
  anomalyStrength?: number;
  severity: string;
  features: Record<string, number>;
};

export type DetectorName = "isolation_forest" | "ratio_rule" | "robust_z" | "seasonal_rule" | "median_ratio_rule" | "dollar_rule";

export type EvalWindow = { from: Date; to: Date };

export function inWindow(timestamp: Date, window?: EvalWindow) {
  if (!window) return true;
  const time = timestamp.getTime();
  return time >= window.from.getTime() && time < window.to.getTime();
}

type DetectorMetadata = {
  detector: DetectorName;
  postFilter: boolean;
  alertBudget?: number | null;
  featureSet: "all" | "numeric";
  fitChargedOnly: boolean;
  budgetRankBy: "severity" | "delta";
  budgetPool: "eligible" | "flagged";
  fitOutsideEvalWindow: boolean;
  robustZThreshold?: number | null;
  contamination: number;
  nEstimators: number;
  maxSamples: string;
  randomState: number;
  calibrationUsed: boolean;
  selectedThreshold?: number | null;
  thresholdPercentile?: number | null;
  scoreDistribution?: Record<string, number>;
  tuningResults?: Array<Record<string, number>>;
  bestF1Config?: Record<string, number> | null;
  bestPrecisionConfig?: Record<string, number> | null;
  minRelativeIncrease: number;
  minAbsoluteDelta: number;
  labeledAnomalies: number;
  detectedAnomalies: number;
};

type IsolationForestOutput = {
  results: IsolationForestResult[];
  metadata: DetectorMetadata;
};

export type DetectorOptions = {
  detector?: DetectorName;
  // Label-assisted grid search; only for calibration runs, never for reported held-out results.
  calibrate?: boolean;
  robustZThreshold?: number;
  contamination?: number;
  nEstimators?: number;
  maxSamples?: "auto" | number;
  randomState?: number;
  thresholdPercentile?: number;
  minRelativeIncrease?: number;
  minAbsoluteDelta?: number;
  // Standalone Isolation Forest: postFilter false, flagged by model score alone (top alertBudget
  // in-window rows, or the model's contamination threshold when no budget is given).
  postFilter?: boolean;
  alertBudget?: number;
  // Isolation Forest input: "numeric" drops the categorical index features (service, region, account,
  // project, source); fitChargedOnly fits and ranks only rows with non-zero cost.
  featureSet?: "all" | "numeric";
  fitChargedOnly?: boolean;
  // Rule with alertBudget: rank eligible rows by the rule's ratio (default) or by dollar increase.
  budgetRankBy?: "severity" | "delta";
  budgetPool?: "eligible" | "flagged";
  // Fit the scaler and forest (and take the gate's score percentile) on rows outside the evaluation window only.
  fitOutsideEvalWindow?: boolean;
  // Rows outside this window still feed rolling features but never count for calibration or evaluation.
  evalWindow?: EvalWindow;
  attributionMode?: "all" | "true_positives" | "none";
  buildRunId?: string;
};

const services = ["compute", "database", "storage", "network"];
const regions = ["us-east-1", "eu-west-1"];
const accounts = ["dev", "staging", "prod"];

function stableIndex(value: string | undefined, knownValues: string[]) {
  if (!value) return 0;
  const knownIndex = knownValues.indexOf(value);
  if (knownIndex >= 0) return knownIndex + 1;
  return Array.from(value).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 97;
}

function projectFromTags(tags: unknown) {
  if (!tags || typeof tags !== "object" || !("project" in tags)) return "unknown";
  const project = (tags as { project?: unknown }).project;
  return typeof project === "string" ? project : "unknown";
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stddev(values: number[], average: number) {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, value) => sum + Math.pow(value - average, 2), 0) / values.length;
  return Math.sqrt(variance);
}

function median(values: number[]) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function finite(value: number, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function buildFeatureRows(records: BillingRecord[], truth: Set<string>, window?: EvalWindow): BillingFeatureRecord[] {
  const sorted = [...records].sort(compareBillingRecords);
  const groups = new Map<string, BillingRecord[]>();
  const timestampTotals = new Map<number, number>();
  const serviceTimestampTotals = new Map<string, number>();
  const groupTimestampTotals = new Map<string, number>();

  for (const record of sorted) {
    const cost = Math.max(0, finite(record.cost));
    const time = record.timestamp.getTime();
    timestampTotals.set(time, (timestampTotals.get(time) ?? 0) + cost);
    serviceTimestampTotals.set(`${time}:${record.service}`, (serviceTimestampTotals.get(`${time}:${record.service}`) ?? 0) + cost);
    groupTimestampTotals.set(
      `${time}:${record.account}:${record.service}:${record.region}`,
      (groupTimestampTotals.get(`${time}:${record.account}:${record.service}:${record.region}`) ?? 0) + cost
    );
  }

  for (const record of sorted) {
    const key = `${record.account}:${record.service}:${record.region}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }

  const features: BillingFeatureRecord[] = [];
  const hourMs = 60 * 60 * 1000;
  for (const groupRecords of groups.values()) {
    const ordered = [...groupRecords].sort(compareBillingRecords);
    const costAtTime = new Map<number, number>();
    for (const item of ordered) {
      const time = item.timestamp.getTime();
      costAtTime.set(time, (costAtTime.get(time) ?? 0) + Math.max(0, finite(item.cost)));
    }
    // History is strictly earlier timestamps; rows sharing a timestamp are not each other's past.
    // The rolling window is the seven most recent earlier rows with a non-zero cost: zero-cost hours
    // (most rows of the aggregated sample) would otherwise pull the rolling median to $0.
    let pastEnd = 0;
    let chargedUpTo = 0;
    const chargedPast: number[] = [];
    for (let index = 0; index < ordered.length; index += 1) {
      const record = ordered[index];
      if (index > 0 && ordered[index - 1].timestamp.getTime() !== record.timestamp.getTime()) pastEnd = index;
      for (; chargedUpTo < pastEnd; chargedUpTo += 1) {
        const pastCost = Math.max(0, finite(ordered[chargedUpTo].cost));
        if (pastCost > 0) chargedPast.push(pastCost);
      }
      const cost = Math.max(0, finite(record.cost));
      const previous = Math.max(0, finite(ordered[pastEnd - 1]?.cost ?? cost));
      const history = chargedPast.slice(-7);
      const positiveHistory = history;
      const history3 = history.slice(-3);
      const rollingMean3 = mean(history3) || previous;
      const rollingMean7 = mean(history) || previous;
      const rollingStd7 = stddev(history, rollingMean7);
      const rollingMedian7 = median(history) || previous;
      const rollingMinPositive7 = positiveHistory.length ? Math.min(...positiveHistory) : previous;
      const rollingMad = median(history.map((value) => Math.abs(value - rollingMedian7)));
      // Floor the MAD scale so a flat history (MAD = 0) does not make any change an unbounded z-score.
      const robustScale = Math.max(rollingMad * 1.4826, 0.25 * rollingMedian7, 0.05);
      const project = projectFromTags(record.tags);
      const dayOfWeek = record.timestamp.getUTCDay();
      const time = record.timestamp.getTime();
      const timestampTotal = timestampTotals.get(time) ?? 0;
      const serviceTotal = serviceTimestampTotals.get(`${time}:${record.service}`) ?? 0;
      const groupTotal = groupTimestampTotals.get(`${time}:${record.account}:${record.service}:${record.region}`) ?? 0;
      const absoluteCostDelta = Math.abs(cost - rollingMedian7);
      const relativeCostDelta = rollingMedian7 > 0 ? finite((cost - rollingMedian7) / rollingMedian7) : 0;
      const rollingPercentileRank = history.length ? history.filter((value) => value <= cost).length / history.length : 0.5;
      const lowImpact = cost < rollingMedian7 * 2 || cost - rollingMedian7 < 0.5;
      features.push({
        id: record.id,
        timestamp: record.timestamp.toISOString(),
        cost,
        logCost: Math.log1p(cost),
        usageQuantity: finite(record.usageQuantity),
        serviceIndex: stableIndex(record.service, services),
        regionIndex: stableIndex(record.region, regions),
        accountIndex: stableIndex(record.account, accounts),
        projectIndex: stableIndex(project, []),
        sourceIndex: stableIndex(record.sourceType, ["synthetic", "focus", "hybrid_synthesized"]),
        hourOfDay: record.timestamp.getUTCHours(),
        dayOfWeek,
        isWeekend: dayOfWeek === 0 || dayOfWeek === 6 ? 1 : 0,
        previousCost: previous,
        costDelta: cost - previous,
        costDeltaPercent: previous > 0 ? finite((cost - previous) / previous) : 0,
        absoluteCostDelta,
        relativeCostDelta,
        rollingMean3,
        rollingMean7,
        rollingStd7,
        rollingMedian7,
        rollingMinPositive7,
        rollingMax7: history.length ? Math.max(...history) : previous,
        costToRollingMean7: rollingMean7 > 0 ? finite(cost / rollingMean7, 1) : 1,
        costToRollingMedian7: rollingMedian7 > 0 ? finite(cost / rollingMedian7, 1) : 1,
        costToRollingMinPositive7: rollingMinPositive7 > 0 ? finite(cost / rollingMinPositive7, 1) : 1,
        rollingPercentileRank,
        groupCostShareAtTimestamp: timestampTotal > 0 ? finite(groupTotal / timestampTotal) : 0,
        serviceCostShareAtTimestamp: timestampTotal > 0 ? finite(serviceTotal / timestampTotal) : 0,
        isLowImpactCandidate: lowImpact ? 1 : 0,
        robustZScore: finite((cost - rollingMedian7) / robustScale),
        historyCount: history.length,
        costPrev24h: costAtTime.get(time - 24 * hourMs) ?? 0,
        costPrev168h: costAtTime.get(time - 168 * hourMs) ?? 0,
        isGroundTruth: truth.has(record.id) || record.isInjectedAnomaly,
        inEvalWindow: inWindow(record.timestamp, window)
      });
    }
  }

  return features;
}

function findMlScript() {
  const candidates = [
    path.resolve(process.cwd(), "../ml/detect_anomalies.py"),
    path.resolve(process.cwd(), "ml/detect_anomalies.py"),
    path.resolve(process.cwd(), "../../ml/detect_anomalies.py")
  ];
  const script = candidates.find((candidate) => existsSync(candidate));
  if (!script) throw new Error("Isolation Forest script not found. Expected ml/detect_anomalies.py.");
  return script;
}

function findPythonExecutable() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const candidates = [
    path.resolve(process.cwd(), "../.venv/bin/python"),
    path.resolve(process.cwd(), ".venv/bin/python")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? "python3";
}

async function runIsolationForest(features: BillingFeatureRecord[], options: DetectorMetadata) {
  const workDir = await mkdtemp(path.join(tmpdir(), "cloud-cost-if-"));
  const inputPath = path.join(workDir, "features.json");
  const outputPath = path.join(workDir, "results.json");

  try {
    await writeFile(inputPath, JSON.stringify({ records: features, options }), "utf-8");
    await execFileAsync(findPythonExecutable(), [findMlScript(), inputPath, outputPath], {
      maxBuffer: 1024 * 1024 * 8
    });
    const output = await readFile(outputPath, "utf-8");
    return JSON.parse(output) as IsolationForestOutput;
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
}

const detectorLabels: Record<DetectorName, string> = {
  isolation_forest: "Isolation Forest",
  ratio_rule: "Ratio rule",
  robust_z: "Robust z-score rule",
  seasonal_rule: "Seasonal rule",
  median_ratio_rule: "Median-reference ratio rule",
  dollar_rule: "Dollar-increase rule"
};

// Alert text in the quantities that made the detector fire: each rule's own reference cost, the ratio and dollar
// increase over it, and the robust z-score.
function explainAlert(detector: DetectorName, postFilter: boolean | undefined, record: BillingRecord, feature: BillingFeatureRecord) {
  const where = `${record.account}/${record.service}/${record.region}`;
  const cost = Math.max(0, record.cost);
  const z = `robust z-score ${feature.robustZScore.toFixed(2)}`;
  if (detector === "isolation_forest" && postFilter === false) {
    return `Isolation Forest (score only) flagged ${where}; cost $${cost.toFixed(2)} vs rolling median $${feature.rollingMedian7.toFixed(2)}; ${z}.`;
  }
  const [reference, name] =
    detector === "robust_z" || detector === "median_ratio_rule" ? [feature.rollingMedian7, "median of the last seven charged rows"]
    : detector === "seasonal_rule" ? [Math.max(feature.costPrev24h, feature.costPrev168h), "larger of the same hour 24 h and 168 h earlier"]
    : [feature.rollingMinPositive7, "lowest of the last seven charged rows"];
  const ratio = reference > 0 ? `${(cost / reference).toFixed(2)}x` : "n/a";
  return `${detectorLabels[detector]}${detector === "isolation_forest" ? " (Isolation Forest gate on the ratio rule)" : ""} flagged ${where}; cost $${cost.toFixed(2)} vs reference $${reference.toFixed(2)} (${name}): ratio ${ratio}, increase $${(cost - reference).toFixed(2)}; ${z}.`;
}

function severityFromResult(result: IsolationForestResult, record: BillingRecord, expectedCost: number) {
  if (result.severity === "critical" || result.severity === "high") return result.severity;
  const ratio = record.cost / Math.max(expectedCost, 1);
  if (ratio >= 3) return "critical";
  if (ratio >= 2) return "high";
  return "medium";
}

export type AnomalySourceType = "synthetic" | "focus" | "hybrid_synthesized" | "all";

function detectorOptions(sourceType: AnomalySourceType, overrides: DetectorOptions = {}): DetectorMetadata {
  const contaminationBySource: Record<AnomalySourceType, number> = {
    synthetic: 0.03,
    hybrid_synthesized: 0.01,
    focus: 0.02,
    all: 0.02
  };
  const hybridMode = sourceType === "hybrid_synthesized";
  return {
    detector: overrides.detector ?? "isolation_forest",
    postFilter: overrides.postFilter ?? true,
    alertBudget: overrides.alertBudget ?? null,
    featureSet: overrides.featureSet ?? "all",
    fitChargedOnly: overrides.fitChargedOnly ?? false,
    budgetRankBy: overrides.budgetRankBy ?? "severity",
    budgetPool: overrides.budgetPool ?? "eligible",
    fitOutsideEvalWindow: overrides.fitOutsideEvalWindow ?? false,
    robustZThreshold: overrides.robustZThreshold ?? null,
    contamination: overrides.contamination ?? contaminationBySource[sourceType],
    nEstimators: overrides.nEstimators ?? 300,
    maxSamples: String(overrides.maxSamples ?? "auto"),
    randomState: overrides.randomState ?? 42,
    calibrationUsed: overrides.calibrate ?? false,
    selectedThreshold: null,
    thresholdPercentile: overrides.thresholdPercentile ?? (hybridMode ? 99 : null),
    minRelativeIncrease: overrides.minRelativeIncrease ?? (hybridMode ? 2.5 : 2),
    minAbsoluteDelta: overrides.minAbsoluteDelta ?? (hybridMode ? 1 : 0.5),
    labeledAnomalies: 0,
    detectedAnomalies: 0
  };
}

async function featurePayloadForSource(prisma: PrismaClient, sourceType: AnomalySourceType, window?: EvalWindow) {
  const [records, labels] = await Promise.all([
    prisma.billingRecord.findMany({
      where: sourceType === "all" ? undefined : { sourceType },
      orderBy: { timestamp: "asc" }
    }),
    sourceType === "hybrid_synthesized" || sourceType === "all"
      ? prisma.groundTruthLabel.findMany({
        where: { sourceDataset: "hybrid_synthesized" },
        select: { billingRecordId: true }
      })
      : Promise.resolve([])
  ]);
  const truth = new Set(labels.map((label) => label.billingRecordId).filter((id): id is string => Boolean(id)));
  return { records, truth, features: buildFeatureRows(records, truth, window) };
}

export async function runAnomalyTuningExperiment(
  prisma: PrismaClient,
  sourceType: AnomalySourceType = "hybrid_synthesized",
  overrides: DetectorOptions = {}
) {
  if (sourceType !== "synthetic" && sourceType !== "hybrid_synthesized") {
    throw new Error("Tuning experiments require labeled synthetic or hybrid_synthesized data.");
  }
  const { features } = await featurePayloadForSource(prisma, sourceType, overrides.evalWindow);
  const requestedOptions = detectorOptions(sourceType, overrides);
  const output = await runIsolationForest(features, {
    ...requestedOptions,
    calibrationUsed: true,
    labeledAnomalies: features.filter((feature) => feature.isGroundTruth).length,
    detectedAnomalies: 0
  });
  return {
    sourceType,
    records: features.length,
    labeledAnomalies: output.metadata.labeledAnomalies,
    tuningResults: output.metadata.tuningResults,
    bestF1Config: output.metadata.bestF1Config,
    bestPrecisionConfig: output.metadata.bestPrecisionConfig
  };
}

export async function runAnomalyDetection(
  prisma: PrismaClient,
  sourceType: AnomalySourceType = "all",
  overrides: DetectorOptions = {}
) {
  if (sourceType === "all") {
    await prisma.rootCauseCandidate.deleteMany();
    await prisma.anomalyResult.deleteMany();
  } else {
    await prisma.rootCauseCandidate.deleteMany({
      where: { anomalyResult: { billingRecord: { sourceType } } }
    });
    await prisma.anomalyResult.deleteMany({
      where: { billingRecord: { sourceType } }
    });
  }

  const { records, features } = await featurePayloadForSource(prisma, sourceType, overrides.evalWindow);
  const recordById = new Map(records.map((record) => [record.id, record]));
  const featureById = new Map(features.map((feature) => [feature.id, feature]));
  const requestedOptions = detectorOptions(sourceType, overrides);
  const output = await runIsolationForest(features, {
    ...requestedOptions,
    calibrationUsed: requestedOptions.calibrationUsed,
    labeledAnomalies: features.filter((feature) => feature.isGroundTruth).length,
    detectedAnomalies: 0
  });
  const results = output.results;

  const anomalies = results
    .filter((result) => result.isAnomaly)
    .map((result) => {
      const record = recordById.get(result.id);
      const feature = featureById.get(result.id);
      if (!record || !feature) return undefined;

      const expectedCost = Math.max(
        0,
        Number((feature.rollingMinPositive7 || feature.rollingMedian7 || feature.rollingMean7 || feature.previousCost || record.cost).toFixed(2))
      );
      const actualCost = Math.max(0, record.cost);
      const strength = result.anomalyStrength ?? Math.max(0, -result.score);
      return {
        timestamp: record.timestamp,
        billingRecordId: record.id,
        score: Number(strength.toFixed(4)),
        severity: severityFromResult(result, record, expectedCost),
        expectedCost,
        actualCost,
        sourceType: record.sourceType,
        explanation: explainAlert(output.metadata.detector, output.metadata.postFilter, record, feature)
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  if (anomalies.length > 0) {
    await prisma.anomalyResult.createMany({ data: anomalies });
  }

  await prisma.detectionRun.create({
    data: {
      sourceType,
      detector: output.metadata.detector,
      robustZThreshold: output.metadata.robustZThreshold ?? null,
      postFilter: output.metadata.postFilter,
      alertBudget: output.metadata.alertBudget ?? null,
      evalWindowFrom: overrides.evalWindow?.from ?? null,
      evalWindowTo: overrides.evalWindow?.to ?? null,
      contamination: output.metadata.contamination,
      nEstimators: output.metadata.nEstimators,
      maxSamples: output.metadata.maxSamples,
      randomState: output.metadata.randomState,
      calibrationUsed: output.metadata.calibrationUsed,
      selectedThreshold: output.metadata.selectedThreshold,
      thresholdPercentile: output.metadata.thresholdPercentile,
      scoreDistribution: output.metadata.scoreDistribution as Prisma.InputJsonValue | undefined,
      tuningResults: output.metadata.tuningResults as Prisma.InputJsonValue | undefined,
      bestF1Config: output.metadata.bestF1Config as Prisma.InputJsonValue | undefined,
      bestPrecisionConfig: output.metadata.bestPrecisionConfig as Prisma.InputJsonValue | undefined,
      minRelativeIncrease: output.metadata.minRelativeIncrease,
      minAbsoluteDelta: output.metadata.minAbsoluteDelta,
      labeledAnomalies: output.metadata.labeledAnomalies,
      detectedAnomalies: output.metadata.detectedAnomalies,
      buildRunId: overrides.buildRunId
    }
  });

  const storedAnomalies = await prisma.anomalyResult.findMany({
    where: sourceType === "all" ? undefined : { sourceType },
    include: { billingRecord: true },
    orderBy: [{ severity: "asc" }, { timestamp: "desc" }]
  });

  if (sourceType === "hybrid_synthesized" && overrides.attributionMode !== "none") {
    const attributableAnomalies = overrides.attributionMode === "true_positives"
      ? storedAnomalies.filter((anomaly) => anomaly.billingRecord?.isInjectedAnomaly)
      : storedAnomalies;
    for (const anomaly of attributableAnomalies) {
      await runRootCauseAttribution(prisma, anomaly.id);
    }
  }

  return storedAnomalies;
}

export type DetectionPreconditionStats = {
  injectedRows: number;
  meetsPrecondition: number;
  recallCeiling: number | null;
  seasonalRecallCeiling: number | null;
  missed: Record<"insufficient_history" | "no_baseline" | "ratio_below_threshold" | "delta_below_threshold" | "passes_rule", number>;
  missedByMultiplier: Record<"below_2" | "from_2_to_3" | "from_3", number>;
  injectedByMultiplier: Record<"below_2" | "from_2_to_3" | "from_3", number>;
};

// How many injected rows a cost-ratio rule could flag at all, and why the undetected ones were missed.
// Mirrors material_cost_spike in ml/detect_anomalies.py.
export async function detectionPreconditionStats(
  prisma: PrismaClient,
  detectedRecordIds: Set<string>,
  thresholds: { minRelativeIncrease: number; minAbsoluteDelta: number },
  window?: EvalWindow
): Promise<DetectionPreconditionStats> {
  const { features } = await featurePayloadForSource(prisma, "hybrid_synthesized", window);
  const injected = features.filter((feature) => feature.isGroundTruth && feature.inEvalWindow);
  const missed = { insufficient_history: 0, no_baseline: 0, ratio_below_threshold: 0, delta_below_threshold: 0, passes_rule: 0 };
  let meetsPrecondition = 0;
  let meetsSeasonal = 0;
  // Missed rows by the multiplier actually applied to the row (drift rows ramp up from just above 1x).
  const labels = await prisma.groundTruthLabel.findMany({ where: { billingRecordId: { in: injected.map((feature) => feature.id) } }, select: { billingRecordId: true, metadata: true } });
  const multiplierOf = new Map(labels.map((label) => [label.billingRecordId, Number((label.metadata as Record<string, unknown> | null)?.injectedMultiplier ?? NaN)]));
  const missedByMultiplier = { below_2: 0, from_2_to_3: 0, from_3: 0 };
  const injectedByMultiplier = { below_2: 0, from_2_to_3: 0, from_3: 0 };
  for (const feature of injected) {
    const multiplier = multiplierOf.get(feature.id) ?? NaN;
    const bucket = multiplier < 2 ? "below_2" : multiplier < 3 ? "from_2_to_3" : "from_3";
    injectedByMultiplier[bucket] += 1;
    if (Math.max(feature.costPrev24h ?? 0, feature.costPrev168h ?? 0) >= 0.1) meetsSeasonal += 1;
    if (!detectedRecordIds.has(feature.id)) missedByMultiplier[bucket] += 1;
    const baseline = Math.max(0, feature.rollingMinPositive7 || feature.rollingMedian7 || 0);
    const eligible = feature.historyCount >= 6 && baseline >= 0.1;
    if (eligible) meetsPrecondition += 1;
    if (detectedRecordIds.has(feature.id)) continue;
    if (feature.historyCount < 6) missed.insufficient_history += 1;
    else if (baseline < 0.1) missed.no_baseline += 1;
    else if (feature.cost / baseline < thresholds.minRelativeIncrease) missed.ratio_below_threshold += 1;
    else if (feature.cost - baseline < thresholds.minAbsoluteDelta) missed.delta_below_threshold += 1;
    else missed.passes_rule += 1;
  }
  return {
    injectedRows: injected.length,
    meetsPrecondition,
    recallCeiling: injected.length ? Number((meetsPrecondition / injected.length).toFixed(4)) : null,
    seasonalRecallCeiling: injected.length ? Number((meetsSeasonal / injected.length).toFixed(4)) : null,
    missed,
    missedByMultiplier,
    injectedByMultiplier
  };
}
