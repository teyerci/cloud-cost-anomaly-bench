import { PrismaClient } from "@prisma/client";
import type { InfrastructureEvent } from "@prisma/client";

export const eventTypeWeights: Record<string, number> = {
  deployment: 0.85,
  autoscaling: 0.9,
  configuration_change: 0.8,
  K8s_High_Resource_Request: 0.9,
  K8s_GPU_Workload: 0.95,
  K8s_Pending_Workload: 0.85,
  K8s_Failed_Workload: 0.9
};

// Service compatibility is inferred from the event type only; label-derived metadata is never read.
function eventTypeServiceMatches(event: InfrastructureEvent, billingService: string | undefined) {
  const service = billingService?.toLowerCase() ?? "";
  if (event.eventType === "K8s_GPU_Workload") {
    return /gpu|compute|accelerated|container|kubernetes|virtual machine|aks/.test(service);
  }
  if (event.eventType === "K8s_High_Resource_Request") {
    return /compute|container|kubernetes|virtual machine|aks|synapse|sql|database/.test(service);
  }
  if (event.eventType === "K8s_Pending_Workload" || event.eventType === "K8s_Failed_Workload") {
    return /unused|orphan|capacity|compute|container|virtual machine|network/.test(service);
  }
  return event.service.toLowerCase() === service;
}

function isKnownRegion(region: string | null | undefined) {
  const normalized = region?.trim().toLowerCase() ?? "";
  return Boolean(normalized && normalized !== "null" && normalized !== "unknown" && normalized !== "n/a");
}

function capScore(score: number, caps: number[]) {
  return Math.min(score, ...caps);
}

// The lookback covers the longest injected incident (12 h gradual drift), so later rows of an
// incident can still see its onset event.
export const ATTRIBUTION_LOOKBACK_HOURS = 12;
export const ATTRIBUTION_LOOKAHEAD_HOURS = 2;
const HOUR_MS = 60 * 60 * 1000;

export type ScoreWeights = { time: number; dimensions: number; eventType: number; service: number; cost: number };
export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = { time: 0.3, dimensions: 0.3, eventType: 0.15, service: 0.15, cost: 0.1 };

type ScoredAnomaly = { timestamp: Date; actualCost: number; expectedCost: number };
type ScoredBilling = { account: string; service: string; region: string; resourceId: string | null } | null | undefined;

export function candidateWindow(anomalyTimestamp: Date) {
  return {
    from: new Date(anomalyTimestamp.getTime() - ATTRIBUTION_LOOKBACK_HOURS * HOUR_MS),
    to: new Date(anomalyTimestamp.getTime() + ATTRIBUTION_LOOKAHEAD_HOURS * HOUR_MS)
  };
}

// Pure scoring function shared by the stored attribution and the evaluation's ablations.
export function scoreCandidate(event: InfrastructureEvent, anomaly: ScoredAnomaly, billing: ScoredBilling, weights: ScoreWeights = DEFAULT_SCORE_WEIGHTS) {
  const lookbackMs = ATTRIBUTION_LOOKBACK_HOURS * HOUR_MS;
  const lookaheadMs = ATTRIBUTION_LOOKAHEAD_HOURS * HOUR_MS;
  const offsetMs = event.timestamp.getTime() - anomaly.timestamp.getTime();
  const timeProximity = Math.max(0, 1 - Math.abs(offsetMs) / (offsetMs <= 0 ? lookbackMs : lookaheadMs));
  const matchedDimensions = [
    event.account === billing?.account ? "account" : undefined,
    event.service === billing?.service ? "service" : undefined,
    event.region === billing?.region ? "region" : undefined,
    event.resourceId && event.resourceId === billing?.resourceId ? "resourceId" : undefined
  ].filter((value): value is string => Boolean(value));
  const dimensionScore = matchedDimensions.length / 4;
  const eventTypeScore = eventTypeWeights[event.eventType] ?? 0.45;
  const costImpact = Math.min(1, (anomaly.actualCost - anomaly.expectedCost) / Math.max(anomaly.expectedCost, 1));
  const serviceMatches = eventTypeServiceMatches(event, billing?.service);
  const regionKnown = isKnownRegion(billing?.region) && isKnownRegion(event.region);
  const caps: number[] = [];
  if (!serviceMatches) caps.push(0.6);
  if (!regionKnown) caps.push(0.6);
  if (!serviceMatches && !regionKnown) caps.push(0.4);
  if (matchedDimensions.length <= 1 && timeProximity > 0) caps.push(0.5);
  const baseScore = timeProximity * weights.time + dimensionScore * weights.dimensions + eventTypeScore * weights.eventType
    + costImpact * weights.cost + Number(serviceMatches) * weights.service;
  return {
    score: Number(capScore(baseScore, caps).toFixed(4)),
    offsetMs,
    signals: {
      timeProximity: Number(timeProximity.toFixed(4)),
      offsetHours: Number((offsetMs / HOUR_MS).toFixed(2)),
      dimensionScore,
      eventTypeScore,
      costImpact: Number(costImpact.toFixed(4)),
      serviceMatches,
      confidenceCaps: caps,
      matchedDimensions
    }
  };
}

