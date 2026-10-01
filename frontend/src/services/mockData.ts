import type { AnomalyResult, BillingRecord, InfrastructureEvent } from "../types";

const now = Date.now();

export const mockBillingRecords: BillingRecord[] = Array.from({ length: 24 }, (_, index) => {
  const cost = index === 16 ? 245 : 58 + Math.sin(index / 2) * 8;
  return {
    id: `mock-billing-${index}`,
    timestamp: new Date(now - (23 - index) * 60 * 60 * 1000).toISOString(),
    account: "prod",
    service: "compute",
    region: "us-east-1",
    resourceId: "prod-compute-us-east-1",
    cost: Number(cost.toFixed(2)),
    usageQuantity: Number((cost * 2.2).toFixed(2))
  };
});

export const mockEvents: InfrastructureEvent[] = [
  {
    id: "mock-event-1",
    timestamp: mockBillingRecords[15].timestamp,
    eventType: "autoscaling",
    account: "prod",
    service: "compute",
    region: "us-east-1",
    resourceId: "prod-compute-us-east-1",
    description: "Autoscaling policy increased instance count"
  },
  {
    id: "mock-event-2",
    timestamp: mockBillingRecords[7].timestamp,
    eventType: "deployment",
    account: "prod",
    service: "database",
    region: "us-east-1",
    description: "Routine database release"
  }
];

export const mockAnomalies: AnomalyResult[] = [
  {
    id: "mock-anomaly-1",
    timestamp: mockBillingRecords[16].timestamp,
    score: 2.7,
    severity: "high",
    expectedCost: 61.25,
    actualCost: 245,
    explanation: "Compute cost exceeded the recent baseline.",
    billingRecord: mockBillingRecords[16]
  }
];
