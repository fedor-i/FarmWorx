import { getSetting } from './db.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const STALE_OPEN_SHIFT = 16 * 60 * MINUTE;
const MEAL_BREAK_AFTER = 5 * 60 * MINUTE;
const MEAL_BREAK_MIN = 30 * MINUTE;

export function localDate(ts, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
}

// Turns one person's punches, oldest first, into shifts. Bad sequences are flagged rather than
// guessed at: a shift without both ends has no hours until a supervisor adds the missing punch.
export function buildShifts(punches, now = Date.now()) {
  const shifts = [];
  let open = null;

  const close = (end, flag) => {
    if (open.breakStart) {
      open.breakMs += (end ?? now) - open.breakStart;
      open.breakStart = null;
    }
    open.end = end;
    if (flag) open.flags.push(flag);
    shifts.push(open);
    open = null;
  };

  for (const punch of punches) {
    if (punch.type === 'in') {
      if (open) close(null, 'missing_out');
      open = { start: punch.ts, end: null, breakMs: 0, breakStart: null, flags: [] };
    } else if (punch.type === 'out') {
      if (open) close(punch.ts);
      else shifts.push({ start: null, end: punch.ts, breakMs: 0, flags: ['missing_in'] });
    } else if (open && punch.type === 'break_start') {
      open.breakStart ??= punch.ts;
    } else if (open && punch.type === 'break_end' && open.breakStart) {
      open.breakMs += punch.ts - open.breakStart;
      open.breakStart = null;
    }
  }
  if (open) {
    if (now - open.start > STALE_OPEN_SHIFT) {
      close(null, 'missing_out');
    } else {
      open.running = true;
      close(null, 'open');
    }
  }

  return shifts.map(({ start, end, breakMs, flags, running }) => {
    const finish = end ?? (running ? now : null);
    const workedMs = start !== null && finish !== null ? Math.max(0, finish - start - breakMs) : null;
    if (workedMs > MEAL_BREAK_AFTER && breakMs < MEAL_BREAK_MIN) flags.push('short_break');
    return {
      start,
      end,
      breakMin: Math.round(breakMs / MINUTE),
      workedMin: workedMs === null ? null : Math.round(workedMs / MINUTE),
      flags,
    };
  });
}

export function timesheet(db, from, to, now = Date.now()) {
  const tz = getSetting(db, 'timezone', 'UTC');
  const lower = Date.parse(from) - 2 * DAY;
  const upper = Date.parse(to) + 3 * DAY;
  const people = db.prepare("SELECT id, name FROM people WHERE role = 'worker' ORDER BY name").all();
  const punchesFor = db.prepare('SELECT type, ts FROM punches WHERE person_id = ? AND ts BETWEEN ? AND ? ORDER BY ts');

  const rows = [];
  const totals = [];
  for (const person of people) {
    let totalMin = 0;
    for (const shift of buildShifts(punchesFor.all(person.id, lower, upper), now)) {
      const date = localDate(shift.start ?? shift.end, tz);
      if (date < from || date > to) continue;
      rows.push({ personId: person.id, name: person.name, date, ...shift });
      totalMin += shift.workedMin ?? 0;
    }
    totals.push({ personId: person.id, name: person.name, workedMin: totalMin });
  }
  rows.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
  return { from, to, timezone: tz, rows, totals };
}

// Spreadsheet apps run cells starting with these characters as formulas.
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function timesheetCsv(sheet) {
  const time = (ts) =>
    ts ? new Intl.DateTimeFormat('en-GB', { timeZone: sheet.timezone, hour: '2-digit', minute: '2-digit' }).format(ts) : '';
  const lines = [['Name', 'Date', 'In', 'Out', 'Break minutes', 'Hours worked', 'Flags']];
  for (const row of sheet.rows) {
    const hours = row.workedMin === null ? '' : (row.workedMin / 60).toFixed(2);
    lines.push([row.name, row.date, time(row.start), time(row.end), row.breakMin, hours, row.flags.join(' ')]);
  }
  return lines.map((cells) => cells.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
