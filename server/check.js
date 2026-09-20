// 成组检查一批时刻写法：逐条独立给结论，单条不成立不影响其它条目，整批都不成立也照常返回每条的结果
const { load, WEEKDAY_NAMES } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText } = require('./zones');

const MAX_ITEMS = 200;
const EXAMPLE = '2026-09-20 09:30';

// 先把样子像日期与时刻的片段捞出来，数值对不对交给后面的逐项检查
const DATE_TOKEN = /(?<!\d)\d{4}-\d{1,2}-\d{1,2}(?!\d)/g;
const TIME_TOKEN = /(?<![\d:])\d{1,2}:\d{2}(?![\d:])/g;
// 日期与时刻之间只允许空白，或者空白夹一个字母 T
const SEPARATOR = /^(\s+|\s*[Tt]\s*)$/;

const pad = (num) => String(num).padStart(2, '0');

function findTokens(input, pattern) {
  return [...input.matchAll(pattern)].map((match) => ({ text: match[0], position: match.index }));
}

function problem(code, message, field, fragment, position) {
  return {
    code,
    message,
    field: field || '',
    fragment: fragment || '',
    position: position === undefined ? -1 : position,
  };
}

// 日期要真存在，例如二月三十号不算数；年份不到一百时 Date.UTC 会把年份错到一九几几年，这里先修正再比对
function realDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  probe.setUTCFullYear(year);
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return probe;
}

function parseDateToken(token) {
  const [year, month, day] = token.text.split('-').map(Number);
  const probe = realDate(year, month, day);
  if (!probe) return null;
  return {
    year,
    month,
    day,
    text: `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`,
    weekday: WEEKDAY_NAMES[probe.getUTCDay()],
    probe,
  };
}

function parseTimeToken(token) {
  const [hour, minute] = token.text.split(':').map(Number);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute, text: `${pad(hour)}:${pad(minute)}` };
}

