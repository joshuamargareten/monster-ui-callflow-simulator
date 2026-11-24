/**
 * temporal.js — Kazoo temporal_route evaluator for the Callflow Simulator.
 *
 * A function-for-function port of Kazoo 4.3:
 *   applications/callflow/src/module/cf_temporal_route.erl  (process_rules, next_rule_date, ...)
 *   core/kazoo_stdlib/src/kz_date.erl                       (normalize, from_iso_week, ...)
 *   applications/callflow/src/cf_util.erl                   (get_timezone)
 *
 * Plus one thing stock Kazoo 4.3 doesn't have: `end_date`. Teklink's Kazoo (and SmartPBX /
 * DT-Callflows, which write it) stop a rule at its end_date — see endLsecOf / isEnded.
 *
 * GOAL: predict what Kazoo WILL do, not what would be "correct". Kazoo's quirks are kept on
 * purpose and marked "KAZOO QUIRK". Where Kazoo would crash (and so fail the call) we throw a
 * KazooCrash instead of guessing, and the caller reports it.
 *
 * Dates are plain {y, m, d} objects. "Local seconds" are naive wall-clock seconds in the route's
 * timezone, exactly like Kazoo's LSec — they are only ever compared with each other.
 *
 * UMD: loads under Monster UI's RequireJS and under Node (for tests). ES5 on purpose, to match
 * Monster house style.
 */
