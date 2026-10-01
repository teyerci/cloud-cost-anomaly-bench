import json
import math
import sys
from pathlib import Path

import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import RobustScaler


FEATURES = [
    "cost",
    "logCost",
    "usageQuantity",
    "previousCost",
    "costDelta",
    "costDeltaPercent",
    "absoluteCostDelta",
    "relativeCostDelta",
    "rollingMean3",
    "rollingMean7",
    "rollingStd7",
    "rollingMedian7",
    "rollingMinPositive7",
    "rollingMax7",
    "costToRollingMean7",
    "costToRollingMedian7",
    "costToRollingMinPositive7",
    "rollingPercentileRank",
    "groupCostShareAtTimestamp",
    "serviceCostShareAtTimestamp",
    "isLowImpactCandidate",
    "robustZScore",
    "hourOfDay",
    "dayOfWeek",
    "isWeekend",
    "serviceIndex",
    "regionIndex",
    "accountIndex",
    "projectIndex",
    "sourceIndex",
    "historyCount",
]

# Isolation Forest without the categorical index features (ordinal codes carry no magnitude).
NUMERIC_FEATURES = [feature for feature in FEATURES if not feature.endswith("Index")]

DETECTORS = ["isolation_forest", "ratio_rule", "robust_z", "seasonal_rule", "median_ratio_rule", "dollar_rule"]
DEFAULT_ROBUST_Z_THRESHOLD = 3.5
RULE_DETECTORS_WITH_THRESHOLDS = ["ratio_rule", "seasonal_rule", "median_ratio_rule", "dollar_rule"]

# Wide enough that the calibrated optimum can be interior on every axis (the chosen point and whether it
# lies on the grid edge are reported). Contamination is not tuned: it only offsets decision_function by
# a constant, so it cannot move a percentile threshold.
TUNING_PERCENTILES = [95, 97, 98, 99, 99.5, 99.8, 99.9]
TUNING_MIN_RELATIVE_INCREASES = [1.2, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0]
TUNING_MIN_ABSOLUTE_DELTAS = [0.1, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0]
# The dollar rule has one threshold, so its grid is finer.
TUNING_DOLLAR_DELTAS = [0.1, 0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 12.0, 16.0, 24.0, 32.0]


def load_payload(path: Path):
    with path.open("r", encoding="utf-8") as file:
        data = json.load(file)
    if isinstance(data, list):
        return data, {}
    if isinstance(data, dict) and isinstance(data.get("records"), list):
        return data["records"], data.get("options") or {}
    raise ValueError("Input JSON must be an array or an object containing a records array.")


def finite_number(value, fallback=0.0):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def feature_matrix(records, features=FEATURES):
    return np.asarray([
        [finite_number(record.get(feature, 0)) for feature in features]
        for record in records
    ], dtype=float)


def confusion_metrics(predictions, labels):
    true_positive = sum(prediction and label for prediction, label in zip(predictions, labels))
    false_positive = sum(prediction and not label for prediction, label in zip(predictions, labels))
    false_negative = sum(not prediction and label for prediction, label in zip(predictions, labels))
    true_negative = sum(not prediction and not label for prediction, label in zip(predictions, labels))
    precision = true_positive / max(true_positive + false_positive, 1)
    recall = true_positive / max(true_positive + false_negative, 1)
    f1 = 2 * precision * recall / max(precision + recall, 1e-12)
    return {
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "truePositives": true_positive,
        "falsePositives": false_positive,
        "falseNegatives": false_negative,
        "trueNegatives": true_negative,
        "detectedAnomalies": sum(predictions),
    }


def material_cost_spike(record, min_relative_increase=2.0, min_absolute_delta=0.5):
    history_count = int(finite_number(record.get("historyCount", 0)))
    cost = max(0.0, finite_number(record.get("cost", 0)))
    baseline = max(0.0, finite_number(
        record.get("rollingMinPositive7", record.get("rollingMedian7", 0))
    ))
    ratio = cost / baseline if baseline > 0 else finite_number(record.get("costToRollingMedian7", 1), 1)
    increase = cost - baseline
    return (
        history_count >= 6
        and baseline >= 0.1
        and increase >= min_absolute_delta
        and ratio >= min_relative_increase
    )


