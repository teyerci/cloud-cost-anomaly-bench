import type { EvaluationMetrics } from "../types";

type Props = {
  evaluation?: EvaluationMetrics;
};

const detectorLabels = {
  isolation_forest: "Isolation Forest",
  ratio_rule: "Ratio rule",
  robust_z: "Robust z-score rule"
};

function percentage(value: number | null | undefined) {
  return value === null || value === undefined ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

export function EvaluationPanel({ evaluation }: Props) {
  if (!evaluation) {
    return null;
  }

  if (evaluation.anomalyMetricsAvailable === false || !evaluation.confusionMatrix) {
    return (
      <section className="panel evaluation-panel">
        <div className="panel-header"><h2>Detection Evaluation</h2><span>billing only</span></div>
        <p>{evaluation.explanation}</p>
        <p className="evaluation-note">
          Detected anomalies: <strong>{evaluation.detectedAnomalies}</strong>. F1 and root-cause accuracy are N/A because ground-truth labels and matching events are unavailable.
        </p>
      </section>
    );
  }

  const matrix = evaluation.confusionMatrix;
  return (
    <section className="panel evaluation-panel">
      <div className="panel-header">
        <h2>Detection Evaluation</h2>
        <span>{evaluation.evaluationType?.replace(/_/g, " ")}</span>
      </div>
      <div className="evaluation-layout">
        <div className="evaluation-scores">
          <div><span>Precision</span><strong>{percentage(evaluation.precision)}</strong></div>
          <div><span>Recall</span><strong>{percentage(evaluation.recall)}</strong></div>
          <div><span>F1 Score</span><strong>{percentage(evaluation.f1Score)}</strong></div>
          <div>
            <span>Scenario Recall</span>
            <strong>{percentage(evaluation.scenarioRecall)}</strong>
            <small>{evaluation.detectedScenarios ?? 0} / {evaluation.injectedScenarios ?? 0} injected incidents</small>
          </div>
          <div>
            <span>Root-cause Top-1 (event ID)</span>
            <strong>{percentage(evaluation.rootCauseTop1Accuracy)}</strong>
            <small>{evaluation.rootCauseEvaluatedDetections} true-positive detections evaluated</small>
          </div>
          <div><span>Root-cause Top-3</span><strong>{percentage(evaluation.rootCauseTop3Accuracy)}</strong></div>
          <div>
            <span>Root-cause MRR</span>
            <strong>{evaluation.rootCauseMrr?.toFixed(3) ?? "N/A"}</strong>
            <small>{evaluation.meanCandidatesPerDetection ?? "N/A"} candidates per detection</small>
          </div>
          <div><span>Top-20 Precision</span><strong>{percentage(evaluation.top20Precision)}</strong></div>
          <div>
            <span>Detected / Labeled records</span>
            <strong>{evaluation.detectedAnomalies} / {evaluation.injectedAnomalies ?? "N/A"}</strong>
          </div>
        </div>
        <div className="confusion-matrix" aria-label="Confusion matrix">
          <div className="matrix-corner" />
          <div className="matrix-heading">Predicted anomaly</div>
          <div className="matrix-heading">Predicted normal</div>
          <div className="matrix-heading row-heading">Actual anomaly</div>
          <div className="matrix-cell true-positive"><span>True positive</span><strong>{matrix.truePositives}</strong></div>
          <div className="matrix-cell false-negative"><span>False negative</span><strong>{matrix.falseNegatives}</strong></div>
          <div className="matrix-heading row-heading">Actual normal</div>
          <div className="matrix-cell false-positive"><span>False positive</span><strong>{matrix.falsePositives}</strong></div>
          <div className="matrix-cell true-negative"><span>True negative</span><strong>{matrix.trueNegatives.toLocaleString()}</strong></div>
        </div>
      </div>
      <p className="evaluation-note">
        Detector: {detectorLabels[evaluation.detector ?? "isolation_forest"]}.
        {" "}{evaluation.detector === "robust_z"
          ? `Robust z ≥ ${evaluation.robustZThreshold ?? 3.5} and delta at least $${Number(evaluation.minAbsoluteDelta ?? 1).toFixed(2)}.`
          : evaluation.detector === "ratio_rule"
            ? `Actual cost at least baseline × ${evaluation.minRelativeIncrease ?? 2.5} and delta at least $${Number(evaluation.minAbsoluteDelta ?? 1).toFixed(2)}.`
            : `${evaluation.nEstimators ?? 300} trees, contamination ${percentage(evaluation.contamination)}, ${evaluation.calibrationUsed
              ? `label-assisted (in-sample) threshold p${evaluation.thresholdPercentile}`
              : `frozen threshold p${evaluation.thresholdPercentile ?? "N/A"}`}; post-filter ×${evaluation.minRelativeIncrease ?? 2} and $${Number(evaluation.minAbsoluteDelta ?? 0.5).toFixed(2)}.`}
      </p>
      {evaluation.calibrationUsed && (
        <p className="evaluation-note">
          This run tuned its threshold on the same labels it reports, so its metrics are an optimistic upper bound.
        </p>
      )}
      <p className="evaluation-note">Post-filtering is used to remove statistically unusual but low-impact cost changes.</p>
    </section>
  );
}
