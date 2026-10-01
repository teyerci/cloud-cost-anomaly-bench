import type { AnomalyResult, BillingRecord, GroundTruthLabel } from "@prisma/client";

type AnomalyWithBilling = AnomalyResult & { billingRecord: BillingRecord | null };

export type PresentedAnomaly = AnomalyWithBilling & {
  expectedCost: number;
  actualCost: number;
  groundTruthLabel?: boolean;
  detectionClassification?: "true_positive" | "false_positive";
  expectedRootCauseType?: string | null;
  expectedRootCauseEventId?: string | null;
};

export function presentAnomaly(
  anomaly: AnomalyWithBilling,
  label?: GroundTruthLabel | null
): PresentedAnomaly {
  const labeledSource = anomaly.sourceType === "synthetic" || anomaly.sourceType === "hybrid_synthesized";
  const isGroundTruthAnomaly = Boolean(anomaly.billingRecord?.isInjectedAnomaly || label);
  return {
    ...anomaly,
    expectedCost: Math.max(0, anomaly.expectedCost),
    actualCost: Math.max(0, anomaly.actualCost),
    groundTruthLabel: labeledSource ? isGroundTruthAnomaly : undefined,
    detectionClassification: labeledSource
      ? isGroundTruthAnomaly ? "true_positive" : "false_positive"
      : undefined,
    expectedRootCauseType: label?.expectedRootCauseType ?? anomaly.billingRecord?.anomalyType ?? null,
    expectedRootCauseEventId: label?.expectedEventId ?? null
  };
}

export function falsePositiveMessage() {
  return "This detection is a non-injection alert: it is not labeled as an injected anomaly in the hybrid ground truth, so no ground-truth Alibaba root cause exists. Candidate events below were ranked by the same scorer but are exploratory and are not counted in attribution accuracy.";
}

// The scorer never sees labels; the false-positive status is applied only when results are shown.
export function presentAttribution<T extends { attributionStatus: string; message?: string; candidates: unknown[] }>(
  billingRecord: BillingRecord | null | undefined,
  result: T
) {
  if (billingRecord?.sourceType === "hybrid_synthesized" && !billingRecord.isInjectedAnomaly) {
    return { ...result, attributionStatus: "exploratory_false_positive" as const, message: falsePositiveMessage() };
  }
  return result;
}
