# cloud-cost-anomaly-bench

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23088203.svg)](https://doi.org/10.5281/zenodo.23088203)

Prototype monorepo for Automated Cloud Cost Anomaly Detection and Root-Cause Attribution.

## Paper

The paper describing this benchmark is under submission and will be linked here after review. The results it reports are those in `results/`; see [Evaluation Protocol](#evaluation-protocol) to reproduce them. A user guide for the dashboard is in `docs/Cloud_Cost_Anomaly_User_Guide.docx`.

## Stack

- Backend: Node.js, Express, TypeScript
- Frontend: React, Vite, TypeScript, Recharts
- Database: PostgreSQL
- ORM: Prisma
- ML: Python scikit-learn Isolation Forest

No authentication or authorization is included.

## Folders

- `backend` - Express API, Prisma models, synthetic data, anomaly and root-cause services
- `frontend` - Vite React UI
- `ml` - JSON-in/JSON-out Isolation Forest script
- `docs` - architecture and API notes
- `data/focus-sample` - optional local folder for manually downloaded FOCUS sample CSV files
- `data/alibaba` - local folder for the downloaded Alibaba pod trace CSV (see `data/alibaba/README.md`)

## Setup

1. Install Node dependencies:

   ```bash
   npm install
   ```

2. Create backend environment:

   ```bash
   cp backend/.env.example backend/.env
   ```

3. Edit `backend/.env` with a PostgreSQL connection string.

4. Start PostgreSQL and make sure `DATABASE_URL` points to the running database.

5. Generate Prisma client and run migrations:

   ```bash
   npm run prisma:generate
   npm run prisma:migrate
   ```

6. Install Python ML dependencies:

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r ml/requirements.txt
   ```

7. Run backend and frontend:

   ```bash
   npm run dev
   ```

Backend defaults to `http://localhost:4000`. Frontend defaults to `http://localhost:5173`.

## Quick API Flow

1. `GET /api/health`
2. `POST /api/data/generate`
3. `POST /api/anomalies/run`
4. `GET /api/anomalies`
5. `GET /api/evaluation?mode=synthetic`
6. `POST /api/root-cause/run/:anomalyId`
7. `GET /api/root-cause/:anomalyId`

## Rebuilding Demo Data After a Clean Database

Cleaning or reinstalling the database removes imported FOCUS records, Alibaba trace events, hybrid synthesized records, labels, detection runs, anomaly results, and root-cause candidates. Recreate the same demo/evaluation dataset with the deterministic rebuild workflow:

```bash
npm run rebuild:demo -- \
  --focus data/focus-sample/focus_sample_100000.csv \
  --alibaba data/alibaba/openb_pod_list_default.csv \
  --seed 42 \
  --scenarios 50 \
  --time-window-hours 4 \
  --min-baseline-cost 1 \
  --cost-multiplier-min 3 \
  --cost-multiplier-max 6
```

The command clears demo/imported/generated rows, re-imports FOCUS, re-imports Alibaba trace data, builds `hybrid_synthesized`, runs detection, and attributes true-positive detections. Use `--skip-detection` or `--skip-attribution` for faster data-only rebuilds.

Equivalent API sequence:

```bash
curl -X POST http://localhost:4000/api/demo/reset-and-rebuild \
  -H "Content-Type: application/json" \
  -d '{
    "focusFilePath":"data/focus-sample/focus_sample_100000.csv",
    "alibabaFilePath":"data/alibaba/openb_pod_list_default.csv",
    "seed":42,
    "numScenarios":50,
    "timeWindowHours":4,
    "minBaselineCost":1.0,
    "costMultiplierMin":3,
    "costMultiplierMax":6,
    "runDetection":true,
    "runAttributionForTruePositives":true
  }'

curl http://localhost:4000/api/demo/last-build-run
curl "http://localhost:4000/api/evaluation?mode=hybrid_synthesized"
```

Same files plus same config plus same seed produce the same injected scenario count, hybrid billing record count, labeled anomaly count, and deterministic expected root-cause event IDs such as `hybrid-event-42-0001`.

### Configurable Hybrid Rebuild Parameters

- `numScenarios` controls how many Alibaba-derived workload events are selected for injected root-cause scenarios. Recommended range: 40-60 for stable project evaluation. Higher values create more injected ground-truth scenarios but may make the dataset more synthetic.
- `seed` makes the rebuild reproducible. Same files, same config, and same seed produce the same hybrid ground truth.
- `minBaselineCost` avoids injecting into tiny cost records where a small billing movement would look large only as a percentage.
- `timeWindowHours` controls how long each injected incident lasts.
- `costMultiplierMin` and `costMultiplierMax` control the injected cost increase magnitude.
- `runDetection` and `runAttributionForTruePositives` decide whether the rebuild also creates anomaly detections and root-cause candidates for true positives.

## ML Script

Run the Isolation Forest script with:

```bash
python ml/detect_anomalies.py input.json output.json
```

The backend exports past-only features including cost and `log1p(cost)`, previous cost, delta and delta percentage, 3/7-record rolling statistics, median/MAD robust z-score, time features, and categorical encodings. Records are grouped by account/service/region, sorted by timestamp, and never use future values.

Defaults are 300 trees, `max_samples=auto`, seed 42, `RobustScaler`, contamination 0.03 for synthetic, 0.01 for hybrid, and 0.02 for FOCUS. Hybrid runs also use an operational post-filter to remove statistically unusual but low-impact billing changes: actual cost at least 2.5x expected cost and absolute delta at least $1.00.

Label-assisted calibration is **opt-in** (`"calibrate": true` on `/api/anomalies/run`). It evaluates a grid across p98, p98.5, p99, p99.5; contamination 0.01, 0.015, 0.02, 0.03; minimum relative increase 2.0, 2.5, 3.0; and minimum absolute delta $0.50, $1.00, $2.00, then applies the best-F1 configuration to the same records. Metrics from a calibrated run are an in-sample upper bound, not a held-out result.

Two label-free rule baselines run through the same script and API (`"detector"`):

- `ratio_rule`: the post-filter alone (cost at least 2.5x the rolling positive minimum and at least $1.00 above it).
- `robust_z`: median/MAD robust z-score at least 3.5 and at least $1.00 above the rolling median.

## Evaluation Protocol

`npm run experiments` produces the reported hybrid results. It needs two inputs that are not in this repository. The Alibaba GPU trace file has no upstream license, so it is downloaded rather than redistributed (`data/alibaba/README.md`). The billing baseline is the full FOCUS 1.0 sample aggregated to hourly series totals. Create both once:

```bash
curl -L -o /tmp/focus_data_table.csv.gz \
  https://media.githubusercontent.com/media/FinOps-Open-Cost-and-Usage-Spec/FOCUS-Sample-Data/main/FOCUS-1.0/focus_data_table.csv.gz
python3 data/tools/aggregate_focus_hourly.py /tmp/focus_data_table.csv.gz data/focus-sample/focus_full_hourly.csv --month 2024-09
curl -L -o data/alibaba/openb_pod_list_default.csv \
  https://raw.githubusercontent.com/alibaba/clusterdata/master/cluster-trace-gpu-v2023/csv/openb_pod_list_default.csv
shasum -a 256 data/alibaba/openb_pod_list_default.csv   # compare with data/focus-sample/inputs.manifest.json
npm run experiments -- --reimport
```

The download is about 500 MB (5.5M line items); the aggregated file has 159,426 rows (one per billing account, service, region, and hour). Later runs reuse the imported data unless `--reimport` is passed.

1. Import FOCUS and Alibaba data once (reused on later runs; `--reimport` forces a fresh import).
2. Split the billing timeline at its median row timestamp into two halves.
3. Main direction: build seed 42 with incidents only in the first half and calibrate each detector family on its own grid, scored on that half only: IF + ratio rule (percentile gate p95–p99.9, factor 1.2–5×, dollar amount $0.10–$16), the ratio rule, and the seasonal rule (factor × dollar amount). Contamination is not searched because it cannot move a percentile threshold. The summary records whether each chosen value lies on the grid's edge.
4. Held-out: seeds 43–47 inject only into the second half and are evaluated only there. Detectors: `ratio_rule` (2.5×, $1), `ratio_rule_frozen`, `ratio_rule_at_if_thresholds` (what the Isolation Forest gate removes), `ratio_rule_budget` (cost-ratio ranking only, at IF + ratio rule's alert count), `seasonal_rule_frozen`, `robust_z`, `if_and_rule_default`, `if_and_rule_frozen`, `if_standalone_budget`, `if_standalone_contamination`, and `if_and_rule_insample` (upper bound only). Isolation Forest's random state is the seed. The oracle build runs only `ratio_rule_frozen`.
5. Swapped direction (skip with `--skip-swapped`): calibrate seed 142 on the second half and test seeds 143–147 on the first, for the main comparison detectors.
6. Sweeps (skip with `--skip-sweeps`): lower multipliers (1.5–2.5×) and five event-noise variants (jitter 0 h / 2 h, region noise 0 / 0.6, 6 distractors).
7. Write `results/experiments.csv`, `results/summary.json` (aggregates, paired differences, grid edges, block statistics, incident timing, code revision), `results/calibration.json`, `results/calibration_grid.csv`, and `results/tables.md`.

Benchmark: 60 incidents per build. Triggers keep their order in the Alibaba trace but are placed evenly over the injected half (the trace's creation times are concentrated near its end), with at least 12 h between incidents in the same series. About 70% are step spikes (up to 4 h) and 30% gradual drift (up to 12 h linear ramp), injected into the eligible hourly row nearest in time to the trigger. Eligibility needs one earlier row, not the detector's six, so the recall ceiling is reported.

Reported metrics: record-level precision/recall/F1 (also precision on injectable series only), incident recall overall and per incident shape, recall ceiling and a breakdown of missed rows, and attribution Top-1/Top-3/MRR by exact expected event ID over each true-positive detection's full candidate pool, with ties broken uniformly at random (expected value). Attribution is reported at row and incident level for the full scorer, five leave-one-out ablations (remaining weights renormalized), and dimension-then-time, nearest-in-time, event-type-only, dimension-only, and random baselines, with a region-dropped breakdown. Statistics are mean ± sample SD over held-out seeds with 95% t-intervals and paired per-seed differences.

Attribution settings:

- `realistic` (default): the true event is stamped up to 1 hour before anomaly onset, carries the Alibaba pod ID instead of the billing resource ID, and (like every distractor) loses its region with probability 0.3, and competes with 3 distractor events per scenario that share the billing account/service/region and sit between 3 hours before and 2 hours after onset.
- `oracle`: the true event is stamped at onset with the billing record's dimensions and has no distractors. It is an upper bound that checks the pipeline works, not an attribution result.

Scenario selection and cost injection are identical across the two settings for the same seed. Event rows never contain the target billing record ID or expected root-cause type; those exist only in `GroundTruthLabel`, and injected rows keep their original tags.

## Current Prototype Capabilities

- `/api/anomalies/run` supports `isolation_forest` (combined with the ratio post-filter by default, or standalone with `postFilter: false` and an optional `alertBudget`), `ratio_rule`, and `robust_z`.
- Synthetic data includes labeled injected anomalies for service spikes, region shifts, project/tag spikes, gradual drift, and unrelated noise events.
- `/api/evaluation` (optionally restricted with `from`/`to`) reports detector parameters, precision, recall, F1-score, incident and per-shape recall, Top-20 precision, confusion matrix, and attribution Top-1/Top-3/MRR with baselines and ablations when labels are available.
- The dashboard supports account, service, region, and severity filters, and marks anomaly points on the cost chart.

## FOCUS Sample Data Support

FOCUS sample data is supported as an additional realistic billing-schema input. It validates the billing normalization pipeline and can be used by the existing Isolation Forest anomaly detector after import.

FOCUS does not have injected labels or matching infrastructure events, so F1 and root-cause accuracy are N/A. Its anomaly count and score distribution remain available. Expected and displayed actual costs are clipped to zero so credits do not become negative billing baselines.

Place manually downloaded CSV files under `data/focus-sample/`, then preview and import them:

```bash
curl "http://localhost:4000/api/focus/mapping-preview?filePath=data/focus-sample/focus_sample_100000.csv"
curl -X POST http://localhost:4000/api/focus/import \
  -H "Content-Type: application/json" \
  -d '{"filePath":"data/focus-sample/focus_sample_100000.csv"}'
curl -X POST http://localhost:4000/api/anomalies/run \
  -H "Content-Type: application/json" \
  -d '{"sourceType":"focus"}'
```

## Hybrid FOCUS + Alibaba Trace Evaluation

Hybrid mode combines FOCUS billing as a realistic baseline with Alibaba pod trace-derived workload events and controlled cost injection. The datasets are not from the same environment. The full Alibaba relative timeline is linearly compressed into the imported FOCUS billing range, preserving event order and relative spacing. Mappings are synthetic, and all generated records and labels use `hybrid_synthesized` or synthesized-ground-truth metadata. The project does not claim a real causal relationship between the public datasets.

Hybrid injection defaults to around 50 root-cause scenarios over 3-to-6-hour windows. It requires a meaningful baseline cost, skips missing/null regions, injects only into compute/container/GPU-compatible billing services, and avoids unrelated services such as Datadog unless a mapping explicitly allows it.

Alibaba trace events are used to generate synthesized root-cause scenarios only for intentionally injected hybrid anomalies. The attribution scorer ranks candidates for every detection without reading labels. A hybrid detection on a non-injected row (a "non-injection alert") has no ground-truth Alibaba root cause; the API marks its candidates as exploratory, and they are not counted in root-cause accuracy. Root-cause metrics are evaluated only on true-positive detections.

Run the flow after applying the Prisma migration:

```bash
curl -X POST http://localhost:4000/api/focus/import \
  -H "Content-Type: application/json" \
  -d '{"filePath":"data/focus-sample/focus_sample_100000.csv"}'

curl -X POST http://localhost:4000/api/hybrid/import-alibaba-trace \
  -H "Content-Type: application/json" \
  -d '{"filePath":"data/alibaba/openb_pod_list_default.csv"}'

curl -X POST http://localhost:4000/api/hybrid/build \
  -H "Content-Type: application/json" \
  -d '{"focusSourceType":"focus","numScenarios":50,"minTimeWindowHours":3,"maxTimeWindowHours":6}'

curl -X POST http://localhost:4000/api/anomalies/run \
  -H "Content-Type: application/json" \
  -d '{"sourceType":"hybrid_synthesized"}'

curl "http://localhost:4000/api/evaluation?mode=hybrid_synthesized"
```

Hybrid detection automatically attributes detected true-positive anomalies. Manual attribution remains available. Backend statuses are `available`, `no_candidates`, `not_available`, and `exploratory_false_positive`; the UI also distinguishes `not_run`, `loading`, and `error`.

## Verification Checklist

1. Import FOCUS billing data.
2. Import the Alibaba pod trace.
3. Build `hybrid_synthesized`.
4. Run detection with `sourceType: "hybrid_synthesized"`.
5. Confirm anomaly expected/actual costs are never negative.
6. Confirm hybrid evaluation shows F1, confusion matrix, selected threshold, and contamination.
7. Select a hybrid true positive and confirm ranked root-cause candidates appear.
8. Run FOCUS detection and confirm F1/root-cause accuracy are N/A and attribution is `not_available`.

## License

The code is released under the MIT License (see `LICENSE`). Third-party data keep their own terms:

- FOCUS sample data (`data/focus-sample/`): FinOps Foundation [FOCUS-Sample-Data](https://github.com/FinOps-Open-Cost-and-Usage-Spec/FOCUS-Sample-Data), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Alibaba GPU cluster trace (`openb_pod_list_default.csv`): [alibaba/clusterdata](https://github.com/alibaba/clusterdata/tree/master/cluster-trace-gpu-v2023), cluster-trace-gpu-v2023; please cite Weng et al., "Beware of Fragmentation: Scheduling GPU-Sharing Workloads with Fragmentation Gradient Descent", USENIX ATC 2023.