// Neutral tie-break for display order: a hash of (anomaly, event) instead of the event ID, whose
// "hybrid-distractor" / "hybrid-event" prefixes would otherwise systematically favor distractors.
export function tieBreakKey(anomalyId: string, eventId: string) {
  let hash = 0x811c9dc5;
  for (const char of `${anomalyId}:${eventId}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export async function runRootCauseAttribution(prisma: PrismaClient, anomalyId: string) {
  const anomaly = await prisma.anomalyResult.findUnique({
    where: { id: anomalyId },
    include: { billingRecord: true }
  });

  if (!anomaly) {
    throw new Error("Anomaly not found");
  }

  await prisma.rootCauseCandidate.deleteMany({ where: { anomalyResultId: anomalyId } });

  const billing = anomaly.billingRecord;
  if (billing?.sourceType === "focus") {
    return {
      attributionStatus: "not_available" as const,
      message: "Root-cause attribution is not available because FOCUS data is billing-only and no matching infrastructure events were provided.",
      candidates: []
    };
  }

  // Every detection is attributed the same way; whether it is a true positive is decided only at
  // evaluation/presentation time, never inside the scorer.
  const window = candidateWindow(anomaly.timestamp);
  const events = await prisma.infrastructureEvent.findMany({
    where: {
      sourceType: billing?.sourceType === "hybrid_synthesized" ? "hybrid_synthesized" : "synthetic",
      timestamp: { gte: window.from, lte: window.to }
    }
  });

  const candidates = events
    .map((event: InfrastructureEvent) => {
      const { score, offsetMs, signals } = scoreCandidate(event, anomaly, billing);
      return {
        anomalyResultId: anomaly.id,
        infrastructureEventId: event.id,
        score,
        reason: `${event.eventType} occurred ${(offsetMs / HOUR_MS).toFixed(1)}h from the anomaly with ${signals.matchedDimensions.length}/4 matching dimensions.`,
        signals
      };
    })
    .filter((candidate) => candidate.score >= 0.35)
    .sort((a, b) => b.score - a.score || tieBreakKey(anomaly.id, a.infrastructureEventId) - tieBreakKey(anomaly.id, b.infrastructureEventId));

  if (candidates.length > 0) {
    await prisma.rootCauseCandidate.createMany({ data: candidates });
  }

  const storedCandidates = (await prisma.rootCauseCandidate.findMany({
    where: { anomalyResultId: anomalyId },
    include: { infrastructureEvent: true }
  })).sort((a, b) => b.score - a.score || tieBreakKey(anomalyId, a.infrastructureEventId) - tieBreakKey(anomalyId, b.infrastructureEventId));
  return {
    attributionStatus: storedCandidates.length ? "available" as const : "no_candidates" as const,
    message: storedCandidates.length
      ? undefined
      : billing?.sourceType === "hybrid_synthesized"
        ? "No matching hybrid root-cause event was found for this anomaly. Try another detected true-positive anomaly or widen the attribution time window."
        : "No matching synthetic infrastructure event was found for this anomaly.",
    candidates: storedCandidates
  };
}
