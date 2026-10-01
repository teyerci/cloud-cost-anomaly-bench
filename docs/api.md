# API

Base URL: `http://localhost:4000/api`

## Health

`GET /health`

Returns backend status.

## Synthetic Data

`POST /data/generate`

Creates normal billing records, injected anomalies, and infrastructure events. Existing prototype data is cleared first. Optional body: `{ "seed": 42 }`.

## Demo Rebuild

`POST /demo/reset-and-rebuild`

Clears demo/imported/generated records without dropping the schema, re-imports FOCUS, re-imports Alibaba trace events, builds deterministic `hybrid_synthesized`, and optionally runs detection plus true-positive attribution.

```json
{
  "focusFilePath": "data/focus-sample/focus_sample_100000.csv",
  "alibabaFilePath": "data/alibaba/openb_pod_list_default.csv",
  "seed": 42,
  "numScenarios": 50,
  "timeWindowHours": 4,
  "minBaselineCost": 1.0,
  "costMultiplierMin": 3,
  "costMultiplierMax": 6,
  "attributionSetting": "realistic",
  "distractorsPerScenario": 3,
  "eventTimeJitterHours": 1,
  "dimensionNoiseRate": 0.3,
  "runDetection": true,
  "runAttributionForTruePositives": true
}
```

`attributionSetting` is `realistic` (default) or `oracle`. In `realistic`, the true event is jittered up to `eventTimeJitterHours` before onset, uses the Alibaba pod ID as its resource, loses its region with probability `dimensionNoiseRate`, and competes with `distractorsPerScenario` same-account/service distractor events. `oracle` defaults all three to 0 and stamps the true event with the billing record's dimensions at onset. The same fields are accepted by `POST /hybrid/build` and `POST /demo/rebuild-hybrid`.

Response includes the selected parameters plus `buildRunId`, imported FOCUS rows, imported Alibaba events, hybrid record count, actual injected scenarios, labeled injected records, deterministic expected root-cause event IDs, optional `detectionRunId`, and precision/recall/F1/confusion metrics when detection runs.

Example response fields:

```json
{
  "status": "ok",
  "seed": 42,
  "numScenarios": 50,
  "timeWindowHours": 4,
  "minBaselineCost": 1,
  "costMultiplierMin": 3,
  "costMultiplierMax": 6,
  "focusImportedRows": 100000,
  "alibabaImportedEvents": 39909,
  "hybridBillingRecords": 100000,
  "injectedScenarios": 50,
  "labeledInjectedRecords": 124,
  "metrics": {
    "precision": 0.55,
    "recall": 0.21,
    "f1Score": 0.30
  }
}
```

### Configurable Hybrid Rebuild Parameters

- `numScenarios` controls how many Alibaba-derived events are selected for injected root-cause scenarios. Recommended range: 40-60 for stable project evaluation.
- `seed` makes the rebuild deterministic when files and config match.
- `minBaselineCost` prevents injection into tiny baseline-cost records.
- `timeWindowHours` controls how long each injected incident lasts.
- `costMultiplierMin` and `costMultiplierMax` control cost increase magnitude.
- `runDetection` and `runAttributionForTruePositives` control optional evaluation work after rebuilding.

`POST /demo/clear-generated-data`

Deletes `synthetic`, `focus`, and `hybrid_synthesized` billing rows; `synthetic`, `alibaba_trace`, and `hybrid_synthesized` events; anomaly results; root-cause candidates; detection runs; and dataset build runs. It does not drop the database schema.

`POST /demo/rebuild-hybrid`

Assumes FOCUS and Alibaba rows already exist. Clears only hybrid synthesized rows/results and rebuilds `hybrid_synthesized` using seed/config.

`GET /demo/last-build-run`

Returns the latest `DatasetBuildRun` metadata, including seed, file paths, scenario count, baseline threshold, imported counts, hybrid record count, and deterministic expected root-cause event IDs.

## Billing Records

`GET /billing-records`

Optional query:

- `limit`: maximum records to return, capped at 2000
- `account`, `service`, `region`, `sourceType`: dimension/source filters
- `from`, `to`: ISO timestamp range filters

## Events

`GET /events`

