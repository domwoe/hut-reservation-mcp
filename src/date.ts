const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SWISS_DATE_RE = /^\d{2}\.\d{2}\.\d{4}$/;

export function parseIsoDate(input: string): Date {
  if (!ISO_DATE_RE.test(input)) {
    throw new Error(`Expected ISO date YYYY-MM-DD, got ${input}`);
  }

  const [year, month, day] = input.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date ${input}`);
  }
  return date;
}

export function formatIsoDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function toSwissDate(input: string): string {
  const date = parseIsoDate(input);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const year = date.getUTCFullYear();
  return `${day}.${month}.${year}`;
}

function parseSwissDate(input: string): Date {
  if (!SWISS_DATE_RE.test(input)) {
    throw new Error(`Invalid Swiss date: ${input}`);
  }

  const [day, month, year] = input.split(".").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid Swiss date: ${input}`);
  }
  return date;
}

export function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function nightsBetween(arrivalDate: string, departureDate: string): string[] {
  const arrival = parseIsoDate(arrivalDate);
  const departure = parseIsoDate(departureDate);
  if (departure.getTime() <= arrival.getTime()) {
    throw new Error("departureDate must be after arrivalDate");
  }

  const nights: string[] = [];
  for (let cursor = arrival; cursor.getTime() < departure.getTime(); cursor = addUtcDays(cursor, 1)) {
    nights.push(formatIsoDate(cursor));
  }
  return nights;
}

export function swissToIsoDate(input: string): string {
  return formatIsoDate(parseSwissDate(input));
}
