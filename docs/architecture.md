# Architecture

`cloud-cost-anomaly` is a small monorepo prototype with four parts:

- `backend`: Express TypeScript API, Prisma client, synthetic data generation, FOCUS CSV normalization, anomaly detection, and root-cause attribution.
- `frontend`: Vite React TypeScript dashboard with cost charting, anomaly table, event timeline, and root-cause details.
- `ml`: Python Isolation Forest script with a stable JSON input/output interface.
- `docs`: project documentation.

## Data Flow

1. `POST /api/data/generate` clears old prototype data and creates seven days of hourly synthetic billing records.
2. The generator injects cost anomalies and nearby infrastructure events for end-to-end evaluation.
3. `POST /api/focus/import` can add normalized FOCUS CSV billing records as an additional billing-data source.
4. `POST /api/hybrid/import-alibaba-trace` converts projected Alibaba pod rows into workload events.
5. `POST /api/hybrid/build` copies the FOCUS baseline, injects controlled costs, creates mapped hybrid events, and stores ground truth.
6. `POST /api/anomalies/run` exports past-only features, stores detector parameters and threshold in `DetectionRun`, and stores anomalies with nonnegative expected/actual costs.
7. `POST /api/root-cause/run/:anomalyId` finds source-compatible events from twelve hours before to two hours after the anomaly and scores each candidate.
8. The React dashboard reads records, events, anomalies, import/build summaries, and candidates from the API.

`POST /api/demo/reset-and-rebuild` wraps steps 3-7 for a clean database or demo reset. It clears only imported/generated/demo rows, not the schema, then records the rebuild configuration in `DatasetBuildRun`.

## FOCUS Sample Data Support

FOCUS sample data is used as an additional realistic billing-schema input. The importer maps flexible FOCUS-like columns into the existing `BillingRecord` model, stores source metadata such as provider and currency, and preserves selected raw source fields for traceability.

FOCUS validates billing normalization but has no labels or matching events. F1 and root-cause accuracy are therefore N/A. Negative credits may remain in raw source data, while anomaly expected/actual costs and chart values are clipped to zero.

## Hybrid FOCUS + Alibaba Trace Evaluation

The optional hybrid builder uses FOCUS as a realistic billing baseline and Alibaba pod traces as realistic workload shapes. They are independent public datasets from different environments.

Alibaba trace seconds are linearly compressed into the complete FOCUS billing timestamp range. This preserves event order and relative spacing while ensuring the projected events overlap the billing baseline. High CPU/memory maps to compute/container services, GPU requests map to compute/GPU/accelerated-compute services, and pending/failed pods map to compute/container/orphan or unused-capacity scenarios. The builder avoids unrelated SaaS services such as Datadog, skips missing/null regions, requires baseline cost at least `$1.00`, and injects around 50 scenarios over contiguous 3-to-6-hour windows by default.

The output is stored separately as `hybrid_synthesized`. Each injected record has a `GroundTruthLabel` linked to its expected synthesized event. Metadata preserves the original FOCUS cost, source Alibaba event ID, mapping explanation, and an explicit statement that the alignment does not imply real synchronization or causality.

Hybrid build selection uses a deterministic seeded RNG. With the same FOCUS file, Alibaba file, seed, and config, the builder produces the same scenario count, hybrid billing record count, labeled anomaly count, and expected root-cause event IDs. Synthesized event IDs are deterministic (`hybrid-event-<seed>-NNNN`) so reproducibility does not depend on database-generated IDs.

### Configurable Hybrid Rebuild Parameters

`numScenarios` controls how many Alibaba-derived events are selected for injected root-cause scenarios. The recommended range is 40-60 for stable project evaluation; higher values create more ground truth but can make the dataset feel more synthetic. `seed` makes the selected scenarios reproducible. `minBaselineCost` avoids tiny cost records, `timeWindowHours` controls incident duration, and `costMultiplierMin`/`costMultiplierMax` control the injected cost increase magnitude.

## Dataset Build Runs

`DatasetBuildRun` stores rebuild metadata: source type, file paths, seed, scenario/window/baseline/multiplier configuration, run-detection flags, imported row/event counts, injected scenario/record counts, hybrid billing count, expected root-cause event IDs, and creation time. `DetectionRun` can reference the associated `buildRunId` so evaluation metrics can be traced back to the dataset build.

## Root-Cause Scoring

Candidates are infrastructure events from twelve hours before to two hours after an anomaly timestamp. The twelve-hour lookback covers the longest injected incident (12 h drift), so later rows in an incident can still reach the onset event. Score ties are displayed in a neutral hash order rather than by event ID, and the evaluation ranks the full candidate pool (without the 0.35 display threshold) with ties broken uniformly at random.

