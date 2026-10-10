const INACTIVE_STATUSES = new Set([
  'archived',
  'deleted',
  'historical',
  'inactive',
  'invalid',
  'rejected',
  'stale',
  'superseded',
]);

function parseOptionalDate(value) {
  if (!value) return null;
  const normalized = String(value).trim();
  const parts = normalized.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-](\d{2}):(\d{2})))?$/u);
  if (!parts) return Number.NaN;
  const [, yearText, monthText, dayText, hourText = '00', minuteText = '00', secondText = '00', zone, offsetHourText, offsetMinuteText] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [0, 31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month] ?? 0;
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return Number.NaN;
  if (zone && zone !== 'Z' && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return Number.NaN;
  const parsed = Date.parse(zone ? normalized : `${normalized}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function routePassesHardGates(row, now) {
  if (!row || Number(row.active) !== 1) return false;
  if (row.answerability !== 'route_authority' || row.resolution !== 'resolved') return false;
  const freshUntil = parseOptionalDate(row.fresh_until);
  return freshUntil === null || (Number.isFinite(freshUntil) && freshUntil >= now.getTime());
}

export function recordPassesHardGates(row, { now, historicalIntent }) {
  if (!row || Number(row.active) !== 1) return false;
  if (row.answerability !== 'memory_allowed' || row.authority_resolution !== 'resolved') return false;

  const status = String(row.status ?? '').toLocaleLowerCase('und');
  const superseded = Boolean(row.superseded_by) || Number(row.has_successor_edge) === 1;
  if (!historicalIntent && (superseded || INACTIVE_STATUSES.has(status))) return false;

  const validFrom = parseOptionalDate(row.valid_from);
  if (Number.isNaN(validFrom) || (validFrom !== null && validFrom > now.getTime())) return false;

  if (!historicalIntent) {
    const validTo = parseOptionalDate(row.valid_to);
    const freshUntil = parseOptionalDate(row.fresh_until);
    if (Number.isNaN(validTo) || (validTo !== null && validTo < now.getTime())) return false;
    if (Number.isNaN(freshUntil) || (freshUntil !== null && freshUntil < now.getTime())) return false;
  }
  return true;
}

export function clampInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(numeric)));
}

export function clampNumber(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, numeric));
}

export function scoreEvidenceCandidate(candidate, activeProjectId) {
  const projectMatch = Boolean(activeProjectId && candidate.row.project_id === activeProjectId);
  const authorityStrength = Math.min(1, Math.max(0, Number(candidate.row.authority_rank ?? 0) / 60));
  const exactStrength = Math.min(1, Math.max(0, Number(candidate.exactStrength ?? 0)));
  const lexicalCoverage = Math.min(1, Math.max(0, Number(candidate.coverage ?? 0)));
  const matchDepth = Math.min(1, Math.max(0, Number(candidate.matchedShingles ?? 0) / 3));
  const branchAgreement = exactStrength > 0 && candidate.fts === 1;
  const score = Math.min(1,
    exactStrength * 0.65
    + lexicalCoverage * 0.42
    + matchDepth * 0.22
    + Number(projectMatch) * 0.15
    + authorityStrength * 0.09
    + Number(branchAgreement) * 0.08,
  );
  return { ...candidate, score, projectMatch, authorityStrength, branchAgreement };
}

export function candidateHasStrongSupport(candidate, exactAliasFloor) {
  if (candidate.exactStrength > 0 && candidate.exactStrength < exactAliasFloor) return false;
  const strongExact = candidate.exactDirect
    && candidate.exactStrength >= exactAliasFloor
    && candidate.exactTargetCount === 1;
  const embeddedExactWithProject = !candidate.exactDirect
    && candidate.exactStrength >= exactAliasFloor
    && candidate.branchAgreement
    && candidate.projectMatch;
  // FTS-only candidates remain observable in shadow telemetry but never cross
  // the default push gate; active-project context is routing context, not an
  // independent relevance signal.
  return strongExact || embeddedExactWithProject;
}
