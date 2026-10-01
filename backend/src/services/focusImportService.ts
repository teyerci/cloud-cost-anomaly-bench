import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";

type FocusInternalField =
  | "timestamp"
  | "provider"
  | "accountId"
  | "service"
  | "region"
  | "tagProject"
  | "usageQuantity"
  | "cost"
  | "currency"
  | "resourceId";

type CsvRow = Record<string, string | undefined>;

export type FocusColumnMapping = Partial<Record<FocusInternalField, string>>;

export type FocusImportSummary = {
  totalRows: number;
  insertedRows: number;
  skippedRows: number;
  validationErrors: string[];
  detectedColumns: string[];
  mappedColumns: FocusColumnMapping;
};

const columnCandidates: Record<FocusInternalField, string[]> = {
  timestamp: ["ChargePeriodStart", "BillingPeriodStart", "x_UsageDate", "UsageDate", "Date"],
  provider: ["ProviderName", "PublisherName", "x_ProviderName"],
  accountId: ["BillingAccountId", "SubAccountId", "LinkedAccountId", "x_AccountId", "AccountId"],
  service: ["ServiceName", "ConsumedService", "ResourceType", "ChargeCategory", "x_ServiceName"],
  region: ["Region", "RegionName", "AvailabilityZone", "x_Region"],
  tagProject: ["Tags", "Tag", "x_Project", "Project", "ResourceTags"],
  usageQuantity: ["UsageQuantity", "PricingQuantity", "x_UsageQuantity", "ConsumedQuantity"],
  cost: ["EffectiveCost", "BilledCost", "ContractedCost", "ListCost", "AmortizedCost", "Cost"],
  currency: ["BillingCurrency", "Currency", "PricingCurrency"],
  resourceId: ["ResourceId", "ResourceName", "x_ResourceId"]
};

function normalizeColumnName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function buildFocusColumnMapping(columns: string[]): FocusColumnMapping {
  const normalized = new Map(columns.map((column) => [normalizeColumnName(column), column]));
  const mapping: FocusColumnMapping = {};

  for (const [field, candidates] of Object.entries(columnCandidates) as Array<[FocusInternalField, string[]]>) {
    const match = candidates.map(normalizeColumnName).map((candidate) => normalized.get(candidate)).find(Boolean);
    if (match) mapping[field] = match;
  }

  return mapping;
}

function clean(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function valueFor(row: CsvRow, mapping: FocusColumnMapping, field: FocusInternalField) {
  const column = mapping[field];
  return column ? clean(row[column]) : undefined;
}

function numberValue(raw: string | undefined) {
  if (!raw) return undefined;
  const parsed = Number(raw.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function traceRow(row: CsvRow, mapping: FocusColumnMapping) {
  return Object.values(mapping).reduce<Record<string, string>>((acc, column) => {
    const value = column ? row[column] : undefined;
    if (column && value !== undefined) acc[column] = value;
    return acc;
  }, {});
}

export function normalizeFocusRow(row: CsvRow, mapping: FocusColumnMapping, rowNumber = 0) {
  const timestampRaw = valueFor(row, mapping, "timestamp");
  const costRaw = valueFor(row, mapping, "cost");
  const timestamp = timestampRaw ? new Date(timestampRaw) : undefined;
  const cost = numberValue(costRaw);
  const errors: string[] = [];

  if (!timestamp || Number.isNaN(timestamp.getTime())) errors.push(`Row ${rowNumber}: timestamp is missing or invalid.`);
  if (cost === undefined) errors.push(`Row ${rowNumber}: cost is missing or invalid.`);

  if (errors.length > 0 || !timestamp || cost === undefined) {
    return { errors };
  }

  const usageQuantity = numberValue(valueFor(row, mapping, "usageQuantity")) ?? 0;
  const tagProject = valueFor(row, mapping, "tagProject") ?? "unknown";
  const provider = valueFor(row, mapping, "provider") ?? "unknown";
  const account = valueFor(row, mapping, "accountId") ?? "unknown";
  const service = valueFor(row, mapping, "service") ?? "unknown";
  const region = valueFor(row, mapping, "region") ?? "unknown";
  const currency = valueFor(row, mapping, "currency") ?? "USD";
  const resourceId = valueFor(row, mapping, "resourceId") ?? null;

  return {
    errors,
    record: {
      timestamp,
      account,
      service,
      region,
      resourceId,
      cost,
      usageQuantity,
      tags: { project: tagProject },
      sourceType: "focus",
      provider,
      currency,
      rawSource: traceRow(row, mapping)
    }
  };
}

function parseCsv(content: string): CsvRow[] {
  return parse(content, {
    bom: true,
    columns: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true
  }) as CsvRow[];
}

function resolveImportPath(filePath: string) {
  if (!filePath.trim()) throw new Error("filePath is required.");
  if (path.isAbsolute(filePath)) return filePath;

  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, filePath),
    path.resolve(cwd, "..", filePath)
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

async function readCsvFile(filePath: string) {
  const resolvedPath = resolveImportPath(filePath);
  const fileStat = await stat(resolvedPath);
  if (!fileStat.isFile()) {
    throw new Error(`FOCUS import path must be a CSV file, not a directory: ${filePath}`);
  }
  return readFile(resolvedPath, "utf-8");
}

export async function previewFocusMapping(filePath: string) {
  const content = await readCsvFile(filePath);
  return previewFocusCsvContent(content);
}

export function previewFocusCsvContent(content: string) {
  const rows = parseCsv(content);
  const detectedColumns = rows.length ? Object.keys(rows[0]) : [];
  return {
    detectedColumns,
    mappedColumns: buildFocusColumnMapping(detectedColumns),
    sampleRows: rows.slice(0, 5)
  };
}

export async function importFocusCsvContent(prisma: PrismaClient, content: string): Promise<FocusImportSummary> {
  const rows = parseCsv(content);
  const detectedColumns = rows.length ? Object.keys(rows[0]) : [];
  const mappedColumns = buildFocusColumnMapping(detectedColumns);
  const validationErrors: string[] = [];
  const records: Prisma.BillingRecordCreateManyInput[] = [];

  rows.forEach((row, index) => {
    const normalized = normalizeFocusRow(row, mappedColumns, index + 2);
    validationErrors.push(...normalized.errors);
    if (normalized.record) records.push(normalized.record);
  });

  if (records.length > 0) {
    await prisma.billingRecord.createMany({ data: records });
  }

  return {
    totalRows: rows.length,
    insertedRows: records.length,
    skippedRows: rows.length - records.length,
    validationErrors,
    detectedColumns,
    mappedColumns
  };
}

export async function importFocusCsv(prisma: PrismaClient, filePath: string): Promise<FocusImportSummary> {
  const content = await readCsvFile(filePath);
  return importFocusCsvContent(prisma, content);
}
