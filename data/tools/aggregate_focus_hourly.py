"""Aggregate a FOCUS 1.0 line-item export to one row per billing account / service / region / hour.

The full FOCUS sample (focus_data_table.csv.gz, ~5.5M line items) is too large to load row by row, and
line items of different resources in the same series and hour are not each other's history. This script
streams the file and writes hourly series totals in the FOCUS column names that
backend/src/services/focusImportService.ts reads, so the regular importer can load the result.

Usage:
    python3 data/tools/aggregate_focus_hourly.py <focus_data_table.csv[.gz]> <output.csv> [--month 2024-09]

Rows outside --month (default: the month with the most line items) are dropped; the full sample has
115 stray March 2024 rows next to a complete September 2024.
"""
import collections
import csv
import gzip
import sys

# Columns the importer maps, in its candidate order.
TIMESTAMP, ACCOUNT, SERVICE, REGION = "ChargePeriodStart", "BillingAccountId", "ServiceName", "RegionName"
COST, USAGE, PROVIDER, CURRENCY = "EffectiveCost", "ConsumedQuantity", "ProviderName", "BillingCurrency"


def number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def read_rows(path):
    opener = gzip.open if path.endswith(".gz") else open
    csv.field_size_limit(10**9)
    with opener(path, "rt", newline="", errors="replace") as handle:
        yield from csv.DictReader(handle)


def main():
    argv = sys.argv[1:]
    month = None
    if "--month" in argv:
        position = argv.index("--month")
        month = argv[position + 1]
        del argv[position:position + 2]
    if len(argv) != 2:
        sys.exit(__doc__)
    source, target = argv

    if month is None:
        months = collections.Counter(row[TIMESTAMP][:7] for row in read_rows(source))
        month = months.most_common(1)[0][0]

    totals = {}
    line_items = kept = 0
    for row in read_rows(source):
        line_items += 1
        stamp = row[TIMESTAMP]
        if not stamp.startswith(month):
            continue
        kept += 1
        hour = f"{stamp[:10]}T{stamp[11:13]}:00:00Z"
        key = (hour, row[ACCOUNT], row[SERVICE], row[REGION])
        entry = totals.get(key)
        if entry is None:
            entry = totals[key] = {"cost": 0.0, "usage": 0.0, "items": 0, "providers": collections.Counter(), "currencies": collections.Counter()}
        entry["cost"] += number(row[COST])
        entry["usage"] += number(row[USAGE])
        entry["items"] += 1
        entry["providers"][row[PROVIDER]] += 1
        entry["currencies"][row[CURRENCY]] += 1
        if line_items % 1_000_000 == 0:
            print(f"... {line_items:,} line items, {len(totals):,} hourly series rows", file=sys.stderr, flush=True)

    with open(target, "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow([TIMESTAMP, ACCOUNT, SERVICE, REGION, COST, USAGE, PROVIDER, CURRENCY, "x_LineItemCount"])
        for (hour, account, service, region), entry in sorted(totals.items()):
            writer.writerow([
                hour, account, service, region,
                f"{entry['cost']:.10f}", f"{entry['usage']:.10f}",
                entry["providers"].most_common(1)[0][0], entry["currencies"].most_common(1)[0][0], entry["items"],
            ])
    print(f"month {month}: {kept:,} of {line_items:,} line items -> {len(totals):,} hourly series rows in {target}", file=sys.stderr)


if __name__ == "__main__":
    main()
