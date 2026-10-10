import type { ColumnInfo, Filter, FilterOp } from "./types";
import { structuredJsonForCopy } from "./structured";

export function isComparison(op: FilterOp): boolean {
  return ["eq", "ne", "gt", "lt", "gte", "lte"].includes(op);
}

export function defaultFilterOp(column?: ColumnInfo): FilterOp {
  return column?.kind === "text" || column?.kind === "nested" || column?.kind === "other" ? "contains" : "eq";
}

export function filterInputType(column: ColumnInfo, op: FilterOp): string {
  if (!isComparison(op)) return "text";
  if (column.kind === "number") return "number";
  const type = column.dataType.toUpperCase();
  if (type === "DATE") return "date";
  if (/^TIMESTAMP(?:_S|_MS|_NS)?$/.test(type)) return "datetime-local";
  if (type === "TIME") return "time";
  return "text"; // Zoned timestamps and intervals need their full textual representation.
}

export function isIntegerColumn(column: ColumnInfo): boolean {
  return /^(?:U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|U?HUGEINT|BIGNUM)$/.test(column.dataType.toUpperCase());
}

export function validateFilter(column: ColumnInfo, filter: Filter): string | null {
  if (filter.op === "is_null" || filter.op === "is_not_null") return null;
  if (filter.op === "contains_any" || filter.op === "not_contains_any") {
    return filter.value.split(",").some((v) => v.trim()) ? null : "Enter at least one comma-separated value.";
  }
  const value = filter.value.trim();
  if (!value && !(column.kind === "text" && ["eq", "ne"].includes(filter.op))) {
    return "Enter a filter value first.";
  }
  // Text operators intentionally search the displayed representation of any type.
  if (!isComparison(filter.op)) return null;
  if (column.kind === "number") {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(Number(value))) {
      return `Enter a finite number for ${column.name}.`;
    }
    if (isIntegerColumn(column)) {
      if (!/^[+-]?\d+$/.test(value)) return `Enter a whole number for ${column.name} (without a decimal point or exponent).`;
      const bits = { TINYINT: 8, SMALLINT: 16, INTEGER: 32, BIGINT: 64, HUGEINT: 128 };
      const type = column.dataType.toUpperCase();
      const unsigned = type.startsWith("U");
      const width = bits[(unsigned ? type.slice(1) : type) as keyof typeof bits];
      if (width) {
        const bound = 1n << BigInt(unsigned ? width : width - 1);
        const n = BigInt(value);
        if (n < (unsigned ? 0n : -bound) || n >= bound) return `Value is outside the ${column.dataType} range.`;
      }
    }
    const decimal = /^DECIMAL\((\d+),\s*(\d+)\)$/i.exec(column.dataType);
    if (decimal) {
      const [mantissa, exponent = "0"] = value.toLowerCase().split("e");
      const [whole, fraction = ""] = mantissa.replace(/^[+-]/, "").split(".");
      const digits = whole + fraction;
      const significant = digits.replace(/^0+/, "");
      if (significant) {
        const shift = Number(exponent) - fraction.length;
        const trailingZeros = significant.length - significant.replace(/0+$/, "").length;
        const scale = Number(decimal[2]);
        if (significant.length + shift > Number(decimal[1]) - scale || shift + trailingZeros < -scale) {
          return `Enter a value that fits ${column.dataType} without rounding.`;
        }
      }
    }
    if (/^FLOAT$/i.test(column.dataType) && Math.abs(Number(value)) > 3.4028234663852886e38) {
      return `Value is outside the ${column.dataType} range.`;
    }
  } else if (column.kind === "bool" && !/^(true|false)$/i.test(value)) {
    return "Choose true or false.";
  } else if (column.kind === "date") {
    const type = column.dataType.toUpperCase();
    if (/^[+-]?infinity$/i.test(value) && (type === "DATE" || type.startsWith("TIMESTAMP"))) return null;
    if (type === "DATE" || type.startsWith("TIMESTAMP")) {
      const date = /^(\d{4,})-(\d{2})-(\d{2})/.exec(value);
      if (!date) return type === "DATE" ? "Enter a date as YYYY-MM-DD." : "Enter a timestamp with a date and time.";
      const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]);
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (!year || month < 1 || month > 12 || day < 1 || day > days[month - 1]) return "Enter a valid calendar date.";
      if (type === "DATE" && value !== date[0]) return "Enter a date as YYYY-MM-DD.";
      if (type.startsWith("TIMESTAMP") && !/^\d{4,}-\d{2}-\d{2}[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3])(?::?[0-5]\d)?)?$/.test(value)) {
        return "Enter a valid timestamp, for example 2026-10-05 14:30:00.";
      }
    } else if (type.startsWith("TIME") && !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:[+-](?:[01]\d|2[0-3])(?::?[0-5]\d)?)?$/.test(value)) {
      return "Enter a valid time, for example 14:30:00.";
    }
  } else if (column.kind === "nested") {
    // Validate syntax only; keep the original JSON so large integers retain their digits.
    try { JSON.parse(structuredJsonForCopy(filter.value)); } catch { return "Enter valid JSON to compare a structured value."; }
  }
  return null;
}
