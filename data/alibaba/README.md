# Alibaba GPU Cluster Trace

The experiments use `openb_pod_list_default.csv` from Alibaba's cluster-trace-gpu-v2023. The trace is published without a license file, so it is not redistributed here. Download it into this folder:

```bash
curl -L -o data/alibaba/openb_pod_list_default.csv \
  https://raw.githubusercontent.com/alibaba/clusterdata/master/cluster-trace-gpu-v2023/csv/openb_pod_list_default.csv
shasum -a 256 data/alibaba/openb_pod_list_default.csv
```

The SHA-256 of the file used for the reported results is recorded in `data/focus-sample/inputs.manifest.json` (`1ee7ed79c27a3b0861cda8ddba86a004c6aba904caafa329a76ae93ca63834a8`).

Source: https://github.com/alibaba/clusterdata/tree/master/cluster-trace-gpu-v2023. Please cite: Weng, Q., et al. "Beware of Fragmentation: Scheduling GPU-Sharing Workloads with Fragmentation Gradient Descent." USENIX ATC 2023.
