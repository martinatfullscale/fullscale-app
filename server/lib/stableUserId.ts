// Deterministic int4 id for legacy integer userId columns (remixJobs,
// distributionProfiles, publishingSchedules). Users keyed by UUID or email
// hash to a stable positive int until the Tier-3 column migration lands.
// Extracted from routes.ts so OAuth connect flows derive the same ids as
// the API routes.
export function stableUserIntId(raw: unknown): number {
  const s = raw == null ? "" : String(raw);
  if (s === "") return 1;
  const n = Number(s);
  if (Number.isInteger(n) && n > 0) return n;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  // % INT_MAX guards the one value (h === -2^31) where Math.abs exceeds the
  // int4 column range; || 1 covers the zero cases.
  return (Math.abs(h) % 2147483647) || 1;
}