def robust_z_value(record, min_absolute_delta):
    # The feature builder floors the MAD scale (see anomalyService.ts), so a flat history no longer
    # produces an unbounded z-score.
    return finite_number(record.get("robustZScore", 0))


def seasonal_reference(record):
    """Seasonal-naive reference cost: the larger of the same hour 24 h and 168 h earlier (0 if neither exists)."""
    return max(0.0, finite_number(record.get("costPrev24h", 0)), finite_number(record.get("costPrev168h", 0)))


def seasonal_spike(record, min_relative_increase, min_absolute_delta):
    cost = max(0.0, finite_number(record.get("cost", 0)))
    reference = seasonal_reference(record)
    return reference >= 0.1 and cost - reference >= min_absolute_delta and cost / reference >= min_relative_increase


def median_ratio_spike(record, min_relative_increase, min_absolute_delta):
    """Ratio rule against the rolling median (the z-score rule's centre) instead of the window minimum. Like the
    z-score rule it has no minimum reference cost, so at 1.875x and $1 it is the z-score rule where its scale floor binds."""
    cost = max(0.0, finite_number(record.get("cost", 0)))
    median = max(0.0, finite_number(record.get("rollingMedian7", 0)))
    ratio = cost / median if median > 0 else float("inf")
    return (int(finite_number(record.get("historyCount", 0))) >= 6 and cost - median >= min_absolute_delta
            and ratio >= min_relative_increase), (min(ratio, 1e6))


def dollar_spike(record, min_absolute_delta):
    """Dollar-only rule: the dollar increase over the ratio rule's reference (window minimum), with no ratio test."""
    cost = max(0.0, finite_number(record.get("cost", 0)))
    baseline = max(0.0, finite_number(record.get("rollingMinPositive7", record.get("rollingMedian7", 0))))
    increase = cost - baseline
    return (int(finite_number(record.get("historyCount", 0))) >= 6 and baseline >= 0.1 and increase >= min_absolute_delta), increase


def rule_flag_and_severity(record, detector, min_relative_increase, min_absolute_delta, z_threshold):
    if detector == "median_ratio_rule":
        return median_ratio_spike(record, min_relative_increase, min_absolute_delta)
    if detector == "dollar_rule":
        return dollar_spike(record, min_absolute_delta)
    if detector == "ratio_rule":
        return (material_cost_spike(record, min_relative_increase, min_absolute_delta),
                finite_number(record.get("costToRollingMinPositive7", 1), 1))
    if detector == "seasonal_rule":
        reference = seasonal_reference(record)
        cost = max(0.0, finite_number(record.get("cost", 0)))
        return seasonal_spike(record, min_relative_increase, min_absolute_delta), (cost / reference if reference > 0 else 0.0)
    z = robust_z_value(record, min_absolute_delta)
    history_count = int(finite_number(record.get("historyCount", 0)))
    increase = finite_number(record.get("cost", 0)) - finite_number(record.get("rollingMedian7", 0))
    return history_count >= 6 and z >= z_threshold and increase >= min_absolute_delta, min(z, 1e6)


def rule_eligible(record, detector):
    """Rows a rule can rank at all (its preconditions), used for alert-budget matching."""
    if detector == "seasonal_rule":
        return seasonal_reference(record) >= 0.1
    if detector == "median_ratio_rule":
        return int(finite_number(record.get("historyCount", 0))) >= 6
    baseline = max(0.0, finite_number(record.get("rollingMinPositive7", record.get("rollingMedian7", 0))))
    return int(finite_number(record.get("historyCount", 0))) >= 6 and baseline >= 0.1


