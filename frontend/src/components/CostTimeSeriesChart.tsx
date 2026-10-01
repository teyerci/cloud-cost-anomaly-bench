import { ComposedChart, Line, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from "recharts";
import type { AnomalyResult, BillingRecord } from "../types";

type Props = {
  records: BillingRecord[];
  anomalies: AnomalyResult[];
  selectedAnomaly?: AnomalyResult;
};

function hourTimestamp(value: string) {
  const date = new Date(value);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

export function CostTimeSeriesChart({ records, anomalies, selectedAnomaly }: Props) {
  const visibleRecords = [...records];
  const selectedRecord = selectedAnomaly?.billingRecord;
  if (selectedRecord && !visibleRecords.some((record) => record.id === selectedRecord.id)) {
    visibleRecords.push(selectedRecord);
  }

  const anomalyHours = new Set(anomalies.map((anomaly) => hourTimestamp(anomaly.timestamp)));
  const selectedHour = selectedAnomaly ? hourTimestamp(selectedAnomaly.timestamp) : undefined;
  const byHour = visibleRecords.reduce<Map<number, number>>((acc, record) => {
    const hour = hourTimestamp(record.timestamp);
    acc.set(hour, (acc.get(hour) ?? 0) + Math.max(0, record.cost));
    return acc;
  }, new Map());

  const data = [...byHour.entries()].sort(([left], [right]) => left - right).map(([timestamp, cost]) => ({
    timestamp,
    cost: Number(cost.toFixed(2)),
    anomalyCost: anomalyHours.has(timestamp) ? Number(cost.toFixed(2)) : null,
    selectedAnomalyCost: selectedHour === timestamp ? Number(cost.toFixed(2)) : null
  }));

  return (
    <section className="panel chart-panel">
      <div className="panel-header">
        <h2>Cost Time Series</h2>
        <span>
          {selectedAnomaly
            ? `${selectedAnomaly.billingRecord?.account ?? ""} / ${selectedAnomaly.billingRecord?.service ?? ""} / ${selectedAnomaly.billingRecord?.region ?? ""}, selected ±24h`
            : `${data.length} hourly buckets`}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={data}>
          <XAxis
            dataKey="timestamp"
            domain={["dataMin", "dataMax"]}
            minTickGap={32}
            scale="time"
            tickFormatter={(value) => new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" })}
            type="number"
          />
          <YAxis />
          <Tooltip
            formatter={(value) => [`$${value}`, "Cost"]}
            labelFormatter={(value) => new Date(value).toLocaleString()}
          />
          <Line type="monotone" dataKey="cost" stroke="#2563eb" strokeWidth={2} dot={false} />
          <Scatter dataKey="anomalyCost" name="Anomaly" fill="#dc2626" />
          <Scatter dataKey="selectedAnomalyCost" name="Selected anomaly" fill="#f59e0b" shape="diamond" />
        </ComposedChart>
      </ResponsiveContainer>
    </section>
  );
}