Returns infrastructure events ordered by timestamp. Supports `account`, `service`, `region`, `from`, and `to` filters.

## Anomalies

`POST /anomalies/run`

Runs the Python detector through the backend and stores anomaly results.

Optional JSON body:

```json
{
  "sourceType": "synthetic",
  "detector": "isolation_forest",
  "calibrate": false,
  "postFilter": true,
  "alertBudget": 90,
  "robustZThreshold": 3.5,
  "contamination": 0.03,
  "nEstimators": 300,
  "maxSamples": "auto",
  "randomState": 42,
  "thresholdPercentile": 99,
  "minRelativeIncrease": 2.5,
  "minAbsoluteDelta": 1.0
}
```

`sourceType` may be `synthetic`, `focus`, `hybrid_synthesized`, or `all`. The default is `all`. Hybrid defaults are stricter than the generic detector: contamination `0.01`, threshold percentile `p99`, minimum relative increase `2.5x`, and minimum absolute delta `$1.00`.

`detector` is `isolation_forest` (default), `ratio_rule` (post-filter only), or `robust_z` (robust z-score ≥ `robustZThreshold` and delta ≥ `minAbsoluteDelta`). `calibrate: true` runs the label-assisted grid and applies its best-F1 configuration to the same records; results are then an in-sample upper bound. Calibration is off by default. For `isolation_forest`, `postFilter: false` makes the model score alone decide: with `alertBudget` the top-k rows are flagged, otherwise the model's own contamination threshold is used. The experiment runner also passes an evaluation window so that calibration only sees one part of the timeline; this is not exposed on the HTTP endpoint.

`POST /anomalies/tune`

Runs a labeled tuning experiment without storing anomaly rows. It is intended for `hybrid_synthesized` or `synthetic` data and returns every tested configuration plus the best-F1 and best precision-with-recall-50% choices.

`GET /anomalies`

Returns stored anomalies with linked billing records, nonnegative expected/actual costs, and ground-truth/true-positive/false-positive fields for labeled sources. Supports `account`, `service`, `region`, `sourceType`, `severity`, `from`, and `to`.

`GET /anomalies/:id`

Returns one anomaly with its billing record and root-cause candidates.

## Evaluation

`GET /evaluation?mode=hybrid_synthesized[&from=<ISO>&to=<ISO>]`

With `from` and `to`, only records, detections, and labels in `[from, to)` are evaluated.

Synthetic and hybrid modes report the detector and its parameters, whether calibration was used, confusion matrix, record-level precision/recall/F1, Top-20 precision, scenario recall (`detectedScenarios / injectedScenarios`), per-shape recall (`shapeRecall.spike`, `shapeRecall.drift`), and root-cause metrics: `rootCauseTop1Accuracy`, `rootCauseTop3Accuracy`, and `rootCauseMrr` (exact expected event ID over the full candidate pool, ties broken uniformly at random), `rootCauseTypeTop1Accuracy` (event type only, reported separately), `meanCandidatesPerDetection`, and `endToEndAttributionCoverage` (incidents whose first detected row ranks the expected event first / all incidents). `attribution` holds row-level and incident-level Top-1/Top-3/MRR for the full scorer, five ablations, and nearest-in-time, event-type-only, dimension-only, and random baselines, plus a region-dropped breakdown. When calibration runs, it evaluates threshold percentiles p98, p98.5, p99, p99.5; contamination values 0.01, 0.015, 0.02, and 0.03; minimum relative increases 2.0, 2.5, and 3.0; and minimum absolute deltas 0.5, 1.0, and 2.0, and stores the best-F1 configuration.

Operational post-filtering removes statistically unusual but low-impact changes. Hybrid defaults are `actualCost >= expectedCost * 2.5` and `actualCost - expectedCost >= 1.00`; generic defaults are `2.0` and `0.50`. FOCUS reports records, detections, and score distribution; F1 and root-cause accuracy are N/A.

Root-cause metrics are evaluated only for true-positive detections with injected ground truth. Non-injection alerts are attributed like any other detection but are not counted as correct or incorrect attribution results.

## FOCUS Sample Data Support

