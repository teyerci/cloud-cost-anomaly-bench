import { useEffect, useRef, useState } from "react";
import { AnomalyTable } from "../components/AnomalyTable";
import { CostTimeSeriesChart } from "../components/CostTimeSeriesChart";
import { EventTimeline } from "../components/EventTimeline";
import { EvaluationPanel } from "../components/EvaluationPanel";
import { RootCausePanel } from "../components/RootCausePanel";
import {
  fetchAnomalies,
  fetchBillingRecords,
  fetchBillingWindow,
  fetchDashboardSummary,
  fetchEvaluation,
  fetchEvents,
  fetchHybridStatus,
  fetchRootCause,
  importAlibabaTrace,
  importFocusCsv,
  buildHybridDataset,
  previewFocusMapping,
  resetAndRebuildDemoData,
  runAnomalyDetection,
  runDataGeneration,
  runRootCause
} from "../services/api";
import { mockAnomalies, mockBillingRecords, mockEvents } from "../services/mockData";
import type {
  AnomalyResult,
  BillingRecord,
  DashboardFilters,
  DashboardSummary,
  DemoRebuildSummary,
  EvaluationMetrics,
  FocusImportSummary,
  FocusPreview,
  AlibabaTraceImportSummary,
  AttributionUiStatus,
  HybridBuildSummary,
  HybridStatus,
  InfrastructureEvent,
  RootCauseCandidate
} from "../types";

const emptyFilters: DashboardFilters = { account: "", service: "", region: "", severity: "", sourceType: "" };

function uniqueValues<T>(items: T[], selector: (item: T) => string | undefined) {
  return [...new Set(items.map(selector).filter((value): value is string => Boolean(value)))].sort();
}

