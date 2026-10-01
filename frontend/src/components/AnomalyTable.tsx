import type { AnomalyResult } from "../types";

type Props = {
  anomalies: AnomalyResult[];
  selectedId?: string;
  onSelect: (anomaly: AnomalyResult) => void;
};

export function AnomalyTable({ anomalies, selectedId, onSelect }: Props) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Anomalies</h2>
        <span>{anomalies.length} detected</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Service</th>
              <th>Region</th>
              <th>Account</th>
              <th>Source</th>
              <th>Severity</th>
              <th>Actual</th>
              <th>Expected</th>
              <th>Score</th>
              <th>Ground Truth</th>
              <th>Evaluation</th>
              <th>Expected Cause</th>
              <th>Expected Event ID</th>
            </tr>
          </thead>
          <tbody>
            {anomalies.map((anomaly) => (
              <tr
                key={anomaly.id}
                className={selectedId === anomaly.id ? "selected" : ""}
                onClick={() => onSelect(anomaly)}
              >
                <td>{new Date(anomaly.timestamp).toLocaleString()}</td>
                <td>{anomaly.billingRecord?.service ?? "unknown"}</td>
                <td>{anomaly.billingRecord?.region ?? "unknown"}</td>
                <td>{anomaly.billingRecord?.account ?? "unknown"}</td>
                <td>{anomaly.sourceType ?? anomaly.billingRecord?.sourceType ?? "unknown"}</td>
                <td><span className={`badge ${anomaly.severity}`}>{anomaly.severity}</span></td>
                <td>${Math.max(0, anomaly.actualCost).toFixed(2)}</td>
                <td>${Math.max(0, anomaly.expectedCost).toFixed(2)}</td>
                <td>{anomaly.score.toFixed(3)}</td>
                <td>
                  {anomaly.groundTruthLabel === undefined
                    ? "N/A"
                    : anomaly.groundTruthLabel ? "anomaly" : "normal"}
                </td>
                <td>
                  {anomaly.detectionClassification
                    ? <span className={`badge ${anomaly.detectionClassification}`}>{anomaly.detectionClassification.replace("_", " ")}</span>
                    : "N/A"}
                </td>
                <td>{anomaly.expectedRootCauseType ?? anomaly.billingRecord?.anomalyType ?? "N/A"}</td>
                <td>{anomaly.expectedRootCauseEventId ?? "N/A"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