// 只看写法不看数值的规范形式，用来比对两个片段是不是同一个日期或时刻
function canonDateText(token) {
  const [year, month, day] = token.text.split('-').map(Number);
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

function canonTimeText(token) {
  const [hour, minute] = token.text.split(':').map(Number);
  return `${pad(hour)}:${pad(minute)}`;
}

// 切换规则里「第几个星期几」落在某一年的具体几号
function switchDayOfMonth(year, rule) {
  if (rule.week === 'last') {
    const lastDay = new Date(Date.UTC(year, rule.month, 0));
    return lastDay.getUTCDate() - ((lastDay.getUTCDay() - rule.weekday + 7) % 7);
  }
  const first = new Date(Date.UTC(year, rule.month - 1, 1));
  return 1 + ((rule.weekday - first.getUTCDay() + 7) % 7) + (Number(rule.week) - 1) * 7;
}

function fmtMs(ms) {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

// 切换日不存在的那一段：开始规则生效的当地时刻起，时钟拨快多少分钟，这段时刻就不存在
function dstGap(zone, year) {
  if (!zone.usesDst || !zone.dstStart || zone.dstOffsetMinutes === null) return null;
  if (year < zone.fromYear || (zone.toYear !== null && year > zone.toYear)) return null;
  const delta = zone.dstOffsetMinutes - zone.offsetMinutes;
  if (delta <= 0) return null;
  const day = switchDayOfMonth(year, zone.dstStart);
  const startMs = Date.UTC(year, zone.dstStart.month - 1, day, zone.dstStart.hour, zone.dstStart.minute);
  return { startMs, endMs: startMs + delta * 60000 };
}

// 单条检查：只往 problems 里放结论，任何情况都不往外抛
function checkItem(item, index, zone) {
  if (typeof item !== 'string') {
    return {
      index,
      input: item === undefined ? null : item,
      ok: false,
      normalized: null,
      problems: [problem('ITEM_NOT_TEXT', `这一条不是文本，时刻要写成一串文字，例如 ${EXAMPLE}`, 'item')],
      suggestion: EXAMPLE,
    };
  }
  const input = item;
  if (!input.trim()) {
    return {
      index,
      input,
      ok: false,
      normalized: null,
      problems: [problem('ITEM_EMPTY', '这一条是空白，没有可检查的内容', 'item')],
      suggestion: EXAMPLE,
    };
  }

  const dates = findTokens(input, DATE_TOKEN);
  const times = findTokens(input, TIME_TOKEN);

  if (dates.length === 0 || times.length === 0) {
    let message;
    if (dates.length === 0 && times.length === 0) {
      message = `认不出日期与时刻，规范写法是日期在前时刻在后，例如 ${EXAMPLE}`;
    } else if (dates.length === 0) {
      message = '认不出日期，日期要写成四位年加短横线加两位月日，例如 2026-09-20';
    } else {
      message = '认不出时刻，时刻要写成两位小时加冒号加两位分钟，例如 09:30';
    }
    return {
      index,
      input,
      ok: false,
      normalized: null,
      problems: [problem('ITEM_UNRECOGNIZED', message, 'item')],
      suggestion: EXAMPLE,
    };
  }

  if (dates.length > 1) {
    const first = canonDateText(dates[0]);
    const second = canonDateText(dates[1]);
    const message = first === second
      ? `同一个日期「${first}」写了两次，一条里留一个日期就好`
      : `同一串里出现两个不同日期：「${first}」与「${second}」，一条里只能留一个日期`;
    return {
      index,
      input,
      ok: false,
      normalized: null,
      problems: [problem('DATE_DUPLICATED', message, 'date', dates[1].text, dates[1].position)],
      suggestion: EXAMPLE,
    };
  }

  if (times.length > 1) {
    const first = canonTimeText(times[0]);
    const second = canonTimeText(times[1]);
    const message = first === second
      ? `同一个时刻「${first}」写了两次，一条里留一个时刻就好`
      : `同一串里出现两个时刻：「${first}」与「${second}」，一条里只能留一个时刻`;
    return {
      index,
      input,
      ok: false,
      normalized: null,
      problems: [problem('TIME_DUPLICATED', message, 'time', times[1].text, times[1].position)],
      suggestion: EXAMPLE,
    };
  }

  const dateToken = dates[0];
  const timeToken = times[0];
  const problems = [];

  // 头尾与中间只允许空白，中间可以夹一个字母 T；其余内容都算认不出
  const head = timeToken.position < dateToken.position ? timeToken : dateToken;
  const tail = head === timeToken ? dateToken : timeToken;
  const prefix = input.slice(0, head.position);
  const middle = input.slice(head.position + head.text.length, tail.position);
  const suffix = input.slice(tail.position + tail.text.length);
  const stray = [];
  let strayFragment = '';
  let strayPosition = -1;
  if (prefix.trim()) {
    stray.push(`开头的「${prefix.trim()}」`);
    strayFragment = prefix.trim();
    strayPosition = input.indexOf(strayFragment);
  }
  if (suffix.trim()) {
    stray.push(`结尾的「${suffix.trim()}」`);
    if (!strayFragment) {
      strayFragment = suffix.trim();
      strayPosition = input.lastIndexOf(strayFragment);
    }
  }
  if (!SEPARATOR.test(middle)) {
    if (middle.trim()) {
      stray.push(`中间的「${middle.trim()}」`);
      if (!strayFragment) {
        strayFragment = middle.trim();
        strayPosition = input.indexOf(strayFragment, head.position + head.text.length);
      }
    } else {
      stray.push('日期与时刻之间没有任何分隔');
      if (strayPosition === -1) strayPosition = head.position + head.text.length;
    }
  }
  if (stray.length) {
    problems.push(problem('ITEM_UNRECOGNIZED', `多出了认不出的内容：${stray.join('、')}`, 'item', strayFragment, strayPosition));
  }

  if (timeToken.position < dateToken.position) {
    problems.push(problem(
      'ORDER_REVERSED',
      `次序颠倒：时刻「${timeToken.text}」写在了日期「${dateToken.text}」前面，规范写法是日期在前时刻在后`,
      'order',
      timeToken.text,
      timeToken.position,
    ));
  }

  const date = parseDateToken(dateToken);
  if (!date) {
    problems.push(problem(
      'DATE_NOT_EXIST',
      `日期「${dateToken.text}」不存在，请检查年份、月份与日（例如二月没有三十号）`,
      'date',
      dateToken.text,
      dateToken.position,
    ));
  }

  const time = parseTimeToken(timeToken);
  if (!time) {
    const [hour, minute] = timeToken.text.split(':').map(Number);
    const why = hour > 23
      ? '小时写到了二十四点之后，一天只有零点到二十三点'
      : '分钟超出了零到五十九的范围';
    problems.push(problem('TIME_OUT_OF_RANGE', `时刻「${timeToken.text}」不成立：${why}`, 'time', timeToken.text, timeToken.position));
  }

  // 日期与时刻都真实存在时给出规范写法，再看这一刻是否落在夏令时切换不存在的那一段里
  let normalized = null;
  let suggestion = null;
  if (date && time) {
    normalized = {
      date: date.text,
      time: time.text,
      text: `${date.text} ${time.text}`,
      weekday: date.weekday,
    };
    const gap = dstGap(zone, date.year);
    if (gap) {
      const localMs = date.probe.getTime() + (time.hour * 60 + time.minute) * 60000;
      if (localMs >= gap.startMs && localMs < gap.endMs) {
        const startText = fmtMs(gap.startMs);
        const endText = fmtMs(gap.endMs);
        problems.push(problem(
          'DST_GAP',
          `这一刻在${zone.displayName}（${zone.name}）不存在：${startText} 起时钟拨快到 ${endText}，这段时刻不会出现`,
          'time',
          timeToken.text,
          timeToken.position,
        ));
        suggestion = endText;
      }
    }
  }

  if (problems.length && !suggestion) suggestion = normalized ? normalized.text : EXAMPLE;

  return {
    index,
    input,
    ok: problems.length === 0,
    normalized,
    problems,
    suggestion: problems.length ? suggestion : null,
  };
}

// 成组检查：请求本身不成立才抛业务异常；单条不成立只记在自己的结果里，整批照常返回
function checkBatch(options) {
  const input = options && typeof options === 'object' ? options : {};
  const zoneId = pickText(input.zoneId);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择时区', 'zoneId');
  const data = load();
  const zone = data.zones.find((item) => item.id === zoneId);
  if (!zone) throw new ApiError(404, 'ZONE_NOT_FOUND', '选中的时区没有登记过', 'zoneId');

  const items = input.items;
  if (!Array.isArray(items)) throw new ApiError(400, 'ITEMS_REQUIRED', '请把要检查的内容逐条放进 items 数组', 'items');
  if (items.length === 0) throw new ApiError(400, 'ITEMS_EMPTY', '至少给一条要检查的内容', 'items');
  if (items.length > MAX_ITEMS) throw new ApiError(400, 'ITEMS_TOO_MANY', `一批最多检查 ${MAX_ITEMS} 条，超出了请分组提交`, 'items');

  const checked = items.map((item, index) => {
    try {
      return checkItem(item, index, zone);
    } catch (err) {
      console.error('[tp118] 检查单条内容时出现未预期的问题：', err);
      return {
        index,
        input: typeof item === 'string' ? item : null,
        ok: false,
        normalized: null,
        problems: [problem('ITEM_CHECK_FAILED', '这一条检查时出现意外问题，请换种写法再试', 'item')],
        suggestion: EXAMPLE,
      };
    }
  });
  const ok = checked.filter((item) => item.ok).length;

  return {
    zone: {
      id: zone.id,
      name: zone.name,
      displayName: zone.displayName,
      usesDst: zone.usesDst,
      offsetText: offsetText(zone.offsetMinutes),
      dstOffsetText: zone.usesDst && zone.dstOffsetMinutes !== null ? offsetText(zone.dstOffsetMinutes) : '',
    },
    summary: { total: checked.length, ok, failed: checked.length - ok },
    results: checked,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = { checkBatch };
