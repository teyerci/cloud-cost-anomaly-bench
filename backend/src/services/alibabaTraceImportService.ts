import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { parse } from "csv-parse/sync";

type CsvRow = Record<string, string | undefined>;

type AlibabaPodRow = {
  name: string;
  cpuMilli?: number;
  memoryMiB?: number;
  numGpu?: number;
  gpuMilli?: number;
  gpuSpec?: string;
  qos?: string;
  podPhase?: string;
  creationTime: number;
  deletionTime?: number;
  scheduledTime?: number;
};

export type AlibabaTraceImportSummary = {
  totalRows: number;
  validRows: number;
  skippedRows: number;
  insertedEvents: number;
  replacedEvents: number;
  validationErrors: string[];
  focusStartTime: string;
  focusEndTime: string;
  traceStartSeconds: number;
  traceEndSeconds: number;
  traceDurationDays: number;
  projectedDurationDays: number;
  timeCompressionRatio: number;
  alignmentMode: "compressed_to_focus_range";
};

const SYNTHETIC_ALIGNMENT_NOTE =
  "Alibaba relative trace time was linearly compressed into the FOCUS billing range for controlled evaluation; this preserves event ordering but does not imply real synchronization or causality.";

type TimeProjection = {
  focusStartTime: Date;
  focusEndTime: Date;
  traceStartSeconds: number;
  traceEndSeconds: number;
};