def evaluate_rule_grid(records, labels, mask, detector, z_threshold):
    """Label-assisted grid over a rule's own thresholds, scored only on the evaluation window."""
    tuning_results, best = [], None
    ratios = [1.0] if detector == "dollar_rule" else TUNING_MIN_RELATIVE_INCREASES
    deltas = TUNING_DOLLAR_DELTAS if detector == "dollar_rule" else TUNING_MIN_ABSOLUTE_DELTAS
    for min_relative_increase in ratios:
        for min_absolute_delta in deltas:
            predictions = [rule_flag_and_severity(r, detector, min_relative_increase, min_absolute_delta, z_threshold)[0] for r in records]
            result = {"minRelativeIncrease": min_relative_increase, "minAbsoluteDelta": min_absolute_delta,
                      **confusion_metrics(masked(predictions, mask), masked(labels, mask))}
            tuning_results.append(result)
            if best is None or (result["f1"], result["precision"], result["recall"]) > (best["f1"], best["precision"], best["recall"]):
                best = result
    return tuning_results, best


def rule_predictions(records, detector, min_relative_increase, min_absolute_delta, z_threshold):
    """Label-free rule baselines evaluated under the same protocol as Isolation Forest."""
    predictions = []
    severity_scores = []
    for record in records:
        if detector in RULE_DETECTORS_WITH_THRESHOLDS:
            flagged, severity = rule_flag_and_severity(record, detector, min_relative_increase, min_absolute_delta, z_threshold)
        else:
            z = robust_z_value(record, min_absolute_delta)
            history_count = int(finite_number(record.get("historyCount", 0)))
            increase = finite_number(record.get("cost", 0)) - finite_number(record.get("rollingMedian7", 0))
            flagged = history_count >= 6 and z >= z_threshold and increase >= min_absolute_delta
            severity = min(z, 1e6)
        predictions.append(bool(flagged))
        severity_scores.append(float(severity))
    severity_scores = np.asarray(severity_scores, dtype=float)
    return predictions, -severity_scores, severity_scores


def model_scores(records, contamination, n_estimators, max_samples, random_state, features=FEATURES, fit_rows=None):
    # fit_rows: indices the scaler and forest are fitted on (default: all rows); every row is scored.
    matrix = feature_matrix(records, features)
    fit_matrix = matrix if fit_rows is None else matrix[fit_rows]
    scaler = RobustScaler().fit(fit_matrix)
    scaled = scaler.transform(matrix)
    model = IsolationForest(
        contamination=contamination,
        n_estimators=n_estimators,
        max_samples=max_samples,
        random_state=random_state,
        n_jobs=-1,
    )
    model.fit(scaler.transform(fit_matrix))
    decision_scores = model.decision_function(scaled)
    return decision_scores, -decision_scores


def predictions_for(records, severity_scores, percentile, min_relative_increase, min_absolute_delta, reference_rows=None):
    # reference_rows: the rows whose scores define the percentile (default: all rows).
    reference = severity_scores[reference_rows] if reference_rows else severity_scores
    threshold = float(np.percentile(reference, percentile))
    predictions = [
        bool(
            severity >= threshold
            and material_cost_spike(record, min_relative_increase, min_absolute_delta)
        )
        for record, severity in zip(records, severity_scores)
    ]
    return threshold, predictions


def masked(values, mask):
    return [value for value, keep in zip(values, mask) if keep]


