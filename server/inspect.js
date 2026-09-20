// 成组时刻检查：每条都是一段自由文本，分词后逐条核对，
// 问题分开列出并定位到字符串内的具体位置；单条不成立不拖累同批其它条目。

const { load, WEEKDAY_NAMES } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText } = require('./zones');
const { findSpringGap, offsetAtLocal } = require('./dst');

const MAX_ITEMS = 200;
const pad = (num) => String(num).padStart(2, '0');

// 三种片段各自的形状。日期允许短横线、斜杠、点与中文年月日；时刻认数字钟面（含全角冒号）与中文几点几分
const ZONE_PATTERN = /([A-Za-z_]+(?:\/[A-Za-z_]+)+|UTC)\b/g;
const DATE_PATTERN = /(?<!\d)(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?(?!\d)/g;
const CLOCK_PATTERN = /(?<!\d)(\d{1,2})\s*[:：]\s*(\d{1,2})(?!\d)/g;
const CN_TIME_PATTERN = /(?<!\d)(\d{1,2})\s*[点时]\s*(?:(\d{1,2})\s*分?)?(?!\d)/g;

// 这些只是连接用的标点或字样，认不出时不计为残余内容
const IGNORED_WORDS = ['当地时间', '本地时间', '上午', '下午', '早上', '晚上', '凌晨', '中午', '傍晚', '时区', '时间'];
const IGNORED_CHARS = new Set([' ', '\t', ',', '，', ';', '；', '、', '@', '=', '(', ')', '（', '）', '[', ']', '【', '】', ':', '：', '/', '\\', '.', '-', 'T', 't', '~', '～']);

function scanPattern(text, pattern, type) {
  const tokens = [];
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    tokens.push({ type, raw: match[0], index: match.index, end: match.index + match[0].length, groups: match.slice(1) });
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
  }
  return tokens;
}

