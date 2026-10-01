import "dotenv/config";
import cors from "cors";
import express from "express";
import { prisma } from "./prisma.js";
import { runAnomalyDetection, runAnomalyTuningExperiment, type DetectorName, type DetectorOptions } from "./services/anomalyService.js";
import { evaluateCurrentRun, type EvaluationMode } from "./services/evaluationService.js";
import { importFocusCsv, importFocusCsvContent, previewFocusMapping } from "./services/focusImportService.js";
import { importAlibabaTraceCsv } from "./services/alibabaTraceImportService.js";
import {
  clearGeneratedDemoData,
  getLastDatasetBuildRun,
  rebuildHybridDemoData,
  resetAndRebuildDemoData
} from "./services/demoDataService.js";
import { buildHybridDataset, getHybridStatus } from "./services/hybridDatasetService.js";
import { runRootCauseAttribution } from "./services/rootCauseService.js";
import { generateSyntheticData } from "./services/syntheticData.js";
import { presentAnomaly, presentAttribution } from "./services/anomalyPresentation.js";

const app = express();
const port = Number(process.env.PORT ?? 4000);

app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "cloud-cost-anomaly-backend" });
});

app.post("/api/data/generate", async (req, res, next) => {
  try {
    res.json(await generateSyntheticData(prisma, {
      seed: typeof req.body?.seed === "number" ? req.body.seed : undefined
    }));
  } catch (error) {
    next(error);
  }
});

function stringQuery(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function dateQuery(value: unknown) {
  const raw = stringQuery(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

app.get("/api/billing-records", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 500), 2000);
    const from = dateQuery(req.query.from);
    const to = dateQuery(req.query.to);
    const records = await prisma.billingRecord.findMany({
      where: {
        account: stringQuery(req.query.account),
        service: stringQuery(req.query.service),
        region: stringQuery(req.query.region),
        sourceType: stringQuery(req.query.sourceType),
        timestamp: from || to ? { gte: from, lte: to } : undefined
      },
      orderBy: { timestamp: "asc" },
      take: limit
    });
    res.json(records);
  } catch (error) {
    next(error);
  }
});