def evaluate_grid(records, labels, mask, contamination, n_estimators, max_samples, random_state, features=FEATURES, fit_rows=None):
    """Label-assisted grid search, scored only on rows inside the evaluation window (mask)."""
    tuning_results = []
    best_f1 = None
    best_precision = None
    selected_scores = None
    selected_decisions = None

    for contamination in [contamination]:
        decision_scores, severity_scores = model_scores(records, contamination, n_estimators, max_samples, random_state, features, fit_rows)
        for percentile in TUNING_PERCENTILES:
            for min_relative_increase in TUNING_MIN_RELATIVE_INCREASES:
                for min_absolute_delta in TUNING_MIN_ABSOLUTE_DELTAS:
                    threshold, predictions = predictions_for(
                        records, severity_scores, percentile, min_relative_increase, min_absolute_delta, fit_rows
                    )
                    result = {
                        "contamination": contamination,
                        "thresholdPercentile": percentile,
                        "selectedThreshold": threshold,
                        "minRelativeIncrease": min_relative_increase,
                        "minAbsoluteDelta": min_absolute_delta,
                        **confusion_metrics(masked(predictions, mask), masked(labels, mask)),
                    }
                    tuning_results.append(result)
                    if best_f1 is None or (result["f1"], result["precision"], result["recall"]) > (
                        best_f1["f1"], best_f1["precision"], best_f1["recall"]
                    ):
                        best_f1 = result
                        selected_scores = severity_scores
                        selected_decisions = decision_scores
                    if result["recall"] >= 0.5 and (
                        best_precision is None
                        or (result["precision"], result["f1"], result["recall"]) > (
                            best_precision["precision"], best_precision["f1"], best_precision["recall"]
                        )
                    ):
                        best_precision = result

    return tuning_results, best_f1, best_precision, selected_decisions, selected_scores


