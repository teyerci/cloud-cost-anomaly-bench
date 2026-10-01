import assert from "node:assert/strict";
import { buildFocusColumnMapping, normalizeFocusRow, previewFocusCsvContent } from "../src/services/focusImportService.js";

const columns = ["ChargePeriodStart", "ProviderName", "BillingAccountId", "ServiceName", "Region", "EffectiveCost", "UsageQuantity", "BillingCurrency"];
const mapping = buildFocusColumnMapping(columns);

assert.equal(mapping.timestamp, "ChargePeriodStart");
assert.equal(mapping.provider, "ProviderName");
assert.equal(mapping.accountId, "BillingAccountId");
assert.equal(mapping.service, "ServiceName");
assert.equal(mapping.cost, "EffectiveCost");

const valid = normalizeFocusRow(
  {
    ChargePeriodStart: "2026-05-01T00:00:00Z",
    ProviderName: "Example Cloud",
    BillingAccountId: "acct-1",
    ServiceName: "Compute",
    Region: "us-east-1",
    EffectiveCost: "12.34",
    UsageQuantity: "9",
    BillingCurrency: "EUR"
  },
  mapping,
  2
);

assert.equal(valid.errors.length, 0);
assert.equal(valid.record?.account, "acct-1");
assert.equal(valid.record?.currency, "EUR");

const missingOptional = normalizeFocusRow({ ChargePeriodStart: "2026-05-01", EffectiveCost: "0" }, mapping, 3);
assert.equal(missingOptional.errors.length, 0);
assert.equal(missingOptional.record?.provider, "unknown");
assert.equal(missingOptional.record?.usageQuantity, 0);

const invalidTimestamp = normalizeFocusRow({ ChargePeriodStart: "not-a-date", EffectiveCost: "1" }, mapping, 4);
assert.equal(invalidTimestamp.record, undefined);
assert.equal(invalidTimestamp.errors.length, 1);

const invalidCost = normalizeFocusRow({ ChargePeriodStart: "2026-05-01", EffectiveCost: "abc" }, mapping, 5);
assert.equal(invalidCost.record, undefined);
assert.equal(invalidCost.errors.length, 1);

const preview = previewFocusCsvContent("UsageDate,Cost\n2026-05-01,10\n");
assert.equal(preview.detectedColumns.length, 2);
assert.equal(preview.mappedColumns.timestamp, "UsageDate");
assert.equal(preview.mappedColumns.cost, "Cost");

console.log("FOCUS import verification passed.");