// 日期是否真实存在：月日先过范围，再用 Date.UTC 回卷比对兜住二月三十号这类
function validDateParts(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function positionOf(text, start, end) {
  return { start, end, position: `第 ${start + 1}–${end} 字`, snippet: text.slice(start, end) };
}

// 去掉所有已认出片段后，剩下的可见内容按连续段挑出来
function residueRuns(text, covered) {
  const masked = new Array(text.length).fill(false);
  covered.forEach(([start, end]) => {
    for (let i = start; i < end; i += 1) masked[i] = true;
  });
  let work = '';
  for (let i = 0; i < text.length; i += 1) work += masked[i] ? ' ' : text[i];
  IGNORED_WORDS.forEach((word) => {
    work = work.split(word).join(' '.repeat(word.length));
  });
  work = work.replace(/tz/gi, '  ');

  const runs = [];
  let i = 0;
  while (i < work.length) {
    if (work[i] === ' ' || IGNORED_CHARS.has(work[i])) { i += 1; continue; }
    const start = i;
    while (i < work.length && work[i] !== ' ' && !IGNORED_CHARS.has(work[i])) i += 1;
    const piece = work.slice(start, i);
    // 纯数字残片（例如只写了一半的 2026-09）不逐条报，缺日期/时刻的提示已经能覆盖
    if (!/^\d+$/.test(piece)) runs.push({ start, end: i, text: piece });
  }
  return runs;
}

function normalizedDateToken(token) {
  const [y, m, d] = token.groups.map(Number);
  return `${y}-${pad(m)}-${pad(d)}`;
}

function normalizedTimeToken(token) {
  return `${pad(token.hour)}:${pad(token.minute)}`;
}

// 逐条检查一条文本；raw 可以是字符串，也可以是 { text, zoneId }（条目自带时区覆盖批次默认）
function inspectOne(raw, index, defaultZone, zones) {
  const isObject = raw && typeof raw === 'object';
  const text = typeof raw === 'string' ? raw.trim() : (isObject && typeof raw.text === 'string' ? raw.text.trim() : '');
  const itemZoneId = isObject ? pickText(raw.zoneId) : '';
  const issues = [];
  const push = (code, field, part, message, at) => issues.push({ code, field, part, message, at });

  if (!text) {
    push('EMPTY', 'text', '整条', '这一条是空的，没有可检查的内容', null);
    return { index, input: text, status: 'invalid', issues, parsed: null, canonical: null, suggestion: null };
  }

  // 分词（三类字符互不相交：时区只含字母斜杠下划线，日期时刻只含数字与中文单位）
  const zoneTokens = scanPattern(text, ZONE_PATTERN, 'zone');
  const dateTokens = scanPattern(text, DATE_PATTERN, 'date').map((token) => {
    const [year, month, day] = token.groups.map(Number);
    return { ...token, year, month, day, exists: validDateParts(year, month, day) };
  });
  const timeTokens = [];
  scanPattern(text, CLOCK_PATTERN, 'time').forEach((token) => {
    timeTokens.push({ ...token, hour: Number(token.groups[0]), minute: Number(token.groups[1]), kind: 'clock' });
  });
  scanPattern(text, CN_TIME_PATTERN, 'time').forEach((token) => {
    // 没写分钟的“九点”按整点算；“九点半”只会匹配到“九点”，“半”留给残余内容去指出
    const minute = token.groups[1] === undefined ? 0 : Number(token.groups[1]);
    timeTokens.push({ ...token, hour: Number(token.groups[0]), minute, kind: 'cn' });
  });
  timeTokens.sort((a, b) => a.index - b.index);
  const covered = [...zoneTokens, ...dateTokens, ...timeTokens].map((token) => [token.index, token.end]);

  // 时区：文本里写了按文本，否则看条目自带，再否则用批次默认
  let zone = null;
  if (zoneTokens.length > 1) {
    push('UNRECOGNIZED', 'zoneId', '时区', `一串里写出了两个时区：${zoneTokens[0].raw} 与 ${zoneTokens[1].raw}`, positionOf(text, zoneTokens[1].index, zoneTokens[1].end));
  }
  if (zoneTokens.length >= 1) {
    const name = zoneTokens[0].raw;
    const found = zones.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!found) {
      push('ZONE_NOT_FOUND', 'zoneId', '时区', `时区 ${name} 没有登记过，检查拼写或改用已登记的时区名`, positionOf(text, zoneTokens[0].index, zoneTokens[0].end));
    } else {
      zone = found;
    }
  } else if (itemZoneId) {
    const found = zones.find((item) => item.id === itemZoneId);
    if (!found) push('ZONE_NOT_FOUND', 'zoneId', '时区', `指定的来源时区没有登记过`, null);
    else zone = found;
  } else if (defaultZone) {
    zone = defaultZone;
  } else {
    push('ZONE_MISSING', 'zoneId', '时区', '这一条没有写时区，批次也没给默认时区，无法判断切换日缺口', null);
  }

  // 日期：逐个验证是否真实存在，再看是否一条里混进两个日期
  dateTokens.forEach((token) => {
    if (!token.exists) {
      push('DATE_NOT_EXIST', 'date', '日期', `${token.year} 年 ${token.month} 月没有 ${token.day} 号，这个日期本身不存在`, positionOf(text, token.index, token.end));
    }
  });
  if (dateTokens.length >= 2) {
    const [first, second] = dateTokens;
    const same = first.year === second.year && first.month === second.month && first.day === second.day;
    const message = same
      ? `同一个日期写了两遍：${normalizedDateToken(first)}`
      : `一串里出现了两个不同的日期：${normalizedDateToken(first)} 与 ${normalizedDateToken(second)}`;
    push('DATE_DUPLICATED', 'date', '日期', message, positionOf(text, second.index, second.end));
  }

  // 时刻：小时过二十四、分钟到六十都不算数
  timeTokens.forEach((token) => {
    if (token.hour >= 24) {
      push('TIME_OUT_OF_RANGE', 'time', '时刻', `时刻写到二十四点之后了：${pad(token.hour)}:${pad(token.minute)}，小时只能填零到二十三`, positionOf(text, token.index, token.end));
    } else if (token.minute >= 60) {
      push('TIME_OUT_OF_RANGE', 'time', '时刻', `分钟不能到 ${token.minute}，只能填零到五十九`, positionOf(text, token.index, token.end));
    }
  });
  if (timeTokens.length >= 2) {
    push('UNRECOGNIZED', 'time', '时刻', `一串里只能写一个时刻，这里认出了 ${timeTokens.length} 个`, positionOf(text, timeTokens[1].index, timeTokens[1].end));
  }

  const oneDate = dateTokens.length === 1 ? dateTokens[0] : null;
  const oneTime = timeTokens.length === 1 ? timeTokens[0] : null;

  if (oneDate && !oneTime) {
    push('UNRECOGNIZED', 'time', '时刻', '只认出了日期，没认出时刻，时刻写成 09:30 或 9点30分', positionOf(text, oneDate.index, oneDate.end));
  }
  if (oneTime && dateTokens.length === 0) {
    push('UNRECOGNIZED', 'date', '日期', '只认出了时刻，没认出日期，日期写成 2026-09-20 这样', positionOf(text, oneTime.index, oneTime.end));
  }
  if (dateTokens.length === 0 && timeTokens.length === 0) {
    const message = zoneTokens.length > 0
      ? '只认出了时区，日期与时刻都没写出来'
      : '这串写法认不出，日期与时刻都没找到';
    push('UNRECOGNIZED', 'text', '整条', message, null);
  }

  // 日期与时刻次序颠倒：恰好各一个，且时刻写在了日期前面
  if (oneDate && oneTime && oneTime.index < oneDate.index) {
    push('ORDER_REVERSED', 'order', '次序', `时刻写在了日期前面，日期要在前、时刻在后`, positionOf(text, oneTime.index, oneTime.end));
  }

  // 残余内容：例如“九点半”的“半”、随口写的附言；一个片段都没认出来时不重复报
  if (dateTokens.length > 0 || timeTokens.length > 0 || zoneTokens.length > 0) {
    residueRuns(text, covered).forEach((run) => {
      push('UNRECOGNIZED', 'text', '认不出的片段', `“${run.text}” 这部分认不出`, { start: run.start, end: run.end, position: `第 ${run.start + 1}–${run.end} 字`, snippet: run.text });
    });
  }

  // 夏令时缺口：日期真实、时刻在范围内、时区已解析，才落到切换日上判
  let gap = null;
  if (oneDate && oneDate.exists && oneTime && oneTime.hour < 24 && oneTime.minute < 60 && zone) {
    const civilMs = Date.UTC(oneDate.year, oneDate.month - 1, oneDate.day, oneTime.hour, oneTime.minute);
    gap = findSpringGap(zone, civilMs);
    if (gap) {
      push('DST_GAP', 'time', '夏令时缺口',
        `${zone.name} 在 ${gap.startText} 到 ${gap.endText} 之间把钟向前拨了 ${gap.deltaMinutes} 分钟，${pad(oneTime.hour)}:${pad(oneTime.minute)} 这个钟面时刻在当地不存在`,
        positionOf(text, oneTime.index, oneTime.end));
    }
  }

  // 建议写法：缺口给跳钟前后两个选择；次序问题给重排后的串；其它认不出的给带时区的示例
  let suggestion = null;
  if (gap) {
    suggestion = `改成跳钟前的 ${gap.beforeText}，或跳到的 ${gap.afterText}`;
  } else if (oneDate && oneTime && issues.some((item) => item.code === 'ORDER_REVERSED')) {
    suggestion = `${normalizedDateToken(oneDate)} ${normalizedTimeToken(oneTime)}${zone ? ` ${zone.name}` : ''}`;
  } else if (issues.some((item) => item.code === 'UNRECOGNIZED' || item.code === 'ZONE_MISSING' || item.code === 'ZONE_NOT_FOUND')) {
    suggestion = `例如：2026-09-20 09:30${zone ? ` ${zone.name}` : ' Asia/Shanghai'}`;
  }

  if (issues.length > 0) {
    return { index, input: text, status: 'invalid', issues, parsed: null, canonical: null, suggestion };
  }

  // 成立：写出规范写法，并用当时实际采用的偏移折算出 UTC
  const civilMs = Date.UTC(oneDate.year, oneDate.month - 1, oneDate.day, oneTime.hour, oneTime.minute);
  const where = offsetAtLocal(zone, civilMs);
  const utcMs = civilMs - where.offsetMinutes * 60000;
  const utc = new Date(utcMs);
  const canonicalText = `${normalizedDateToken(oneDate)} ${normalizedTimeToken(oneTime)}`;

  return {
    index,
    input: text,
    status: 'ok',
    issues: [],
    parsed: {
      year: oneDate.year,
      month: oneDate.month,
      day: oneDate.day,
      hour: oneTime.hour,
      minute: oneTime.minute,
      zoneId: zone.id,
      zoneName: zone.name,
      dst: where.dst,
    },
    canonical: {
      text: canonicalText,
      date: normalizedDateToken(oneDate),
      time: normalizedTimeToken(oneTime),
      weekday: WEEKDAY_NAMES[new Date(civilMs).getUTCDay()],
      offsetText: offsetText(where.offsetMinutes),
      utc: `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())} ${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}`,
    },
    suggestion: null,
  };
}

