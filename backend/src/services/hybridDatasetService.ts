import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { compareBillingRecords } from "./billingOrder.js";
import { createSeededRandom } from "./seededRandom.js";

export type HybridBuildOptions = {
  focusSourceType?: "focus";
  numScenarios?: number;
  timeWindowHours?: number;
  minTimeWindowHours?: number;
  maxTimeWindowHours?: number;
  minBaselineCost?: number;
  costMultiplierMin?: number;
  costMultiplierMax?: number;
  seed?: number;
  buildRunId?: string;
  attributionSetting?: AttributionSetting;
  distractorsPerScenario?: number;
  eventTimeJitterHours?: number;
  dimensionNoiseRate?: number;
  // Only inject incidents whose whole window lies in [injectionFrom, injectionTo), so calibration and
  // test builds can use disjoint parts of the billing timeline.
  injectionFrom?: Date | string;
  injectionTo?: Date | string;
  // Share of scenarios injected as gradual drift (linear ramp over driftWindowHours) instead of a step spike.
  driftFraction?: number;
  driftWindowHours?: number;
  // Minimum spacing between incidents in the same account/service/region series (default 12 h).
  minIncidentGapHours?: number;
};

export type IncidentShape = "spike" | "drift";

// Every service alias any trigger type can inject into (union of mappingForEvent aliases).
const INJECTABLE_SERVICE_ALIASES = ["compute", "gpu", "accelerated", "ec2", "elastic compute", "virtual machine",
  "kubernetes", "container", "aks", "eks", "unused", "orphan", "capacity"];

// Whether a series could ever receive an injected incident (compute-like service and a known region).
export function isInjectableSeries(service: string, region: string) {
  const normalizedRegion = region.trim().toLowerCase();
  const knownRegion = Boolean(normalizedRegion && !["null", "unknown", "n/a"].includes(normalizedRegion));
  const normalizedService = service.toLowerCase();
  return knownRegion && INJECTABLE_SERVICE_ALIASES.some((alias) => normalizedService.includes(alias));
}

// oracle: the true event is stamped at anomaly onset with the billing record's dimensions and no
// competing events (an upper bound). realistic: onset jitter, pod-level resource IDs, optional
// region noise, and same-account/service distractor events drawn from unused Alibaba triggers.
export type AttributionSetting = "oracle" | "realistic";

const SYNTHESIS_EXPLANATION =
  "FOCUS billing and Alibaba trace data come from different environments. This event-to-cost relationship was synthesized for controlled evaluation and is not real-world causal evidence.";

