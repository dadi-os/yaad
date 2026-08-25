export function toSqlVector(values: number[]): string {
  return `[${values.join(",")}]`;
}

export function parseVector(value: unknown): number[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "number")) {
      return value;
    }
    return null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (inner.length === 0) {
    return [];
  }
  const parsed = inner.split(",").map((item) => Number(item.trim()));
  if (parsed.some((item) => Number.isNaN(item))) {
    return null;
  }
  return parsed;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    const a = left[i];
    const b = right[i];
    if (a === undefined || b === undefined) {
      return 0;
    }
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function cosineDistanceToSimilarity(distance: number): number {
  return 1 - distance;
}