// 成组入口：信封级问题（没给 items、超出上限、批次默认时区不存在）走 ApiError；
// 其余一切问题都落在各条的结论里，整批全不成立也正常返回
function inspectBatch(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  if (!Array.isArray(input.items)) {
    throw new ApiError(400, 'BATCH_ITEMS_REQUIRED', '成组检查要提交 items 数组，每条写一段时刻文本', 'items');
  }
  if (input.items.length > MAX_ITEMS) {
    throw new ApiError(400, 'BATCH_TOO_LARGE', `一批最多提交 ${MAX_ITEMS} 条，这一批有 ${input.items.length} 条`, 'items');
  }

  const data = load();
  let defaultZone = null;
  const batchZoneId = pickText(input.zoneId);
  if (batchZoneId) {
    defaultZone = data.zones.find((item) => item.id === batchZoneId) || null;
    if (!defaultZone) throw new ApiError(400, 'ZONE_NOT_FOUND', '批次默认时区没有登记过', 'zoneId');
  }

  const items = input.items.map((raw, index) => {
    if (typeof raw === 'string') return inspectOne(raw, index, defaultZone, data.zones);
    if (raw && typeof raw === 'object' && typeof raw.text === 'string') {
      return inspectOne({ text: raw.text, zoneId: raw.zoneId }, index, defaultZone, data.zones);
    }
    const fallback = inspectOne('', index, defaultZone, data.zones);
    fallback.input = raw === null || raw === undefined ? '' : String(raw);
    return fallback;
  });

  return {
    total: items.length,
    okCount: items.filter((item) => item.status === 'ok').length,
    invalidCount: items.filter((item) => item.status === 'invalid').length,
    zone: defaultZone ? { id: defaultZone.id, name: defaultZone.name } : null,
    items,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = { inspectBatch, inspectOne, validDateParts, residueRuns, MAX_ITEMS };