(function(root, factory) {
	if (typeof define === 'function' && define.amd) {
		define([], factory);
	} else if (typeof module === 'object' && module.exports) {
		module.exports = factory();
	} else {
		root.crvTemporal = factory();
	}
}(this, function() {
	'use strict';

	var SECONDS_IN_DAY = 86400;
	// Seconds between 0000-01-01T00:00:00 and 1970-01-01T00:00:00 (Erlang gregorian vs unix).
	var GREGORIAN_UNIX_OFFSET = 62167219200;
	// Recursion/loop guard where Kazoo itself could loop forever.
	var LOOP_GUARD = 1000;

	// kz_date:wday_to_dow/1 — note KAZOO QUIRK: "wensday" is canonical in Kazoo data.
	var WDAY_TO_DOW = {
		monday: 1, tuesday: 2, wednesday: 3, wensday: 3,
		thursday: 4, friday: 5, saturday: 6, sunday: 7
	};
	// kz_date:dow_to_wday/1
	var DOW_TO_WDAY = [null, 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
	// kz_date:ordinal_to_position/1
	var ORDINAL_TO_POSITION = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4 };

	// cf_temporal_route.hrl defaults
	var DEFAULTS = {
		name: 'no_name',
		cycle: '',
		interval: 1,
		days: [],
		wdays: [],
		ordinal: 'first',
		month: 1,
		wtimeStart: 0,
		wtimeStop: SECONDS_IN_DAY
	};

	/* ---------------------------------------------------------------------------------------- *
	 * Errors
	 * ---------------------------------------------------------------------------------------- */

	/**
	 * Thrown wherever Erlang would raise (function_clause, badarith, badmatch, ...).
	 * kind: 'crash' — Kazoo raises and the call fails;
	 *       'hang'  — Kazoo loops forever (we stop at LOOP_GUARD); the call hangs.
	 */
	function KazooCrash(message, kind) {
		this.name = 'KazooCrash';
		this.message = message;
		this.kind = kind || 'crash';
		this.stack = (new Error(message)).stack;
	}
	KazooCrash.prototype = Object.create(Error.prototype);
	KazooCrash.prototype.constructor = KazooCrash;

	function crash(message) {
		throw new KazooCrash(message, 'crash');
	}

	function hang(message) {
		throw new KazooCrash(message, 'hang');
	}

	/* ---------------------------------------------------------------------------------------- *
	 * Erlang arithmetic + calendar primitives
	 * ---------------------------------------------------------------------------------------- */

	// Erlang `div` / `rem`: truncate toward zero.
	function ediv(a, b) { return Math.trunc(a / b); }
	function erem(a, b) { return a - b * Math.trunc(a / b); }

	function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }

	function isLeapYear(y) {
		return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
	}

	// calendar:last_day_of_the_month/2 — only valid for months 1..12.
	function lastDayOfMonth(y, m) {
		if (!isInt(y) || !isInt(m) || m < 1 || m > 12) {
			crash('calendar:last_day_of_the_month(' + y + ', ' + m + ') — invalid month');
		}
		if (m === 2) { return isLeapYear(y) ? 29 : 28; }
		return [4, 6, 9, 11].indexOf(m) !== -1 ? 30 : 31;
	}

	// kz_date:days_in_month/2 — additionally accepts 0 and 13.
	function daysInMonth(y, m) {
		if (m === 0) { return daysInMonth(y - 1, 12); }
		if (m === 13) { return daysInMonth(y + 1, 1); }
		return lastDayOfMonth(y, m);
	}

	function isValidDate(date) {
		return date && isInt(date.y) && isInt(date.m) && isInt(date.d) &&
			date.m >= 1 && date.m <= 12 && date.d >= 1 && date.d <= lastDayOfMonth(date.y, date.m);
	}

	function assertValidDate(date, where) {
		if (!isValidDate(date)) {
			crash(where + ': invalid date ' + JSON.stringify(date));
		}
	}

	// Days since 1970-01-01 (Howard Hinnant's days_from_civil). Stands in for
	// calendar:date_to_gregorian_days — only differences and weekdays are ever used, except
	// for gregorian *seconds* conversion, which goes through GREGORIAN_UNIX_OFFSET.
	function daysFromCivilRaw(y, m, d) {
		y -= m <= 2 ? 1 : 0;
		var era = Math.floor(y / 400),
			yoe = y - era * 400,
			mp = (m + 9) % 12,
			doy = Math.floor((153 * mp + 2) / 5) + d - 1,
			doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
		return era * 146097 + doe - 719468;
	}

	// calendar:date_to_gregorian_days/1 — crashes on invalid dates, like Erlang.
	function gdays(date) {
		assertValidDate(date, 'calendar:date_to_gregorian_days');
		return daysFromCivilRaw(date.y, date.m, date.d);
	}

	// calendar:gregorian_days_to_date/1
	function civilFromDays(z) {
		z += 719468;
		var era = Math.floor(z / 146097),
			doe = z - era * 146097,
			yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365),
			y = yoe + era * 400,
			doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)),
			mp = Math.floor((5 * doy + 2) / 153),
			d = doy - Math.floor((153 * mp + 2) / 5) + 1,
			m = mp < 10 ? mp + 3 : mp - 9;
		return { y: y + (m <= 2 ? 1 : 0), m: m, d: d };
	}

	// calendar:day_of_the_week/1 — ISO 8601: 1 = Monday ... 7 = Sunday.
	function dayOfWeek(date) {
		var days = gdays(date);
		return (((days + 3) % 7) + 7) % 7 + 1;
	}

	function compareDates(a, b) {
		if (a.y !== b.y) { return a.y < b.y ? -1 : 1; }
		if (a.m !== b.m) { return a.m < b.m ? -1 : 1; }
		if (a.d !== b.d) { return a.d < b.d ? -1 : 1; }
		return 0;
	}

	function sameDate(a, b) { return compareDates(a, b) === 0; }

	function addDays(date, n) { return civilFromDays(gdays(date) + n); }

	// calendar:iso_week_number/1 — exact port of the Erlang stdlib algorithm.
	function gregorianDaysOfIsoW01d1(year) {
		var d0101 = daysFromCivilRaw(year, 1, 1),
			dow = dayOfWeek({ y: year, m: 1, d: 1 });
		return dow <= 4 ? d0101 - dow + 1 : d0101 + 7 - dow + 1;
	}

	function isoWeekNumber(date) {
		var d = gdays(date),
			w01 = gregorianDaysOfIsoW01d1(date.y),
			w01Next = gregorianDaysOfIsoW01d1(date.y + 1);
		if (w01 <= d && d < w01Next) {
			return { year: date.y, week: Math.floor((d - w01) / 7) + 1 };
		}
		if (d < w01) {
			var pwn = dayOfWeek({ y: date.y - 1, m: 1, d: 1 }) === 4 ||
				dayOfWeek({ y: date.y - 1, m: 12, d: 31 }) === 4 ? 53 : 52;
			return { year: date.y - 1, week: pwn };
		}
		return { year: date.y + 1, week: 1 };
	}

	/* ---------------------------------------------------------------------------------------- *
	 * kz_date
	 * ---------------------------------------------------------------------------------------- */

	// kz_date:normalize/1 — e.g. {2011, 1, 36} -> {2011, 2, 5}. Iterative to avoid deep
	// recursion when a daily rule's start_date is decades old; same results as the Erlang.
	function normalize(date) {
		var y = date.y, m = date.m, d = date.d, guard = 0, prev;
		for (;;) {
			if (++guard > 100000) { crash('kz_date:normalize did not converge for ' + JSON.stringify(date)); }
			if (m === 0) { y -= 1; m = 12; continue; }
			if (d === 0) {
				prev = normalize({ y: y, m: m - 1, d: 1 });
				y = prev.y; m = prev.m; d = lastDayOfMonth(prev.y, prev.m);
				continue;
			}
			if (m > 12) { y += ediv(m, 12); m = erem(m, 12); continue; }
			var over = d - daysInMonth(y, m); // crashes for negative months, like Erlang
			if (over > 0) { m += 1; d = over; continue; }
			// KAZOO QUIRK: negative days fall through un-normalized, and the next calendar call
			// on them crashes — which is what Erlang does too.
			return { y: y, m: m, d: d };
		}
	}

	// kz_date:from_iso_week/1 — the Monday of the given ISO week. Accepts week numbers > 53.
	function fromIsoWeek(year, week) {
		var jan4 = daysFromCivilRaw(year, 1, 4),
			jan4Dow = dayOfWeek({ y: year, m: 1, d: 4 });
		return civilFromDays((jan4 - (jan4Dow - 1)) + (week - 1) * 7);
	}

	// kz_date:wday_to_dow/1 — crashes (function_clause) on anything unknown.
	function wdayToDow(wday) {
		if (!Object.prototype.hasOwnProperty.call(WDAY_TO_DOW, wday)) {
			crash('kz_date:wday_to_dow("' + wday + '") — unknown weekday');
		}
		return WDAY_TO_DOW[wday];
	}

	// kz_date:ordinal_to_position/1 — crashes on "every"/"last"/unknown.
	function ordinalToPosition(ordinal) {
		if (!Object.prototype.hasOwnProperty.call(ORDINAL_TO_POSITION, ordinal)) {
			crash('kz_date:ordinal_to_position("' + ordinal + '") — unsupported ordinal');
		}
		return ORDINAL_TO_POSITION[ordinal];
	}

	// kz_date:find_next_weekday/2
	function findNextWeekday(date, wday) {
		var refDow = wdayToDow(wday),
			dow = dayOfWeek(date);
		if (dow === refDow) { return normalize({ y: date.y, m: date.m, d: date.d + 7 }); }
		if (refDow > dow) { return normalize({ y: date.y, m: date.m, d: date.d + (refDow - dow) }); }
		return normalize({ y: date.y, m: date.m, d: date.d + (7 - dow) + refDow });
	}

	/* ---------------------------------------------------------------------------------------- *
	 * cf_temporal_route helpers
	 * ---------------------------------------------------------------------------------------- */

	// iso_week_difference/2 — whole ISO weeks between the Mondays of two dates.
	function isoWeekDifference(a, b) {
		var wa = isoWeekNumber(a), wb = isoWeekNumber(b),
			ds0 = gdays(fromIsoWeek(wa.year, wa.week)),
			ds1 = gdays(fromIsoWeek(wb.year, wb.week));
		return Math.trunc(Math.abs(ds0 - ds1) / 7);
	}

	// find_active_days/2 — the rule's weekdays (as DOW) on or after today's DOW, in rule order.
	function findActiveDays(wdays, dow0) {
		var out = [];
		for (var i = 0; i < wdays.length; i++) {
			var dow = wdayToDow(wdays[i]);
			if (dow >= dow0) { out.push(dow); }
		}
		return out;
	}

	// sort_wdays/1 — KAZOO QUIRK: an EMPTY list means ALL SEVEN DAYS, not none.
	function sortWdays(wdays) {
		if (!wdays || wdays.length === 0) {
			return DOW_TO_WDAY.slice(1);
		}
		var keyed = wdays.map(function(day, idx) { return { dow: wdayToDow(day), idx: idx, day: day }; });
		keyed.sort(function(a, b) { return a.dow - b.dow || a.idx - b.idx; }); // lists:keysort is stable
		return keyed.map(function(k) { return k.day; });
	}

	// date_of_dow/4 — "unsafe": may return a date in the NEXT month (e.g. a 5th Monday that
	// doesn't exist). Callers rely on that.
	function dateOfDow(year, month, wday, ordinal) {
		if (month === 1) { return dateOfDow(year - 1, 13, wday, ordinal); }
		var refDate = { y: year, m: month - 1, d: lastDayOfMonth(year, month - 1) },
			refDays = gdays(refDate),
			dow = wdayToDow(wday),
			occurrence = ordinalToPosition(ordinal),
			refDow = dayOfWeek(refDate),
			days;
		if (refDow === dow) {
			days = refDays + 7 + 7 * occurrence;
		} else if (dow < refDow) {
			days = refDays + dow + (7 - refDow) + 7 * occurrence;
		} else {
			days = refDays + Math.abs(dow - refDow) + 7 * occurrence;
		}
		return normalize(civilFromDays(days));
	}

	// find_ordinal_weekday/4 — retries the next month whenever date_of_dow raises.
	function findOrdinalWeekday(year, month, wday, ordinal, depth) {
		depth = depth || 0;
		if (depth > LOOP_GUARD) {
			hang('find_ordinal_weekday loops forever for ordinal "' + ordinal + '" — Kazoo would hang');
		}
		if (month === 13) { return findOrdinalWeekday(year + 1, 1, wday, ordinal, depth + 1); }
		if (month > 12) { return findOrdinalWeekday(year + 1, month - 12, wday, ordinal, depth + 1); }
		try {
			return dateOfDow(year, month, wday, ordinal);
		} catch (e) {
			if (!(e instanceof KazooCrash) || e.kind === 'hang') { throw e; }
			return findOrdinalWeekday(year, month + 1, wday, ordinal, depth + 1);
		}
	}

	// find_last_weekday/2 — try the 5th occurrence; if that spills into another month, the 4th.
	function findLastWeekday(date, wday) {
		var y = date.y, m = date.m;
		if (m === 13) { return findLastWeekday({ y: y + 1, m: 1, d: date.d }, wday); }
		if (m > 12) { return findLastWeekday({ y: y + 1, m: m - 12, d: date.d }, wday); }
		try {
			var fifth = dateOfDow(y, m, wday, 'fifth');
			if (fifth.y === y && fifth.m === m) { return fifth; }
		} catch (e) {
			if (!(e instanceof KazooCrash)) { throw e; }
		}
		return dateOfDow(y, m, wday, 'fourth');
	}

	// find_next_yearly_ordinal_weekday/5 — KAZOO QUIRK: compares month only, not year.
	function findNextYearlyOrdinalWeekday(y0, m0, wday, ordinal, interval) {
		for (var i = 0; i < LOOP_GUARD; i++) {
			var date = findOrdinalWeekday(y0, m0, wday, ordinal);
			if (date.m === m0) { return date; }
			y0 += interval;
		}
		hang('find_next_yearly_ordinal_weekday never finds a date — Kazoo loops forever and the call hangs');
	}

	/* ---------------------------------------------------------------------------------------- *
	 * next_rule_date/2 — "The big daddy"
	 * Returns the (possibly un-normalized) date of the rule's next occurrence on/after `date`.
	 * Clause order mirrors the Erlang function heads exactly.
	 * ---------------------------------------------------------------------------------------- */

	function nextRuleDate(rule, date) {
		var cycle = rule.cycle,
			i0 = rule.interval,
			start = rule.startDate,
			y0 = start.y, m0 = start.m, d0 = start.d,
			y1 = date.y, m1 = date.m, d1 = date.d,
			single = rule.wdays.length === 1 ? rule.wdays[0] : null,
			distance, offset, found, m01;

		if (cycle === 'date') {
			return start;
		}

		if (i0 === 0 && cycle !== '') {
			crash('interval is 0 — Erlang badarith (division by zero)');
		}

		if (cycle === 'daily') {
			var ds0 = gdays(start), ds1 = gdays(date);
			offset = Math.trunc((ds1 - ds0) / i0) * i0;
			return normalize({ y: y0, m: m0, d: d0 + offset + i0 });
		}

		if (cycle === 'weekly') {
			var today = date,
				dow0 = dayOfWeek(today),
				active = findActiveDays(rule.wdays, dow0);
			distance = isoWeekDifference(start, today);
			offset = Math.trunc(distance / i0) * i0;

			if (active.length && compareDates(today, start) < 0 && distance === offset) {
				return nextRuleDate(rule, start);
			}
			if (active.length && sameDate(today, start) && active[0] === dow0 && distance === offset) {
				return start;
			}
			if (active.length && distance === offset) {
				return normalize({ y: y1, m: m1, d: d1 + active[0] - dow0 });
			}
			var w0 = isoWeekNumber(start),
				monday = fromIsoWeek(w0.year, w0.week + offset + i0);
			return normalize({ y: monday.y, m: monday.m, d: (monday.d - 1) + wdayToDow(rule.wdays[0]) });
		}

		if (cycle === 'monthly') {
			distance = (y1 - y0) * 12 - m0 + m1;
			offset = Math.trunc(distance / i0) * i0;

			if (rule.days.length > 0) {
				var later = rule.days.filter(function(d) { return d > d1; });
				if (later.length && distance === offset) {
					m01 = m0 + offset;
					return normalize({ y: y0 + ediv(m01, 12), m: erem(m01, 12), d: later[0] });
				}
				m01 = m0 + offset + i0;
				return normalize({ y: y0 + ediv(m01, 12), m: erem(m01, 12), d: rule.days[0] });
			}

			if (single !== null && rule.ordinal === 'every') {
				if (distance === offset) {
					found = findNextWeekday({ y: y1, m: m1, d: d1 }, single);
					if (found.y === y1 && found.m === m1) { return found; }
					if (i0 === 1) { return found; }
				}
				return findOrdinalWeekday(y0, m0 + offset + i0, single, 'first');
			}

			if (single !== null && rule.ordinal === 'last') {
				if (distance === offset) {
					found = findLastWeekday({ y: y1, m: m1, d: 1 }, single);
					if (d1 < found.d) { return found; }
				}
				return findLastWeekday({ y: y0, m: m0 + offset + i0, d: 1 }, single);
			}

			if (single !== null) {
				// KAZOO QUIRK (documented upstream): wrong for a "fifth" weekday with interval > 1
				// when the current month only has four. Kept as-is.
				if (distance === offset) {
					found = findOrdinalWeekday(y1, m1, single, rule.ordinal);
					if (found.m === m1 && d1 < found.d && i0 > 1) { return found; }
					if (i0 === 1 && (d1 < found.d || m1 < found.m)) { return found; }
				}
				return findOrdinalWeekday(y0, m0 + offset + i0, single, rule.ordinal);
			}

			crash('monthly rule needs `days`, or exactly one weekday with an ordinal (has ' +
				rule.wdays.length + ' weekdays) — Erlang function_clause');
		}

		if (cycle === 'yearly') {
			var month = rule.month;
			distance = y1 - y0;
			offset = Math.trunc(distance / i0) * i0;

			if (rule.days.length > 0) {
				// Not normalized here on purpose — process_rules normalizes (e.g. Feb 30 -> Mar 2).
				if (distance !== offset) { return { y: y0 + offset + i0, m: month, d: rule.days[0] }; }
				if (m1 < month) { return { y: y1, m: month, d: rule.days[0] }; }
				if (m1 > month) { return { y: y0 + offset + i0, m: month, d: rule.days[0] }; }
				var rest = rule.days.slice();
				while (rest.length && d1 >= rest[0]) { rest.shift(); } // lists:dropwhile
				if (!rest.length) { return { y: y0 + offset + i0, m: month, d: rule.days[0] }; }
				return { y: y1, m: month, d: rest[0] };
			}

			if (single !== null && rule.ordinal === 'every') {
				if (distance === offset) {
					// KAZOO QUIRK: {Y1, Month, D1} can be an invalid date (e.g. Feb 31) — Erlang
					// crashes in calendar:day_of_the_week. gdays() reproduces that crash.
					found = findNextWeekday({ y: y1, m: month, d: d1 }, single);
					if (found.y === y1 && found.m === month && m1 < month) { return found; }
					if (found.y === y1 && found.m === month && m1 === month && d1 < found.d) { return found; }
				}
				return findOrdinalWeekday(y0 + offset + i0, month, single, 'first');
			}

			if (single !== null && rule.ordinal === 'last') {
				if (distance === offset) {
					found = findLastWeekday({ y: y1, m: month, d: 1 }, single);
					if (found.y === y1 && m1 < month) { return found; }
					if (found.y === y1 && m1 === month && d1 < found.d) { return found; }
				}
				return findLastWeekday({ y: y0 + offset + i0, m: month, d: 1 }, single);
			}

			if (single !== null) {
				if (distance === offset) {
					found = findOrdinalWeekday(y1, month, single, rule.ordinal);
					if (found.y === y1 && found.m === month && m1 < month) { return found; }
					if (found.y === y1 && found.m === month && m1 === month && d1 < found.d) { return found; }
				}
				return findNextYearlyOrdinalWeekday(y0 + offset + i0, month, single, rule.ordinal, i0);
			}

			crash('yearly rule needs `days`, or exactly one weekday with an ordinal (has ' +
				rule.wdays.length + ' weekdays) — Erlang function_clause');
		}

		crash('unknown cycle "' + cycle + '" — Erlang function_clause in next_rule_date');
	}

	/* ---------------------------------------------------------------------------------------- *
	 * Doc -> rule (build_rule/4 + kzd_temporal_rules getters)
	 * ---------------------------------------------------------------------------------------- */

	// kz_json:get_integer_value — numeric strings are coerced (your data has "61200").
	function toInteger(value, dflt, field) {
		if (value === undefined || value === null || value === '') { return dflt; }
		if (typeof value === 'number' && isFinite(value)) { return Math.trunc(value); }
		if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) { return parseInt(value, 10); }
		crash('cannot convert ' + field + '=' + JSON.stringify(value) + ' to integer');
	}

	// kz_json:get_boolean_value — true/false/"true"/"false", anything else = undefined.
	function toBooleanOrUndefined(value) {
		if (value === true || value === 'true') { return true; }
		if (value === false || value === 'false') { return false; }
		return undefined;
	}

	function toNonEmptyString(value, dflt) {
		return typeof value === 'string' && value.length > 0 ? value : dflt;
	}

	var formatterCache = {};

	/** UTC instant (ms) -> wall clock in `timezone`. Throws KazooCrash on an unknown zone. */
	function toLocal(epochMs, timezone) {
		var fmt = formatterCache[timezone];
		if (!fmt) {
			try {
				fmt = new Intl.DateTimeFormat('en-US', {
					timeZone: timezone, hourCycle: 'h23',
					year: 'numeric', month: '2-digit', day: '2-digit',
					hour: '2-digit', minute: '2-digit', second: '2-digit'
				});
			} catch (e) {
				crash('unknown timezone "' + timezone + '"');
			}
			formatterCache[timezone] = fmt;
		}
		var parts = {};
		fmt.formatToParts(new Date(epochMs)).forEach(function(p) { parts[p.type] = p.value; });
		return {
			y: parseInt(parts.year, 10), m: parseInt(parts.month, 10), d: parseInt(parts.day, 10),
			hour: parseInt(parts.hour, 10) % 24, minute: parseInt(parts.minute, 10), second: parseInt(parts.second, 10)
		};
	}

	// kz_date:from_gregorian_seconds/2 — gregorian UTC seconds -> LOCAL date in timezone.
	function fromGregorianSeconds(seconds, timezone) {
		var local = toLocal((seconds - GREGORIAN_UNIX_OFFSET) * 1000, timezone);
		return { y: local.y, m: local.m, d: local.d };
	}

	/**
	 * end_date as naive local seconds (our epoch, like LSec), read the way Kazoo reads start_date:
	 * gregorian UTC seconds converted into the route's timezone. null when there is no end date.
	 *   'exclusive' (Teklink; DT-Callflows temporalRuleEndDateExclusive): the rule stops AT
	 *               end_date. DT writes midnight of the end day, so that day is not included;
	 *               SmartPBX writes 23:59:59 of its last day, so that day is.
	 *   'inclusive' a midnight end_date includes its own day (DT without that setting).
	 */
	function endLsecOf(doc, timezone, endMode) {
		var v = doc.end_date;
		if (v === undefined || v === null || v === '' || v === 0 || v === '0') { return null; }
		var secs = toInteger(v, null, 'end_date'),
			local = toLocal((secs - GREGORIAN_UNIX_OFFSET) * 1000, timezone),
			sod = local.hour * 3600 + local.minute * 60 + local.second,
			lsec = gdays({ y: local.y, m: local.m, d: local.d }) * SECONDS_IN_DAY + sod;
		return endMode === 'inclusive' && sod === 0 ? lsec + SECONDS_IN_DAY : lsec;
	}

	// DT-Callflows "manual" rule (night-mode switch): cycle daily, no window, `enabled` flipped by
	// a feature code. Kazoo treats it like any forced rule; only the wording differs.
	function isManual(doc) {
		return !!(doc && doc.dimension && doc.dimension.rule_type === 'manual');
	}

	function gregorianSecondsToUnixMs(seconds) {
		return (seconds - GREGORIAN_UNIX_OFFSET) * 1000;
	}

	/**
	 * build_rule/4. `lsecGregorian` is only used as Kazoo's (odd) default when a doc has no
	 * start_date: kzd_temporal_rules:start_date(Doc, LSec) — local seconds treated as UTC.
	 * KAZOO QUIRK kept.
	 */
	function buildRule(id, doc, timezone, lsecGregorian, endMode) {
		var startSeconds = toInteger(doc.start_date, lsecGregorian, 'start_date');
		return {
			manual: isManual(doc),
			endLsec: endLsecOf(doc, timezone, endMode),
			id: id,
			name: toNonEmptyString(doc.name, DEFAULTS.name),
			cycle: toNonEmptyString(doc.cycle, DEFAULTS.cycle),
			interval: toInteger(doc.interval, DEFAULTS.interval, 'interval'),
			days: (Array.isArray(doc.days) ? doc.days : DEFAULTS.days).map(function(d) {
				return toInteger(d, undefined, 'days[]');
			}),
			enabled: toBooleanOrUndefined(doc.enabled),
			month: toInteger(doc.month, DEFAULTS.month, 'month'),
			ordinal: toNonEmptyString(doc.ordinal, DEFAULTS.ordinal),
			startDate: fromGregorianSeconds(startSeconds, timezone),
			wdays: sortWdays(Array.isArray(doc.wdays) ? doc.wdays : DEFAULTS.wdays),
			wtimeStart: toInteger(doc.time_window_start, DEFAULTS.wtimeStart, 'time_window_start'),
			wtimeStop: toInteger(doc.time_window_stop, DEFAULTS.wtimeStop, 'time_window_stop')
		};
	}

	/* ---------------------------------------------------------------------------------------- *
	 * Time inputs
	 * ---------------------------------------------------------------------------------------- */

	/**
	 * Normalizes the caller's notion of "now" into a local wall clock:
	 *   { instant: Date|ms }                         -> converted into `timezone`
	 *   { local: {y, m, d, hour?, minute?, second?} } -> used as-is (simulator: pick a time
	 *                                                   in the account's own zone)
	 */
	function resolveNow(at, timezone) {
		var local;
		if (at && at.local) {
			local = {
				y: at.local.y, m: at.local.m, d: at.local.d,
				hour: at.local.hour || 0, minute: at.local.minute || 0, second: at.local.second || 0
			};
			assertValidDate(local, 'resolveNow');
		} else {
			var ms = at && at.instant !== undefined ? +at.instant : Date.now();
			local = toLocal(ms, timezone);
		}
		var date = { y: local.y, m: local.m, d: local.d },
			secOfDay = local.hour * 3600 + local.minute * 60 + local.second;
		return {
			date: date,
			secOfDay: secOfDay,
			// Naive local seconds on our own epoch — compared only with each other (Kazoo's LSec).
			lsec: gdays(date) * SECONDS_IN_DAY + secOfDay,
			// Kazoo's LSec on the gregorian epoch, needed only for the missing-start_date default.
			lsecGregorian: (gdays(date) + 719528) * SECONDS_IN_DAY + secOfDay,
			local: local
		};
	}

	function windowFor(baseDate, rule) {
		var base = gdays(baseDate) * SECONDS_IN_DAY;
		return { baseDate: baseDate, start: base + rule.wtimeStart, end: base + rule.wtimeStop };
	}

	/** Our epoch's local seconds -> {y, m, d, hour, minute, second} for display. */
	function lsecToLocal(lsec) {
		var days = Math.floor(lsec / SECONDS_IN_DAY),
			rem = lsec - days * SECONDS_IN_DAY,
			date = civilFromDays(days);
		return {
			y: date.y, m: date.m, d: date.d,
			hour: Math.floor(rem / 3600), minute: Math.floor((rem % 3600) / 60), second: rem % 60
		};
	}

	/**
	 * The time-window half of process_rules/3 for ONE already-built, enabled rule.
	 * Returns { outcome: 'active' | 'not-yet' | 'expired', window }.
	 */
	function testWindow(rule, now) {
		// "Weekly logic becomes convoluted when prev date is passed for SearchDate.
		//  This creates lots of edge cases so pass today in weekly only."
		var searchDate = rule.cycle === 'weekly' ? now.date : normalize({ y: now.date.y, m: now.date.m, d: now.date.d - 1 }),
			baseDate = normalize(nextRuleDate(rule, searchDate)),
			win = windowFor(baseDate, rule);
		if (now.lsec < win.start) { return { outcome: 'not-yet', window: win }; }
		if (now.lsec > win.end) { return { outcome: 'expired', window: win }; }
		return { outcome: 'active', window: win };
	}

	// The rule's end_date has passed (see endLsecOf): it no longer applies at all.
	function isEnded(rule, now) {
		return rule.endLsec !== null && rule.endLsec !== undefined && now.lsec > rule.endLsec; // like Kazoo's own "LSec > End"
	}

	function isFutureStart(rule, now) {
		// kz_date:relative_difference(Now, {StartDate, {0,0,0}}) =:= 'future'
		return gdays(rule.startDate) * SECONDS_IN_DAY > now.lsec;
	}

	/* ---------------------------------------------------------------------------------------- *
	 * Public: evaluate a whole temporal_route node
	 * ---------------------------------------------------------------------------------------- */

	// cf_util:get_timezone/2
	function resolveTimezone(nodeData, accountTimezone) {
		var tz = nodeData && toNonEmptyString(nodeData.timezone, undefined);
		if (tz && tz !== 'inherit') { return tz; }
		return accountTimezone;
	}

	/**
	 * get_temporal_route/2 routes: data.rules, then branch keys, then rule_set, then each route
	 * expanded through temporal_rule_sets. Each route = { ruleId, branch }.
	 */
	function buildRoutes(nodeData, childKeys, ruleSets) {
		var routes = [], sets = ruleSets || {};
		(nodeData && Array.isArray(nodeData.rules) ? nodeData.rules : []).forEach(function(id) {
			routes.push({ ruleId: id, branch: id });
		});
		// cf_exe:get_branch_keys — every child key. "_" is never a rule doc so Kazoo just fails to
		// open it; we drop it here to keep the trace clean (no behavioural difference).
		(childKeys || []).forEach(function(key) {
			if (key !== '_') { routes.push({ ruleId: key, branch: key }); }
		});
		if (nodeData && nodeData.rule_set) {
			var set = sets[nodeData.rule_set];
			((set && set.temporal_rules) || []).forEach(function(id) {
				routes.push({ ruleId: id, branch: 'rule_set' });
			});
		}
		// maybe_expand_rulesets/3
		var expanded = [];
		routes.forEach(function(r) {
			if (r.branch === 'rule_set') { expanded.push(r); return; }
			var s = sets[r.ruleId], members = (s && s.temporal_rules) || [];
			if (members.length) {
				members.forEach(function(id) { expanded.push({ ruleId: id, branch: r.ruleId }); });
			} else {
				expanded.push({ ruleId: r.ruleId, branch: r.ruleId });
			}
		});
		return expanded;
	}

	/**
	 * Evaluate a temporal_route callflow node the way Kazoo would.
	 *
	 * @param {Object} args
	 * @param {Object} args.node             the node's `data` ({ rules: [...], timezone?, rule_set? })
	 * @param {Array}  args.childKeys        Object.keys(node.children)
	 * @param {Object} args.ruleDocs         { ruleId: temporal_rules doc }
	 * @param {Object} [args.ruleSets]       { setId: temporal_rule_sets doc }
	 * @param {String} args.accountTimezone  the account's timezone
	 * @param {Object} [args.at]             { instant } or { local } — defaults to now
	 * @param {Object} [args.force]          { ruleId: true|false } — simulate the enable/disable
	 *                                       feature codes without touching the real docs
	 * @returns {Object} {
	 *   branch:      child key Kazoo continues with ('_' = default), or null if Kazoo would crash
	 *   kazooError:  { ruleId, message } when Kazoo would crash and fail the call, else null
	 *   bestEffortBranch: branch if crashing rules are skipped (for display only)
	 *   matched:     the matching trace entry or null
	 *   timezone, now: { y, m, d, hour, minute, second }
	 *   trace:       one entry per route, in Kazoo's order (see OUTCOMES)
	 * }
	 */
	function evaluateRoute(args) {
		var timezone = resolveTimezone(args.node, args.accountTimezone),
			now = resolveNow(args.at, timezone),
			routes = buildRoutes(args.node, args.childKeys, args.ruleSets),
			force = args.force || {},
			ruleDocs = args.ruleDocs || {},
			trace = [],
			seen = {},
			kazooError = null,
			built = [],
			endMode = args.endDate || 'exclusive';

		// Phase 1 — get_temporal_rules/2: load, discard future starts, build. A crash here takes
		// down the whole route in Kazoo, even for a rule that would never be reached.
		routes.forEach(function(route) {
			var key = route.ruleId + '\u0000' + route.branch;
			if (seen[key]) { return; } // identical route evaluated twice gives an identical result
			seen[key] = true;

			var entry = { ruleId: route.ruleId, branch: route.branch, name: null, outcome: null, detail: null, window: null },
				doc = ruleDocs[route.ruleId];
			trace.push(entry);

			if (!doc) {
				entry.outcome = 'missing';
				entry.detail = 'No temporal_rules doc with this id — Kazoo skips it.';
				return;
			}
			entry.name = toNonEmptyString(doc.name, DEFAULTS.name);
			try {
				var rule = buildRule(route.branch, doc, timezone, now.lsecGregorian, endMode);
				if (Object.prototype.hasOwnProperty.call(force, route.ruleId)) {
					rule.enabled = force[route.ruleId];
				}
				entry.name = rule.name;
				entry.manual = rule.manual;
				if (isFutureStart(rule, now)) {
					entry.outcome = 'future-start';
					entry.detail = 'start_date ' + fmtDate(rule.startDate) + ' is in the future — Kazoo discards the rule.';
					return;
				}
				// Checked with start_date, before any forcing: past its end date a rule is gone.
				if (isEnded(rule, now)) {
					entry.outcome = 'ended';
					entry.detail = 'Its end date has passed (last day ' + fmtDate(lsecToLocal(rule.endLsec - 1)) + ') — the rule no longer applies.';
					return;
				}
				built.push({ rule: rule, entry: entry });
			} catch (e) {
				if (!(e instanceof KazooCrash)) { throw e; }
				entry.outcome = 'error';
				entry.detail = e.message;
				if (!kazooError) { kazooError = { ruleId: route.ruleId, phase: 'load', kind: e.kind, message: e.message }; }
			}
		});

		// Phase 2 — process_rules/3: first match wins.
		var winner = null, bestEffort = null;
		built.forEach(function(item) {
			var rule = item.rule, entry = item.entry;
			if (bestEffort) {
				entry.outcome = 'not-reached';
				entry.detail = 'An earlier rule already matched.';
				return;
			}
			if (rule.enabled === false) {
				entry.outcome = 'disabled';
				entry.detail = rule.manual ? 'Manual switch is OFF.' : 'Forced off (enabled: false).';
				return;
			}
			if (rule.enabled === true) {
				entry.outcome = 'forced';
				entry.detail = rule.manual ? 'Manual switch is ON — matches regardless of time.' : 'Forced on (enabled: true) — matches regardless of time.';
				bestEffort = entry;
				if (!kazooError) { winner = entry; }
				return;
			}
			if (rule.cycle === '') {
				entry.outcome = 'invalid';
				entry.detail = 'No cycle — Kazoo logs "invalid" and skips it.';
				return;
			}
			try {
				var res = testWindow(rule, now);
				entry.outcome = res.outcome;
				entry.window = { start: lsecToLocal(res.window.start), end: lsecToLocal(res.window.end) };
				entry.detail = {
					'active': 'Inside the active window.',
					'not-yet': 'Next window has not started yet.',
					'expired': 'Today\'s window already ended.'
				}[res.outcome];
				if (res.outcome === 'active') {
					bestEffort = entry;
					if (!kazooError) { winner = entry; }
				}
			} catch (e) {
				if (!(e instanceof KazooCrash)) { throw e; }
				entry.outcome = 'error';
				entry.detail = e.message;
				// Only fatal in Kazoo if the call actually reached this rule.
				if (!kazooError && !winner) { kazooError = { ruleId: rule.id, phase: 'process', kind: e.kind, message: e.message }; }
			}
		});

		return {
			branch: kazooError ? null : (winner ? winner.branch : '_'),
			kazooError: kazooError,
			bestEffortBranch: bestEffort ? bestEffort.branch : '_',
			matched: kazooError ? null : winner,
			timezone: timezone,
			now: now.local,
			trace: trace
		};
	}

	/* ---------------------------------------------------------------------------------------- *
	 * Public: describe a single rule (drives the "· now / next Nov 23 / ended" labels)
	 * ---------------------------------------------------------------------------------------- */

	/**
	 * @returns {Object} {
	 *   state: 'active' | 'upcoming' | 'ended' | 'never' | 'not-started' |
	 *          'forced-on' | 'forced-off' | 'invalid' | 'error',
	 *   window: { start, end } of the current/next occurrence (local wall clock) when known,
	 *   detail: human text
	 * }
	 */
	function describeRule(doc, opts) {
		opts = opts || {};
		var timezone = opts.timezone,
			now = resolveNow(opts.at, timezone),
			horizon = opts.horizonDays || 400,
			rule;
		try {
			rule = buildRule(doc.id || null, doc, timezone, now.lsecGregorian, opts.endDate);
		} catch (e) {
			if (!(e instanceof KazooCrash)) { throw e; }
			return { state: 'error', window: null, detail: e.message };
		}
		if (isEnded(rule, now)) {
			var last = lsecToLocal(rule.endLsec - 1);
			return { state: 'ended', window: null, endedOn: { y: last.y, m: last.m, d: last.d }, detail: 'Ended ' + fmtDate(last) + '.' };
		}
		if (rule.enabled === true) { return { state: 'forced-on', manual: rule.manual, window: null, detail: rule.manual ? 'Manual switch ON — always active.' : 'Forced on — always active.' }; }
		if (rule.enabled === false) { return { state: 'forced-off', manual: rule.manual, window: null, detail: rule.manual ? 'Manual switch OFF — never active.' : 'Forced off — never active.' }; }
		if (rule.cycle === '') { return { state: 'invalid', window: null, detail: 'No cycle set.' }; }
		if (rule.wtimeStop < rule.wtimeStart) {
			return { state: 'never', window: null, detail: 'Window ends before it starts (crosses midnight) — Kazoo never matches it.' };
		}

		try {
			if (!isFutureStart(rule, now)) {
				var current = testWindow(rule, now);
				if (current.outcome === 'active') {
					return { state: 'active', window: displayWindow(current.window), detail: 'Active now.' };
				}
			}
			// Scan forward one day at a time, testing each day at the window's opening second.
			for (var k = 0; k <= horizon; k++) {
				var day = addDays(now.date, k);
				if (k === 0 && rule.wtimeStart <= now.secOfDay) { continue; }
				var probe = {
					date: day,
					secOfDay: rule.wtimeStart,
					lsec: gdays(day) * SECONDS_IN_DAY + rule.wtimeStart
				};
				if (isFutureStart(rule, probe)) { continue; }
				if (isEnded(rule, probe)) { break; } // and never again
				var res = testWindow(rule, probe);
				if (res.outcome === 'active') {
					// A one-off `date` rule's start_date IS its occurrence, so ahead of today it's
					// simply upcoming. 'not-started' is for recurring rules that begin later.
					var started = rule.cycle === 'date' || !isFutureStart(rule, now);
					return {
						state: started ? 'upcoming' : 'not-started',
						window: displayWindow(res.window),
						detail: (started ? 'Next active ' : 'Starts ') + fmtDate(res.window.baseDate) + '.'
					};
				}
			}
		} catch (e) {
			if (!(e instanceof KazooCrash)) { throw e; }
			return { state: 'error', window: null, detail: e.message };
		}
		if (rule.endLsec !== null && rule.cycle !== 'date') {
			return { state: 'never', window: null, detail: 'Not active again before it ends ' + fmtDate(lsecToLocal(rule.endLsec - 1)) + '.' };
		}
		if (rule.cycle === 'date' && compareDates(rule.startDate, now.date) <= 0) {
			return { state: 'ended', window: null, endedOn: rule.startDate, detail: 'Ended ' + fmtDate(rule.startDate) + '.' };
		}
		return { state: 'never', window: null, detail: 'Not active in the next ' + horizon + ' days.' };
	}

	function displayWindow(win) {
		return { start: lsecToLocal(win.start), end: lsecToLocal(win.end) };
	}

	function pad2(n) { return (n < 10 ? '0' : '') + n; }
	function fmtDate(d) { return d.y + '-' + pad2(d.m) + '-' + pad2(d.d); }

	/* ---------------------------------------------------------------------------------------- *
	 * Public: static lint — things worth flagging on the canvas
	 * ---------------------------------------------------------------------------------------- */

	/** @returns {Array} [{ level: 'error'|'warning'|'info', code, message }] */
	function lintRule(doc, opts) {
		var issues = [],
			add = function(level, code, message) { issues.push({ level: level, code: code, message: message }); },
			cycle = toNonEmptyString(doc.cycle, ''),
			wdays = Array.isArray(doc.wdays) ? doc.wdays : [],
			nowMs = opts && opts.nowMs !== undefined ? opts.nowMs : Date.now(),
			start, stop;

		wdays.forEach(function(w) {
			if (!Object.prototype.hasOwnProperty.call(WDAY_TO_DOW, w)) {
				add('error', 'unknown-weekday', 'Unknown weekday "' + w + '" — Kazoo crashes loading this route, failing every call through it.');
			}
		});
		try { start = toInteger(doc.time_window_start, 0, 'time_window_start'); stop = toInteger(doc.time_window_stop, SECONDS_IN_DAY, 'time_window_stop'); } catch (e) {
			add('error', 'bad-window', e.message);
		}
		if (start !== undefined && stop !== undefined) {
			if (stop < start) { add('error', 'overnight-window', 'Window crosses midnight — Kazoo never matches it. Split it into two rules.'); }
			else if (stop === start) { add('warning', 'zero-window', 'Window is zero seconds long.'); }
		}
		if (doc.enabled === true || doc.enabled === 'true') { add('info', 'forced-on', 'Forced on — ignores the schedule entirely.'); }
		if (doc.enabled === false || doc.enabled === 'false') { add('info', 'forced-off', 'Forced off — never matches.'); }
		if (cycle === '') { add('warning', 'no-cycle', 'No cycle — Kazoo skips this rule.'); }
		if (cycle === 'weekly' && wdays.length === 0) { add('warning', 'weekly-all-days', 'No weekdays set — Kazoo treats that as EVERY day.'); }
		if (cycle === 'daily') { add('info', 'daily', 'Daily cycle — runs every ' + (toInteger(doc.interval, 1, 'interval') > 1 ? doc.interval + ' days' : 'day') + ' forever from start_date.'); }
		if ((cycle === 'monthly' || cycle === 'yearly') && !(Array.isArray(doc.days) && doc.days.length) && wdays.length !== 1) {
			add('error', 'ordinal-needs-one-weekday', 'A ' + cycle + ' rule without `days` needs exactly one weekday — Kazoo crashes on this one.');
		}
		if (toInteger(doc.interval, 1, 'interval') === 0) { add('error', 'zero-interval', 'interval is 0 — Kazoo crashes (division by zero).'); }
		if (doc.ordinal === 'fifth' && toInteger(doc.interval, 1, 'interval') > 1) {
			add('warning', 'fifth-interval-bug', 'Known Kazoo bug: "fifth" weekday with interval > 1 can land on the wrong date.');
		}
		try {
			var tzl = (opts && opts.timezone) || 'UTC',
				nowL = resolveNow({ instant: nowMs }, tzl),
				endL = endLsecOf(doc, tzl, opts && opts.endDate),
				startL = gdays(fromGregorianSeconds(toInteger(doc.start_date, nowL.lsecGregorian, 'start_date'), tzl)) * SECONDS_IN_DAY;
			if (endL !== null && endL <= startL) {
				add('warning', 'end-before-start', 'Its end date is on or before its start date — it never applies.');
			} else if (endL !== null && nowL.lsec > endL) {
				add('info', 'ended', 'Ended ' + fmtDate(lsecToLocal(endL - 1)) + ' — it no longer applies.');
			}
		} catch (e) {
			if (!(e instanceof KazooCrash)) { throw e; }
			add('error', 'bad-date', e.message);
		}
		if (isManual(doc) && doc.enabled === undefined) {
			add('info', 'manual-unset', 'Manual switch has no position, so it runs as a daily all-day rule: it always matches.');
		}
		// The dry run catches what static checks can't; when they already found an error, it
		// would only report the same cause again.
		var hasError = issues.some(function(i) { return i.level === 'error'; });
		var dry = hasError ? null : dryRun(doc, (opts && opts.timezone) || 'UTC', nowMs, 366, opts && opts.endDate);
		if (dry) {
			add('error', dry.kind === 'hang' ? 'kazoo-hang' : 'kazoo-crash',
				(dry.kind === 'hang' ? 'Kazoo loops forever on this rule' : 'Kazoo crashes on this rule') +
				' from ' + fmtDate(dry.date) + ' — every call reaching it ' + (dry.kind === 'hang' ? 'hangs' : 'fails') +
				'. (' + dry.message + ')');
		}
		return issues;
	}

	/**
	 * Evaluates the rule once per day for `days` days. Returns the first day Kazoo would crash or
	 * hang ({ date, kind, message }) or null. Catches what static checks can't, e.g. a yearly
	 * "fifth Sunday of February" every 4 years that never finds a date.
	 */
	function dryRun(doc, timezone, nowMs, days, endMode) {
		var today, rule;
		try {
			today = resolveNow({ instant: nowMs }, timezone);
			rule = buildRule(null, doc, timezone, today.lsecGregorian, endMode);
		} catch (e) {
			if (!(e instanceof KazooCrash)) { throw e; }
			return { date: today ? today.date : null, kind: e.kind, message: e.message };
		}
		if (rule.enabled !== undefined || rule.cycle === '') { return null; } // never evaluated
		for (var k = 0; k < days; k++) {
			var day = addDays(today.date, k),
				probe = { date: day, secOfDay: 0, lsec: gdays(day) * SECONDS_IN_DAY };
			if (isFutureStart(rule, probe)) { continue; }
			if (isEnded(rule, probe)) { break; }
			try {
				testWindow(rule, probe);
			} catch (e) {
				if (!(e instanceof KazooCrash)) { throw e; }
				return { date: day, kind: e.kind, message: e.message };
			}
		}
		return null;
	}

	/**
	 * A rule's dates for display, in the route's timezone: { start, lastDay } as {y, m, d}
	 * (lastDay null without an end date), and whether it is a DT manual switch.
	 */
	function ruleDates(doc, timezone, endMode) {
		var out = { start: null, lastDay: null, manual: isManual(doc) };
		if (!doc) { return out; }
		try {
			if (doc.start_date !== undefined && doc.start_date !== null && doc.start_date !== '') {
				out.start = fromGregorianSeconds(toInteger(doc.start_date, 0, 'start_date'), timezone || 'UTC');
			}
			var end = endLsecOf(doc, timezone || 'UTC', endMode);
			if (end !== null) { var l = lsecToLocal(end - 1); out.lastDay = { y: l.y, m: l.m, d: l.d }; }
		} catch (e) {
			if (!(e instanceof KazooCrash)) { throw e; }
		}
		return out;
	}

	return {
		evaluateRoute: evaluateRoute,
		ruleDates: ruleDates,
		isManual: isManual,
		describeRule: describeRule,
		lintRule: lintRule,
		resolveTimezone: resolveTimezone,
		gregorianSecondsToUnixMs: gregorianSecondsToUnixMs,
		KazooCrash: KazooCrash,
		// Exposed for unit tests only.
		_internals: {
			normalize: normalize,
			fromIsoWeek: fromIsoWeek,
			isoWeekNumber: isoWeekNumber,
			isoWeekDifference: isoWeekDifference,
			dayOfWeek: dayOfWeek,
			dateOfDow: dateOfDow,
			findOrdinalWeekday: findOrdinalWeekday,
			findLastWeekday: findLastWeekday,
			findNextWeekday: findNextWeekday,
			sortWdays: sortWdays,
			nextRuleDate: nextRuleDate,
			buildRule: buildRule,
			buildRoutes: buildRoutes,
			testWindow: testWindow,
			resolveNow: resolveNow,
			fromGregorianSeconds: fromGregorianSeconds,
			toLocal: toLocal,
			gdays: gdays,
			civilFromDays: civilFromDays
		}
	};
}));
