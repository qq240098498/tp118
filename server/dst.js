// 把登记的夏令时规则（第几个星期几的几点几分）落到具体年份的具体时刻上，
// 并判定某个民用时刻是否落在春季跳钟后不存在的那一小时里。
//
// 这里不使用运行环境的本地时区：民用日历一律用 Date 的 UTC 字段承载，
// 偏移折算只做毫秒加减法，结论与服务器设在哪无关。

const DAY_MS = 86400000;

const pad = (num) => String(num).padStart(2, '0');

// 某年某月第 n 个星期几（week 取 '1'..'4' 或 'last'，weekday 零为周日）那天零点的毫秒数
function nthWeekdayDate(year, month, week, weekday) {
  if (week === 'last') {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const last = new Date(Date.UTC(year, month - 1, lastDay));
    const diff = (last.getUTCDay() - weekday + 7) % 7;
    return Date.UTC(year, month - 1, lastDay - diff);
  }
  const nth = Number(week);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstHit = 1 + ((weekday - first.getUTCDay() + 7) % 7);
  return Date.UTC(year, month - 1, firstHit + (nth - 1) * 7);
}

function ruleInstant(rulePart, baseDateMs) {
  return baseDateMs + (rulePart.hour * 60 + rulePart.minute) * 60000;
}

// 某年开始夏令时（春季跳钟）的缺口：起始按标准时钟点解读，钟向前拨一个偏移差，
// [start, start + delta) 这段民用时间在当地根本不存在
function springGapOfYear(zone, year) {
  const startDay = nthWeekdayDate(year, zone.dstStart.month, zone.dstStart.week, zone.dstStart.weekday);
  const start = ruleInstant(zone.dstStart, startDay);
  const delta = (zone.dstOffsetMinutes - zone.offsetMinutes) * 60000;
  return { start, end: start + delta, delta };
}

// 规则在这一年是否有效：档案有生效区间，已停止实行夏令时的年份不再有缺口
function ruleActiveInYear(zone, year) {
  if (!zone.usesDst || !zone.dstStart || !zone.dstEnd || zone.dstOffsetMinutes === null) return false;
  if (year < zone.fromYear) return false;
  if (zone.toYear !== null && year > zone.toYear) return false;
  return true;
}

function civilFields(civilMs) {
  const d = new Date(civilMs);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

function civilText(civilMs) {
  const f = civilFields(civilMs);
  return `${f.year}-${pad(f.month)}-${pad(f.day)} ${pad(f.hour)}:${pad(f.minute)}`;
}

// 判定一个民用时刻是否落在该时区春季切换日不存在的小时里；不是缺口返回 null
function findSpringGap(zone, civilMs) {
  if (!ruleActiveInYear(zone, civilFields(civilMs).year)) return null;

  const f = civilFields(civilMs);
  const candidates = [];
  // 民用日期本身不会离开所在公历年，只需查这一年的缺口；年初仍把上一年一并兜住
  candidates.push(springGapOfYear(zone, f.year));
  if (f.month === 1) candidates.push(springGapOfYear(zone, f.year - 1));

  const hit = candidates.find((gap) => civilMs >= gap.start && civilMs < gap.end);
  if (!hit) return null;

  return {
    startMs: hit.start,
    endMs: hit.end,
    deltaMinutes: zone.dstOffsetMinutes - zone.offsetMinutes,
    startText: civilText(hit.start),
    endText: civilText(hit.end),
    beforeText: civilText(hit.start - 60000),
    afterText: civilText(hit.end),
  };
}

// 民用时刻当时采用的偏移（用于把成立的时刻折算成 UTC）。
// 北半球开始月早于结束月，夏令时夹在两段之间；南半球跨年，年中是标准时、跨年间是夏令时。
// 秋季回退的重叠小时不报错，确定性地按夏令时一侧取。
function offsetAtLocal(zone, civilMs) {
  if (!ruleActiveInYear(zone, civilFields(civilMs).year)) {
    return { offsetMinutes: zone.offsetMinutes, dst: false };
  }
  const f = civilFields(civilMs);
  const start = ruleInstant(zone.dstStart, nthWeekdayDate(f.year, zone.dstStart.month, zone.dstStart.week, zone.dstStart.weekday));
  const end = ruleInstant(zone.dstEnd, nthWeekdayDate(f.year, zone.dstEnd.month, zone.dstEnd.week, zone.dstEnd.weekday));

  let dst;
  if (zone.dstStart.month < zone.dstEnd.month) {
    dst = civilMs >= start && civilMs < end;
  } else {
    dst = civilMs >= start || civilMs < end;
  }
  return {
    offsetMinutes: dst ? zone.dstOffsetMinutes : zone.offsetMinutes,
    dst,
  };
}

module.exports = {
  nthWeekdayDate,
  findSpringGap,
  offsetAtLocal,
  springGapOfYear,
  ruleActiveInYear,
  DAY_MS,
};
