import type {
  AnomalyResult,
  BillingRecord,
  DashboardSummary,
  DemoRebuildSummary,
  DashboardFilters,
  EvaluationMetrics,
  FocusImportSummary,
  FocusPreview,
  AlibabaTraceImportSummary,
  HybridBuildSummary,
  HybridStatus,
  InfrastructureEvent,
  RootCauseResponse
} from "../types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000/api";

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`);
  if (!response.ok) throw new Error(`API request failed: ${response.status}`);
  return response.json();
}

function filterQuery(filters?: Partial<DashboardFilters>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (value) params.set(key, value);
  }
  return params.toString();
}

export async function fetchBillingRecords(filters?: Partial<DashboardFilters>) {
  const params = new URLSearchParams(filterQuery(filters));
  params.set("limit", "2000");
  return getJson<BillingRecord[]>(`/billing-records?${params.toString()}`);
}

export async function fetchBillingWindow(anomaly: AnomalyResult, hours = 24) {
  const record = anomaly.billingRecord;
  if (!record) return [];
  const center = new Date(anomaly.timestamp).getTime();
  const windowMs = hours * 60 * 60 * 1000;
  const params = new URLSearchParams({
    account: record.account,
    service: record.service,
    region: record.region,
    sourceType: record.sourceType ?? "",
    from: new Date(center - windowMs).toISOString(),
    to: new Date(center + windowMs).toISOString(),
    limit: "2000"
  });
  return getJson<BillingRecord[]>(`/billing-records?${params.toString()}`);
}

export async function fetchEvents(filters?: Partial<DashboardFilters>) {
  const query = filterQuery(filters);
  return getJson<InfrastructureEvent[]>(`/events${query ? `?${query}` : ""}`);
}

export async function fetchAnomalies(filters?: Partial<DashboardFilters>) {
  const query = filterQuery(filters);
  return getJson<AnomalyResult[]>(`/anomalies${query ? `?${query}` : ""}`);
}

export async function fetchDashboardSummary(filters?: Partial<DashboardFilters>) {
  const query = filterQuery(filters);
  return getJson<DashboardSummary>(`/dashboard/summary${query ? `?${query}` : ""}`);
}

export async function runDataGeneration() {
  const response = await fetch(`${API_BASE_URL}/data/generate`, { method: "POST" });
  if (!response.ok) throw new Error("Failed to generate synthetic data.");
  return response.json();
}

export async function runAnomalyDetection(sourceType = "all") {
  const response = await fetch(`${API_BASE_URL}/anomalies/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceType })
  });
  if (!response.ok) throw new Error("Failed to run anomaly detection.");
  return response.json();
}

export async function runRootCause(anomalyId: string) {
  const response = await fetch(`${API_BASE_URL}/root-cause/run/${anomalyId}`, { method: "POST" });
  if (!response.ok) throw new Error("Failed to run root-cause attribution.");
  return response.json() as Promise<RootCauseResponse>;
}

export async function fetchRootCause(anomalyId: string) {
  return getJson<RootCauseResponse>(`/root-cause/${anomalyId}`);
}

export async function fetchEvaluation(mode = "all") {
  const params = new URLSearchParams({ mode });
  return getJson<EvaluationMetrics>(`/evaluation?${params.toString()}`);
}

export async function previewFocusMapping(filePath: string) {
  const params = new URLSearchParams({ filePath });
  return getJson<FocusPreview>(`/focus/mapping-preview?${params.toString()}`);
}

export async function importFocusCsv(filePath: string) {
  const response = await fetch(`${API_BASE_URL}/focus/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filePath })
  });
  if (!response.ok) throw new Error("Failed to import FOCUS CSV.");
  return response.json() as Promise<FocusImportSummary>;
}

export async function fetchHybridStatus() {
  return getJson<HybridStatus>("/hybrid/status");
}

export async function importAlibabaTrace(filePath: string, focusStartTime?: string, focusEndTime?: string) {
  const response = await fetch(`${API_BASE_URL}/hybrid/import-alibaba-trace`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filePath,
      focusStartTime: focusStartTime || undefined,
      focusEndTime: focusEndTime || undefined
    })
  });
  if (!response.ok) throw new Error("Failed to import Alibaba trace CSV.");
  return response.json() as Promise<AlibabaTraceImportSummary>;
}

export async function buildHybridDataset() {
  const response = await fetch(`${API_BASE_URL}/hybrid/build`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      focusSourceType: "focus",
      numScenarios: 50,
      minTimeWindowHours: 3,
      maxTimeWindowHours: 6
    })
  });
  if (!response.ok) throw new Error("Failed to build hybrid dataset.");
  return response.json() as Promise<HybridBuildSummary>;
}

export async function resetAndRebuildDemoData(options: {
  focusFilePath: string;
  alibabaFilePath: string;
  seed: number;
  numScenarios: number;
  timeWindowHours?: number;
  minBaselineCost?: number;
  costMultiplierMin?: number;
  costMultiplierMax?: number;
  runDetection: boolean;
  runAttributionForTruePositives: boolean;
}) {
  const response = await fetch(`${API_BASE_URL}/demo/reset-and-rebuild`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options)
  });
  if (!response.ok) throw new Error("Failed to reset and rebuild demo data.");
  return response.json() as Promise<DemoRebuildSummary>;
}
