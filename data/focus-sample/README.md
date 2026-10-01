# FOCUS Sample Data

The files here come from, or are derived from, the FinOps Foundation's [FOCUS-Sample-Data](https://github.com/FinOps-Open-Cost-and-Usage-Spec/FOCUS-Sample-Data) repository (FOCUS 1.0), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

- `focus_sample.csv`, `focus_sample_10000.csv.zip`, `focus_sample_100000.csv.gz`: subsets of the sample for the dashboard demo (unpack `focus_sample_100000.csv.gz` to `focus_sample_100000.csv` before use).
- `inputs.manifest.json`: SHA-256 checksums and row counts of the inputs used for the reported experiments, and the software environment.
- `focus_full_hourly.csv` (not committed): the full FOCUS 1.0 sample aggregated to hourly account/service/region totals by `data/tools/aggregate_focus_hourly.py`; see the main README for the commands.