def detect(records, options):
    if not records:
        return {"results": [], "metadata": options}

    contamination = finite_number(options.get("contamination", 0.02), 0.02)
    contamination = min(0.49, max(0.0001, contamination))
    n_estimators = max(50, int(finite_number(options.get("nEstimators", 300), 300)))
    random_state = int(finite_number(options.get("randomState", 42), 42))
    max_samples = options.get("maxSamples", "auto")
    if isinstance(max_samples, str) and max_samples != "auto":
        max_samples = int(finite_number(max_samples, 256))

    detector = options.get("detector", "isolation_forest")
    if detector not in DETECTORS:
        raise ValueError(f"Unknown detector {detector!r}; expected one of {DETECTORS}.")
    z_threshold = finite_number(options.get("robustZThreshold", DEFAULT_ROBUST_Z_THRESHOLD), DEFAULT_ROBUST_Z_THRESHOLD)
    labels = [bool(record.get("isGroundTruth", False)) for record in records]
    # Rows outside the evaluation window (e.g. the other time block) never contribute to calibration.
    mask = [bool(record.get("inEvalWindow", True)) for record in records]
    post_filter = bool(options.get("postFilter", True))
    alert_budget = options.get("alertBudget")
    feature_set = options.get("featureSet", "all")
    fit_charged_only = bool(options.get("fitChargedOnly", False))
    budget_rank_by = options.get("budgetRankBy", "severity")
    # budgetPool "flagged": rank only rows the rule itself flags at the given thresholds (the pool a gate on
    # that rule can choose from), instead of every row meeting the rule's preconditions.
    budget_pool = options.get("budgetPool", "eligible")
    fit_outside = bool(options.get("fitOutsideEvalWindow", False))
    min_relative_increase = finite_number(options.get("minRelativeIncrease", 2.0), 2.0)
    min_absolute_delta = finite_number(options.get("minAbsoluteDelta", 0.5), 0.5)
    requested_threshold_percentile = options.get("thresholdPercentile")
    wants_calibration = bool(options.get("calibrateThreshold", False) or options.get("calibrationUsed", False))
    calibration_used = bool(
        wants_calibration
        and any(masked(labels, mask))
        and ((detector == "isolation_forest" and post_filter) or detector in RULE_DETECTORS_WITH_THRESHOLDS)
    )

    tuning_results = None
    best_f1_config = None
    best_precision_config = None
    selected_threshold = None
    threshold_percentile = None
    if detector != "isolation_forest":
        if calibration_used:
            tuning_results, best_f1_config = evaluate_rule_grid(records, labels, mask, detector, z_threshold)
            min_relative_increase = best_f1_config["minRelativeIncrease"]
            min_absolute_delta = best_f1_config["minAbsoluteDelta"]
        predictions, decision_scores, severity_scores = rule_predictions(
            records, detector, min_relative_increase, min_absolute_delta, z_threshold
        )
        if alert_budget is not None and detector in RULE_DETECTORS_WITH_THRESHOLDS + ["robust_z"]:
            # Budget-matched rule: flag the top-k in-window rows by the rule's own severity (among rows
            # meeting its preconditions), with k set to another detector's alert count.
            budget = max(0, int(finite_number(alert_budget, 0)))
            # budgetRankBy "delta": rank the ratio rule's eligible rows by dollar increase over the reference
            # cost instead of by cost ratio (the dollar-threshold counterpart of the ratio ranking).
            if budget_rank_by == "delta" and detector == "ratio_rule":
                rank_key = [max(0.0, finite_number(r.get("cost", 0))) - max(0.0, finite_number(r.get("rollingMinPositive7", 0))) for r in records]
            else:
                rank_key = severity_scores
            def in_pool(i):
                if budget_pool == "flagged":
                    return rule_predictions([records[i]], detector, min_relative_increase, min_absolute_delta, z_threshold)[0][0]
                if detector in ("robust_z", "median_ratio_rule"):
                    # The z-score rule's own preconditions: six earlier charged rows and the dollar increase.
                    increase = finite_number(records[i].get("cost", 0)) - finite_number(records[i].get("rollingMedian7", 0))
                    return int(finite_number(records[i].get("historyCount", 0))) >= 6 and increase >= min_absolute_delta
                return rule_eligible(records[i], detector)
            ranked = sorted((i for i, keep in enumerate(mask) if keep and in_pool(i)), key=lambda i: (-rank_key[i], i))
            chosen = set(ranked[:budget])
            predictions = [i in chosen for i in range(len(records))]
    elif not post_filter:
        # Standalone Isolation Forest: the model score alone decides. With an alert budget, flag the
        # top-k in-window rows (matched to a baseline's alert count); otherwise use the model's own
        # contamination threshold (decision_function < 0).
        features = NUMERIC_FEATURES if feature_set == "numeric" else FEATURES
        charged = [finite_number(record.get("cost", 0)) > 0 for record in records]
        fit_rows = [i for i in range(len(records)) if (charged[i] or not fit_charged_only) and not (fit_outside and mask[i])] \
            if fit_charged_only or fit_outside else None
        decision_scores, severity_scores = model_scores(
            records, contamination, n_estimators, max_samples, random_state, features, fit_rows
        )
        if alert_budget is not None:
            budget = max(0, int(finite_number(alert_budget, 0)))
            candidates = (i for i, keep in enumerate(mask) if keep and (charged[i] or not fit_charged_only))
            in_window = sorted(candidates, key=lambda i: (-severity_scores[i], i))
            chosen = set(in_window[:budget])
            predictions = [i in chosen for i in range(len(records))]
        else:
            predictions = [bool(score < 0 and (charged[i] or not fit_charged_only)) for i, score in enumerate(decision_scores)]
    elif calibration_used:
        # featureSet "numeric" / fitChargedOnly also apply to calibration: the grid is then searched with the forest
        # fitted, and the percentile taken, on charged rows without category codes.
        calibration_features = NUMERIC_FEATURES if feature_set == "numeric" else FEATURES
        calibration_fit_rows = [i for i, record in enumerate(records) if finite_number(record.get("cost", 0)) > 0] if fit_charged_only else None
        tuning_results, best_f1_config, best_precision_config, decision_scores, severity_scores = evaluate_grid(
            records, labels, mask, contamination, n_estimators, max_samples, random_state, calibration_features, calibration_fit_rows
        )
        contamination = best_f1_config["contamination"]
        threshold_percentile = best_f1_config["thresholdPercentile"]
        selected_threshold = best_f1_config["selectedThreshold"]
        min_relative_increase = best_f1_config["minRelativeIncrease"]
        min_absolute_delta = best_f1_config["minAbsoluteDelta"]
        _, predictions = predictions_for(
            records, severity_scores, threshold_percentile, min_relative_increase, min_absolute_delta, calibration_fit_rows
        )
    else:
        # fitOutsideEvalWindow: fit on the other half and take the gate's percentile over its scores (held out).
        # featureSet "numeric" / fitChargedOnly: fit (and take the percentile) on charged rows without category codes.
        features = NUMERIC_FEATURES if feature_set == "numeric" else FEATURES
        charged = [finite_number(record.get("cost", 0)) > 0 for record in records]
        fit_rows = [i for i in range(len(records)) if not (fit_outside and mask[i]) and (charged[i] or not fit_charged_only)] \
            if fit_outside or fit_charged_only else None
        decision_scores, severity_scores = model_scores(records, contamination, n_estimators, max_samples, random_state, features, fit_rows)
        threshold_percentile = finite_number(requested_threshold_percentile, None) if requested_threshold_percentile is not None else None
        if threshold_percentile is not None:
            reference_scores = severity_scores[fit_rows] if fit_rows else severity_scores
            selected_threshold = float(np.percentile(reference_scores, threshold_percentile))
        else:
            selected_threshold = None
        threshold = selected_threshold if selected_threshold is not None else 0.0
        predictions = [
            bool(
                severity >= threshold
                and material_cost_spike(record, min_relative_increase, min_absolute_delta)
            )
            for record, severity in zip(records, severity_scores)
        ]

    results = []
    for record, is_anomaly, decision_score, severity_score in zip(
        records, predictions, decision_scores, severity_scores
    ):
        robust_z = finite_number(record.get("robustZScore", 0))
        ratio = finite_number(record.get("costToRollingMedian7", 1), 1)
        anomaly_strength = max(
            0.0,
            float(severity_score),
            robust_z / 10.0,
            (ratio - 1.0) / 5.0,
            (finite_number(record.get("costToRollingMinPositive7", 1), 1) - 1.0) / 5.0,
        ) if is_anomaly else 0.0
        results.append({
            "id": record.get("id"),
            "timestamp": record.get("timestamp"),
            "isAnomaly": bool(is_anomaly),
            "score": float(decision_score),
            "anomalyStrength": float(anomaly_strength),
            "severity": (
                "critical" if is_anomaly and anomaly_strength >= 1
                else "high" if is_anomaly and anomaly_strength >= 0.5
                else "medium" if is_anomaly else "normal"
            ),
            "features": {feature: finite_number(record.get(feature, 0)) for feature in FEATURES},
        })

    finite_scores = severity_scores[np.isfinite(severity_scores)]
    score_distribution = {
        f"p{percentile}": float(np.percentile(finite_scores, percentile)) if finite_scores.size else 0.0
        for percentile in [50, 90, 95, 96, 97, 98, 99]
    }
    return {
        "results": results,
        "metadata": {
            "detector": detector,
            "postFilter": post_filter,
            "alertBudget": alert_budget,
            "featureSet": feature_set,
            "fitChargedOnly": fit_charged_only,
            "budgetRankBy": budget_rank_by,
            "budgetPool": budget_pool,
            "fitOutsideEvalWindow": fit_outside,
            "robustZThreshold": z_threshold if detector == "robust_z" else None,
            "contamination": contamination,
            "nEstimators": n_estimators,
            "maxSamples": str(max_samples),
            "randomState": random_state,
            "calibrationUsed": calibration_used,
            "selectedThreshold": selected_threshold,
            "thresholdPercentile": threshold_percentile,
            "scoreDistribution": score_distribution,
            "tuningResults": tuning_results,
            "bestF1Config": best_f1_config,
            "bestPrecisionConfig": best_precision_config,
            "minRelativeIncrease": min_relative_increase,
            "minAbsoluteDelta": min_absolute_delta,
            "labeledAnomalies": sum(masked(labels, mask)),
            "detectedAnomalies": sum(predictions),
        },
    }


def main():
    if len(sys.argv) not in [2, 3]:
        print("Usage: python detect_anomalies.py input.json [output.json]", file=sys.stderr)
        sys.exit(1)

    input_path = Path(sys.argv[1])
    records, options = load_payload(input_path)
    output = json.dumps(detect(records, options), indent=2)

    if len(sys.argv) == 3:
        Path(sys.argv[2]).write_text(output + "\n", encoding="utf-8")
    else:
        print(output)


if __name__ == "__main__":
    main()
