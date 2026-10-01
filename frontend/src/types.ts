export type BillingRecord = {
  id: string;
  timestamp: string;
  account: string;
  service: string;
  region: string;
  resourceId?: string | null;
  cost: number;
  usageQuantity: number;
  tags?: Record<string, string>;
  sourceType?: string;
  provider?: string;
  currency?: string;
  rawSource?: Record<string, string>;
  isInjectedAnomaly?: boolean;
  anomalyType?: string;
  expectedRootCause?: string;
};

export type InfrastructureEvent = {
  id: string;
  timestamp: string;
  eventType: string;
  account: string;
  service: string;
  region: string;
  resourceId?: string;
  description: string;
  sourceType?: string;
  metadata?: Record<string, unknown>;
};

export type AnomalyResult = {
  id: string;
  timestamp: string;
  score: number;
  severity: string;
  expectedCost: number;
  actualCost: number;
  explanation: string;
  sourceType?: string;
  groundTruthLabel?: boolean;
  detectionClassification?: "true_positive" | "false_positive";
  expectedRootCauseType?: string | null;
  expectedRootCauseEventId?: string | null;
  billingRecord?: BillingRecord;
};

export type RootCauseCandidate = {
  id: string;
  score: number;
  reason: string;
  signals?: Record<string, unknown>;
  infrastructureEvent: InfrastructureEvent;
};

export type DashboardFilters = {
  account: string;
  service: string;
  region: string;
  severity: string;
  sourceType: string;
};

export type FocusColumnMapping = Partial<Record<
  "timestamp" | "provider" | "accountId" | "service" | "region" | "tagProject" | "usageQuantity" | "cost" | "currency" | "resourceId",
  string
>>;

export type FocusPreview = {
  detectedColumns: string[];
  mappedColumns: FocusColumnMapping;
  sampleRows: Record<string, string>[];
};

export type FocusImportSummary = {
  totalRows: number;
  insertedRows: number;
  skippedRows: number;
  validationErrors: string[];
  detectedColumns: string[];
  mappedColumns: FocusColumnMapping;
};

export type EvaluationMetrics = {
  mode?: string;
  evaluationType?: string;
  records: number;
  injectedAnomalies?: number;
  detectedAnomalies: number;
  anomalyMetricsAvailable?: boolean;
  confusionMatrix?: {
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    trueNegatives: number;
  };
  precision?: number;
  recall?: number;
  f1Score?: number;
  rootCauseTop1Accuracy: number | null;
  rootCauseEvaluatedDetections: number;
  contamination?: number | null;
  nEstimators?: number | null;
  maxSamples?: string | null;
  randomState?: number | null;
  calibrationUsed?: boolean;
  selectedThreshold?: number | null;
  thresholdPercentile?: number | null;
  scoreDistribution?: Record<string, number> | null;
  minRelativeIncrease?: number | null;
  minAbsoluteDelta?: number | null;
  tuningResults?: Array<Record<string, number>> | null;
  bestF1Config?: Record<string, number> | null;
  top20Precision?: number | null;
  detector?: "isolation_forest" | "ratio_rule" | "robust_z" | null;
  robustZThreshold?: number | null;
  injectedScenarios?: number;
  detectedScenarios?: number;
  scenarioRecall?: number | null;
  rootCauseTop3Accuracy?: number | null;
  rootCauseMrr?: number | null;
  rootCauseTypeTop1Accuracy?: number | null;
  meanCandidatesPerDetection?: number | null;
  endToEndAttributionCoverage?: number | null;
  explanation?: string;
};

export type RootCauseResponse = {
  attributionStatus: "available" | "no_candidates" | "not_available" | "exploratory_false_positive";
  message?: string;
  candidates: RootCauseCandidate[];
};

export type AttributionUiStatus =
  | "not_run"
  | "loading"
  | "available"
  | "not_available"
  | "no_candidates"
  | "exploratory_false_positive"
  | "error";

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

export type HybridBuildSummary = {
  baselineRecords: number;
  injectedScenarios: number;
  injectedRecords?: number;
  hybridEvents: number;
  costMultiplierRange: number[];
  timeWindowHours: number;
  minTimeWindowHours?: number;
  maxTimeWindowHours?: number;
  sourceDataset: "hybrid_synthesized";
};

export type HybridStatus = {
  available: boolean;
  focusRecords: number;
  importedEvents: number;
  hybridRecords: number;
  hybridEvents: number;
  groundTruthLabels: number;
};

export type DemoRebuildSummary = {
  status: "ok";
  buildRunId: string;
  seed: number;
  numScenarios: number;
  timeWindowHours: number;
  minBaselineCost: number;
  costMultiplierMin: number;
  costMultiplierMax: number;
  runDetection: boolean;
  runAttributionForTruePositives: boolean;
  focusImportedRows: number;
  alibabaImportedEvents: number;
  hybridBillingRecords: number;
  injectedScenarios: number;
  labeledInjectedRecords?: number;
  injectedRecords?: number;
  detectionRunId?: string | null;
  metrics?: {
    precision: number | null;
    recall: number | null;
    f1Score?: number | null;
    f1: number | null;
    tp: number | null;
    fp: number | null;
    fn: number | null;
    tn: number | null;
  } | null;
};

export type DashboardSummary = {
  totalRecords: number;
  totalEvents: number;
  totalAnomalies: number;
};