Candidate source is constrained by dataset: synthetic anomalies use synthetic events, hybrid anomalies use hybrid synthesized events, and FOCUS-only anomalies return `not_available`.

The score combines:

- Time proximity (normalized separately for the lookback and lookahead sides)
- Matching account, service, region, and resource ID
- Event type weight
- Service compatibility inferred from the event type
- Cost impact compared with expected cost

The scorer reads only fields an operator would see on an event. Ground truth (expected event ID and root-cause type) is stored only in `GroundTruthLabel`, and injected billing rows keep their original tags, so labels cannot leak into detection features or attribution scores.

The current scoring model is intentionally explainable and simple. Attribution is a separate event-correlation layer, not causal diagnosis.

Hybrid builds use one of two attribution settings. `oracle` stamps the true event at anomaly onset with the billing record's dimensions and adds no competitors; it is an upper bound. `realistic` jitters the true event up to one hour before onset, uses the Alibaba pod ID as its resource, drops the region of the true event and of each distractor with the same probability (0.3), and adds three distractor events per scenario that share account/service/region and sit between three hours before and two hours after onset. Distractors come from Alibaba events not used as scenario triggers. Noise uses a separate seeded stream, so scenario selection and cost injection are identical across settings for a given seed.

## Benchmark Construction

Hybrid builds can restrict injection to a time block (`injectionFrom`/`injectionTo`); triggers then keep their order in the trace but are placed evenly over the block by rank (the trace's creation times are concentrated near its end, so a linear projection would cluster incidents), and incidents in the same series stay at least `minIncidentGapHours` (default 12) apart. Each trigger picks the eligible row nearest in time (compute-like service, known region, cost and baseline at least `minBaselineCost`, cost within 0.5–2× of the baseline, at least one earlier row, whole incident window inside the block). A share of incidents (`driftFraction`) is gradual drift, ramping linearly to the full multiplier over `driftWindowHours`; the rest are step spikes. Shapes use their own seeded stream, so selection does not change when the drift share changes.

## Detection And Calibration

Features include cost, log cost, usage, previous cost, delta/percentage, 3/7-record rolling mean, 7-record standard deviation/median/maximum, cost ratios, median/MAD robust z-score, time values, and categorical encodings. They are calculated only from records in the same account/service/region series with strictly earlier timestamps; records that share a timestamp are not each other's history. Records are sorted by content (timestamp, dimensions, cost, usage, tags) rather than database order, so identical data always produces identical features, baselines, and Isolation Forest input. The detector is still a batch outlier detector: the scaler and Isolation Forest are fitted and scored on the same records.

The model uses 300 trees, `max_samples=auto`, seed 42, `RobustScaler`, and source-specific contamination. Hybrid defaults are contamination `0.01`, threshold percentile `p99`, minimum relative increase `2.5x`, and minimum absolute delta `$1.00`. A material-spike post-filter removes tiny credit/rounding movements.

Label-assisted calibration is opt-in and is scored only on rows inside the evaluation window. It searches the percentile gate (p98, p98.5, p99, p99.5), minimum relative increase (2.0, 2.5, 3.0), and minimum absolute delta (0.5, 1.0, 2.0); contamination is not searched because it shifts every Isolation Forest score by a constant and cannot move a percentile threshold. Isolation Forest runs either combined with the ratio post-filter (a row must pass both) or standalone (`postFilter: false`), where the model score alone decides, at a top-k alert budget or at the model's own contamination threshold. The experiment protocol (`backend/scripts/runExperiments.ts`) calibrates on seed 42 in the calibration half of the timeline and evaluates frozen thresholds on seeds 43–47 in the test half, so no normal row is shared; re-tuning on the test labels is reported only as an upper bound.

Detection is reported at record level (precision/recall/F1, also per incident shape), incident level (injected incidents with at least one detected row), and against a recall ceiling (share of injected rows meeting the ratio rule's six-row and $0.10 preconditions). Top-20 precision ranks detections by anomaly score to show triage quality. FOCUS-only data still has no F1 without labels.

## Attribution Status

Alibaba trace-derived labels exist only for injected hybrid anomalies. Non-injection alerts (detections on rows that were not injected) are not verified-normal billing, but they have no ground-truth Alibaba root cause. They are scored like every other detection; the API then presents them as `exploratory_false_positive`, and their candidates must not be presented as confirmed likely causes.

Root-cause Top-1, Top-3, and MRR are computed only on true-positive detections, by exact expected event ID. Event-type Top-1 is reported separately.

Backend statuses are `available`, `no_candidates`, `not_available`, and `exploratory_false_positive`. The frontend additionally uses `not_run`, `loading`, and `error` so an unexecuted attribution is not confused with a completed empty result.

## Out of Scope

This prototype intentionally excludes Docker, Kubernetes, CI/CD, authentication, authorization, and cloud deployment.
