import { PrismaClient } from "@prisma/client";
import type { InfrastructureEvent } from "@prisma/client";
import { type EvalWindow } from "./anomalyService.js";
import { compareBillingRecords } from "./billingOrder.js";
import { isInjectableSeries } from "./hybridDatasetService.js";
import {
  DEFAULT_SCORE_WEIGHTS,
  candidateWindow,
  eventTypeWeights,
  scoreCandidate,
  type ScoreWeights
} from "./rootCauseService.js";

export type EvaluationMode = "synthetic" | "hybrid_synthesized" | "focus" | "all";

export type EvaluationOptions = {
  // Only records, detections, and labels in [from, to) are evaluated (e.g. the test block).
  window?: EvalWindow;
};

type RankMetrics = { top1: number | null; top3: number | null; mrr: number | null };

function round(value: number, digits = 4) {
  return Number(value.toFixed(digits));
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Expected Top-1 / Top-3 / reciprocal rank of the single correct candidate when ties are broken
// uniformly at random, so no ranker benefits from event-ID order. A missing candidate scores 0.
function expectedRank(scores: number[], correctIndex: number) {
  if (correctIndex < 0) return { top1: 0, top3: 0, rr: 0 };
  const target = scores[correctIndex];
  const better = scores.filter((score) => score > target).length;
  const tied = scores.filter((score) => score === target).length;
  let top1 = 0;
  let top3 = 0;
  let rr = 0;
  for (let position = better + 1; position <= better + tied; position += 1) {
    if (position === 1) top1 += 1;
    if (position <= 3) top3 += 1;
    rr += 1 / position;
  }
  return { top1: top1 / tied, top3: top3 / tied, rr: rr / tied };
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function summarize(items: Array<{ top1: number; top3: number; rr: number }>): RankMetrics {
  const top1 = mean(items.map((item) => item.top1));
  const top3 = mean(items.map((item) => item.top3));
  const mrr = mean(items.map((item) => item.rr));
  return {
    top1: top1 === null ? null : round(top1),
    top3: top3 === null ? null : round(top3),
    mrr: mrr === null ? null : round(mrr)
  };
}

// Leave-one-out ablations with the remaining weights renormalized to sum to 1, so removing a component
// does not also lower every score relative to the absolute confidence caps.
function withoutComponent(component: keyof ScoreWeights): ScoreWeights {
  const kept = { ...DEFAULT_SCORE_WEIGHTS, [component]: 0 };
  const total = Object.values(kept).reduce((sum, weight) => sum + weight, 0);
  return Object.fromEntries(Object.entries(kept).map(([key, weight]) => [key, weight / total])) as ScoreWeights;
}

const ABLATIONS: Record<string, ScoreWeights> = {
  minus_time: withoutComponent("time"),
  minus_dimensions: withoutComponent("dimensions"),
  minus_event_type: withoutComponent("eventType"),
  minus_service: withoutComponent("service"),
  minus_cost: withoutComponent("cost")
};

export async function evaluateCurrentRun(prisma: PrismaClient, mode: EvaluationMode = "all", options: EvaluationOptions = {}) {
  const window = options.window;
  const recordWhere = mode === "all" ? {} : { sourceType: mode };
  const timeFilter = window ? { timestamp: { gte: window.from, lt: window.to } } : {};
  const [records, anomalies, hybridLabels, detectionRun] = await Promise.all([
    prisma.billingRecord.findMany({
      where: { ...recordWhere, ...timeFilter },
      select: { id: true, timestamp: true, isInjectedAnomaly: true, expectedRootCause: true, anomalyType: true, sourceType: true }
    }),
    prisma.anomalyResult.findMany({
      where: { ...(mode === "all" ? {} : { sourceType: mode }), ...timeFilter },
      include: { billingRecord: true }
    }),
    mode === "synthetic" || mode === "focus"
      ? Promise.resolve([])
      : prisma.groundTruthLabel.findMany({ where: { sourceDataset: "hybrid_synthesized" } }),
    prisma.detectionRun.findFirst({
      where: mode === "all" ? undefined : { sourceType: mode },
      orderBy: { createdAt: "desc" }
    })
  ]);

  if (mode === "focus") {
    return {
      mode,
      evaluationType: "billing_only",
      records: records.length,
      detectedAnomalies: anomalies.length,
      anomalyMetricsAvailable: false,
      contamination: detectionRun?.contamination ?? 0.02,
      selectedThreshold: null,
      thresholdPercentile: null,
      calibrationUsed: false,
      scoreDistribution: detectionRun?.scoreDistribution ?? null,
      rootCauseTop1Accuracy: null,
      rootCauseEvaluatedDetections: 0,
      attributionStatus: "not_available",
      explanation: "FOCUS billing-only data has no injected anomaly or infrastructure-event ground truth."
    };
  }

  const recordById = new Map(records.map((record) => [record.id, record]));
  const hybridLabelByRecord = new Map(
    hybridLabels.filter((label) => label.billingRecordId && recordById.has(label.billingRecordId)).map((label) => [label.billingRecordId!, label])
  );
  const scenarioKeyFor = (recordId: string) =>
    hybridLabelByRecord.get(recordId)?.expectedEventId ?? recordById.get(recordId)?.anomalyType ?? recordId;
  const truth = new Set(
    records.filter((record) => record.isInjectedAnomaly || hybridLabelByRecord.has(record.id)).map((record) => record.id)
  );
  const detectedAnomalies = anomalies.filter((anomaly) => anomaly.billingRecordId && recordById.has(anomaly.billingRecordId));
  const detected = new Set(detectedAnomalies.map((anomaly) => anomaly.billingRecordId!));
  const truePositives = [...detected].filter((id) => truth.has(id)).length;
  const falsePositives = [...detected].filter((id) => !truth.has(id)).length;
  const falseNegatives = [...truth].filter((id) => !detected.has(id)).length;
  const precision = truePositives / Math.max(truePositives + falsePositives, 1);
  const recall = truePositives / Math.max(truePositives + falseNegatives, 1);
  const f1Score = (2 * precision * recall) / Math.max(precision + recall, 0.0001);
  // Ties in anomaly score are ordered by billing-row content, never by generated IDs.
  const rankedAnomalies = [...detectedAnomalies].sort((left, right) =>
    right.score - left.score || compareBillingRecords(left.billingRecord!, right.billingRecord!));
  const top20 = rankedAnomalies.slice(0, 20);
  const top20Precision = top20.length
    ? round(top20.filter((anomaly) => truth.has(anomaly.billingRecordId!)).length / top20.length)
    : null;

  // rawSource is loaded only for injected and detected rows, for stable FOCUS row keys; the incident shape
  // comes from the label.
  const detailIds = [...new Set([...truth, ...detected])];
  const details = await prisma.billingRecord.findMany({ where: { id: { in: detailIds } }, select: { id: true, rawSource: true } });
  const rawById = new Map(details.map((detail) => [detail.id, jsonObject(detail.rawSource)]));
  const shapeOf = (id: string) => {
    const shape = jsonObject(hybridLabelByRecord.get(id)?.metadata).incidentShape;
    return typeof shape === "string" ? shape : "spike";
  };
  const stableKey = (id: string) => String(rawById.get(id)?.originalFocusBillingRecordId ?? id);
  const falsePositiveIds = [...detected].filter((id) => !truth.has(id));
  // Incidents can only be injected into compute-like series with a known region; alerts elsewhere are
  // reported separately so precision is not charged only for series that can never hold a positive.
  const detectedById = new Map(detectedAnomalies.map((anomaly) => [anomaly.billingRecordId!, anomaly.billingRecord!]));
  const injectableFalsePositives = falsePositiveIds.filter((id) => {
    const billing = detectedById.get(id);
    return billing ? isInjectableSeries(billing.service, billing.region) : false;
  }).length;

  // Scenario-level and per-shape views: one injected incident spans several billing rows.
  const scenarioKeys = new Set([...truth].map(scenarioKeyFor));
  const detectedScenarios = new Set([...detected].filter((id) => truth.has(id)).map(scenarioKeyFor));
  const byShape: Record<string, { injectedRows: number; detectedRows: number; scenarios: number; detectedScenarios: number }> = {};
  for (const shape of new Set([...truth].map(shapeOf))) {
    const rows = [...truth].filter((id) => shapeOf(id) === shape);
    const shapeScenarios = new Set(rows.map(scenarioKeyFor));
    const hitScenarios = new Set(rows.filter((id) => detected.has(id)).map(scenarioKeyFor));
    byShape[shape] = {
      injectedRows: rows.length,
      detectedRows: rows.filter((id) => detected.has(id)).length,
      scenarios: shapeScenarios.size,
      detectedScenarios: hitScenarios.size
    };
  }
  const shapeRecall = Object.fromEntries(Object.entries(byShape).map(([shape, counts]) => [shape, {
    recall: counts.injectedRows ? round(counts.detectedRows / counts.injectedRows) : null,
    scenarioRecall: counts.scenarios ? round(counts.detectedScenarios / counts.scenarios) : null,
    ...counts
  }]));

  // Attribution: every true-positive detection is ranked over its full candidate pool (events from
  // 12 h before to 2 h after it), without the 0.35 display threshold, by the scorer, its ablations,
  // and simple baselines. Hybrid labels name the exact expected event.
  const labeledDetections = detectedAnomalies.filter((anomaly) => truth.has(anomaly.billingRecordId!));
  let attribution: Record<string, unknown> = {};
  if (mode === "hybrid_synthesized" && labeledDetections.length) {
    const events = await prisma.infrastructureEvent.findMany({ where: { sourceType: "hybrid_synthesized" } });
    const eventById = new Map(events.map((event) => [event.id, event]));
    const rankers: Record<string, (event: InfrastructureEvent, anomaly: (typeof labeledDetections)[number]) => number> = {
      full: (event, anomaly) => scoreCandidate(event, anomaly, anomaly.billingRecord).score,
      ...Object.fromEntries(Object.entries(ABLATIONS).map(([name, weights]) => [
        name, (event: InfrastructureEvent, anomaly: (typeof labeledDetections)[number]) => scoreCandidate(event, anomaly, anomaly.billingRecord, weights).score
      ])),
      nearest_time: (event, anomaly) => -Math.abs(event.timestamp.getTime() - anomaly.timestamp.getTime()),
      event_type_only: (event) => eventTypeWeights[event.eventType] ?? 0.45,
      dimensions_only: (event, anomaly) => scoreCandidate(event, anomaly, anomaly.billingRecord).signals.matchedDimensions.length,
      // Filter-then-time baseline: prefer candidates matching more billing dimensions, then the nearest in time.
      dimensions_then_time: (event, anomaly) =>
        scoreCandidate(event, anomaly, anomaly.billingRecord).signals.matchedDimensions.length * 1e9
        - Math.abs(event.timestamp.getTime() - anomaly.timestamp.getTime()),
      random: () => 0
    };

    const perDetection = labeledDetections.map((anomaly) => {
      const label = hybridLabelByRecord.get(anomaly.billingRecordId!);
      const pool = events.filter((event) => {
        const range = candidateWindow(anomaly.timestamp);
        return event.timestamp >= range.from && event.timestamp <= range.to;
      });
      const correctIndex = pool.findIndex((event) => event.id === label?.expectedEventId);
      const ranks = Object.fromEntries(Object.entries(rankers).map(([name, rank]) =>
        [name, expectedRank(pool.map((event) => rank(event, anomaly)), correctIndex)]));
      const fullScores = pool.map((event) => rankers.full(event, anomaly));
      const topScore = fullScores.length ? Math.max(...fullScores) : null;
      const topGroup = pool.filter((_, index) => fullScores[index] === topScore);
      const typeTop1 = topGroup.length
        ? topGroup.filter((event) => event.eventType === label?.expectedEventType).length / topGroup.length
        : 0;
      const expectedEvent = label?.expectedEventId ? eventById.get(label.expectedEventId) : undefined;
      return {
        anomaly,
        scenarioKey: scenarioKeyFor(anomaly.billingRecordId!),
        poolSize: pool.length,
        inPool: correctIndex >= 0,
        regionDropped: expectedEvent ? expectedEvent.region.toLowerCase() === "unknown" : false,
        typeTop1,
        ranks
      };
    });

    // Incident level: the first detected row of each incident (earliest; rows sharing a timestamp are
    // ordered by billing-row content, so the choice does not depend on generated IDs).
    const firstByScenario = new Map<string, (typeof perDetection)[number]>();
    for (const item of perDetection) {
      const current = firstByScenario.get(item.scenarioKey);
      if (!current || compareBillingRecords(item.anomaly.billingRecord!, current.anomaly.billingRecord!) < 0) {
        firstByScenario.set(item.scenarioKey, item);
      }
    }
    const incidentItems = [...firstByScenario.values()];

    attribution = {
      rowLevel: Object.fromEntries(Object.keys(rankers).map((name) => [name, summarize(perDetection.map((item) => item.ranks[name]))])),
      incidentLevel: Object.fromEntries(Object.keys(rankers).map((name) => [name, summarize(incidentItems.map((item) => item.ranks[name]))])),
      regionDropped: {
        dropped: { detections: perDetection.filter((item) => item.regionDropped).length, ...summarize(perDetection.filter((item) => item.regionDropped).map((item) => item.ranks.full)) },
        kept: { detections: perDetection.filter((item) => !item.regionDropped).length, ...summarize(perDetection.filter((item) => !item.regionDropped).map((item) => item.ranks.full)) }
      },
      // Top-1 of the scorer and the dimension/time baselines, split by whether the true event lost its region.
      regionBreakdown: Object.fromEntries((["dropped", "kept"] as const).map((group) => {
        const items = perDetection.filter((item) => item.regionDropped === (group === "dropped"));
        return [group, Object.fromEntries(["full", "dimensions_then_time", "dimensions_only", "nearest_time", "random"]
          .map((name) => [name, summarize(items.map((item) => item.ranks[name])).top1]))];
      })),
      expectedEventInPool: round(perDetection.filter((item) => item.inPool).length / perDetection.length),
      typeTop1: round(mean(perDetection.map((item) => item.typeTop1)) ?? 0),
      meanPoolSize: round(mean(perDetection.map((item) => item.poolSize)) ?? 0, 2),
      evaluatedIncidents: incidentItems.length,
      // Incidents detected AND whose first detected row ranks the expected event first, over all incidents.
      endToEndCoverage: scenarioKeys.size
        ? round(incidentItems.reduce((sum, item) => sum + item.ranks.full.top1, 0) / scenarioKeys.size)
        : null
    };
  }
  const rowLevelFull = (attribution.rowLevel as Record<string, RankMetrics> | undefined)?.full;

  return {
    mode,
    evaluationType: mode === "hybrid_synthesized" ? "synthesized_ground_truth" : "injected_ground_truth",
    window: window ? { from: window.from.toISOString(), to: window.to.toISOString() } : null,
    records: records.length,
    injectedAnomalies: truth.size,
    injectedRecords: truth.size,
    detectedAnomalies: detected.size,
    detector: detectionRun?.detector ?? null,
    postFilter: detectionRun?.postFilter ?? null,
    alertBudget: detectionRun?.alertBudget ?? null,
    robustZThreshold: detectionRun?.robustZThreshold ?? null,
    contamination: detectionRun?.contamination ?? null,
    nEstimators: detectionRun?.nEstimators ?? null,
    maxSamples: detectionRun?.maxSamples ?? null,
    randomState: detectionRun?.randomState ?? null,
    calibrationUsed: detectionRun?.calibrationUsed ?? false,
    selectedThreshold: detectionRun?.selectedThreshold ?? null,
    thresholdPercentile: detectionRun?.thresholdPercentile ?? null,
    scoreDistribution: detectionRun?.scoreDistribution ?? null,
    minRelativeIncrease: detectionRun?.minRelativeIncrease ?? null,
    minAbsoluteDelta: detectionRun?.minAbsoluteDelta ?? null,
    tuningResults: detectionRun?.tuningResults ?? null,
    bestF1Config: detectionRun?.bestF1Config ?? null,
    anomalyMetricsAvailable: true,
    confusionMatrix: {
      truePositives,
      falsePositives,
      falseNegatives,
      trueNegatives: records.length - truePositives - falsePositives - falseNegatives
    },
    precision: round(precision),
    recall: round(recall),
    f1Score: round(f1Score),
    top20Precision,
    injectedScenarios: scenarioKeys.size,
    detectedScenarios: detectedScenarios.size,
    scenarioRecall: scenarioKeys.size ? round(detectedScenarios.size / scenarioKeys.size) : null,
    shapeRecall,
    injectableFalsePositives,
    precisionInjectableSeries: round(truePositives / Math.max(truePositives + injectableFalsePositives, 1)),
    falsePositiveKeys: falsePositiveIds.length <= 500 ? falsePositiveIds.map(stableKey).sort() : null,
    injectedKeys: [...truth].map(stableKey).sort(),
    rootCauseTop1Accuracy: rowLevelFull?.top1 ?? null,
    rootCauseTop3Accuracy: rowLevelFull?.top3 ?? null,
    rootCauseMrr: rowLevelFull?.mrr ?? null,
    rootCauseTypeTop1Accuracy: (attribution.typeTop1 as number | undefined) ?? null,
    meanCandidatesPerDetection: (attribution.meanPoolSize as number | undefined) ?? null,
    endToEndAttributionCoverage: (attribution.endToEndCoverage as number | null | undefined) ?? null,
    rootCauseEvaluatedDetections: labeledDetections.length,
    attribution
  };
}