FOCUS sample data is an additional billing-data input for validating normalization with a realistic vendor-neutral cost schema. It does not replace synthetic data for full anomaly and root-cause evaluation because FOCUS billing records do not include injected labels or infrastructure events by themselves.

`GET /focus/status`

Returns whether FOCUS import support is available and basic usage instructions.

`GET /focus/mapping-preview?filePath=data/focus-sample/focus_sample_100000.csv`

Reads the CSV header and first five rows, proposes a FOCUS-to-BillingRecord mapping, and does not insert data.

`POST /focus/import`

Imports normalized FOCUS billing rows into `BillingRecord`.

JSON body:

```json
{
  "filePath": "data/focus-sample/focus_sample_100000.csv"
}
```

The import also accepts `csvContent` for callers that already have uploaded CSV content.

Response summary:

- `totalRows`
- `insertedRows`
- `skippedRows`
- `validationErrors`
- `detectedColumns`
- `mappedColumns`

## Hybrid FOCUS + Alibaba Trace Evaluation

FOCUS supplies billing-only baseline records. Alibaba supplies workload/resource traces from a different environment. The API projects Alibaba relative timestamps onto the FOCUS timeline and injects controlled anomalies for evaluation. Injection is aligned to Alibaba trace-derived workload event types and restricted to compatible compute/container/GPU billing services with known regions and meaningful baselines. Alibaba-derived root-cause labels exist only for injected hybrid anomalies. False-positive detections are labeled normal and do not have ground-truth Alibaba root causes.

`GET /hybrid/status`

Returns counts for FOCUS records, imported Alibaba events, hybrid records/events, and ground-truth labels.

`POST /hybrid/import-alibaba-trace`

```json
{
  "filePath": "data/alibaba/openb_pod_list_default.csv",
  "focusStartTime": "2025-01-01T00:00:00.000Z",
  "focusEndTime": "2025-01-31T23:00:00.000Z"
}
```

Both time overrides are optional. By default, the earliest and latest imported FOCUS billing timestamps define the target range. The importer linearly compresses the complete Alibaba trace range into that interval, preserving event order and relative spacing. Invalid rows are skipped and returned as validation errors.

The response includes `traceDurationDays`, `projectedDurationDays`, `timeCompressionRatio`, and `alignmentMode: "compressed_to_focus_range"`. This projection is synthetic and does not imply real synchronization.

Import replaces previous `alibaba_trace` events and inserts the generated events in bounded batches, so re-importing applies the current projection without accumulating duplicate raw trace events.

`POST /hybrid/build`

```json
{
  "focusSourceType": "focus",
  "seed": 42,
  "numScenarios": 50,
  "timeWindowHours": 4,
  "minBaselineCost": 1.0,
  "costMultiplierMin": 3,
  "costMultiplierMax": 6
}
```

Creates a `hybrid_synthesized` copy of the FOCUS baseline, synthesized events, injected costs/usage, and ground-truth labels. The builder avoids near-zero/insufficient-history baselines, requires baseline cost at least `$1.00`, skips missing/null regions, restricts injection to compatible compute/container/GPU services, avoids unrelated services such as Datadog, preserves original cost, and stores expected root-cause event metadata. Defaults inject around 50 root-cause scenarios over 3-to-6-hour windows, or a fixed `timeWindowHours` when provided. The same input files, seed, and config produce stable expected event IDs (`hybrid-event-<seed>-0001`, etc.). The response reports both injected scenarios and injected/labeled billing records.

`GET /hybrid/ground-truth`

Returns labels with expected event IDs/types, anomaly windows, billing records, explanations, and expected synthesized root-cause types.

## Root Cause

`POST /root-cause/run/:anomalyId`

Runs attribution and stores ranked candidates with confidence, matched dimensions, evidence, timestamp/source, and pod resource metadata when available. Status is `available`, `no_candidates`, `not_available`, or `exploratory_false_positive`.

The scorer never reads labels. For hybrid detections on non-injected rows, the API relabels the result when presenting it:

```json
{
  "attributionStatus": "exploratory_false_positive",
  "message": "This detection is a non-injection alert: ...",
  "candidates": [ "...ranked by the same scorer, shown as exploratory..." ]
}
```

`GET /root-cause/:anomalyId`

Returns root-cause candidates for one anomaly ordered by score.
