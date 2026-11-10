export function attendanceNeedsReview(person: Record<string, unknown>, latestChecks?: Map<string, Record<string, unknown>>): boolean;
export function attendanceNotEntered(person: Record<string, unknown>): boolean;
export function indexLatestChecks(checks: unknown): Map<string, Record<string, unknown>>;