export function Dashboard() {
  const [records, setRecords] = useState<BillingRecord[]>(mockBillingRecords);
  const [chartRecords, setChartRecords] = useState<BillingRecord[]>(mockBillingRecords);
  const [events, setEvents] = useState<InfrastructureEvent[]>(mockEvents);
  const [anomalies, setAnomalies] = useState<AnomalyResult[]>(mockAnomalies);
  const [selectedAnomaly, setSelectedAnomaly] = useState<AnomalyResult | undefined>(mockAnomalies[0]);
  const [rootCauses, setRootCauses] = useState<RootCauseCandidate[]>([]);
  const [filters, setFilters] = useState<DashboardFilters>(emptyFilters);
  const [evaluation, setEvaluation] = useState<EvaluationMetrics | undefined>();
  const [summary, setSummary] = useState<DashboardSummary>({
    totalRecords: 0,
    totalEvents: 0,
    totalAnomalies: 0
  });
  const [focusFilePath, setFocusFilePath] = useState("data/focus-sample/focus_sample_100000.csv");
  const [focusPreview, setFocusPreview] = useState<FocusPreview | undefined>();
  const [focusSummary, setFocusSummary] = useState<FocusImportSummary | undefined>();
  const [alibabaFilePath, setAlibabaFilePath] = useState("");
  const [alibabaSummary, setAlibabaSummary] = useState<AlibabaTraceImportSummary | undefined>();
  const [hybridSummary, setHybridSummary] = useState<HybridBuildSummary | undefined>();
  const [hybridStatus, setHybridStatus] = useState<HybridStatus | undefined>();
  const [demoFocusPath, setDemoFocusPath] = useState("data/focus-sample/focus_sample_100000.csv");
  const [demoAlibabaPath, setDemoAlibabaPath] = useState("data/alibaba/openb_pod_list_default.csv");
  const [demoSeed, setDemoSeed] = useState(42);
  const [demoScenarios, setDemoScenarios] = useState(50);
  const [demoTimeWindowHours, setDemoTimeWindowHours] = useState(4);
  const [demoMinBaselineCost, setDemoMinBaselineCost] = useState(1);
  const [demoCostMultiplierMin, setDemoCostMultiplierMin] = useState(3);
  const [demoCostMultiplierMax, setDemoCostMultiplierMax] = useState(6);
  const [demoRunDetection, setDemoRunDetection] = useState(true);
  const [demoRunAttribution, setDemoRunAttribution] = useState(true);
  const [demoSummary, setDemoSummary] = useState<DemoRebuildSummary | undefined>();
  const [attributionStatus, setAttributionStatus] = useState<AttributionUiStatus>("not_run");
  const [attributionMessage, setAttributionMessage] = useState("");
  const [status, setStatus] = useState("Using mock data until the backend responds.");
  const chartRef = useRef<HTMLDivElement>(null);

  async function refresh(nextFilters = filters) {
    const [nextRecords, nextEvents, nextAnomalies, nextSummary] = await Promise.all([
      fetchBillingRecords(nextFilters),
      fetchEvents(nextFilters),
      fetchAnomalies(nextFilters),
      fetchDashboardSummary(nextFilters)
    ]);
    setRecords(nextRecords);
    const firstAnomaly = nextAnomalies[0];
    if (firstAnomaly?.billingRecord) {
      const windowRecords = await fetchBillingWindow(firstAnomaly).catch(() => []);
      setChartRecords(windowRecords.length ? windowRecords : [firstAnomaly.billingRecord!]);
    } else {
      setChartRecords(nextRecords);
    }
    setEvents(nextEvents);
    setAnomalies(nextAnomalies);
    setSummary(nextSummary);
    setSelectedAnomaly(nextAnomalies[0]);
    setAttributionStatus("not_run");
    setAttributionMessage("");
    setStatus("Connected to backend.");
  }

  useEffect(() => {
    refresh().catch(() => setStatus("Backend unavailable. Showing mock data."));
    fetchHybridStatus().then(setHybridStatus).catch(() => undefined);
  }, []);

  async function handleGenerate() {
    setStatus("Generating synthetic data...");
    await runDataGeneration();
    const nextFilters = { ...emptyFilters, sourceType: "synthetic" };
    setFilters(nextFilters);
    await refresh(nextFilters);
    setEvaluation(undefined);
    setStatus("Synthetic data ready. Source filter set to synthetic; click Run Detection.");
  }

  async function handleRunAnomalies() {
    if (!filters.sourceType) {
      setStatus("Select synthetic, focus, or hybrid_synthesized before running detection.");
      return;
    }
    setStatus("Running anomaly detection...");
    const mode = filters.sourceType;
    await runAnomalyDetection(mode);
    await refresh(filters);
    setRootCauses([]);
    setAttributionStatus("not_run");
    setAttributionMessage("");
    setEvaluation(await fetchEvaluation(mode));
    setStatus("Anomaly detection complete.");
  }

  async function handleRunRootCause() {
    if (!selectedAnomaly) return;
    setStatus("Running root-cause attribution...");
    setAttributionStatus("loading");
    setAttributionMessage("");
    try {
      const result = await runRootCause(selectedAnomaly.id);
      setRootCauses(result.candidates);
      setAttributionStatus(result.attributionStatus);
      setAttributionMessage(result.message ?? "");
      setStatus("Root-cause attribution complete.");
    } catch {
      setRootCauses([]);
      setAttributionStatus("error");
      setAttributionMessage("Root-cause attribution failed. Check the backend log and try again.");
      setStatus("Root-cause attribution failed.");
    }
  }

  async function handleSelect(anomaly: AnomalyResult) {
    setSelectedAnomaly(anomaly);
    setRootCauses([]);
    setAttributionStatus("loading");
    setAttributionMessage("");
    setChartRecords(anomaly.billingRecord ? [anomaly.billingRecord] : []);
    fetchBillingWindow(anomaly)
      .then((windowRecords) => setChartRecords(windowRecords.length ? windowRecords : anomaly.billingRecord ? [anomaly.billingRecord] : []))
      .catch(() => setChartRecords(anomaly.billingRecord ? [anomaly.billingRecord] : []));
    requestAnimationFrame(() => chartRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }));
    fetchRootCause(anomaly.id)
      .then((result) => {
        setRootCauses(result.candidates);
        setAttributionStatus(result.attributionStatus);
        setAttributionMessage(result.message ?? "");
      })
      .catch(() => {
        setRootCauses([]);
        setAttributionStatus("error");
        setAttributionMessage("Could not load stored root-cause candidates.");
      });
  }

  async function handleFilterChange(key: keyof DashboardFilters, value: string) {
    const nextFilters = { ...filters, [key]: value };
    setFilters(nextFilters);
    await refresh(nextFilters);
    if (key === "sourceType") {
      if (value) {
        fetchEvaluation(value).then(setEvaluation).catch(() => setEvaluation(undefined));
      } else {
        setEvaluation(undefined);
      }
    }
  }

  async function handleFocusPreview() {
    setStatus("Previewing FOCUS mapping...");
    const preview = await previewFocusMapping(focusFilePath);
    setFocusPreview(preview);
    setStatus("FOCUS mapping preview ready.");
  }

  async function handleFocusImport() {
    setStatus("Importing FOCUS CSV...");
    const summary = await importFocusCsv(focusFilePath);
    setFocusSummary(summary);
    setHybridStatus(await fetchHybridStatus());
    await refresh();
    setStatus(`FOCUS import complete: ${summary.insertedRows} rows appended.`);
  }

  async function handleAlibabaImport() {
    setStatus("Importing Alibaba pod trace...");
    const summary = await importAlibabaTrace(alibabaFilePath);
    setAlibabaSummary(summary);
    setHybridStatus(await fetchHybridStatus());
    setStatus(`Alibaba trace import complete: ${summary.insertedEvents} events inserted.`);
  }

  async function handleHybridBuild() {
    setStatus("Building synthesized hybrid dataset...");
    const summary = await buildHybridDataset();
    setHybridSummary(summary);
    setHybridStatus(await fetchHybridStatus());
    const nextFilters = { ...filters, sourceType: "hybrid_synthesized" };
    setFilters(nextFilters);
    await refresh(nextFilters);
    setEvaluation(undefined);
    setStatus(`Hybrid dataset ready: ${summary.injectedScenarios} anomaly scenarios injected.`);
  }

  async function handleDemoResetRebuild() {
    if (!Number.isFinite(demoSeed)) {
      setStatus("Seed must be numeric.");
      return;
    }
    if (!Number.isFinite(demoScenarios) || demoScenarios < 1 || demoScenarios > 200) {
      setStatus("Injected scenarios must be between 1 and 200.");
      return;
    }
    if (!Number.isFinite(demoTimeWindowHours) || demoTimeWindowHours < 1 || demoTimeWindowHours > 24) {
      setStatus("Time window hours must be between 1 and 24.");
      return;
    }
    if (!Number.isFinite(demoMinBaselineCost) || demoMinBaselineCost < 0) {
      setStatus("Minimum baseline cost must be 0 or greater.");
      return;
    }
    if (!Number.isFinite(demoCostMultiplierMin) || demoCostMultiplierMin < 1) {
      setStatus("Minimum cost multiplier must be at least 1.");
      return;
    }
    if (!Number.isFinite(demoCostMultiplierMax) || demoCostMultiplierMax < demoCostMultiplierMin) {
      setStatus("Maximum cost multiplier must be greater than or equal to the minimum multiplier.");
      return;
    }
    setStatus("Resetting and rebuilding demo data...");
    const summary = await resetAndRebuildDemoData({
      focusFilePath: demoFocusPath,
      alibabaFilePath: demoAlibabaPath,
      seed: demoSeed,
      numScenarios: demoScenarios,
      timeWindowHours: demoTimeWindowHours,
      minBaselineCost: demoMinBaselineCost,
      costMultiplierMin: demoCostMultiplierMin,
      costMultiplierMax: demoCostMultiplierMax,
      runDetection: demoRunDetection,
      runAttributionForTruePositives: demoRunAttribution
    });
    setDemoSummary(summary);
    setHybridStatus(await fetchHybridStatus());
    const nextFilters = { ...emptyFilters, sourceType: "hybrid_synthesized" };
    setFilters(nextFilters);
    await refresh(nextFilters);
    setEvaluation(demoRunDetection ? await fetchEvaluation("hybrid_synthesized") : undefined);
    setStatus(`Demo data rebuilt with seed ${summary.seed}: ${summary.injectedScenarios} scenarios, ${summary.hybridBillingRecords.toLocaleString()} hybrid records.`);
  }

  const accountOptions = uniqueValues(records, (record) => record.account);
  const serviceOptions = uniqueValues(records, (record) => record.service);
  const regionOptions = uniqueValues(records, (record) => record.region);

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>cloud-cost-anomaly</h1>
          <p>Automated cloud cost anomaly detection and root-cause attribution prototype.</p>
        </div>
        <div className="actions">
          <button onClick={handleGenerate}>Generate Data</button>
          <button className="primary" onClick={handleRunAnomalies}>Run Detection</button>
        </div>
      </header>

      <div className="status">{status}</div>

      <section className="filters" aria-label="Dashboard filters">
        <select value={filters.account} onChange={(event) => handleFilterChange("account", event.target.value)}>
          <option value="">All accounts</option>
          {accountOptions.map((account) => <option key={account} value={account}>{account}</option>)}
        </select>
        <select value={filters.service} onChange={(event) => handleFilterChange("service", event.target.value)}>
          <option value="">All services</option>
          {serviceOptions.map((service) => <option key={service} value={service}>{service}</option>)}
        </select>
        <select value={filters.region} onChange={(event) => handleFilterChange("region", event.target.value)}>
          <option value="">All regions</option>
          {regionOptions.map((region) => <option key={region} value={region}>{region}</option>)}
        </select>
        <select value={filters.severity} onChange={(event) => handleFilterChange("severity", event.target.value)}>
          <option value="">All severities</option>
          <option value="critical">critical</option>
          <option value="high">high</option>
          <option value="medium">medium</option>
        </select>
        <select value={filters.sourceType} onChange={(event) => handleFilterChange("sourceType", event.target.value)}>
          <option value="">All sources (view only)</option>
          <option value="synthetic">synthetic</option>
          <option value="focus">focus</option>
          <option value="hybrid_synthesized">hybrid_synthesized</option>
        </select>
      </section>

      <section className="panel focus-panel">
        <div className="panel-header">
          <h2>FOCUS Sample Data Import</h2>
          <span>billing normalization</span>
        </div>
        <div className="focus-controls">
          <input
            value={focusFilePath}
            onChange={(event) => setFocusFilePath(event.target.value)}
            placeholder="data/focus-sample/focus_sample_100000.csv"
          />
          <button onClick={handleFocusPreview}>Preview Mapping</button>
          <button className="primary" onClick={handleFocusImport}>Import FOCUS CSV</button>
        </div>
        <p className="focus-warning">
          FOCUS data is billing data only, so F1 and root-cause evaluation are unavailable. Import appends rows; do not re-import the same file unless duplicates are intended.
        </p>
        <div className="focus-output">
          {focusPreview && (
            <div>
              <h3>Detected Columns</h3>
              <p>{focusPreview.detectedColumns.join(", ") || "No columns detected"}</p>
              <h3>Proposed Mapping</h3>
              <pre>{JSON.stringify(focusPreview.mappedColumns, null, 2)}</pre>
            </div>
          )}
          {focusSummary && (
            <div>
              <h3>Import Summary</h3>
              <p>{focusSummary.insertedRows} inserted, {focusSummary.skippedRows} skipped from {focusSummary.totalRows} rows.</p>
              {focusSummary.validationErrors.length > 0 && <pre>{focusSummary.validationErrors.slice(0, 10).join("\n")}</pre>}
            </div>
          )}
        </div>
      </section>

      <section className="panel focus-panel">
        <div className="panel-header">
          <h2>Hybrid FOCUS + Alibaba Trace Dataset</h2>
          <span>synthesized ground truth</span>
        </div>
        <div className="focus-controls">
          <input
            value={alibabaFilePath}
            onChange={(event) => setAlibabaFilePath(event.target.value)}
            placeholder="data/alibaba/openb_pod_list_default.csv"
          />
          <button onClick={handleAlibabaImport}>Import Alibaba Trace</button>
          <button className="primary" onClick={handleHybridBuild}>Build Hybrid Dataset</button>
        </div>
        <p className="focus-warning">
          Hybrid mode uses FOCUS billing data and Alibaba trace-derived workload events with synthetic injection. It is for controlled evaluation and does not represent real causality between the two public datasets.
        </p>
        <div className="hybrid-stats">
          <span>Alibaba Trace Events Imported: <strong>{hybridStatus?.importedEvents ?? alibabaSummary?.insertedEvents ?? 0}</strong></span>
          <span>Injected Root-Cause Scenarios: <strong>{hybridStatus?.hybridEvents ?? hybridSummary?.injectedScenarios ?? 0}</strong></span>
          <span>Labeled Injected Records: <strong>{hybridStatus?.groundTruthLabels ?? hybridSummary?.injectedRecords ?? 0}</strong></span>
          <span>Hybrid Billing Records: <strong>{hybridStatus?.hybridRecords ?? hybridSummary?.baselineRecords ?? 0}</strong></span>
          {alibabaSummary && (
            <span>
              Timeline compression: <strong>{alibabaSummary.timeCompressionRatio.toFixed(2)}x</strong>
              {" "}({alibabaSummary.traceDurationDays.toFixed(1)} days into {alibabaSummary.projectedDurationDays.toFixed(1)} days)
            </span>
          )}
        </div>
        {alibabaSummary?.validationErrors.length ? (
          <pre>{alibabaSummary.validationErrors.slice(0, 10).join("\n")}</pre>
        ) : null}
      </section>

      <section className="panel focus-panel">
        <div className="panel-header">
          <h2>Reset and Rebuild Demo Data</h2>
          <span>reproducible seed</span>
        </div>
        <p className="focus-warning">
          This clears and recreates demo/imported/generated data. It does not drop the database schema.
        </p>
        <div className="focus-controls demo-controls">
          <input value={demoFocusPath} onChange={(event) => setDemoFocusPath(event.target.value)} placeholder="data/focus-sample/focus_sample_100000.csv" />
          <input value={demoAlibabaPath} onChange={(event) => setDemoAlibabaPath(event.target.value)} placeholder="data/alibaba/openb_pod_list_default.csv" />
          <input type="number" value={demoSeed} onChange={(event) => setDemoSeed(Number(event.target.value))} title="Seed" />
          <label className="field-label">
            Injected scenarios
            <input type="number" min={1} max={200} value={demoScenarios} onChange={(event) => setDemoScenarios(Number(event.target.value))} title="Number of injected scenarios" />
            <small>Recommended range: 40-60 for stable evaluation. Higher values create more injected ground-truth scenarios but may make the dataset more synthetic.</small>
          </label>
          <label className="field-label">
            Time window hours
            <input type="number" min={1} max={24} value={demoTimeWindowHours} onChange={(event) => setDemoTimeWindowHours(Number(event.target.value))} />
          </label>
          <label className="field-label">
            Min baseline cost
            <input type="number" min={0} step={0.1} value={demoMinBaselineCost} onChange={(event) => setDemoMinBaselineCost(Number(event.target.value))} />
          </label>
          <label className="field-label">
            Cost multiplier min
            <input type="number" min={1} step={0.1} value={demoCostMultiplierMin} onChange={(event) => setDemoCostMultiplierMin(Number(event.target.value))} />
          </label>
          <label className="field-label">
            Cost multiplier max
            <input type="number" min={1} step={0.1} value={demoCostMultiplierMax} onChange={(event) => setDemoCostMultiplierMax(Number(event.target.value))} />
          </label>
          <label className="checkbox-label">
            <input type="checkbox" checked={demoRunDetection} onChange={(event) => setDemoRunDetection(event.target.checked)} />
            Run detection
          </label>
          <label className="checkbox-label">
            <input type="checkbox" checked={demoRunAttribution} onChange={(event) => setDemoRunAttribution(event.target.checked)} />
            Attribute true positives
          </label>
          <button className="primary" onClick={handleDemoResetRebuild}>Reset and Rebuild Demo Data</button>
        </div>
        {demoSummary && (
          <div className="hybrid-stats demo-summary">
            <span>Build Run: <strong>{demoSummary.buildRunId}</strong></span>
            <span>Seed: <strong>{demoSummary.seed}</strong></span>
            <span>Requested Scenarios: <strong>{demoSummary.numScenarios}</strong></span>
            <span>Window Hours: <strong>{demoSummary.timeWindowHours}</strong></span>
            <span>Min Baseline: <strong>${demoSummary.minBaselineCost.toFixed(2)}</strong></span>
            <span>Multiplier Range: <strong>{demoSummary.costMultiplierMin.toFixed(1)}x-{demoSummary.costMultiplierMax.toFixed(1)}x</strong></span>
            <span>FOCUS Rows: <strong>{demoSummary.focusImportedRows.toLocaleString()}</strong></span>
            <span>Alibaba Events: <strong>{demoSummary.alibabaImportedEvents.toLocaleString()}</strong></span>
            <span>Hybrid Records: <strong>{demoSummary.hybridBillingRecords.toLocaleString()}</strong></span>
            <span>Actual Injected Scenarios: <strong>{demoSummary.injectedScenarios}</strong></span>
            <span>Labeled Injected Records: <strong>{demoSummary.labeledInjectedRecords ?? demoSummary.injectedRecords ?? "N/A"}</strong></span>
            {demoSummary.metrics && (
              <span>
                F1: <strong>{(demoSummary.metrics.f1Score ?? demoSummary.metrics.f1)?.toFixed(3) ?? "N/A"}</strong>
                {" "}Precision: <strong>{demoSummary.metrics.precision?.toFixed(3) ?? "N/A"}</strong>
                {" "}Recall: <strong>{demoSummary.metrics.recall?.toFixed(3) ?? "N/A"}</strong>
              </span>
            )}
          </div>
        )}
      </section>

      <section className="metrics">
        <div title="All billing records matching the current account, service, region, and source filters. The chart displays at most 2,000.">
          <span>Matching Records</span>
          <strong>{summary.totalRecords.toLocaleString()}</strong>
          <small>{records.length.toLocaleString()} displayed</small>
        </div>
        <div title="Infrastructure events matching the current filters. FOCUS-only data normally has no events.">
          <span>{filters.sourceType === "hybrid_synthesized" ? "Injected Root-Cause Events" : "Infrastructure Events"}</span>
          <strong>{summary.totalEvents.toLocaleString()}</strong>
          <small>matching current filters</small>
        </div>
        <div title="Detected anomaly results matching the current filters.">
          <span>Detected Anomalies</span>
          <strong>{summary.totalAnomalies.toLocaleString()}</strong>
          <small>matching current filters</small>
        </div>
        <div>
          <span>Source F1 Score</span>
          <strong>
            {evaluation?.anomalyMetricsAvailable === false
              ? "N/A"
              : evaluation?.f1Score !== undefined ? evaluation.f1Score.toFixed(2) : "--"}
          </strong>
          <small>
            {evaluation?.anomalyMetricsAvailable === false
              ? "billing only; no ground truth"
              : filters.sourceType || "select a source"}
          </small>
        </div>
      </section>
      <p className="f1-note">
        F1-score is available only for synthetic or hybrid_synthesized datasets with ground-truth anomaly labels. For FOCUS-only billing data, F1 is N/A.
      </p>

      <EvaluationPanel evaluation={evaluation} />

      <div ref={chartRef}>
        <CostTimeSeriesChart records={chartRecords} anomalies={anomalies} selectedAnomaly={selectedAnomaly} />
      </div>

      <section className="dashboard-grid">
        <div className="main-column">
          <AnomalyTable anomalies={anomalies} selectedId={selectedAnomaly?.id} onSelect={handleSelect} />
          <EventTimeline events={events} />
        </div>
        <RootCausePanel
          anomaly={selectedAnomaly}
          candidates={rootCauses}
          attributionStatus={attributionStatus}
          attributionMessage={attributionMessage}
          onRun={handleRunRootCause}
        />
      </section>
    </main>
  );
}