function clamp(value: number | undefined, fallback: number, min: number, max: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function jsonObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mappingForEvent(eventType: string, metadata: Prisma.JsonValue | null) {
  const source = jsonObject(metadata);
  const qos = typeof source.qos === "string" ? source.qos : undefined;
  if (eventType === "K8s_GPU_Workload") {
    return {
      service: "gpu_compute",
      rootCauseType: "accelerated_compute",
      project: "accelerated_compute",
      aliases: ["compute", "gpu", "accelerated", "ec2", "elastic compute", "virtual machine", "kubernetes", "container", "aks", "eks"]
    };
  }
  if (eventType === "K8s_Pending_Workload" || eventType === "K8s_Failed_Workload") {
    return {
      service: "unused_capacity",
      rootCauseType: "orphan_resource",
      project: "orphan_resource",
      aliases: ["compute", "container", "kubernetes", "virtual machine", "ec2", "elastic compute", "unused", "orphan", "capacity"]
    };
  }
  if (qos === "LS") {
    return {
      service: "compute",
      rootCauseType: "latency_sensitive_workload",
      project: "latency_sensitive_workload",
      aliases: ["compute", "ec2", "elastic compute", "virtual machine", "kubernetes", "container", "aks", "eks"]
    };
  }
  if (qos?.toLowerCase() === "burstable") {
    return {
      service: "compute",
      rootCauseType: "burstable_workload",
      project: "burstable_workload",
      aliases: ["compute", "ec2", "elastic compute", "virtual machine", "kubernetes", "container", "aks", "eks"]
    };
  }
  return {
    service: "compute",
    rootCauseType: "high_resource_workload",
    project: "compute_workload",
    aliases: ["compute", "ec2", "elastic compute", "virtual machine", "kubernetes", "container", "aks", "eks"]
  };
}

// Event IDs carry no role: the true event and its distractors get the same kind of opaque, seeded ID.
function opaqueEventId(seed: number, scenarioId: string, role: string) {
  return `hybrid-evt-${createHash("sha256").update(`${seed}:${scenarioId}:${role}`).digest("hex").slice(0, 16)}`;
}

function scenarioMultiplier(
  eventType: string,
  metadata: Prisma.JsonValue | null,
  index: number,
  configuredMin?: number,
  configuredMax?: number
) {
  const source = jsonObject(metadata);
  const qos = typeof source.qos === "string" ? source.qos.toLowerCase() : "";
  const fraction = ((index + 1) * 0.61803398875) % 1;
  if (configuredMin !== undefined && configuredMax !== undefined) {
    return configuredMin + fraction * (configuredMax - configuredMin);
  }
  if (eventType === "K8s_GPU_Workload") {
    return 4 + fraction * 4;
  }
  if (eventType === "K8s_High_Resource_Request") {
    return 2 + fraction * 2;
  }
  if (eventType === "K8s_Pending_Workload" || eventType === "K8s_Failed_Workload") {
    return 1.5 + fraction * 1.5;
  }
  if (qos === "burstable") {
    return 3 + fraction * 3;
  }
  return 3 + fraction * 3;
}

function scenarioDurationHours(eventType: string, index: number, minHours: number, maxHours: number) {
  if (eventType === "K8s_Pending_Workload" || eventType === "K8s_Failed_Workload") {
    return Math.max(minHours, Math.min(maxHours, 5 + (index % 2)));
  }
  const range = Math.max(0, maxHours - minHours);
  return minHours + (index % Math.max(1, Math.floor(range) + 1));
}

function median(values: number[]) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

export async function getHybridStatus(prisma: PrismaClient) {
  const [focusRecords, importedEvents, hybridRecords, hybridEvents, groundTruthLabels] = await Promise.all([
    prisma.billingRecord.count({ where: { sourceType: "focus" } }),
    prisma.infrastructureEvent.count({ where: { sourceType: "alibaba_trace" } }),
    prisma.billingRecord.count({ where: { sourceType: "hybrid_synthesized" } }),
    prisma.infrastructureEvent.count({ where: { sourceType: "hybrid_synthesized" } }),
    prisma.groundTruthLabel.count({ where: { sourceDataset: "hybrid_synthesized" } })
  ]);
  return { available: true, focusRecords, importedEvents, hybridRecords, hybridEvents, groundTruthLabels };
}

export async function buildHybridDataset(prisma: PrismaClient, options: HybridBuildOptions = {}) {
  const seed = Math.floor(clamp(options.seed, 42, 1, Number.MAX_SAFE_INTEGER));
  const rng = createSeededRandom(seed);
  const numScenarios = Math.floor(clamp(options.numScenarios, 50, 1, 500));
  const requestedWindowHours = options.timeWindowHours;
  const minTimeWindowHours = requestedWindowHours !== undefined
    ? clamp(requestedWindowHours, 4, 1, 24)
    : clamp(options.minTimeWindowHours, 3, 1, 24);
  const maxTimeWindowHours = requestedWindowHours !== undefined
    ? minTimeWindowHours
    : clamp(options.maxTimeWindowHours, 6, minTimeWindowHours, 24);
  const minBaselineCost = clamp(options.minBaselineCost, 1, 0.01, 1_000_000);
  const minMultiplier = clamp(options.costMultiplierMin, 3, 1.1, 10);
  const maxMultiplier = clamp(options.costMultiplierMax, 6, minMultiplier, 10);
  const attributionSetting: AttributionSetting = options.attributionSetting === "oracle" ? "oracle" : "realistic";
  const realistic = attributionSetting === "realistic";
  const distractorsPerScenario = Math.floor(clamp(options.distractorsPerScenario, realistic ? 3 : 0, 0, 20));
  const eventTimeJitterHours = clamp(options.eventTimeJitterHours, realistic ? 1 : 0, 0, 6);
  const dimensionNoiseRate = clamp(options.dimensionNoiseRate, realistic ? 0.3 : 0, 0, 1);
  // Separate stream so scenario selection is identical across attribution settings for a seed.
  const noiseRng = createSeededRandom((seed ^ 0x9e3779b9) >>> 0);
  const hourMs = 60 * 60 * 1000;
  const injectionFromMs = options.injectionFrom ? new Date(options.injectionFrom).getTime() : -Infinity;
  const injectionToMs = options.injectionTo ? new Date(options.injectionTo).getTime() : Infinity;
  const driftFraction = clamp(options.driftFraction, 0, 0, 1);
  const driftWindowHours = clamp(options.driftWindowHours, 12, 1, 72);
  // Independent stream for incident shapes so adding drift does not change trigger selection.
  const shapeRng = createSeededRandom((seed ^ 0x5bd1e995) >>> 0);
  const shapeCounts: Record<IncidentShape, number> = { spike: 0, drift: 0 };

  const [unorderedFocusRecords, importedEvents] = await Promise.all([
    prisma.billingRecord.findMany({ where: { sourceType: options.focusSourceType ?? "focus" } }),
    prisma.infrastructureEvent.findMany({
      where: {
        sourceType: "alibaba_trace",
        eventType: {
          in: [
            "K8s_High_Resource_Request",
            "K8s_GPU_Workload",
            "K8s_Pending_Workload",
            "K8s_Failed_Workload"
          ]
        }
      },
      orderBy: [{ timestamp: "asc" }, { eventType: "asc" }, { resourceId: "asc" }, { description: "asc" }]
    })
  ]);
  const focusRecords = unorderedFocusRecords.sort(compareBillingRecords);
  if (!focusRecords.length) throw new Error("No FOCUS billing records are available. Import FOCUS data first.");
  if (!importedEvents.length) throw new Error("No Alibaba trace events are available. Import the Alibaba pod trace first.");

  await prisma.$transaction([
    prisma.groundTruthLabel.deleteMany({ where: { sourceDataset: "hybrid_synthesized" } }),
    prisma.rootCauseCandidate.deleteMany({ where: { infrastructureEvent: { sourceType: "hybrid_synthesized" } } }),
    prisma.anomalyResult.deleteMany({ where: { sourceType: "hybrid_synthesized" } }),
    prisma.infrastructureEvent.deleteMany({ where: { sourceType: "hybrid_synthesized" } }),
    prisma.billingRecord.deleteMany({ where: { sourceType: "hybrid_synthesized" } })
  ]);

  await prisma.billingRecord.createMany({
    data: focusRecords.map((record) => ({
      timestamp: record.timestamp,
      account: record.account,
      service: record.service,
      region: record.region,
      resourceId: record.resourceId,
      cost: record.cost,
      usageQuantity: record.usageQuantity,
      tags: record.tags ?? Prisma.JsonNull,
      sourceType: "hybrid_synthesized",
      provider: record.provider,
      currency: record.currency,
      rawSource: {
        ...jsonObject(record.rawSource),
        originalFocusBillingRecordId: record.id,
        buildRunId: options.buildRunId,
        seed,
        synthesisExplanation: SYNTHESIS_EXPLANATION
      }
    }))
  });

  const hybridRecords = (await prisma.billingRecord.findMany({ where: { sourceType: "hybrid_synthesized" } }))
    .sort(compareBillingRecords);
  const orderedEvents = [...importedEvents].sort((left, right) =>
    left.timestamp.getTime() - right.timestamp.getTime()
    || left.eventType.localeCompare(right.eventType)
    || (left.resourceId ?? "").localeCompare(right.resourceId ?? "")
    || left.description.localeCompare(right.description)
  );
  const shuffledEvents = rng.shuffle(orderedEvents);
  const triggers = shuffledEvents.slice(0, Math.min(numScenarios * 4, shuffledEvents.length));
  const triggerIds = new Set(triggers.map((event) => event.id));
  // Distractors are re-timestamped next to each incident, so they may come from anywhere on the timeline.
  const distractorPool = shuffledEvents.filter((event) => !triggerIds.has(event.id));
  let distractorCursor = 0;
  let distractorEventCount = 0;
  const labels = [];
  let injectedScenarioCount = 0;
  const usedMultipliers: number[] = [];
  const usedRecordIds = new Set<string>();
  const groupedHistory = new Map<string, typeof hybridRecords>();
  const pastEndByGroup = new Map<string, number>();
  const incidentWindowsBySeries = new Map<string, Array<[number, number]>>();
  const minIncidentGapMs = clamp(options.minIncidentGapHours, 12, 0, 168) * hourMs;
  const candidateContext = new Map<string, { baseline: number; historyCount: number; positiveHistoryCount: number }>();

  for (const record of hybridRecords) {
    const key = `${record.account}:${record.service}:${record.region}`;
    const history = groupedHistory.get(key) ?? [];
    // Same strictly-earlier-timestamp history as the detector features (records are time-ordered).
    const last = history[history.length - 1];
    if (!last || last.timestamp.getTime() < record.timestamp.getTime()) pastEndByGroup.set(key, history.length);
    const pastEnd = pastEndByGroup.get(key) ?? 0;
    // Reference cost: median of the seven most recent earlier rows with a non-zero cost, the same window
    // as the detector features.
    const positivePriorCosts: number[] = [];
    for (let back = pastEnd - 1; back >= 0 && positivePriorCosts.length < 7; back -= 1) {
      if (history[back].cost > 0) positivePriorCosts.unshift(history[back].cost);
    }
    candidateContext.set(record.id, {
      baseline: median(positivePriorCosts),
      historyCount: pastEnd,
      positiveHistoryCount: positivePriorCosts.length
    });
    history.push(record);
    groupedHistory.set(key, history);
  }

  function hasKnownRegion(region: string) {
    const normalized = region.trim().toLowerCase();
    return Boolean(normalized && normalized !== "null" && normalized !== "unknown" && normalized !== "n/a");
  }

  function matchesMappedService(service: string, aliases: string[]) {
    const normalized = service.toLowerCase();
    return aliases.some((alias) => normalized.includes(alias));
  }

  function pickBaselineRecord(candidates: typeof hybridRecords, triggerTime: Date, aliases: string[]) {
    return candidates
      .filter((record) => {
        const context = candidateContext.get(record.id);
        // A reference cost is needed to define the incident's size; the detector's own history gate
        // (>= 6 earlier rows) is deliberately not required here.
        if (!context || context.historyCount < 1 || context.baseline < minBaselineCost || record.cost < minBaselineCost) return false;
        if (context.positiveHistoryCount < 1) return false;
        const start = record.timestamp.getTime();
        if (start < injectionFromMs || start + maxIncidentHours * hourMs > injectionToMs) return false;
        // Keep incidents in the same series apart, so one incident never sits in another's rolling history.
        const seriesWindows = incidentWindowsBySeries.get(`${record.account}:${record.service}:${record.region}`) ?? [];
        const end = start + maxIncidentHours * hourMs;
        if (seriesWindows.some(([otherStart, otherEnd]) => start < otherEnd + minIncidentGapMs && end + minIncidentGapMs > otherStart)) return false;
        if (!hasKnownRegion(record.region)) return false;
        if (!matchesMappedService(record.service, aliases)) return false;
        const ratio = record.cost / context.baseline;
        return ratio >= 0.5 && ratio <= 2;
      })
      // Nearest eligible row in time to the trigger. Earlier versions preferred the most stable rows
      // (cost closest to baseline), which made injected incidents unusually easy to detect.
      .sort((left, right) => {
        const timeDifference = Math.abs(left.timestamp.getTime() - triggerTime.getTime())
          - Math.abs(right.timestamp.getTime() - triggerTime.getTime());
        if (timeDifference !== 0) return timeDifference;
        return left.account.localeCompare(right.account)
          || left.service.localeCompare(right.service)
          || left.region.localeCompare(right.region)
          || (left.resourceId ?? "").localeCompare(right.resourceId ?? "")
          || left.cost - right.cost;
      })[0];
  }

  const maxIncidentHours = Math.max(maxTimeWindowHours, driftFraction > 0 ? driftWindowHours : 0);
  // With an injection block, triggers are placed by rank rather than by their Alibaba creation time:
  // about 90% of trigger-type events fall in the last 20% of the trace, so a linear projection would
  // pack every incident into the last few days of the block. Rank placement keeps the triggers' order
  // and spreads them evenly over the block.
  const blocked = Number.isFinite(injectionFromMs) && Number.isFinite(injectionToMs);
  const placementSpanMs = blocked ? Math.max(0, injectionToMs - injectionFromMs - maxIncidentHours * hourMs) : 0;
  const triggerRank = new Map([...triggers]
    .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime() || left.id.localeCompare(right.id))
    .map((event, rank) => [event.id, rank]));
  for (let index = 0; index < triggers.length && injectedScenarioCount < numScenarios; index += 1) {
    const trigger = triggers[index];
    const triggerTime = blocked
      ? new Date(injectionFromMs + ((triggerRank.get(trigger.id)! + 0.5) / triggers.length) * placementSpanMs)
      : trigger.timestamp;
    const mapping = mappingForEvent(trigger.eventType, trigger.metadata);
    const searchWindowMs = maxTimeWindowHours * 60 * 60 * 1000;
    const nearby = hybridRecords.filter((record) =>
      !usedRecordIds.has(record.id) && Math.abs(record.timestamp.getTime() - triggerTime.getTime()) <= searchWindowMs
    );
    const serviceMatches = nearby.filter((record) =>
      matchesMappedService(record.service, mapping.aliases)
    );
    const unusedRecords = hybridRecords.filter((candidate) =>
      !usedRecordIds.has(candidate.id) && matchesMappedService(candidate.service, mapping.aliases)
    );
    const record =
      pickBaselineRecord(serviceMatches, triggerTime, mapping.aliases) ??
      pickBaselineRecord(unusedRecords, triggerTime, mapping.aliases);
    if (!record) continue;
    const multiplier = Number(scenarioMultiplier(trigger.eventType, trigger.metadata, index, minMultiplier, maxMultiplier).toFixed(4));
    usedMultipliers.push(multiplier);
    const shape: IncidentShape = shapeRng.next() < driftFraction ? "drift" : "spike";
    const durationHours = shape === "drift"
      ? driftWindowHours
      : requestedWindowHours !== undefined
        ? minTimeWindowHours
        : scenarioDurationHours(trigger.eventType, index, minTimeWindowHours, maxTimeWindowHours);
    const windowEnd = new Date(record.timestamp.getTime() + durationHours * 60 * 60 * 1000);
    const windowRecords = hybridRecords
      .filter((candidate) =>
        !usedRecordIds.has(candidate.id) &&
        candidate.account === record.account &&
        candidate.service === record.service &&
        candidate.region === record.region &&
        candidate.timestamp.getTime() >= record.timestamp.getTime() &&
        candidate.timestamp.getTime() < windowEnd.getTime()
      )
      .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime())
      .filter((candidate) => {
        const context = candidateContext.get(candidate.id);
        return Boolean(context && context.baseline >= minBaselineCost && candidate.cost >= minBaselineCost);
      });
    const injectedRecords = windowRecords.length ? windowRecords : [record];
    for (const injectedRecord of injectedRecords) {
      usedRecordIds.add(injectedRecord.id);
    }
    const seriesKey = `${record.account}:${record.service}:${record.region}`;
    incidentWindowsBySeries.set(seriesKey, [...(incidentWindowsBySeries.get(seriesKey) ?? []), [record.timestamp.getTime(), windowEnd.getTime()]]);
    shapeCounts[shape] += 1;
    const scenarioId = `${seed}-${String(injectedScenarioCount + 1).padStart(4, "0")}`;
    const onsetMs = record.timestamp.getTime();
    const regionDropped = realistic && noiseRng.next() < dimensionNoiseRate;

    // Event rows carry only what an operator would see; ground truth lives in GroundTruthLabel.
    const hybridEvent = await prisma.infrastructureEvent.create({
      data: {
        id: opaqueEventId(seed, scenarioId, "event"),
        timestamp: new Date(onsetMs - noiseRng.next() * eventTimeJitterHours * hourMs),
        eventType: trigger.eventType,
        account: record.account,
        service: record.service,
        region: regionDropped ? "unknown" : record.region,
        resourceId: realistic ? trigger.resourceId : record.resourceId ?? trigger.resourceId,
        description: `Synthesized trigger based on ${trigger.eventType}: ${trigger.description}`,
        sourceType: "hybrid_synthesized",
        metadata: {
          ...jsonObject(trigger.metadata),
          sourceAlibabaEventId: trigger.id,
          buildRunId: options.buildRunId,
          seed,
          attributionSetting,
          mappingExplanation: SYNTHESIS_EXPLANATION
        }
      }
    });
    injectedScenarioCount += 1;

    for (let distractorIndex = 0; distractorIndex < distractorsPerScenario && distractorCursor < distractorPool.length; distractorIndex += 1) {
      const source = distractorPool[distractorCursor];
      distractorCursor += 1;
      // Offsets in [-3h, +2h] around onset so some distractors are closer than the true event.
      const offsetHours = -3 + noiseRng.next() * 5;
      await prisma.infrastructureEvent.create({
        data: {
          id: opaqueEventId(seed, scenarioId, `distractor-${distractorIndex + 1}`),
          timestamp: new Date(onsetMs + offsetHours * hourMs),
          eventType: source.eventType,
          account: record.account,
          service: record.service,
          // Region noise hits distractors at the same rate as the true event, so a missing region is not
          // a marker of the true event.
          region: realistic && noiseRng.next() < dimensionNoiseRate ? "unknown" : record.region,
          resourceId: source.resourceId,
          description: `Synthesized trigger based on ${source.eventType}: ${source.description}`,
          sourceType: "hybrid_synthesized",
          metadata: {
            ...jsonObject(source.metadata),
            sourceAlibabaEventId: source.id,
            buildRunId: options.buildRunId,
            seed,
            attributionSetting,
            mappingExplanation: SYNTHESIS_EXPLANATION
          }
        }
      });
      distractorEventCount += 1;
    }

    for (const injectedRecord of injectedRecords) {
      const originalCost = injectedRecord.cost;
      const originalUsageQuantity = injectedRecord.usageQuantity;
      // Drift ramps linearly from just above 1x at onset to the full multiplier at the window end.
      const elapsedHours = (injectedRecord.timestamp.getTime() - onsetMs) / hourMs;
      const rowMultiplier = shape === "drift"
        ? 1 + (multiplier - 1) * Math.min(1, (elapsedHours + 1) / durationHours)
        : multiplier;
      await prisma.billingRecord.update({
        where: { id: injectedRecord.id },
        data: {
          cost: Number((originalCost * rowMultiplier).toFixed(6)),
          usageQuantity: Number((originalUsageQuantity * rowMultiplier).toFixed(6)),
          isInjectedAnomaly: true,
          anomalyType: mapping.rootCauseType,
          expectedRootCause: trigger.eventType
        }
      });

      labels.push({
        billingRecordId: injectedRecord.id,
        anomalyWindowStart: record.timestamp,
        anomalyWindowEnd: windowEnd,
        expectedRootCauseType: mapping.rootCauseType,
        expectedEventId: hybridEvent.id,
        expectedEventType: trigger.eventType,
        sourceDataset: "hybrid_synthesized",
        explanation: SYNTHESIS_EXPLANATION,
        // Injection details live with the label, not in the billing row's raw source.
        metadata: {
          originalCost,
          originalUsageQuantity,
          injectedMultiplier: Number(rowMultiplier.toFixed(4)),
          scenarioMultiplier: multiplier,
          incidentShape: shape,
          scenarioProject: mapping.project,
          injectedWindowSize: injectedRecords.length,
          injectedWindowHours: durationHours,
          buildRunId: options.buildRunId,
          seed
        }
      });
    }
  }

  if (labels.length) await prisma.groundTruthLabel.createMany({ data: labels });
  return {
    baselineRecords: hybridRecords.length,
    injectedScenarios: injectedScenarioCount,
    injectedRecords: labels.length,
    hybridEvents: injectedScenarioCount + distractorEventCount,
    spikeScenarios: shapeCounts.spike,
    driftScenarios: shapeCounts.drift,
    driftFraction,
    driftWindowHours,
    injectionFrom: Number.isFinite(injectionFromMs) ? new Date(injectionFromMs) : null,
    injectionTo: Number.isFinite(injectionToMs) ? new Date(injectionToMs) : null,
    distractorEvents: distractorEventCount,
    attributionSetting,
    distractorsPerScenario,
    eventTimeJitterHours,
    dimensionNoiseRate,
    costMultiplierRange: usedMultipliers.length
      ? [Math.min(...usedMultipliers), Math.max(...usedMultipliers)]
      : [minMultiplier, maxMultiplier],
    timeWindowHours: maxTimeWindowHours,
    minTimeWindowHours,
    maxTimeWindowHours,
    seed,
    minBaselineCost,
    expectedRootCauseEventIds: labels.map((label) => label.expectedEventId).filter((id, index, ids) => ids.indexOf(id) === index),
    sourceDataset: "hybrid_synthesized"
  };
}
