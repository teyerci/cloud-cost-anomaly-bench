import type { AnomalyResult, AttributionUiStatus, RootCauseCandidate } from "../types";

type Props = {
  anomaly?: AnomalyResult;
  candidates: RootCauseCandidate[];
  attributionStatus: AttributionUiStatus;
  attributionMessage?: string;
  onRun: () => void;
};

function metadataValue(metadata: Record<string, unknown> | undefined, key: string) {
  const value = metadata?.[key];
  return value === undefined || value === null || value === "" ? undefined : String(value);
}

function emptyMessage(anomaly: AnomalyResult, status: AttributionUiStatus, message?: string) {
  if (status === "not_run") return "Run attribution to search for related infrastructure events.";
  if (status === "loading") return "Searching and ranking root-cause events...";
  if (status === "error") return message ?? "Root-cause attribution failed.";
  if (status === "exploratory_false_positive") {
    return "This is a false-positive detection in the hybrid ground truth. No Alibaba-derived ground-truth root cause exists for this record.";
  }
  if (message) return message;
  if (anomaly.billingRecord?.sourceType === "focus") {
    return "Root-cause attribution is not available because FOCUS data is billing-only and no matching infrastructure events were provided.";
  }
  if (anomaly.billingRecord?.sourceType === "hybrid_synthesized") {
    return "No matching hybrid root-cause event was found for this anomaly. Try another detected true-positive anomaly or widen the attribution time window.";
  }
  return "No matching synthetic infrastructure event was found for this anomaly.";
}

export function RootCausePanel({
  anomaly,
  candidates,
  attributionStatus,
  attributionMessage,
  onRun
}: Props) {
  return (
    <aside className="panel root-cause">
      <div className="panel-header">
        <h2>Root Cause</h2>
        {anomaly && (
          <button disabled={attributionStatus === "loading"} onClick={onRun}>
            {attributionStatus === "loading" ? "Running..." : "Run Attribution"}
          </button>
        )}
      </div>
      {!anomaly && <p className="empty">Select an anomaly to inspect likely causes.</p>}
      {anomaly && (
        <>
          <div className="summary">
            <span>Selected anomaly</span>
            <strong>{anomaly.billingRecord?.account} / {anomaly.billingRecord?.service}</strong>
            <p>{anomaly.explanation}</p>
          </div>
          {attributionStatus === "exploratory_false_positive" && (
            <div className="warning-box">
              This is a false-positive detection in the hybrid ground truth. No Alibaba-derived ground-truth root cause exists for this record.
              {attributionMessage && <p>{attributionMessage}</p>}
            </div>
          )}
          {candidates.length === 0 ? (
            <p className="empty">{emptyMessage(anomaly, attributionStatus, attributionMessage)}</p>
          ) : (
            <div className="candidate-list">
              {attributionStatus === "exploratory_false_positive" && <h3>Nearby events, exploratory only</h3>}
              {candidates.map((candidate, index) => {
                const metadata = candidate.infrastructureEvent.metadata;
                const matchedDimensions = Array.isArray(candidate.signals?.matchedDimensions)
                  ? candidate.signals.matchedDimensions.join(", ")
                  : "none";
                return (
                  <article className="candidate" key={candidate.id}>
                    <div>
                      <strong>#{index + 1} {candidate.infrastructureEvent.eventType}</strong>
                      <span>
                        {attributionStatus === "exploratory_false_positive"
                          ? "exploratory"
                          : `${Math.round(candidate.score * 100)}% confidence`}
                      </span>
                    </div>
                    <dl className="candidate-details">
                      <dt>Time</dt><dd>{new Date(candidate.infrastructureEvent.timestamp).toLocaleString()}</dd>
                      <dt>Source</dt><dd>{candidate.infrastructureEvent.sourceType ?? "unknown"}</dd>
                      <dt>Matched</dt><dd>{matchedDimensions}</dd>
                      {metadataValue(metadata, "podName") && <><dt>Pod</dt><dd>{metadataValue(metadata, "podName")}</dd></>}
                      {metadataValue(metadata, "cpuMilli") && <><dt>CPU</dt><dd>{metadataValue(metadata, "cpuMilli")} millicores</dd></>}
                      {metadataValue(metadata, "memoryMiB") && <><dt>Memory</dt><dd>{metadataValue(metadata, "memoryMiB")} MiB</dd></>}
                      {metadataValue(metadata, "numGpu") && <><dt>GPU</dt><dd>{metadataValue(metadata, "numGpu")}</dd></>}
                      {metadataValue(metadata, "gpuMilli") && <><dt>GPU request</dt><dd>{metadataValue(metadata, "gpuMilli")} milli-GPU</dd></>}
                    </dl>
                    <p><strong>Evidence:</strong> {candidate.reason}</p>
                    <small>{candidate.infrastructureEvent.description}</small>
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}
    </aside>
  );
}
