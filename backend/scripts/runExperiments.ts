import "dotenv/config";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { importAlibabaTraceCsv } from "../src/services/alibabaTraceImportService.js";
import {
  detectionPreconditionStats,
  runAnomalyDetection,
  type DetectorOptions,
  type EvalWindow
} from "../src/services/anomalyService.js";
import { clearGeneratedDemoData, rebuildHybridDemoData, type DemoRebuildOptions } from "../src/services/demoDataService.js";
import { evaluateCurrentRun } from "../src/services/evaluationService.js";
import { importFocusCsv } from "../src/services/focusImportService.js";
import { isInjectableSeries, type AttributionSetting } from "../src/services/hybridDatasetService.js";

// Evaluation protocol. The billing timeline is split at its median timestamp into two blocks. In the
// main direction, seed 42 injects incidents into the first block and is the only run that sees labels
// (label-assisted calibration of each detector on its own grid); held-out seeds 43-47 inject into the
// second block and are evaluated only there. The swapped direction repeats this with the blocks
// exchanged (calibration seed 142, held-out seeds 143-147), so results also vary with the normal rows.

function readArg(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readNumberArg(name: string, fallback: number) {
  const value = readArg(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be numeric.`);
  return parsed;
}

// Hourly account/service/region totals of the full FOCUS 1.0 sample (5.5M line items, September 2024),
// produced by data/tools/aggregate_focus_hourly.py.
const focusFilePath = readArg("--focus") ?? "data/focus-sample/focus_full_hourly.csv";
const alibabaFilePath = readArg("--alibaba") ?? "data/alibaba/openb_pod_list_default.csv";
const calibrationSeed = readNumberArg("--calibration-seed", 42);
const testSeeds = (readArg("--seeds") ?? "43,44,45,46,47").split(",").map(Number);
const outDir = path.resolve(process.cwd(), "..", readArg("--out-dir") ?? "results");
const skipSweeps = process.argv.includes("--skip-sweeps");
const skipSwapped = process.argv.includes("--skip-swapped");
const buildConfig = {
  focusFilePath,
  alibabaFilePath,
  // Each half of September holds ~1,000 eligible hourly rows in ~26 compute series; 60 incidents per
  // block with a 12 h minimum gap per series fits within the eligibility filters.
  numScenarios: readNumberArg("--scenarios", 60),
  timeWindowHours: readNumberArg("--time-window-hours", 4),
  minBaselineCost: readNumberArg("--min-baseline-cost", 1),
  costMultiplierMin: readNumberArg("--cost-multiplier-min", 3),
  costMultiplierMax: readNumberArg("--cost-multiplier-max", 6),
  distractorsPerScenario: readNumberArg("--distractors", 3),
  driftFraction: readNumberArg("--drift-fraction", 0.3),
  driftWindowHours: readNumberArg("--drift-window-hours", 12),
  minIncidentGapHours: readNumberArg("--min-incident-gap-hours", 12)
};

type Row = Record<string, string | number | boolean | null>;
type Json = Record<string, unknown>;
type Stats = { n: number; mean: number; sd: number; ciLow: number; ciHigh: number } | null;

// A-priori settings (never tuned on labels).
const RATIO_RULE: DetectorOptions = { detector: "ratio_rule", minRelativeIncrease: 2.5, minAbsoluteDelta: 1 };
const ROBUST_Z: DetectorOptions = { detector: "robust_z", robustZThreshold: 3.5, minAbsoluteDelta: 1 };
// The z-score rule where its scale floor binds (scale = 0.25 x median): cost >= max(1.875 x median, median + $1).
// Derived from the z-score rule's own settings, not from labels.
const MEDIAN_RULE_ZFLOOR: DetectorOptions = { detector: "median_ratio_rule", minRelativeIncrease: 1.875, minAbsoluteDelta: 1 };
const IF_AND_RULE_DEFAULT: DetectorOptions = { detector: "isolation_forest", thresholdPercentile: 99, minRelativeIncrease: 2.5, minAbsoluteDelta: 1 };

const ATTRIBUTION_NOISE_VARIANTS: Array<{ name: string; options: Partial<DemoRebuildOptions> }> = [
  { name: "jitter_0h", options: { eventTimeJitterHours: 0 } },
  { name: "jitter_2h", options: { eventTimeJitterHours: 2 } },
  { name: "region_noise_0", options: { dimensionNoiseRate: 0 } },
  { name: "region_noise_0.6", options: { dimensionNoiseRate: 0.6 } },
  { name: "distractors_6", options: { distractorsPerScenario: 6 } }
];

async function ensureSourceData(prisma: PrismaClient) {
  const [focus, alibaba] = await Promise.all([
    prisma.billingRecord.count({ where: { sourceType: "focus" } }),
    prisma.infrastructureEvent.count({ where: { sourceType: "alibaba_trace" } })
  ]);
  if (focus && alibaba && !process.argv.includes("--reimport")) {
    console.log(`Reusing imported data: ${focus} FOCUS rows, ${alibaba} Alibaba events.`);
    return;
  }
  console.log("Importing FOCUS and Alibaba source data...");
  await clearGeneratedDemoData(prisma);
  await importFocusCsv(prisma, focusFilePath);
  await importAlibabaTraceCsv(prisma, alibabaFilePath);
}

async function timelineBlocks(prisma: PrismaClient) {
  const stamps = (await prisma.billingRecord.findMany({ where: { sourceType: "focus" }, select: { timestamp: true } }))
    .map((row) => row.timestamp.getTime())
    .sort((a, b) => a - b);
  const split = new Date(stamps[Math.floor(stamps.length / 2)]);
  const start = new Date(stamps[0]);
  const end = new Date(stamps[stamps.length - 1] + 60 * 60 * 1000);
  return { first: { from: start, to: split }, second: { from: split, to: end } };
}

// Rows, charged rows, and spend per block (the billing data itself, before any injection).
async function blockStats(prisma: PrismaClient, block: EvalWindow) {
  const rows = await prisma.billingRecord.findMany({
    where: { sourceType: "focus", timestamp: { gte: block.from, lt: block.to } },
    select: { cost: true, account: true, service: true, region: true }
  });
  const seriesKey = (row: { account: string; service: string; region: string }) => `${row.account}:${row.service}:${row.region}`;
  return {
    rows: rows.length,
    series: new Set(rows.map(seriesKey)).size,
    // Series that can receive an incident: compute-like with a known region and some row of at least $1.
    injectableSeries: new Set(rows.filter((row) => row.cost >= 1 && isInjectableSeries(row.service, row.region)).map(seriesKey)).size,
    chargedRows: rows.filter((row) => row.cost > 0).length,
    rowsAtLeast1: rows.filter((row) => row.cost >= 1).length,
    totalSpend: Number(rows.reduce((sum, row) => sum + Math.max(0, row.cost), 0).toFixed(2))
  };
}

// Onset spread of the incidents in the current build (hours from block start, as fractions of the block).
async function incidentTiming(prisma: PrismaClient, block: EvalWindow) {
  const labels = await prisma.groundTruthLabel.findMany({
    where: { sourceDataset: "hybrid_synthesized" },
    select: { expectedEventId: true, anomalyWindowStart: true, billingRecord: { select: { account: true, service: true, region: true } } }
  });
  const incidentSeries = new Set(labels.filter((label) => label.billingRecord)
    .map((label) => `${label.billingRecord!.account}:${label.billingRecord!.service}:${label.billingRecord!.region}`)).size;
  const contamination = await historyContamination(prisma);
  const onsetByIncident = new Map<string, number>();
  for (const label of labels) {
    const key = label.expectedEventId ?? "";
    const time = label.anomalyWindowStart.getTime();
    onsetByIncident.set(key, Math.min(onsetByIncident.get(key) ?? Infinity, time));
  }
  const span = block.to.getTime() - block.from.getTime();
  const positions = [...onsetByIncident.values()].map((time) => (time - block.from.getTime()) / span).sort((a, b) => a - b);
  const quantile = (p: number) => positions.length ? Number(positions[Math.min(positions.length - 1, Math.floor(p * positions.length))].toFixed(3)) : null;
  return {
    incidents: positions.length,
    incidentSeries,
    ...contamination,
    injectedRowsPerIncident: positions.length ? Number((labels.length / positions.length).toFixed(2)) : null,
    onsetP10: quantile(0.1),
    onsetP50: quantile(0.5),
    onsetP90: quantile(0.9)
  };
}

// How often an injected row's detector history (the seven most recent earlier charged rows of its series)
// contains a row injected for a different incident: the clock-time gap between incidents does not rule it out.
async function historyContamination(prisma: PrismaClient) {
  const labels = await prisma.groundTruthLabel.findMany({
    where: { sourceDataset: "hybrid_synthesized" },
    select: { billingRecordId: true, expectedEventId: true, anomalyWindowStart: true, billingRecord: { select: { account: true, service: true, region: true } } }
  });
  const incidentOf = new Map(labels.map((label) => [label.billingRecordId, label.expectedEventId]));
  const series = [...new Set(labels.filter((label) => label.billingRecord).map((label) => JSON.stringify(label.billingRecord)))].map((key) => JSON.parse(key));
  let affectedRows = 0;
  const affectedIncidents = new Set<string>();
  for (const key of series) {
    const rows = (await prisma.billingRecord.findMany({ where: { sourceType: "hybrid_synthesized", ...key }, select: { id: true, timestamp: true, cost: true } }))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    for (let index = 0; index < rows.length; index += 1) {
      const incident = incidentOf.get(rows[index].id);
      if (!incident) continue;
      const history: string[] = [];
      for (let back = index - 1; back >= 0 && history.length < 7; back -= 1) {
        if (rows[back].timestamp.getTime() < rows[index].timestamp.getTime() && rows[back].cost > 0) history.push(rows[back].id);
      }
      if (history.some((id) => incidentOf.has(id) && incidentOf.get(id) !== incident)) {
        affectedRows += 1;
        affectedIncidents.add(incident);
      }
    }
  }
  const incidents = new Set(labels.map((label) => label.expectedEventId)).size;
  return {
    historyContaminatedRowShare: labels.length ? Number((affectedRows / labels.length).toFixed(4)) : null,
    historyContaminatedIncidentShare: incidents ? Number((affectedIncidents.size / incidents).toFixed(4)) : null
  };
}

// ---------------------------------------------------------------- progress
// A step is one benchmark build or one detector evaluation. Each unit of work has a fixed number of steps
// (UNIT_STEPS); a unit whose actual count differs logs a warning and corrects the total.
const UNIT_STEPS = { calibration: 12, seedFull: 27, seed: 24, sweep: 17 };
const progress = { done: 0, reused: 0, total: 0, start: Date.now() };

function duration(seconds: number) {
  if (!Number.isFinite(seconds)) return "?";
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

function reportProgress() {
  const elapsed = (Date.now() - progress.start) / 1000;
  const ran = progress.done - progress.reused;
  const remaining = ran > 0 ? (elapsed / ran) * (progress.total - progress.done) : NaN;
  const percent = progress.total ? (100 * progress.done) / progress.total : 0;
  console.log(`[progress] ${percent.toFixed(1)}% (${progress.done}/${progress.total} steps, elapsed ${duration(elapsed)}, remaining ~${duration(remaining)})`);
}

function stepDone() {
  progress.done += 1;
  reportProgress();
}

async function build(prisma: PrismaClient, seed: number, setting: AttributionSetting, block: EvalWindow, extra: Partial<DemoRebuildOptions> = {}) {
  const { buildRun, hybrid } = await rebuildHybridDemoData(prisma, {
    ...buildConfig,
    seed,
    attributionSetting: setting,
    distractorsPerScenario: setting === "oracle" ? 0 : buildConfig.distractorsPerScenario,
    injectionFrom: block.from,
    injectionTo: block.to,
    ...extra
  });
  await assertNoLabelLeak(prisma);
  stepDone();
  return { buildRunId: buildRun.id, hybrid, timing: await incidentTiming(prisma, block) };
}

// Leakage check: the rows detectors and rankers read must not tell injected rows or true events apart.
// True events and distractors must carry the same metadata keys and the same kind of ID, and injected
// billing rows the same raw-source keys as every other row.
let leakChecks = 0;
async function assertNoLabelLeak(prisma: PrismaClient) {
  const [labels, events, records] = await Promise.all([
    prisma.groundTruthLabel.findMany({ where: { sourceDataset: "hybrid_synthesized" }, select: { billingRecordId: true, expectedEventId: true } }),
    prisma.infrastructureEvent.findMany({ where: { sourceType: "hybrid_synthesized" }, select: { id: true, metadata: true } }),
    prisma.billingRecord.findMany({ where: { sourceType: "hybrid_synthesized" }, select: { id: true, rawSource: true } })
  ]);
  const keysOf = (value: unknown) => Object.keys(value && typeof value === "object" ? value as Json : {}).sort().join(",");
  const trueEvents = new Set(labels.map((label) => label.expectedEventId));
  const injected = new Set(labels.map((label) => label.billingRecordId));
  const eventKeys = (isTrue: boolean) => new Set(events.filter((event) => trueEvents.has(event.id) === isTrue).map((event) => keysOf(event.metadata)));
  const rowKeys = (isInjected: boolean) => new Set(records.filter((record) => injected.has(record.id) === isInjected).map((record) => keysOf(record.rawSource)));
  const idShape = (id: string) => id.replace(/[0-9a-f]{16}$/, "");
  const problems: string[] = [];
  const distractorKeys = eventKeys(false);
  if (distractorKeys.size && [...eventKeys(true)].some((keys) => !distractorKeys.has(keys))) problems.push("event metadata keys differ between true events and distractors");
  if (new Set(events.map((event) => idShape(event.id))).size > 1) problems.push("event IDs differ in form");
  const otherKeys = rowKeys(false);
  if ([...rowKeys(true)].some((keys) => !otherKeys.has(keys))) problems.push("raw-source keys of injected rows differ from other rows");
  if (problems.length) throw new Error(`Label leak: ${problems.join("; ")}`);
  leakChecks += 1;
}

// ---------------------------------------------------------------- checkpoints
// Every unit of work (a direction's calibration, one test seed, one sweep seed) starts from its own benchmark
// build, so a stopped run can resume by reusing finished units. A unit's saved result is reused only when the
// code commit, arguments, and benchmark configuration are identical and the working tree was clean.
const checkpoint = { dir: "", fingerprint: "", resume: false, reused: 0 };

async function checkpointed<T>(key: string, steps: number, fn: () => Promise<T>): Promise<T> {
  const file = path.join(checkpoint.dir, `${key}.json`);
  if (checkpoint.resume && existsSync(file)) {
    const saved = JSON.parse(await readFile(file, "utf8"));
    if (saved.fingerprint === checkpoint.fingerprint) {
      leakChecks += saved.leakChecks;
      checkpoint.reused += 1;
      progress.done += steps;
      progress.reused += steps;
      console.log(`[resume] reusing ${key}`);
      reportProgress();
      return saved.value as T;
    }
  }
  const leakChecksBefore = leakChecks;
  const stepsBefore = progress.done;
  const value = await fn();
  const actual = progress.done - stepsBefore;
  if (actual !== steps) {
    console.warn(`[progress] ${key} took ${actual} steps, planned ${steps}; update UNIT_STEPS`);
    progress.total += actual - steps;
  }
  await mkdir(checkpoint.dir, { recursive: true });
  // Write to a temporary file and rename, so a run killed mid-write never leaves a truncated checkpoint.
  await writeFile(`${file}.tmp`, JSON.stringify({ fingerprint: checkpoint.fingerprint, leakChecks: leakChecks - leakChecksBefore, value }));
  await rename(`${file}.tmp`, file);
  return value;
}

type Calibration = { row: Row; bestF1: Json | null; tuning: Json[] | null };
type CalibrationResults = Record<"ifCalibration" | "ruleCalibration" | "seasonalCalibration" | "medianCalibration" | "dollarCalibration" | "ifChargedCalibration", Calibration>;
// The filter with Isolation Forest fitted on charged rows without category codes gets its own calibration: its score
// distribution differs, so the whole-month filter's percentile would be a different (much stricter) operating point.
const CHARGED_FIT: DetectorOptions = { featureSet: "numeric", fitChargedOnly: true };

// Frozen detector settings from a direction's calibration results.
function deriveFrozen(cal: CalibrationResults, name: string) {
  const bestIf = cal.ifCalibration.bestF1!;
  const bestRule = cal.ruleCalibration.bestF1!;
  const bestSeasonal = cal.seasonalCalibration.bestF1!;
  const bestMedian = cal.medianCalibration.bestF1!;
  const bestDollar = cal.dollarCalibration.bestF1!;
  const bestIfCharged = cal.ifChargedCalibration.bestF1!;
  if (!bestIf || !bestRule || !bestSeasonal || !bestIfCharged || !bestMedian || !bestDollar) throw new Error(`Calibration did not produce best-F1 configurations (${name}).`);
  const ruleThresholds = { minRelativeIncrease: bestRule.minRelativeIncrease as number, minAbsoluteDelta: bestRule.minAbsoluteDelta as number };
  const ifThresholds = { minRelativeIncrease: bestIf.minRelativeIncrease as number, minAbsoluteDelta: bestIf.minAbsoluteDelta as number };
  const ifChargedThresholds = { minRelativeIncrease: bestIfCharged.minRelativeIncrease as number, minAbsoluteDelta: bestIfCharged.minAbsoluteDelta as number };
  return {
    bestIf, bestRule, bestSeasonal, bestMedian, bestDollar, bestIfCharged, ruleThresholds, ifThresholds, ifChargedThresholds,
    RATIO_RULE_FROZEN: { detector: "ratio_rule", ...ruleThresholds } as DetectorOptions,
    SEASONAL_FROZEN: { detector: "seasonal_rule", minRelativeIncrease: bestSeasonal.minRelativeIncrease as number, minAbsoluteDelta: bestSeasonal.minAbsoluteDelta as number } as DetectorOptions,
    MEDIAN_RULE_FROZEN: { detector: "median_ratio_rule", minRelativeIncrease: bestMedian.minRelativeIncrease as number, minAbsoluteDelta: bestMedian.minAbsoluteDelta as number } as DetectorOptions,
    DOLLAR_RULE_FROZEN: { detector: "dollar_rule", minAbsoluteDelta: bestDollar.minAbsoluteDelta as number } as DetectorOptions,
    ifAndRuleFrozen: (seed: number): DetectorOptions => ({ detector: "isolation_forest", thresholdPercentile: bestIf.thresholdPercentile as number, ...ifThresholds, randomState: seed }),
    ifAndRuleCharged: (seed: number): DetectorOptions => ({ detector: "isolation_forest", thresholdPercentile: bestIfCharged.thresholdPercentile as number, ...ifChargedThresholds, randomState: seed, ...CHARGED_FIT })
  };
}

function flatten(evaluation: Awaited<ReturnType<typeof evaluateCurrentRun>>): Row {
  const e = evaluation as Json;
  const row: Row = {
    records: e.records as number,
    injectedScenarios: (e.injectedScenarios as number) ?? null,
    injectedRecords: (e.injectedRecords as number) ?? null,
    alerts: e.detectedAnomalies as number,
    falsePositives: ((e.confusionMatrix as Json | undefined)?.falsePositives as number) ?? null,
    injectableFalsePositives: (e.injectableFalsePositives as number) ?? null,
    precision: (e.precision as number) ?? null,
    precisionInjectableSeries: (e.precisionInjectableSeries as number) ?? null,
    recall: (e.recall as number) ?? null,
    f1: (e.f1Score as number) ?? null,
    scenarioRecall: (e.scenarioRecall as number) ?? null,
    top20Precision: (e.top20Precision as number) ?? null,
    rcEvaluated: (e.rootCauseEvaluatedDetections as number) ?? null,
    minRelativeIncrease: (e.minRelativeIncrease as number) ?? null,
    minAbsoluteDelta: (e.minAbsoluteDelta as number) ?? null,
    thresholdPercentile: (e.thresholdPercentile as number) ?? null
  };
  // Sorted, so the CSV's column order does not depend on the order the database returns labels in.
  for (const [shape, stats] of Object.entries((e.shapeRecall as Json) ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const s = stats as Json;
    row[`recall_${shape}`] = s.recall as number;
    row[`scenarioRecall_${shape}`] = s.scenarioRecall as number;
    row[`scenarios_${shape}`] = s.scenarios as number;
  }
  const attribution = (e.attribution as Json) ?? {};
  for (const level of ["rowLevel", "incidentLevel"]) {
    for (const [ranker, metrics] of Object.entries((attribution[level] as Json) ?? {})) {
      for (const [metric, value] of Object.entries(metrics as Json)) row[`att_${level === "rowLevel" ? "row" : "inc"}_${ranker}_${metric}`] = value as number;
    }
  }
  const region = (attribution.regionDropped as Json) ?? {};
  for (const [group, metrics] of Object.entries(region)) {
    for (const [metric, value] of Object.entries(metrics as Json)) row[`att_region_${group}_${metric}`] = value as number;
  }
  for (const [group, rankers] of Object.entries((attribution.regionBreakdown as Json) ?? {})) {
    for (const [ranker, top1] of Object.entries(rankers as Json)) row[`att_regionTop1_${group}_${ranker}`] = top1 as number;
  }
  row.att_typeTop1 = (attribution.typeTop1 as number) ?? null;
  row.att_meanPoolSize = (attribution.meanPoolSize as number) ?? null;
  row.att_expectedEventInPool = (attribution.expectedEventInPool as number) ?? null;
  row.att_evaluatedIncidents = (attribution.evaluatedIncidents as number) ?? null;
  row.att_endToEndCoverage = (attribution.endToEndCoverage as number) ?? null;
  return row;
}

type Context = Row & { buildRunId: string };

async function runOne(
  prisma: PrismaClient,
  context: Context,
  window: EvalWindow,
  name: string,
  options: DetectorOptions,
  withPreconditions?: { minRelativeIncrease: number; minAbsoluteDelta: number }
): Promise<{ row: Row; falsePositiveKeys: string[] | null; injectedKeys: string[]; bestF1: Json | null; tuning: Json[] | null }> {
  await runAnomalyDetection(prisma, "hybrid_synthesized", { ...options, evalWindow: window, attributionMode: "none", buildRunId: context.buildRunId });
  const evaluation = await evaluateCurrentRun(prisma, "hybrid_synthesized", { window });
  const { buildRunId: _buildRunId, ...contextColumns } = context;
  const row: Row = { ...contextColumns, detector: name, ...flatten(evaluation) };
  if (withPreconditions) {
    const detected = new Set((await prisma.anomalyResult.findMany({ where: { sourceType: "hybrid_synthesized" }, select: { billingRecordId: true } }))
      .map((anomaly) => anomaly.billingRecordId)
      .filter((id): id is string => Boolean(id)));
    const stats = await detectionPreconditionStats(prisma, detected, withPreconditions, window);
    row.recallCeiling = stats.recallCeiling;
    row.seasonalRecallCeiling = stats.seasonalRecallCeiling;
    for (const [reason, count] of Object.entries(stats.missed)) row[`missed_${reason}`] = count;
    for (const [bucket, count] of Object.entries(stats.missedByMultiplier)) row[`missed_mult_${bucket}`] = count;
    for (const [bucket, count] of Object.entries(stats.injectedByMultiplier)) row[`injected_mult_${bucket}`] = count;
  }
  const e = evaluation as Json;
  console.log(JSON.stringify({ direction: row.direction, seed: row.seed, split: row.split, variant: row.variant, detector: name, alerts: row.alerts, f1: row.f1, scenarioRecall: row.scenarioRecall, rcTop1: row.att_row_full_top1 }));
  stepDone();
  return {
    row,
    falsePositiveKeys: (e.falsePositiveKeys as string[] | null) ?? null,
    injectedKeys: (e.injectedKeys as string[]) ?? [],
    bestF1: (e.bestF1Config as Json | null) ?? null,
    tuning: (e.tuningResults as Json[] | null) ?? null
  };
}

// ---------------------------------------------------------------- statistics
const T975: Record<number, number> = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262 };

function stats(values: number[]): Stats {
  const n = values.length;
  if (!n) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)) : 0;
  const half = n > 1 ? (T975[n - 1] ?? 1.96) * sd / Math.sqrt(n) : 0;
  return { n, mean, sd, ciLow: mean - half, ciHigh: mean + half };
}

function numbers(rows: Row[], column: string) {
  return rows.map((row) => row[column]).filter((value): value is number => typeof value === "number");
}

function aggregate(rows: Row[], filter: (row: Row) => boolean, groupKey: string, columns: string[]) {
  const selected = rows.filter(filter);
  const groups = [...new Set(selected.map((row) => String(row[groupKey])))];
  return Object.fromEntries(groups.map((group) => [group, Object.fromEntries(columns.map((column) =>
    [column, stats(numbers(selected.filter((row) => String(row[groupKey]) === group), column))]))]));
}

// Per-seed difference a - b, with a t-interval over seeds.
function paired(rows: Row[], filter: (row: Row) => boolean, a: string, b: string, column: string) {
  const selected = rows.filter(filter);
  const seeds = [...new Set(selected.map((row) => row.seed))];
  const diffs = seeds.flatMap((seed) => {
    const left = selected.find((row) => row.seed === seed && row.detector === a)?.[column];
    const right = selected.find((row) => row.seed === seed && row.detector === b)?.[column];
    return typeof left === "number" && typeof right === "number" ? [left - right] : [];
  });
  return { a, b, column, ...stats(diffs) };
}

function fmt(s: Stats, digits = 3) {
  return s ? `${s.mean.toFixed(digits)} ± ${s.sd.toFixed(digits)} [${s.ciLow.toFixed(digits)}, ${s.ciHigh.toFixed(digits)}]` : "–";
}

function markdownTable(table: Record<string, Record<string, Stats>>, columns: string[]) {
  const lines = [`| | ${columns.join(" | ")} |`, `| --- | ${columns.map(() => "---").join(" | ")} |`];
  for (const [group, values] of Object.entries(table)) lines.push(`| ${group} | ${columns.map((column) => fmt(values[column])).join(" | ")} |`);
  return lines.join("\n");
}

function toCsv(rows: Row[]) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\n") + "\n";
}

// Whether the chosen value of each tuned parameter lies at the edge of the searched grid.
function boundary(best: Json | null, tuning: Json[] | null) {
  if (!best || !tuning?.length) return null;
  return Object.fromEntries(["thresholdPercentile", "minRelativeIncrease", "minAbsoluteDelta"]
    .filter((key) => typeof best[key] === "number")
    .map((key) => {
      const values = [...new Set(tuning.map((row) => row[key] as number))].sort((a, b) => a - b);
      return [key, { chosen: best[key], min: values[0], max: values[values.length - 1], onEdge: best[key] === values[0] || best[key] === values[values.length - 1] }];
    }));
}

function jaccard(a: string[], b: string[]) {
  const left = new Set(a);
  const intersection = b.filter((key) => left.has(key)).length;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

function gitRevision() {
  try {
    const cwd = path.resolve(process.cwd(), "..");
    const commit = execSync("git rev-parse HEAD", { cwd }).toString().trim();
    const dirty = execSync("git status --porcelain --untracked-files=no", { cwd }).toString().trim().length > 0;
    return { commit, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
}

// ---------------------------------------------------------------- one calibrate-then-test direction
type Direction = { name: "main" | "swapped"; calibrationSeed: number; testSeeds: number[]; calibrationBlock: EvalWindow; testBlock: EvalWindow };

async function runDirection(prisma: PrismaClient, direction: Direction, rows: Row[], full: boolean) {
  const base = { direction: direction.name };
  const keep = (result: Calibration) => ({ row: result.row, bestF1: result.bestF1, tuning: result.tuning });
  const calibrationUnit = await checkpointed(`${direction.name}-calibration`, UNIT_STEPS.calibration, async () => {
    const calibrationBuild = await build(prisma, direction.calibrationSeed, "realistic", direction.calibrationBlock);
    const calibrationContext: Context = { ...base, seed: direction.calibrationSeed, split: "calibration", variant: "main", attributionSetting: "realistic", buildRunId: calibrationBuild.buildRunId };
    // Each detector family is calibrated on its own grid, on the calibration block only. The median-reference ratio rule
    // (the z-score rule's centre) and the dollar-increase-only rule (the explanation offered for the Isolation Forest
    // gate's gain) were added after pass 4c and are calibrated the same way.
    const calibrate = async (name: string, options: DetectorOptions) => keep(await runOne(prisma, calibrationContext, direction.calibrationBlock, name, options));
    const cal: CalibrationResults = {
      ifCalibration: await calibrate("calibration_if_and_rule", { detector: "isolation_forest", calibrate: true, randomState: direction.calibrationSeed }),
      ruleCalibration: await calibrate("calibration_ratio_rule", { detector: "ratio_rule", calibrate: true }),
      seasonalCalibration: await calibrate("calibration_seasonal_rule", { detector: "seasonal_rule", calibrate: true }),
      medianCalibration: await calibrate("calibration_median_ratio_rule", { detector: "median_ratio_rule", calibrate: true }),
      dollarCalibration: await calibrate("calibration_dollar_rule", { detector: "dollar_rule", calibrate: true }),
      ifChargedCalibration: await calibrate("calibration_if_and_rule_charged", { detector: "isolation_forest", calibrate: true, randomState: direction.calibrationSeed, ...CHARGED_FIT })
    };
    const f = deriveFrozen(cal, direction.name);
    // Frozen detectors on the calibration block itself (in-sample reference for the held-out numbers).
    const unitRows: Row[] = [cal.ifCalibration.row, cal.ruleCalibration.row, cal.seasonalCalibration.row, cal.ifChargedCalibration.row, cal.medianCalibration.row, cal.dollarCalibration.row];
    const calibrationPrimary = await runOne(prisma, calibrationContext, direction.calibrationBlock, "ratio_rule_frozen", f.RATIO_RULE_FROZEN);
    unitRows.push(calibrationPrimary.row);
    unitRows.push((await runOne(prisma, calibrationContext, direction.calibrationBlock, "if_and_rule_frozen", f.ifAndRuleFrozen(direction.calibrationSeed))).row);
    unitRows.push((await runOne(prisma, calibrationContext, direction.calibrationBlock, "if_and_rule_charged", f.ifAndRuleCharged(direction.calibrationSeed))).row);
    unitRows.push((await runOne(prisma, calibrationContext, direction.calibrationBlock, "median_ratio_rule_frozen", f.MEDIAN_RULE_FROZEN)).row);
    unitRows.push((await runOne(prisma, calibrationContext, direction.calibrationBlock, "dollar_rule_frozen", f.DOLLAR_RULE_FROZEN)).row);
    return { timing: calibrationBuild.timing, cal, rows: unitRows, falsePositiveKeys: calibrationPrimary.falsePositiveKeys ?? [] };
  });
  rows.push(...calibrationUnit.rows);
  const calibrationBuild = { timing: calibrationUnit.timing };
  const { ifCalibration, ruleCalibration, seasonalCalibration, medianCalibration, dollarCalibration, ifChargedCalibration } = calibrationUnit.cal;
  const {
    bestIf, bestRule, bestSeasonal, bestMedian, bestDollar, bestIfCharged, ruleThresholds, ifThresholds, ifChargedThresholds,
    RATIO_RULE_FROZEN, SEASONAL_FROZEN, MEDIAN_RULE_FROZEN, DOLLAR_RULE_FROZEN, ifAndRuleFrozen, ifAndRuleCharged
  } = deriveFrozen(calibrationUnit.cal, direction.name);
  const calibrationFalsePositives = new Set(calibrationUnit.falsePositiveKeys);
  console.log(`[${direction.name}] frozen: rule ${JSON.stringify(ruleThresholds)}, IF+rule ${JSON.stringify({ ...ifThresholds, p: bestIf.thresholdPercentile })}, seasonal ${JSON.stringify(SEASONAL_FROZEN)}`);

  const injectedKeysBySeed: string[][] = [];
  for (const seed of direction.testSeeds) {
    const unit = await checkpointed(`${direction.name}-seed-${seed}`, full ? UNIT_STEPS.seedFull : UNIT_STEPS.seed, async () => {
    const rows: Row[] = [];
    const realistic = await build(prisma, seed, "realistic", direction.testBlock);
    const context: Context = { ...base, seed, split: "test", variant: "main", attributionSetting: "realistic", buildRunId: realistic.buildRunId,
      incidentOnsetP10: realistic.timing.onsetP10, incidentOnsetP50: realistic.timing.onsetP50, incidentOnsetP90: realistic.timing.onsetP90,
      injectedRowsPerIncident: realistic.timing.injectedRowsPerIncident, incidentSeries: realistic.timing.incidentSeries,
      historyContaminatedRowShare: realistic.timing.historyContaminatedRowShare, historyContaminatedIncidentShare: realistic.timing.historyContaminatedIncidentShare };
    const primary = await runOne(prisma, context, direction.testBlock, "ratio_rule_frozen", RATIO_RULE_FROZEN, ruleThresholds);
    primary.row.fpOverlapWithCalibration = (primary.falsePositiveKeys ?? []).filter((key) => calibrationFalsePositives.has(key)).length;
    rows.push(primary.row);
    const injectedKeys = primary.injectedKeys;
    const combined = await runOne(prisma, context, direction.testBlock, "if_and_rule_frozen", ifAndRuleFrozen(seed));
    rows.push(combined.row);
    const detectors: Array<[string, DetectorOptions]> = [
      // The rule at exactly the combined detector's thresholds: what the Isolation Forest gate removes.
      ["ratio_rule_at_if_thresholds", { detector: "ratio_rule", ...ifThresholds }],
      // The rule restricted to the combined detector's alert count: a like-for-like comparison.
      ["ratio_rule_budget", { detector: "ratio_rule", ...ruleThresholds, alertBudget: Number(combined.row.alerts) }],
      // The same alert count ranked by dollar increase instead of ratio: does the dollar amount separate incidents?
      ["ratio_rule_budget_delta", { detector: "ratio_rule", ...ruleThresholds, alertBudget: Number(combined.row.alerts), budgetRankBy: "delta" }],
      ["if_standalone_budget", { detector: "isolation_forest", postFilter: false, alertBudget: Number(primary.row.alerts), contamination: bestIf.contamination as number, randomState: seed }],
      // Isolation Forest without the categorical indices, fitted and ranked on charged rows only.
      ["if_standalone_budget_charged", { detector: "isolation_forest", postFilter: false, alertBudget: Number(primary.row.alerts), contamination: bestIf.contamination as number, randomState: seed, featureSet: "numeric", fitChargedOnly: true }],
      ["seasonal_rule_frozen", SEASONAL_FROZEN],
      ["median_ratio_rule_frozen", MEDIAN_RULE_FROZEN],
      ["dollar_rule_frozen", DOLLAR_RULE_FROZEN],
      // Held-out Isolation Forest: scaler, forest, and gate threshold fitted on the other half only (which holds
      // no incidents in a test build), then applied to the evaluated half.
      ["if_standalone_budget_heldout", { detector: "isolation_forest", postFilter: false, alertBudget: Number(primary.row.alerts), contamination: bestIf.contamination as number, randomState: seed, fitOutsideEvalWindow: true }],
      ["if_and_rule_heldout", { ...ifAndRuleFrozen(seed), fitOutsideEvalWindow: true }],
      // IF + ratio rule with the forest fitted (and the gate percentile taken) on charged rows, without category codes.
      ["if_and_rule_charged", ifAndRuleCharged(seed)],
      // Detectors fixed in advance run in both directions.
      ["ratio_rule", RATIO_RULE],
      ["robust_z", ROBUST_Z],
      ["median_ratio_rule_zfloor", MEDIAN_RULE_ZFLOOR],
      ["if_and_rule_default", { ...IF_AND_RULE_DEFAULT, randomState: seed }],
      ["if_standalone_contamination", { detector: "isolation_forest", postFilter: false, contamination: bestIf.contamination as number, randomState: seed }]
    ];
    if (full) detectors.push(["if_and_rule_insample", { detector: "isolation_forest", calibrate: true, randomState: seed }]);
    const alertsBy = new Map<string, number>();
    for (const [name, options] of detectors) {
      const result = await runOne(prisma, context, direction.testBlock, name, options);
      rows.push(result.row);
      alertsBy.set(name, Number(result.row.alerts));
    }
    // Controls that depend on other detectors' alert counts in this seed.
    const dependent: Array<[string, DetectorOptions]> = [
      // Dollar-increase ranking restricted to the rows the rule flags at IF + ratio rule's thresholds: the same
      // pool the Isolation Forest gate chooses from, at the gate's alert count.
      ["ratio_rule_gatepool_delta", { detector: "ratio_rule", ...ifThresholds, alertBudget: Number(combined.row.alerts), budgetRankBy: "delta", budgetPool: "flagged" }],
      // The same control at the held-out filter's alert count.
      ["ratio_rule_gatepool_delta_heldout", { detector: "ratio_rule", ...ifThresholds, alertBudget: alertsBy.get("if_and_rule_heldout") ?? 0, budgetRankBy: "delta", budgetPool: "flagged" }],
      // Its gate-pool control uses the charged filter's own calibrated rule thresholds.
      ["ratio_rule_gatepool_delta_charged", { detector: "ratio_rule", ...ifChargedThresholds, alertBudget: alertsBy.get("if_and_rule_charged") ?? 0, budgetRankBy: "delta", budgetPool: "flagged" }],
      // The robust z-score rule at the calibrated ratio rule's alert count (ranked by z among its preconditions).
      ["robust_z_at_rule_budget", { ...ROBUST_Z, alertBudget: Number(primary.row.alerts) }],
      // The z-score rule's own alert count, rows with six earlier charged rows and $1 over the rolling median, ranked by median ratio instead of robust z: the direct test of MAD scaling.
      ["median_ratio_rule_at_z_budget", { ...MEDIAN_RULE_ZFLOOR, alertBudget: alertsBy.get("robust_z") ?? 0 }]
    ];
    for (const [name, options] of dependent) rows.push((await runOne(prisma, context, direction.testBlock, name, options)).row);

    if (full) {
      // Oracle: same incidents and detections; only the event stream differs, so only the primary detector is needed.
      const oracle = await build(prisma, seed, "oracle", direction.testBlock);
      rows.push((await runOne(prisma, { ...context, attributionSetting: "oracle", buildRunId: oracle.buildRunId }, direction.testBlock, "ratio_rule_frozen", RATIO_RULE_FROZEN)).row);
    }
    return { rows, injectedKeys };
    });
    rows.push(...unit.rows);
    injectedKeysBySeed.push(unit.injectedKeys);
  }

  const overlaps: number[] = [];
  for (let i = 0; i < injectedKeysBySeed.length; i += 1) {
    for (let j = i + 1; j < injectedKeysBySeed.length; j += 1) overlaps.push(jaccard(injectedKeysBySeed[i], injectedKeysBySeed[j]));
  }
  return {
    frozen: { ratioRule: ruleThresholds, ifAndRule: { ...ifThresholds, thresholdPercentile: bestIf.thresholdPercentile, contamination: bestIf.contamination },
      ifAndRuleCharged: { ...ifChargedThresholds, thresholdPercentile: bestIfCharged.thresholdPercentile },
      medianRatioRule: { minRelativeIncrease: bestMedian.minRelativeIncrease, minAbsoluteDelta: bestMedian.minAbsoluteDelta }, dollarRule: { minAbsoluteDelta: bestDollar.minAbsoluteDelta }, seasonalRule: { minRelativeIncrease: bestSeasonal.minRelativeIncrease, minAbsoluteDelta: bestSeasonal.minAbsoluteDelta } },
    gridBoundary: { ifAndRule: boundary(bestIf, ifCalibration.tuning), ratioRule: boundary(bestRule, ruleCalibration.tuning), seasonalRule: boundary(bestSeasonal, seasonalCalibration.tuning),
      medianRatioRule: boundary(bestMedian, medianCalibration.tuning), dollarRule: boundary(bestDollar, dollarCalibration.tuning) },
    grids: { ifAndRule: ifCalibration.tuning, ratioRule: ruleCalibration.tuning, seasonalRule: seasonalCalibration.tuning, ifAndRuleCharged: ifChargedCalibration.tuning, medianRatioRule: medianCalibration.tuning, dollarRule: dollarCalibration.tuning },
    calibrationTiming: calibrationBuild.timing,
    injectedRowOverlapAcrossSeeds: stats(overlaps),
    ruleThresholds,
    RATIO_RULE_FROZEN,
    ifAndRuleFrozen,
    bestIf
  };
}

async function inputFileHash(filePath: string) {
  if (!filePath.trim()) return null;
  const candidates = [path.resolve(process.cwd(), filePath), path.resolve(process.cwd(), "..", filePath)];
  const resolvedPath = path.isAbsolute(filePath) ? filePath : candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
  try {
    return createHash("sha256").update(await readFile(resolvedPath)).digest("hex");
  } catch {
    return null;
  }
}

async function main() {
  const prisma = new PrismaClient();
  const rows: Row[] = [];
  const revision = gitRevision();
  checkpoint.dir = path.join(outDir, "checkpoint");
  const directions = skipSwapped ? 1 : 2;
  progress.total = directions * UNIT_STEPS.calibration + testSeeds.length * (UNIT_STEPS.seedFull + (skipSwapped ? 0 : UNIT_STEPS.seed)) + (skipSweeps ? 0 : testSeeds.length * UNIT_STEPS.sweep);
  try {
    await ensureSourceData(prisma);
    const blocks = await timelineBlocks(prisma);
    const [focusHash, alibabaHash] = await Promise.all([inputFileHash(focusFilePath), inputFileHash(alibabaFilePath)]);
    checkpoint.fingerprint = JSON.stringify({
      commit: revision.commit,
      args: process.argv.slice(2).filter((arg) => arg !== "--fresh" && arg !== "--keep-checkpoints"),
      buildConfig,
      focusHash,
      alibabaHash,
      blocks: {
        first: { from: blocks.first.from.toISOString(), to: blocks.first.to.toISOString() },
        second: { from: blocks.second.from.toISOString(), to: blocks.second.to.toISOString() }
      }
    });
    checkpoint.resume = !process.argv.includes("--fresh") && !process.argv.includes("--reimport") && revision.commit !== null && revision.dirty === false;
    if (!checkpoint.resume) console.log(`Checkpoints are written but not reused (${process.argv.includes("--fresh") ? "--fresh" : process.argv.includes("--reimport") ? "--reimport" : "working tree not clean or commit unknown"}).`);
    console.log(`First block ${blocks.first.from.toISOString()} – ${blocks.first.to.toISOString()}; second block ${blocks.second.from.toISOString()} – ${blocks.second.to.toISOString()}`);
    const blockSummary = { first: await blockStats(prisma, blocks.first), second: await blockStats(prisma, blocks.second) };

    const main = await runDirection(prisma, { name: "main", calibrationSeed, testSeeds, calibrationBlock: blocks.first, testBlock: blocks.second }, rows, true);
    const swapped = skipSwapped ? null : await runDirection(prisma, {
      name: "swapped", calibrationSeed: calibrationSeed + 100, testSeeds: testSeeds.map((seed) => seed + 100),
      calibrationBlock: blocks.second, testBlock: blocks.first
    }, rows, false);

    // ---------------------------------------------------------- sweeps (main direction, test block)
    if (!skipSweeps) {
      for (const seed of testSeeds) {
        const unitRows = await checkpointed(`sweep-seed-${seed}`, UNIT_STEPS.sweep, async () => {
        const rows: Row[] = [];
        const lowMultiplier = await build(prisma, seed, "realistic", blocks.second, { costMultiplierMin: 1.5, costMultiplierMax: 2.5 });
        const context: Context = { direction: "main", seed, split: "test", variant: "multiplier_1.5-2.5", attributionSetting: "realistic", buildRunId: lowMultiplier.buildRunId };
        const primary = await runOne(prisma, context, blocks.second, "ratio_rule_frozen", main.RATIO_RULE_FROZEN, main.ruleThresholds);
        rows.push(primary.row);
        const combined = await runOne(prisma, context, blocks.second, "if_and_rule_frozen", main.ifAndRuleFrozen(seed));
        rows.push(combined.row);
        rows.push((await runOne(prisma, context, blocks.second, "ratio_rule_budget", { ...main.RATIO_RULE_FROZEN, alertBudget: Number(combined.row.alerts) })).row);
        rows.push((await runOne(prisma, context, blocks.second, "if_standalone_budget", { detector: "isolation_forest", postFilter: false, alertBudget: Number(primary.row.alerts), contamination: main.bestIf.contamination as number, randomState: seed })).row);
        rows.push((await runOne(prisma, context, blocks.second, "if_standalone_budget_charged", { detector: "isolation_forest", postFilter: false, alertBudget: Number(primary.row.alerts), contamination: main.bestIf.contamination as number, randomState: seed, featureSet: "numeric", fitChargedOnly: true })).row);
        rows.push((await runOne(prisma, context, blocks.second, "robust_z", ROBUST_Z)).row);

        for (const variant of ATTRIBUTION_NOISE_VARIANTS) {
          const noisy = await build(prisma, seed, "realistic", blocks.second, variant.options);
          rows.push((await runOne(prisma, { direction: "main", seed, split: "test", variant: `attribution_${variant.name}`, attributionSetting: "realistic", buildRunId: noisy.buildRunId }, blocks.second, "ratio_rule_frozen", main.RATIO_RULE_FROZEN)).row);
        }
        return rows;
        });
        rows.push(...unitRows);
      }
    }

    // ---------------------------------------------------------- summaries
    const test = (direction: string, setting = "realistic", variant = "main") => (row: Row) =>
      row.direction === direction && row.split === "test" && row.variant === variant && row.attributionSetting === setting;
    const calibration = (direction: string) => (row: Row) => row.direction === direction && row.split === "calibration";
    const detectionColumns = ["injectedRecords", "alerts", "falsePositives", "injectableFalsePositives", "precision", "precisionInjectableSeries", "recall", "scenarioRecall", "f1",
      "recall_spike", "recall_drift", "scenarioRecall_spike", "scenarioRecall_drift"];
    const rankers = ["full", "minus_time", "minus_dimensions", "minus_event_type", "minus_service", "minus_cost", "dimensions_then_time", "nearest_time", "event_type_only", "dimensions_only", "random"];
    const primaryRows = (direction: string, setting: string) => (row: Row) => test(direction, setting)(row) && row.detector === "ratio_rule_frozen";
    const attributionTable = (direction: string, level: "row" | "inc", setting: string) => Object.fromEntries(rankers.map((ranker) => [ranker, Object.fromEntries(
      ["top1", "top3", "mrr"].map((metric) => [metric, stats(numbers(rows.filter(primaryRows(direction, setting)), `att_${level}_${ranker}_${metric}`))]))]));
    const attributionExtras = (direction: string, setting: string) => Object.fromEntries(
      ["rcEvaluated", "att_evaluatedIncidents", "att_typeTop1", "att_meanPoolSize", "att_expectedEventInPool", "att_endToEndCoverage",
        "att_region_dropped_detections", "att_region_kept_detections",
        ...["dropped", "kept"].flatMap((group) => ["full", "dimensions_then_time", "dimensions_only", "nearest_time", "random"].map((ranker) => `att_regionTop1_${group}_${ranker}`))]
        .map((column) => [column, stats(numbers(rows.filter(primaryRows(direction, setting)), column))]));
    const attributionPaired = (direction: string) => ["nearest_time", "dimensions_then_time", "dimensions_only", "random"].flatMap((baseline) => ["top1", "top3", "mrr"].map((metric) => ({
      comparison: `full - ${baseline}`,
      metric,
      ...stats(rows.filter(primaryRows(direction, "realistic")).map((row) => Number(row[`att_row_full_${metric}`]) - Number(row[`att_row_${baseline}_${metric}`])))
    })));
    const pairs: Array<[string, string]> = [
      ["if_and_rule_frozen", "ratio_rule_budget"],
      ["ratio_rule_budget_delta", "ratio_rule_budget"],
      ["if_and_rule_frozen", "ratio_rule_budget_delta"],
      ["robust_z", "ratio_rule_frozen"],
      ["if_standalone_budget_heldout", "if_standalone_budget"],
      ["if_standalone_budget_heldout", "ratio_rule_frozen"],
      ["if_and_rule_heldout", "if_and_rule_frozen"],
      ["if_and_rule_heldout", "ratio_rule_frozen"],
      ["if_and_rule_frozen", "ratio_rule_gatepool_delta"],
      ["if_and_rule_heldout", "ratio_rule_gatepool_delta_heldout"],
      ["if_and_rule_charged", "ratio_rule_gatepool_delta_charged"],
      ["if_and_rule_charged", "ratio_rule_frozen"],
      ["robust_z_at_rule_budget", "ratio_rule_frozen"],
      ["if_and_rule_frozen", "ratio_rule_frozen"],
      ["if_and_rule_frozen", "ratio_rule_at_if_thresholds"],
      ["if_standalone_budget", "ratio_rule_frozen"],
      ["if_standalone_budget_charged", "ratio_rule_frozen"],
      ["if_standalone_budget_charged", "if_standalone_budget"],
      ["ratio_rule_frozen", "ratio_rule"],
      ["seasonal_rule_frozen", "ratio_rule_frozen"],
      ["if_and_rule_insample", "if_and_rule_frozen"],
      // Pass 4c controls: is the z-score rule's recall its MAD scaling or its median reference? Does a dollar-only
      // rule reproduce what the Isolation Forest gate adds?
      ["robust_z", "median_ratio_rule_zfloor"],
      ["robust_z", "median_ratio_rule_at_z_budget"],
      ["median_ratio_rule_zfloor", "ratio_rule_frozen"],
      ["median_ratio_rule_frozen", "ratio_rule_frozen"],
      ["dollar_rule_frozen", "ratio_rule_frozen"],
      ["if_and_rule_frozen", "dollar_rule_frozen"],
      ["if_and_rule_heldout", "dollar_rule_frozen"],
      ["if_and_rule_charged", "dollar_rule_frozen"]
    ];
    const pairedFor = (direction: string, variant = "main") => pairs.flatMap(([a, b]) => ["f1", "precision", "scenarioRecall"].map((column) => paired(rows, test(direction, "realistic", variant), a, b, column)));

    // Isolation Forest gate selectivity: share of the rule's false and true positives (at the combined
    // detector's thresholds) that the gate removes.
    const gateSelectivity = (direction: string) => {
      const seeds = [...new Set(rows.filter(test(direction)).map((row) => row.seed))];
      const shares = seeds.flatMap((seed) => {
        const rule = rows.find((row) => test(direction)(row) && row.seed === seed && row.detector === "ratio_rule_at_if_thresholds");
        const gated = rows.find((row) => test(direction)(row) && row.seed === seed && row.detector === "if_and_rule_frozen");
        if (!rule || !gated) return [];
        const ruleFp = Number(rule.falsePositives), gatedFp = Number(gated.falsePositives);
        const ruleTp = Number(rule.alerts) - ruleFp, gatedTp = Number(gated.alerts) - gatedFp;
        return [{ fpRemoved: ruleFp ? 1 - gatedFp / ruleFp : 0, tpRemoved: ruleTp ? 1 - gatedTp / ruleTp : 0 }];
      });
      return { fpRemoved: stats(shares.map((s) => s.fpRemoved)), tpRemoved: stats(shares.map((s) => s.tpRemoved)) };
    };

    const summary = {
      protocol: {
        revision,
        leakChecksPassed: leakChecks,
        calibrationSeed,
        testSeeds,
        blocks,
        blockStats: blockSummary,
        buildConfig,
        frozen: main.frozen,
        frozenSwapped: swapped?.frozen ?? null,
        gridBoundary: main.gridBoundary,
        gridBoundarySwapped: swapped?.gridBoundary ?? null,
        aPriori: { ratioRule: RATIO_RULE, robustZ: ROBUST_Z, ifAndRuleDefault: IF_AND_RULE_DEFAULT },
        statistics: "mean ± sample SD over held-out seeds, with 95% t-interval [low, high]; seeds vary incident placement, shapes, event noise, and the Isolation Forest random state, but share the test block's normal rows (the swapped direction varies those)"
      },
      incidents: {
        calibrationTiming: main.calibrationTiming,
        testTiming: Object.fromEntries(["incidentOnsetP10", "incidentOnsetP50", "incidentOnsetP90", "injectedRowsPerIncident", "incidentSeries", "historyContaminatedRowShare", "historyContaminatedIncidentShare"]
          .map((column) => [column, stats(numbers(rows.filter(primaryRows("main", "realistic")), column))])),
        injectedRowOverlapAcrossSeeds: main.injectedRowOverlapAcrossSeeds
      },
      calibration: aggregate(rows, calibration("main"), "detector", ["alerts", "falsePositives", "precision", "recall", "scenarioRecall", "f1", "att_row_full_top1"]),
      detection: aggregate(rows, test("main"), "detector", detectionColumns),
      detectionSwapped: swapped ? aggregate(rows, test("swapped"), "detector", detectionColumns) : null,
      calibrationSwapped: swapped ? aggregate(rows, calibration("swapped"), "detector", ["alerts", "precision", "recall", "scenarioRecall", "f1"]) : null,
      preconditions: aggregate(rows, primaryRows("main", "realistic"), "detector", ["recallCeiling", "seasonalRecallCeiling", "missed_insufficient_history", "missed_no_baseline", "missed_ratio_below_threshold", "missed_delta_below_threshold", "missed_passes_rule", "fpOverlapWithCalibration",
        "missed_mult_below_2", "missed_mult_from_2_to_3", "missed_mult_from_3", "injected_mult_below_2", "injected_mult_from_2_to_3", "injected_mult_from_3"]),
      pairedDetection: pairedFor("main"),
      pairedDetectionSwapped: swapped ? pairedFor("swapped") : null,
      gateSelectivity: gateSelectivity("main"),
      gateSelectivitySwapped: swapped ? gateSelectivity("swapped") : null,
      attribution: {
        realistic: { rowLevel: attributionTable("main", "row", "realistic"), incidentLevel: attributionTable("main", "inc", "realistic") },
        oracle: { rowLevel: attributionTable("main", "row", "oracle"), incidentLevel: attributionTable("main", "inc", "oracle") },
        swapped: swapped ? { rowLevel: attributionTable("swapped", "row", "realistic"), incidentLevel: attributionTable("swapped", "inc", "realistic") } : null,
        extras: { realistic: attributionExtras("main", "realistic"), oracle: attributionExtras("main", "oracle"), swapped: swapped ? attributionExtras("swapped", "realistic") : null },
        paired: attributionPaired("main"),
        pairedSwapped: swapped ? attributionPaired("swapped") : null
      },
      sweeps: skipSweeps ? null : {
        multiplierDetection: Object.fromEntries(["main", "multiplier_1.5-2.5"].map((variant) => [variant,
          aggregate(rows, (row) => test("main", "realistic", variant)(row) && ["ratio_rule_frozen", "if_and_rule_frozen", "ratio_rule_budget", "robust_z", "if_standalone_budget", "if_standalone_budget_charged"].includes(String(row.detector)), "detector", [...detectionColumns, "recallCeiling"])])),
        pairedLowMultiplier: pairedFor("main", "multiplier_1.5-2.5"),
        attributionNoise: aggregate(rows, (row) => row.direction === "main" && row.split === "test" && row.detector === "ratio_rule_frozen" && row.attributionSetting === "realistic" && (row.variant === "main" || String(row.variant).startsWith("attribution_")),
          "variant", ["att_row_full_top1", "att_row_full_mrr", "att_row_dimensions_then_time_top1", "att_row_nearest_time_top1", "att_row_random_top1", "att_inc_full_top1", "att_meanPoolSize"])
      }
    };

    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "experiments.csv"), toCsv(rows));
    await writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    await writeFile(path.join(outDir, "calibration.json"), JSON.stringify({ ...summary.protocol }, null, 2) + "\n");
    const gridRows: Row[] = [];
    for (const [name, direction] of [["main", main], ["swapped", swapped]] as const) {
      if (!direction) continue;
      for (const [detector, grid] of Object.entries(direction.grids)) {
        for (const point of grid ?? []) {
          gridRows.push({ direction: name, detector, thresholdPercentile: (point.thresholdPercentile as number) ?? null, minRelativeIncrease: point.minRelativeIncrease as number,
            minAbsoluteDelta: point.minAbsoluteDelta as number, precision: point.precision as number, recall: point.recall as number, f1: point.f1 as number,
            detectedAnomalies: point.detectedAnomalies as number });
        }
      }
    }
    await writeFile(path.join(outDir, "calibration_grid.csv"), toCsv(gridRows));
    const tables = [
      "# Hybrid experiment results",
      "",
      `Code revision: ${revision.commit ?? "unknown"}${revision.dirty ? " (uncommitted changes)" : ""}.`,
      `Main direction: calibrate seed ${calibrationSeed} on ${blocks.first.from.toISOString()} – ${blocks.first.to.toISOString()}, test seeds ${testSeeds.join(", ")} on ${blocks.second.from.toISOString()} – ${blocks.second.to.toISOString()}.`,
      `Frozen (main): ${JSON.stringify(main.frozen)}. Grid edges: ${JSON.stringify(main.gridBoundary)}.`,
      "Values: mean ± sample SD [95% t-interval] over held-out seeds.",
      "",
      "## Detection, main direction (realistic)",
      "",
      markdownTable(summary.detection as Record<string, Record<string, Stats>>, ["alerts", "precision", "precisionInjectableSeries", "recall", "scenarioRecall", "f1", "scenarioRecall_spike", "scenarioRecall_drift"]),
      "",
      "## Calibration block (in-sample reference)",
      "",
      markdownTable(summary.calibration as Record<string, Record<string, Stats>>, ["alerts", "precision", "recall", "scenarioRecall", "f1", "att_row_full_top1"]),
      "",
      ...(summary.detectionSwapped ? ["## Detection, swapped direction", "", markdownTable(summary.detectionSwapped as Record<string, Record<string, Stats>>, ["alerts", "precision", "recall", "scenarioRecall", "f1"]), ""] : []),
      "## Attribution, realistic (ratio_rule_frozen true positives)",
      "",
      markdownTable(summary.attribution.realistic.rowLevel, ["top1", "top3", "mrr"]),
      "",
      "## Attribution, oracle",
      "",
      markdownTable(summary.attribution.oracle.rowLevel, ["top1", "top3", "mrr"]),
      ""
    ];
    await writeFile(path.join(outDir, "tables.md"), tables.join("\n"));
    console.log(`Wrote ${rows.length} rows to ${outDir}${checkpoint.reused ? ` (${checkpoint.reused} units reused from checkpoints)` : ""}`);
    // A completed run no longer needs its checkpoints.
    if (!process.argv.includes("--keep-checkpoints")) await rm(checkpoint.dir, { recursive: true, force: true });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