function clean(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function optionalNumber(value: string | undefined) {
  const raw = clean(value);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseRow(row: CsvRow, rowNumber: number) {
  const errors: string[] = [];
  const creationRaw = clean(row.creation_time);
  const creationTime = optionalNumber(creationRaw);
  if (creationTime === undefined) errors.push(`Row ${rowNumber}: creation_time must be numeric.`);

  const optionalFields = [
    ["deletion_time", row.deletion_time],
    ["scheduled_time", row.scheduled_time],
    ["cpu_milli", row.cpu_milli],
    ["memory_mib", row.memory_mib],
    ["num_gpu", row.num_gpu],
    ["gpu_milli", row.gpu_milli]
  ] as const;
  for (const [column, value] of optionalFields) {
    if (clean(value) !== undefined && optionalNumber(value) === undefined) {
      errors.push(`Row ${rowNumber}: ${column} must be numeric when provided.`);
    }
  }

  if (errors.length || creationTime === undefined) return { errors };

  const pod: AlibabaPodRow = {
    name: clean(row.name) ?? `pod-row-${rowNumber}`,
    creationTime,
    deletionTime: optionalNumber(row.deletion_time),
    scheduledTime: optionalNumber(row.scheduled_time),
    cpuMilli: optionalNumber(row.cpu_milli),
    memoryMiB: optionalNumber(row.memory_mib),
    numGpu: optionalNumber(row.num_gpu),
    gpuMilli: optionalNumber(row.gpu_milli),
    gpuSpec: clean(row.gpu_spec),
    qos: clean(row.qos),
    podPhase: clean(row.pod_phase)
  };
  return { errors, pod };
}

export function projectAlibabaTimestamp(
  traceSeconds: number,
  focusStartTime: Date,
  focusEndTime?: Date,
  traceStartSeconds = 0,
  traceEndSeconds?: number
) {
  // Linear compression creates a synthetic shared range while preserving trace order, not real synchronization.
  if (!focusEndTime || traceEndSeconds === undefined || traceEndSeconds <= traceStartSeconds) {
    return new Date(focusStartTime.getTime() + (traceSeconds - traceStartSeconds) * 1000);
  }
  const normalizedPosition = Math.min(1, Math.max(0,
    (traceSeconds - traceStartSeconds) / (traceEndSeconds - traceStartSeconds)
  ));
  return new Date(
    focusStartTime.getTime() + normalizedPosition * (focusEndTime.getTime() - focusStartTime.getTime())
  );
}

function workloadMapping(pod: AlibabaPodRow) {
  if ((pod.numGpu ?? 0) > 0) {
    return { service: "gpu_compute", scenario: "accelerated_compute", explanation: "GPU request mapped synthetically to accelerated compute billing." };
  }
  if (pod.podPhase === "Pending" || pod.podPhase === "Failed") {
    return { service: "unused_capacity", scenario: "orphan_resource", explanation: "Pending/failed workload mapped synthetically to unused or orphaned capacity." };
  }
  return { service: "compute", scenario: "compute_workload", explanation: "CPU or memory workload mapped synthetically to compute billing." };
}

function metadataFor(pod: AlibabaPodRow, projection: TimeProjection, traceSeconds: number) {
  const mapping = workloadMapping(pod);
  const traceDurationSeconds = projection.traceEndSeconds - projection.traceStartSeconds;
  const projectedDurationSeconds = (projection.focusEndTime.getTime() - projection.focusStartTime.getTime()) / 1000;
  return {
    podName: pod.name,
    cpuMilli: pod.cpuMilli,
    memoryMiB: pod.memoryMiB,
    numGpu: pod.numGpu,
    gpuMilli: pod.gpuMilli,
    gpuSpec: pod.gpuSpec,
    qos: pod.qos,
    podPhase: pod.podPhase,
    originalTraceSeconds: traceSeconds,
    syntheticMapping: mapping,
    syntheticAlignment: SYNTHETIC_ALIGNMENT_NOTE,
    projection: {
      mode: "compressed_to_focus_range",
      focusStartTime: projection.focusStartTime.toISOString(),
      focusEndTime: projection.focusEndTime.toISOString(),
      traceStartSeconds: projection.traceStartSeconds,
      traceEndSeconds: projection.traceEndSeconds,
      timeCompressionRatio: traceDurationSeconds / Math.max(projectedDurationSeconds, 1)
    }
  };
}

function eventData(
  pod: AlibabaPodRow,
  projection: TimeProjection,
  eventType: string,
  traceSeconds: number,
  description: string
): Prisma.InfrastructureEventCreateManyInput {
  const mapping = workloadMapping(pod);
  return {
    timestamp: projectAlibabaTimestamp(
      traceSeconds,
      projection.focusStartTime,
      projection.focusEndTime,
      projection.traceStartSeconds,
      projection.traceEndSeconds
    ),
    eventType,
    account: "alibaba-trace",
    service: mapping.service,
    region: "projected",
    resourceId: pod.name,
    description,
    metadata: metadataFor(pod, projection, traceSeconds),
    sourceType: "alibaba_trace"
  };
}

function eventsForPod(pod: AlibabaPodRow, projection: TimeProjection) {
  const events: Prisma.InfrastructureEventCreateManyInput[] = [
    eventData(pod, projection, "K8s_Pod_Created", pod.creationTime, `Pod ${pod.name} was created in the Alibaba trace.`)
  ];
  if (pod.scheduledTime !== undefined) {
    events.push(eventData(pod, projection, "K8s_Pod_Scheduled", pod.scheduledTime, `Pod ${pod.name} was scheduled.`));
  }
  if (pod.deletionTime !== undefined) {
    events.push(eventData(pod, projection, "K8s_Pod_Deleted", pod.deletionTime, `Pod ${pod.name} was deleted.`));
  }
  if ((pod.cpuMilli ?? 0) >= 4000 || (pod.memoryMiB ?? 0) >= 8192) {
    events.push(eventData(pod, projection, "K8s_High_Resource_Request", pod.creationTime, `Pod ${pod.name} requested high CPU or memory.`));
  }
  if ((pod.numGpu ?? 0) > 0) {
    events.push(eventData(pod, projection, "K8s_GPU_Workload", pod.creationTime, `Pod ${pod.name} requested GPU resources.`));
  }
  if (pod.podPhase === "Pending") {
    events.push(eventData(pod, projection, "K8s_Pending_Workload", pod.creationTime, `Pod ${pod.name} remained pending.`));
  }
  if (pod.podPhase === "Failed") {
    events.push(eventData(pod, projection, "K8s_Failed_Workload", pod.creationTime, `Pod ${pod.name} failed.`));
  }
  return events;
}

function resolveImportPath(filePath: string) {
  if (!filePath.trim()) throw new Error("filePath is required.");
  if (path.isAbsolute(filePath)) return filePath;
  const candidates = [path.resolve(process.cwd(), filePath), path.resolve(process.cwd(), "..", filePath)];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function parseRequestedTime(value: string | undefined, field: string) {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${field} must be a valid ISO timestamp.`);
  return parsed;
}

async function resolveFocusRange(
  prisma: PrismaClient,
  requestedStart?: string,
  requestedEnd?: string
) {
  const requestedStartTime = parseRequestedTime(requestedStart, "focusStartTime");
  const requestedEndTime = parseRequestedTime(requestedEnd, "focusEndTime");
  const focusRange = await prisma.billingRecord.aggregate({
    where: { sourceType: "focus" },
    _min: { timestamp: true },
    _max: { timestamp: true }
  });
  const focusStartTime = requestedStartTime ?? focusRange._min.timestamp;
  const focusEndTime = requestedEndTime ?? focusRange._max.timestamp;
  if (!focusStartTime || !focusEndTime) {
    throw new Error("Import FOCUS billing records first or provide both focusStartTime and focusEndTime.");
  }
  if (focusEndTime.getTime() <= focusStartTime.getTime()) {
    throw new Error("focusEndTime must be later than focusStartTime.");
  }
  return { focusStartTime, focusEndTime };
}

function traceRange(pods: AlibabaPodRow[]) {
  const timestamps = pods.flatMap((pod) =>
    [pod.creationTime, pod.scheduledTime, pod.deletionTime].filter((value): value is number => value !== undefined)
  );
  return {
    traceStartSeconds: Math.min(...timestamps),
    traceEndSeconds: Math.max(...timestamps)
  };
}

export async function importAlibabaTraceCsv(
  prisma: PrismaClient,
  filePath: string,
  requestedFocusStartTime?: string,
  requestedFocusEndTime?: string
): Promise<AlibabaTraceImportSummary> {
  const resolvedPath = resolveImportPath(filePath);
  const fileStat = await stat(resolvedPath);
  if (!fileStat.isFile()) throw new Error(`Alibaba trace import path must be a CSV file: ${filePath}`);
  const rows = parse(await readFile(resolvedPath, "utf-8"), {
    bom: true,
    columns: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true
  }) as CsvRow[];
  const validationErrors: string[] = [];
  const pods: AlibabaPodRow[] = [];

  rows.forEach((row, index) => {
    const parsed = parseRow(row, index + 2);
    validationErrors.push(...parsed.errors);
    if (parsed.pod) {
      pods.push(parsed.pod);
    }
  });

  if (!pods.length) {
    throw new Error("No valid Alibaba pod rows were found.");
  }
  const focusRange = await resolveFocusRange(prisma, requestedFocusStartTime, requestedFocusEndTime);
  const projection: TimeProjection = { ...focusRange, ...traceRange(pods) };
  const events = pods.flatMap((pod) => eventsForPod(pod, projection));
  const replaced = await prisma.infrastructureEvent.deleteMany({ where: { sourceType: "alibaba_trace" } });
  const batchSize = 500;
  for (let index = 0; index < events.length; index += batchSize) {
    await prisma.infrastructureEvent.createMany({ data: events.slice(index, index + batchSize) });
  }
  const traceDurationSeconds = projection.traceEndSeconds - projection.traceStartSeconds;
  const projectedDurationSeconds = (projection.focusEndTime.getTime() - projection.focusStartTime.getTime()) / 1000;
  return {
    totalRows: rows.length,
    validRows: pods.length,
    skippedRows: rows.length - pods.length,
    insertedEvents: events.length,
    replacedEvents: replaced.count,
    validationErrors,
    focusStartTime: projection.focusStartTime.toISOString(),
    focusEndTime: projection.focusEndTime.toISOString(),
    traceStartSeconds: projection.traceStartSeconds,
    traceEndSeconds: projection.traceEndSeconds,
    traceDurationDays: Number((traceDurationSeconds / 86400).toFixed(4)),
    projectedDurationDays: Number((projectedDurationSeconds / 86400).toFixed(4)),
    timeCompressionRatio: Number((traceDurationSeconds / projectedDurationSeconds).toFixed(4)),
    alignmentMode: "compressed_to_focus_range"
  };
}