app.get("/api/events", async (req, res, next) => {
  try {
    const from = dateQuery(req.query.from);
    const to = dateQuery(req.query.to);
    const events = await prisma.infrastructureEvent.findMany({
      where: {
        account: stringQuery(req.query.account),
        service: stringQuery(req.query.service),
        region: stringQuery(req.query.region),
        sourceType: stringQuery(req.query.sourceType),
        timestamp: from || to ? { gte: from, lte: to } : undefined
      },
      orderBy: { timestamp: "asc" }
    });
    res.json(events);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dashboard/summary", async (req, res, next) => {
  try {
    const account = stringQuery(req.query.account);
    const service = stringQuery(req.query.service);
    const region = stringQuery(req.query.region);
    const sourceType = stringQuery(req.query.sourceType);
    const severity = stringQuery(req.query.severity);
    const billingWhere = { account, service, region, sourceType };
    const eventWhere = { account, service, region, sourceType };
    const [totalRecords, totalEvents, totalAnomalies] = await Promise.all([
      prisma.billingRecord.count({ where: billingWhere }),
      prisma.infrastructureEvent.count({ where: eventWhere }),
      prisma.anomalyResult.count({
        where: {
          severity,
          billingRecord: billingWhere
        }
      })
    ]);
    res.json({ totalRecords, totalEvents, totalAnomalies });
  } catch (error) {
    next(error);
  }
});

function sourceTypeFromBody(value: unknown) {
  return value === "synthetic" || value === "focus" || value === "hybrid_synthesized" || value === "all" ? value : "all";
}

app.post("/api/anomalies/run", async (req, res, next) => {
  try {
    const detector = req.body?.detector;
    const detectorOptions: DetectorOptions = {
      detector: ["isolation_forest", "ratio_rule", "robust_z", "seasonal_rule", "median_ratio_rule", "dollar_rule"].includes(detector) ? detector as DetectorName : undefined,
      calibrate: req.body?.calibrate === true,
      postFilter: typeof req.body?.postFilter === "boolean" ? req.body.postFilter : undefined,
      alertBudget: typeof req.body?.alertBudget === "number" ? req.body.alertBudget : undefined,
      robustZThreshold: typeof req.body?.robustZThreshold === "number" ? req.body.robustZThreshold : undefined,
      contamination: typeof req.body?.contamination === "number" ? req.body.contamination : undefined,
      nEstimators: typeof req.body?.nEstimators === "number" ? req.body.nEstimators : undefined,
      maxSamples: req.body?.maxSamples === "auto" || typeof req.body?.maxSamples === "number"
        ? req.body.maxSamples
        : undefined,
      randomState: typeof req.body?.randomState === "number" ? req.body.randomState : undefined,
      thresholdPercentile: typeof req.body?.thresholdPercentile === "number" ? req.body.thresholdPercentile : undefined,
      minRelativeIncrease: typeof req.body?.minRelativeIncrease === "number" ? req.body.minRelativeIncrease : undefined,
      minAbsoluteDelta: typeof req.body?.minAbsoluteDelta === "number" ? req.body.minAbsoluteDelta : undefined
    };
    res.json(await runAnomalyDetection(prisma, sourceTypeFromBody(req.body?.sourceType), detectorOptions));
  } catch (error) {
    next(error);
  }
});

app.post("/api/anomalies/tune", async (req, res, next) => {
  try {
    const detectorOptions: DetectorOptions = {
      nEstimators: typeof req.body?.nEstimators === "number" ? req.body.nEstimators : undefined,
      maxSamples: req.body?.maxSamples === "auto" || typeof req.body?.maxSamples === "number"
        ? req.body.maxSamples
        : undefined,
      randomState: typeof req.body?.randomState === "number" ? req.body.randomState : undefined
    };
    const sourceType = sourceTypeFromBody(req.body?.sourceType);
    res.json(await runAnomalyTuningExperiment(
      prisma,
      sourceType === "synthetic" ? "synthetic" : "hybrid_synthesized",
      detectorOptions
    ));
  } catch (error) {
    next(error);
  }
});

app.post("/api/demo/clear-generated-data", async (_req, res, next) => {
  try {
    res.json(await clearGeneratedDemoData(prisma));
  } catch (error) {
    next(error);
  }
});

app.post("/api/demo/rebuild-hybrid", async (req, res, next) => {
  try {
    const { buildRun, hybrid } = await rebuildHybridDemoData(prisma, req.body ?? {});
    res.json({
      status: "ok",
      buildRunId: buildRun.id,
      seed: buildRun.seed,
      hybridBillingRecords: hybrid.baselineRecords,
      injectedScenarios: hybrid.injectedScenarios,
      injectedRecords: hybrid.injectedRecords,
      expectedRootCauseEventIds: hybrid.expectedRootCauseEventIds
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/demo/reset-and-rebuild", async (req, res, next) => {
  try {
    res.json(await resetAndRebuildDemoData(prisma, req.body ?? {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/demo/last-build-run", async (_req, res, next) => {
  try {
    const run = await getLastDatasetBuildRun(prisma);
    if (!run) {
      res.status(404).json({ error: "No dataset build run found." });
      return;
    }
    res.json(run);
    res.json(run);
  } catch (error) {
    next(error);
  }
});

app.get("/api/focus/status", (_req, res) => {
  res.json({
    available: true,
    inputModes: ["filePath", "csvContent"],
    instructions: "Place FOCUS sample CSV files under data/focus-sample/ and call /api/focus/mapping-preview?filePath=data/focus-sample/file.csv before importing."
  });
});

app.get("/api/focus/mapping-preview", async (req, res, next) => {
  try {
    const filePath = stringQuery(req.query.filePath);
    if (!filePath) {
      res.status(400).json({ error: "filePath query parameter is required." });
      return;
    }
    res.json(await previewFocusMapping(filePath));
  } catch (error) {
    next(error);
  }
});

app.post("/api/focus/import", async (req, res, next) => {
  try {
    const filePath = typeof req.body?.filePath === "string" ? req.body.filePath : undefined;
    const csvContent = typeof req.body?.csvContent === "string" ? req.body.csvContent : undefined;
    if (!filePath && !csvContent) {
      res.status(400).json({ error: "filePath or csvContent is required." });
      return;
    }
    res.json(csvContent ? await importFocusCsvContent(prisma, csvContent) : await importFocusCsv(prisma, filePath!));
  } catch (error) {
    next(error);
  }
});

app.get("/api/hybrid/status", async (_req, res, next) => {
  try {
    res.json(await getHybridStatus(prisma));
  } catch (error) {
    next(error);
  }
});

app.post("/api/hybrid/import-alibaba-trace", async (req, res, next) => {
  try {
    const filePath = typeof req.body?.filePath === "string" ? req.body.filePath.trim() : "";
    const focusStartTime = typeof req.body?.focusStartTime === "string" ? req.body.focusStartTime : undefined;
    const focusEndTime = typeof req.body?.focusEndTime === "string" ? req.body.focusEndTime : undefined;
    if (!filePath) {
      res.status(400).json({ error: "filePath is required." });
      return;
    }
    res.json(await importAlibabaTraceCsv(prisma, filePath, focusStartTime, focusEndTime));
  } catch (error) {
    next(error);
  }
});

app.post("/api/hybrid/build", async (req, res, next) => {
  try {
    res.json(await buildHybridDataset(prisma, req.body ?? {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/hybrid/ground-truth", async (_req, res, next) => {
  try {
    res.json(await prisma.groundTruthLabel.findMany({
      where: { sourceDataset: "hybrid_synthesized" },
      include: { billingRecord: true, expectedEvent: true },
      orderBy: { anomalyWindowStart: "asc" }
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/anomalies", async (req, res, next) => {
  try {
    const from = dateQuery(req.query.from);
    const to = dateQuery(req.query.to);
    const account = stringQuery(req.query.account);
    const service = stringQuery(req.query.service);
    const region = stringQuery(req.query.region);
    const sourceType = stringQuery(req.query.sourceType);
    const billingRecordFilter = account || service || region || sourceType ? { account, service, region, sourceType } : undefined;
    const anomalies = await prisma.anomalyResult.findMany({
      where: {
        severity: stringQuery(req.query.severity),
        timestamp: from || to ? { gte: from, lte: to } : undefined,
        billingRecord: billingRecordFilter
      },
      include: { billingRecord: true },
      orderBy: { timestamp: "desc" }
    });
    const labels = await prisma.groundTruthLabel.findMany({
      where: {
        billingRecordId: {
          in: anomalies.map((anomaly) => anomaly.billingRecordId).filter((id): id is string => Boolean(id))
        }
      }
    });
    const labelByRecord = new Map(labels.map((label) => [label.billingRecordId, label]));
    res.json(anomalies.map((anomaly) => presentAnomaly(
      anomaly,
      anomaly.billingRecordId ? labelByRecord.get(anomaly.billingRecordId) : undefined
    )));
  } catch (error) {
    next(error);
  }
});

app.get("/api/anomalies/:id", async (req, res, next) => {
  try {
    const anomaly = await prisma.anomalyResult.findUnique({
      where: { id: req.params.id },
      include: { billingRecord: true, rootCauseCandidates: { include: { infrastructureEvent: true }, orderBy: { score: "desc" } } }
    });
    if (!anomaly) {
      res.status(404).json({ error: "Anomaly not found" });
      return;
    }
    const label = anomaly.billingRecordId
      ? await prisma.groundTruthLabel.findFirst({ where: { billingRecordId: anomaly.billingRecordId } })
      : null;
    res.json(presentAnomaly(anomaly, label));
  } catch (error) {
    next(error);
  }
});

app.get("/api/evaluation", async (req, res, next) => {
  try {
    const requested = stringQuery(req.query.mode);
    const mode: EvaluationMode =
      requested === "synthetic" || requested === "focus" || requested === "hybrid_synthesized" ? requested : "all";
    const from = dateQuery(req.query.from);
    const to = dateQuery(req.query.to);
    res.json(await evaluateCurrentRun(prisma, mode, from && to ? { window: { from, to } } : {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/root-cause/run/:anomalyId", async (req, res, next) => {
  try {
    const anomaly = await prisma.anomalyResult.findUnique({
      where: { id: req.params.anomalyId },
      include: { billingRecord: true }
    });
    res.json(presentAttribution(anomaly?.billingRecord, await runRootCauseAttribution(prisma, req.params.anomalyId)));
  } catch (error) {
    next(error);
  }
});

app.get("/api/root-cause/:anomalyId", async (req, res, next) => {
  try {
    const anomaly = await prisma.anomalyResult.findUnique({
      where: { id: req.params.anomalyId },
      include: { billingRecord: true }
    });
    if (!anomaly) {
      res.status(404).json({ error: "Anomaly not found" });
      return;
    }
    const candidates = await prisma.rootCauseCandidate.findMany({
      where: { anomalyResultId: req.params.anomalyId },
      include: { infrastructureEvent: true },
      orderBy: { score: "desc" }
    });
    res.json(presentAttribution(anomaly.billingRecord, {
      attributionStatus: anomaly.billingRecord?.sourceType === "focus"
        ? "not_available"
        : candidates.length ? "available" : "no_candidates",
      message: anomaly.billingRecord?.sourceType === "focus"
        ? "Root-cause attribution is not available because FOCUS data is billing-only and no matching infrastructure events were provided."
        : candidates.length ? undefined
          : anomaly.billingRecord?.sourceType === "hybrid_synthesized"
            ? "No matching hybrid root-cause event was found for this anomaly. Try another detected true-positive anomaly or widen the attribution time window."
            : "No matching synthetic infrastructure event was found for this anomaly.",
      candidates
    }));
  } catch (error) {
    next(error);
  }
});

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(error.message === "Anomaly not found" ? 404 : 500).json({ error: error.message });
});

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
