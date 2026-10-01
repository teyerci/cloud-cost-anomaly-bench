import type { BillingRecord } from "@prisma/client";

// Postgres returns ties in arbitrary physical order, and row order feeds rolling features,
// baseline selection, and Isolation Forest subsampling. Sort on content so identical data
// always produces identical results, independent of generated IDs or insert order.
export function compareBillingRecords(left: BillingRecord, right: BillingRecord) {
  return left.timestamp.getTime() - right.timestamp.getTime()
    || compareText(left.account, right.account)
    || compareText(left.service, right.service)
    || compareText(left.region, right.region)
    || compareText(left.resourceId ?? "", right.resourceId ?? "")
    || left.cost - right.cost
    || left.usageQuantity - right.usageQuantity
    || compareText(JSON.stringify(left.tags ?? null), JSON.stringify(right.tags ?? null));
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
