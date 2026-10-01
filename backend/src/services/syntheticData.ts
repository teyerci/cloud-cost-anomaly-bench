import { PrismaClient } from "@prisma/client";
import { createSeededRandom } from "./seededRandom.js";

const services = ["compute", "database", "storage", "network"];
const accounts = ["dev", "staging", "prod"];
const regions = ["us-east-1", "eu-west-1"];

type InjectedAnomaly = {
  offsetHours: number;
  durationHours?: number;
  account: string;
  service: string;
  region: string;
  multiplier: number;
  eventType: string;
  anomalyType: string;
  project: string;
};

const injectedAnomalies: InjectedAnomaly[] = [
  { offsetHours: 38, account: "prod", service: "compute", region: "us-east-1", multiplier: 4.4, eventType: "autoscaling", anomalyType: "service_spike", project: "checkout" },
  { offsetHours: 82, account: "prod", service: "database", region: "eu-west-1", multiplier: 3.8, eventType: "configuration_change", anomalyType: "region_shift", project: "analytics" },
  { offsetHours: 116, durationHours: 4, account: "dev", service: "storage", region: "eu-west-1", multiplier: 2.7, eventType: "configuration_change", anomalyType: "tag_project_spike", project: "ml-lab" },
  { offsetHours: 129, account: "staging", service: "network", region: "us-east-1", multiplier: 4.1, eventType: "deployment", anomalyType: "deployment_spike", project: "payments" },
  { offsetHours: 146, durationHours: 6, account: "prod", service: "compute", region: "eu-west-1", multiplier: 1.55, eventType: "autoscaling", anomalyType: "gradual_cost_drift", project: "search" }
];

function baselineCost(service: string, account: string, hour: number) {
  const serviceBase = { compute: 62, database: 44, storage: 18, network: 25 }[service] ?? 20;
  const accountFactor = account === "prod" ? 1.8 : account === "staging" ? 0.85 : 0.55;
  const dayNightFactor = hour >= 8 && hour <= 19 ? 1.15 : 0.82;
  const smoothNoise = 1 + Math.sin(hour / 3) * 0.08;
  return serviceBase * accountFactor * dayNightFactor * smoothNoise;
}

export async function generateSyntheticData(prisma: PrismaClient, options: { seed?: number } = {}) {
  const seed = options.seed ?? 42;
  const rng = createSeededRandom(seed);
  await prisma.rootCauseCandidate.deleteMany();
  await prisma.anomalyResult.deleteMany();
  await prisma.infrastructureEvent.deleteMany({ where: { sourceType: "synthetic" } });
  await prisma.billingRecord.deleteMany({ where: { sourceType: "synthetic" } });

  const now = new Date();
  now.setMinutes(0, 0, 0);
  const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const records = [];
  for (let hourIndex = 0; hourIndex < 7 * 24; hourIndex += 1) {
    const timestamp = new Date(start.getTime() + hourIndex * 60 * 60 * 1000);
    for (const account of accounts) {
      for (const service of services) {
        for (const region of regions) {
          const anomaly = injectedAnomalies.find(
            (item) =>
              hourIndex >= item.offsetHours &&
              hourIndex < item.offsetHours + (item.durationHours ?? 1) &&
              item.account === account &&
              item.service === service &&
              item.region === region
          );
          const deterministicNoise = 0.98 + rng.next() * 0.04;
          const baseline = baselineCost(service, account, timestamp.getHours()) * deterministicNoise;
          const driftStep = anomaly?.anomalyType === "gradual_cost_drift" ? 1 + (hourIndex - anomaly.offsetHours) * 0.18 : 1;
          const cost = Number((baseline * (anomaly?.multiplier ?? 1) * driftStep).toFixed(2));
          const project = anomaly?.project ?? (service === "database" ? "analytics" : service === "storage" ? "archive" : "platform");
          records.push({
            timestamp,
            account,
            service,
            region,
            resourceId: `${account}-${service}-${region}`,
            cost,
            usageQuantity: Number((cost * (service === "storage" ? 14 : 2.3)).toFixed(2)),
            tags: { environment: account, owner: service === "database" ? "data-platform" : "platform", project },
            sourceType: "synthetic",
            provider: "synthetic",
            currency: "USD",
            rawSource: { seed },
            isInjectedAnomaly: Boolean(anomaly),
            anomalyType: anomaly?.anomalyType,
            expectedRootCause: anomaly?.eventType
          });
        }
      }
    }
  }

  const events: Array<{
    timestamp: Date;
    eventType: string;
    account: string;
    service: string;
    region: string;
    resourceId: string;
    description: string;
    sourceType: string;
    metadata: Record<string, string | boolean>;
  }> = injectedAnomalies.map((anomaly, index) => {
    const eventTime = new Date(start.getTime() + (anomaly.offsetHours - 1 + index * 0.35) * 60 * 60 * 1000);
    return {
      timestamp: eventTime,
      eventType: anomaly.eventType,
      account: anomaly.account,
      service: anomaly.service,
      region: anomaly.region,
      resourceId: `${anomaly.account}-${anomaly.service}-${anomaly.region}`,
      description: `${anomaly.eventType} on ${anomaly.service} in ${anomaly.account}/${anomaly.region}`,
      sourceType: "synthetic",
      metadata: { source: "synthetic-generator", relatedToInjectedAnomaly: true, anomalyType: anomaly.anomalyType }
    };
  });

  events.push(
    {
      timestamp: new Date(start.getTime() + 24 * 60 * 60 * 1000),
      eventType: "deployment",
      account: "dev",
      service: "compute",
      region: "eu-west-1",
      resourceId: "dev-compute-eu-west-1",
      description: "Routine dev compute deployment",
      sourceType: "synthetic",
      metadata: { source: "synthetic-generator" }
    },
    {
      timestamp: new Date(start.getTime() + 115 * 60 * 60 * 1000),
      eventType: "configuration_change",
      account: "prod",
      service: "storage",
      region: "us-east-1",
      resourceId: "prod-storage-us-east-1",
      description: "Storage lifecycle policy update",
      sourceType: "synthetic",
      metadata: { source: "synthetic-generator" }
    },
    {
      timestamp: new Date(start.getTime() + 117 * 60 * 60 * 1000),
      eventType: "deployment",
      account: "prod",
      service: "compute",
      region: "us-east-1",
      resourceId: "prod-compute-us-east-1",
      description: "Unrelated production compute deployment",
      sourceType: "synthetic",
      metadata: { source: "synthetic-generator", noise: true }
    },
    {
      timestamp: new Date(start.getTime() + 148 * 60 * 60 * 1000),
      eventType: "configuration_change",
      account: "dev",
      service: "network",
      region: "eu-west-1",
      resourceId: "dev-network-eu-west-1",
      description: "Noise event outside the affected dimensions",
      sourceType: "synthetic",
      metadata: { source: "synthetic-generator", noise: true }
    }
  );

  await prisma.billingRecord.createMany({ data: records });
  await prisma.infrastructureEvent.createMany({ data: events });

  return { billingRecords: records.length, infrastructureEvents: events.length };
}
