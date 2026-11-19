export function normalizeContactPhone(value: unknown): string;
export function phoneLeadingZeroRestored(value: unknown): boolean;
export function emailLooksValid(value: unknown): boolean;
export function companyKey(value: unknown): string;
export function companiesLookAlike(a: string, b: string): boolean;
export function suggestCompany(value: string, counts: Map<string, number>): { company: string; count: number } | null;
