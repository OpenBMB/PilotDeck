export function formatReleaseDate(date, timeZone = "Asia/Shanghai") {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function buildDateVersion(releaseDate, revision = 0) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(releaseDate);
  if (!match) throw new Error(`Invalid desktop release date: ${releaseDate}`);
  const [, year, month, day] = match;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const daysInMonth = new Date(Date.UTC(Number(year), monthNumber, 0)).getUTCDate();
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > daysInMonth) {
    throw new Error(`Invalid desktop release date: ${releaseDate}`);
  }
  const parsedRevision = parseRevision(revision);
  return `${Number(year)}.${monthNumber * 100 + dayNumber}.${parsedRevision}`;
}

export function buildReleaseTag(releaseDate, revision = 0) {
  buildDateVersion(releaseDate, revision);
  const parsedRevision = parseRevision(revision);
  return `desktop-v${releaseDate.replaceAll("-", ".")}${parsedRevision > 0 ? `-r${parsedRevision + 1}` : ""}`;
}

export function parseRevision(value) {
  const normalized = value === undefined || value === null ? "" : String(value).trim();
  if (normalized !== "" && !/^\d+$/u.test(normalized)) {
    throw new Error(`Invalid desktop release revision: ${value}`);
  }
  const revision = normalized === "" ? 0 : Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(revision)) {
    throw new Error(`Invalid desktop release revision: ${value}`);
  }
  return revision;
}
