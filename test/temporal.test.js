'use strict';
/**
 * Tests for app/lib/temporal.js. Run: npm test
 *
 * Three independent oracles:
 *   1. Known real-world dates (US holidays, ISO week facts, Erlang docstring examples).
 *   2. A brute-force reference written with plain JS Date (not the port's own calendar code),
 *      checked day by day across several years for every cycle where Kazoo's behaviour is
 *      "what you'd expect". Where Kazoo is quirky, a separate test pins the quirk explicitly.
 *   3. 17 real-world temporal rules (names and ids anonymized), evaluated at specific instants.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var T = require('../app/lib/temporal');
var I = T._internals;
var REAL = require('./fixtures/real-world-temporal-rules.json');

var NY = 'America/New_York';
var G_UNIX = 62167219200;
var WD = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function D(y, m, d) { return { y: y, m: m, d: d }; }
function gsec(y, m, d) { return Date.UTC(y, m - 1, d) / 1000 + G_UNIX; } // midnight UTC, gregorian secs
function at(y, m, d, hour, minute, second) {
	return { local: { y: y, m: m, d: d, hour: hour || 0, minute: minute || 0, second: second || 0 } };
}
function byName(name) {
	var id = Object.keys(REAL).filter(function(k) { return REAL[k].name === name; })[0];
	assert.ok(id, 'fixture has rule ' + name);
	return REAL[id];
}

/** Evaluate one rule doc as the sole rule of a route. Start dates are interpreted in UTC. */
function evalOne(doc, when, tz) {
	var id = doc.id || 'r1';
	return T.evaluateRoute({
		node: { rules: [id] }, childKeys: [id, '_'],
		ruleDocs: (function() { var o = {}; o[id] = doc; return o; }()),
		accountTimezone: tz || 'UTC', at: when
	});
}
function isActive(doc, y, m, d, sec, tz) {
	var r = evalOne(doc, at(y, m, d, Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60), tz);
	if (r.kazooError) { throw new Error('kazoo error: ' + r.kazooError.message); }
	return r.branch !== '_';
}

/* ---------- Brute-force reference, built on JS Date only ---------- */
var ref = {
	days: function(y, m, d) { return Math.round(Date.UTC(y, m - 1, d) / 864e5); },
	dow: function(y, m, d) { var w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return w === 0 ? 7 : w; },
	monday: function(y, m, d) { return ref.days(y, m, d) - (ref.dow(y, m, d) - 1); },
	dim: function(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); },
	nthWeekday: function(y, m, dow, n) { // n: 0..3, or 'last'
		var hits = [];
		for (var d = 1; d <= ref.dim(y, m); d++) { if (ref.dow(y, m, d) === dow) { hits.push(d); } }
		return n === 'last' ? hits[hits.length - 1] : hits[n];
	},
	eachDay: function(from, to, fn) {
		for (var t = Date.UTC(from.y, from.m - 1, from.d); t <= Date.UTC(to.y, to.m - 1, to.d); t += 864e5) {
			var x = new Date(t); fn(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate());
		}
	}
};

/* =========================================================================================== *
 * 1. Calendar helpers vs known facts
 * =========================================================================================== */

test('normalize matches kz_date semantics', function() {
	assert.deepEqual(I.normalize(D(2011, 1, 36)), D(2011, 2, 5)); // the Erlang docstring example
	assert.deepEqual(I.normalize(D(2026, 13, 1)), D(2027, 1, 1));
	assert.deepEqual(I.normalize(D(2026, 0, 15)), D(2025, 12, 15));
	assert.deepEqual(I.normalize(D(2026, 3, 0)), D(2026, 2, 28));
	assert.deepEqual(I.normalize(D(2024, 3, 0)), D(2024, 2, 29)); // leap year
	assert.deepEqual(I.normalize(D(2026, 1, 0)), D(2025, 12, 31));
	assert.deepEqual(I.normalize(D(2026, 24, 1)), D(2027, 12, 1)); // rem 12 = 0 -> December
	assert.deepEqual(I.normalize(D(2017, 12, 4 + 3273)), D(2026, 11, 20)); // big daily offset (3273 days)
});

test('ISO week number / from_iso_week / day of week', function() {
	assert.deepEqual(I.isoWeekNumber(D(2026, 1, 1)), { year: 2026, week: 1 });
	assert.deepEqual(I.isoWeekNumber(D(2021, 1, 3)), { year: 2020, week: 53 });
	assert.deepEqual(I.isoWeekNumber(D(2024, 12, 30)), { year: 2025, week: 1 });
	assert.deepEqual(I.fromIsoWeek(2026, 1), D(2025, 12, 29));
	assert.deepEqual(I.fromIsoWeek(2026, 1 + 52), D(2026, 12, 28)); // week numbers past 52 roll on
	assert.equal(I.dayOfWeek(D(2026, 11, 20)), 5); // Friday
	assert.equal(I.dayOfWeek(D(2026, 11, 22)), 7); // Sunday
	// Cross-check the port's calendar against JS Date across 1999..2031.
	ref.eachDay(D(1999, 12, 1), D(2031, 1, 31), function(y, m, d) {
		assert.equal(I.dayOfWeek(D(y, m, d)), ref.dow(y, m, d));
		var mon = I.fromIsoWeek(I.isoWeekNumber(D(y, m, d)).year, I.isoWeekNumber(D(y, m, d)).week);
		assert.equal(ref.days(mon.y, mon.m, mon.d), ref.monday(y, m, d));
	});
});

test('ordinal weekdays land on real US holidays (2026)', function() {
	assert.deepEqual(I.dateOfDow(2026, 1, 'monday', 'third'), D(2026, 1, 19));     // MLK Day
	assert.deepEqual(I.findLastWeekday(D(2026, 5, 1), 'monday'), D(2026, 5, 25));  // Memorial Day
	assert.deepEqual(I.dateOfDow(2026, 9, 'monday', 'first'), D(2026, 9, 7));      // Labor Day
	assert.deepEqual(I.dateOfDow(2026, 11, 'thursday', 'fourth'), D(2026, 11, 26)); // Thanksgiving
	assert.deepEqual(I.findLastWeekday(D(2026, 1, 1), 'friday'), D(2026, 1, 30));  // 5th exists
	// "Unsafe" by design: a 5th Monday that doesn't exist spills into the next month.
	assert.deepEqual(I.dateOfDow(2026, 2, 'monday', 'fifth'), D(2026, 3, 2));
});

test('sort_wdays: sorted, "wensday" accepted, EMPTY means all seven days', function() {
	assert.deepEqual(I.sortWdays(['sunday', 'monday']), ['monday', 'sunday']);
	assert.deepEqual(I.sortWdays(['wensday', 'monday']), ['monday', 'wensday']);
	assert.deepEqual(I.sortWdays([]), WD);
	assert.throws(function() { I.sortWdays(['wendsday']); }, T.KazooCrash);
});

test('timezone: gregorian start_date -> local date, and DST edges', function() {
	// RH 2026's start_date is local midnight Sept 11 in New York, stored as 04:00 UTC.
	assert.deepEqual(I.fromGregorianSeconds(63956318400, NY), D(2026, 9, 11));
	// Spring forward 2026-03-08: 06:59:59Z = 01:59:59 EST, 07:00:00Z = 03:00:00 EDT.
	var before = I.toLocal(Date.UTC(2026, 2, 8, 6, 59, 59), NY), after = I.toLocal(Date.UTC(2026, 2, 8, 7, 0, 0), NY);
	assert.deepEqual([before.hour, before.minute], [1, 59]);
	assert.deepEqual([after.hour, after.minute], [3, 0]);
	assert.throws(function() { I.toLocal(0, 'Not/AZone'); }, T.KazooCrash);
});

/* =========================================================================================== *
 * 2. Brute-force reference, day by day over several years
 * =========================================================================================== */

var RANGE = { from: D(2024, 1, 1), to: D(2028, 12, 31) };
var WIN = { start: 9 * 3600, stop: 17 * 3600 };

// Probe each day just inside, at, and just outside the window edges.
function probeDay(doc, y, m, d, expectedDay) {
	[[WIN.start - 1, false], [WIN.start, true], [12 * 3600, true], [WIN.stop, true], [WIN.stop + 1, false]].forEach(function(p) {
		var expected = expectedDay && p[1];
		var got = isActive(doc, y, m, d, p[0]);
		if (got !== expected) {
			assert.fail(JSON.stringify(doc) + ' on ' + y + '-' + m + '-' + d + ' @' + p[0] + 's: expected ' + expected + ', got ' + got);
		}
	});
}

test('weekly (interval 1..3, various weekday sets) matches the reference', function() {
	var start = D(2023, 6, 14); // a Wednesday
	[1, 2, 3].forEach(function(interval) {
		[['monday', 'wednesday', 'friday'], ['sunday'], ['saturday', 'sunday'], [], ['wensday', 'thursday']].forEach(function(wdays) {
			var doc = { cycle: 'weekly', interval: interval, wdays: wdays, start_date: gsec(start.y, start.m, start.d),
				time_window_start: WIN.start, time_window_stop: WIN.stop };
			var dows = (wdays.length ? wdays : WD).map(function(w) { return w === 'wensday' ? 3 : WD.indexOf(w) + 1; });
			var startMonday = ref.monday(start.y, start.m, start.d);
			ref.eachDay(RANGE.from, RANGE.to, function(y, m, d) {
				var weeks = (ref.monday(y, m, d) - startMonday) / 7;
				probeDay(doc, y, m, d, weeks % interval === 0 && dows.indexOf(ref.dow(y, m, d)) !== -1);
			});
		});
	});
});

test('daily (interval 1..4) matches the reference — incl. the start-day quirk', function() {
	var start = D(2023, 12, 30);
	[1, 2, 3, 4].forEach(function(interval) {
		var doc = { cycle: 'daily', interval: interval, start_date: gsec(start.y, start.m, start.d),
			time_window_start: WIN.start, time_window_stop: WIN.stop };
		ref.eachDay(RANGE.from, RANGE.to, function(y, m, d) {
			var n = ref.days(y, m, d) - ref.days(start.y, start.m, start.d);
			probeDay(doc, y, m, d, n % interval === 0);
		});
	});
});

test('KAZOO QUIRK: a daily rule with interval >= 2 does NOT fire on its own start date', function() {
	var mk = function(interval) {
		return { cycle: 'daily', interval: interval, start_date: gsec(2026, 3, 10), time_window_start: 0, time_window_stop: 86400 };
	};
	assert.equal(isActive(mk(1), 2026, 3, 10, 43200), true);
	assert.equal(isActive(mk(2), 2026, 3, 10, 43200), false); // start day skipped...
	assert.equal(isActive(mk(2), 2026, 3, 12, 43200), true);  // ...then every 2nd day from it
});

test('date cycle fires on exactly one local day', function() {
	var doc = { cycle: 'date', start_date: gsec(2026, 7, 4), wdays: ['sunday'], time_window_start: WIN.start, time_window_stop: WIN.stop };
	ref.eachDay(D(2026, 6, 25), D(2026, 7, 15), function(y, m, d) {
		probeDay(doc, y, m, d, y === 2026 && m === 7 && d === 4);
	});
});

test('monthly by day-of-month (sorted, <= 28) matches the reference', function() {
	var start = D(2023, 11, 5);
	[1, 2, 3].forEach(function(interval) {
		[[1], [15], [1, 15, 28], [10, 20]].forEach(function(days) {
			var doc = { cycle: 'monthly', interval: interval, days: days, start_date: gsec(start.y, start.m, start.d),
				time_window_start: WIN.start, time_window_stop: WIN.stop };
			ref.eachDay(RANGE.from, RANGE.to, function(y, m, d) {
				var months = (y - start.y) * 12 + (m - start.m);
				probeDay(doc, y, m, d, months % interval === 0 && days.indexOf(d) !== -1);
			});
		});
	});
});

test('KAZOO QUIRK: "every month on the 31st" also fires on the 1st after a 30-day month', function() {
	var doc = { cycle: 'monthly', interval: 1, days: [31], start_date: gsec(2025, 1, 1), time_window_start: 0, time_window_stop: 86400 };
	assert.equal(isActive(doc, 2026, 3, 31, 43200), true);
	assert.equal(isActive(doc, 2026, 4, 30, 43200), false);
	assert.equal(isActive(doc, 2026, 5, 1, 43200), true); // April 31 normalizes to May 1
	assert.equal(isActive(doc, 2026, 5, 31, 43200), true);
});

test('monthly ordinal weekday (first..fourth, last; interval 1) matches the reference', function() {
	var start = D(2023, 1, 1);
	['first', 'second', 'third', 'fourth', 'last'].forEach(function(ordinal) {
		WD.forEach(function(wday, idx) {
			var doc = { cycle: 'monthly', interval: 1, ordinal: ordinal, wdays: [wday], start_date: gsec(start.y, start.m, start.d),
				time_window_start: WIN.start, time_window_stop: WIN.stop };
			var n = ordinal === 'last' ? 'last' : ['first', 'second', 'third', 'fourth'].indexOf(ordinal);
			ref.eachDay(D(2025, 1, 1), D(2027, 12, 31), function(y, m, d) {
				probeDay(doc, y, m, d, ref.nthWeekday(y, m, idx + 1, n) === d);
			});
		});
	});
});

// Verified against Kazoo's own Erlang (tools/kazoo-oracle): in 2026-2027 this rule fires on
// every genuine fifth Monday AND on Jun 1 2026, Feb 1 2027, Mar 1 2027 and Nov 1 2027.
test('KAZOO QUIRK: monthly "fifth Monday" also fires on a Monday the 1st after a four-Monday month', function() {
	var doc = { cycle: 'monthly', interval: 1, ordinal: 'fifth', wdays: ['monday'], start_date: gsec(2025, 1, 1), time_window_start: 0, time_window_stop: 86400 };
	assert.equal(isActive(doc, 2026, 6, 29, 43200), true);  // a genuine fifth Monday
	// May 2026 has four Mondays (4..25); its "fifth" spills to Mon Jun 1, which is exactly
	// the day after the search date (May 31), so it fires.
	assert.equal(isActive(doc, 2026, 6, 1, 43200), true);
	// July 2026 also has four Mondays, but its spill (Aug 3) is not the 1st: searching from
	// Aug 2 finds August's own fifth Monday (Aug 31), so Aug 3 does NOT fire.
	assert.equal(isActive(doc, 2026, 8, 3, 43200), false);
	assert.equal(isActive(doc, 2026, 8, 31, 43200), true);
});

test('yearly by month+day and by ordinal weekday (interval 1) match the reference', function() {
	var start = D(2022, 3, 3);
	var byDay = { cycle: 'yearly', interval: 1, month: 7, days: [4], start_date: gsec(start.y, start.m, start.d),
		time_window_start: WIN.start, time_window_stop: WIN.stop };
	var thanksgiving = { cycle: 'yearly', interval: 1, month: 11, ordinal: 'fourth', wdays: ['thursday'],
		start_date: gsec(start.y, start.m, start.d), time_window_start: WIN.start, time_window_stop: WIN.stop };
	var memorial = { cycle: 'yearly', interval: 1, month: 5, ordinal: 'last', wdays: ['monday'],
		start_date: gsec(start.y, start.m, start.d), time_window_start: WIN.start, time_window_stop: WIN.stop };
	ref.eachDay(RANGE.from, RANGE.to, function(y, m, d) {
		probeDay(byDay, y, m, d, m === 7 && d === 4);
		probeDay(thanksgiving, y, m, d, m === 11 && d === ref.nthWeekday(y, 11, 4, 3));
		probeDay(memorial, y, m, d, m === 5 && d === ref.nthWeekday(y, 5, 1, 'last'));
	});
});

test('yearly interval 2 only fires in active years', function() {
	var doc = { cycle: 'yearly', interval: 2, month: 12, days: [25], start_date: gsec(2024, 1, 1), time_window_start: 0, time_window_stop: 86400 };
	assert.equal(isActive(doc, 2024, 12, 25, 43200), true);
	assert.equal(isActive(doc, 2025, 12, 25, 43200), false);
	assert.equal(isActive(doc, 2026, 12, 25, 43200), true);
});

/* =========================================================================================== *
 * 3. Route semantics + real-world rules (America/New_York)
 * =========================================================================================== */

function route(rules, when, opts) {
	opts = opts || {};
	var docs = {};
	rules.forEach(function(r) { docs[r.id] = r; });
	return T.evaluateRoute({
		node: opts.node || { rules: rules.map(function(r) { return r.id; }) },
		childKeys: opts.childKeys || rules.map(function(r) { return r.id; }).concat('_'),
		ruleDocs: opts.ruleDocs || docs, accountTimezone: opts.tz || NY, at: when, force: opts.force
	});
}
function w(id, wdays, start, stop) {
	return { id: id, name: id, cycle: 'weekly', interval: 1, wdays: wdays, start_date: gsec(2020, 1, 1), time_window_start: start, time_window_stop: stop };
}

test('route: first match wins; later rules are "not-reached"', function() {
	var r = route([w('a', ['friday'], 9 * 3600, 17 * 3600), w('b', ['friday'], 0, 86400)], at(2026, 11, 20, 10));
	assert.equal(r.branch, 'a');
	assert.deepEqual(r.trace.map(function(t) { return t.outcome; }), ['active', 'not-reached']);
});

test('route: nothing matches -> default "_"', function() {
	var r = route([w('a', ['monday'], 0, 86400)], at(2026, 11, 20, 10));
	assert.equal(r.branch, '_');
	assert.equal(r.trace[0].outcome, 'not-yet');
});

test('route: missing docs are skipped, child keys are appended after data.rules', function() {
	var a = w('a', ['friday'], 0, 86400);
	var r = route([a], at(2026, 11, 20, 10), { node: { rules: ['ghost'] }, childKeys: ['a', '_'] });
	assert.deepEqual(r.trace.map(function(t) { return [t.ruleId, t.outcome]; }), [['ghost', 'missing'], ['a', 'active']]);
	assert.equal(r.branch, 'a');
});

test('route: a crashing rule fails the whole call even if an earlier rule matches', function() {
	var good = w('good', ['friday'], 0, 86400), bad = w('bad', ['fryday'], 0, 86400);
	var r = route([good, bad], at(2026, 11, 20, 10));
	assert.equal(r.branch, null);
	assert.equal(r.kazooError.ruleId, 'bad');
	assert.equal(r.kazooError.phase, 'load');
	assert.equal(r.bestEffortBranch, 'good');
});

test('route: future start_date is discarded; timezone override and "inherit"', function() {
	var future = Object.assign(w('f', ['friday'], 0, 86400), { start_date: gsec(2027, 1, 1) });
	assert.equal(route([future], at(2026, 11, 20, 10)).trace[0].outcome, 'future-start');
	assert.equal(T.resolveTimezone({ timezone: 'Europe/London' }, NY), 'Europe/London');
	assert.equal(T.resolveTimezone({ timezone: 'inherit' }, NY), NY);
	assert.equal(T.resolveTimezone({}, NY), NY);
});

test('route: an instant is evaluated in the route timezone', function() {
	// 2026-11-20 14:30Z = 09:30 EST (Fri) in New York, 14:30 in London.
	var rule = w('a', ['friday'], 9 * 3600, 10 * 3600);
	assert.equal(route([rule], { instant: Date.UTC(2026, 10, 20, 14, 30) }).branch, 'a');
	assert.equal(route([rule], { instant: Date.UTC(2026, 10, 20, 14, 30) }, { tz: 'Europe/London' }).branch, '_');
});

test('route: force simulates the enable/disable feature codes', function() {
	var rule = w('a', ['monday'], 0, 86400);
	assert.equal(route([rule], at(2026, 11, 20, 10), { force: { a: true } }).branch, 'a');
	assert.equal(route([w('b', ['friday'], 0, 86400)], at(2026, 11, 20, 10), { force: { b: false } }).branch, '_');
});

test('real: "RH 2026" holiday is active all of Sept 11 2026 (New York) and only then', function() {
	var rh = byName('Holiday 2026');
	assert.equal(route([rh], at(2026, 9, 11, 0, 0, 0)).branch, rh.id);
	assert.equal(route([rh], at(2026, 9, 11, 23, 59, 59)).branch, rh.id);
	assert.equal(route([rh], at(2026, 9, 12, 0, 30)).branch, '_');
	assert.equal(route([rh], at(2026, 9, 10, 23, 59)).branch, '_');
	assert.equal(T.describeRule(rh, { timezone: NY, at: at(2026, 11, 20, 10) }).state, 'ended');
	assert.equal(T.describeRule(rh, { timezone: NY, at: at(2026, 9, 1, 10) }).state, 'upcoming');
});

test('real: "Dart night test" — weekly, all seven days incl. "wensday", 13:15-23:55', function() {
	var r = byName('Night test');
	assert.equal(route([r], at(2026, 11, 18, 14)).branch, r.id); // a Wednesday — via "wensday"
	assert.equal(route([r], at(2026, 11, 18, 23, 56)).trace[0].outcome, 'expired');
	assert.equal(route([r], at(2026, 11, 18, 13, 14)).trace[0].outcome, 'not-yet');
});

test('real: forced-on / forced-off rules', function() {
	assert.equal(route([byName('Forced-on test')], at(2026, 11, 20, 3)).trace[0].outcome, 'forced');
	assert.equal(route([byName('Forced-off test')], at(2026, 11, 22, 10)).trace[0].outcome, 'disabled');
});

test('real: "test" (weekly, EMPTY wdays) matches every day; its stop is the string "61106"', function() {
	var r = byName('test');
	assert.equal(typeof r.time_window_stop, 'string');
	[18, 19, 20, 21, 22].forEach(function(day) {
		assert.equal(route([r], at(2026, 11, day, 12)).branch, r.id);
	});
});

test('real: "Passover 2022 Thur" is DAILY — it has fired 09:00-12:00 every day since 2022', function() {
	var r = byName('Holiday 2022 Thu');
	assert.equal(r.cycle, 'daily');
	assert.equal(route([r], at(2026, 11, 20, 10)).branch, r.id);
	assert.equal(route([r], at(2026, 11, 20, 12, 30)).branch, '_');
	assert.ok(T.lintRule(r).some(function(i) { return i.code === 'daily'; }));
});

test('real: every real rule builds and describes without crashing', function() {
	Object.keys(REAL).forEach(function(id) {
		var doc = Object.assign({ id: id }, REAL[id]);
		var desc = T.describeRule(doc, { timezone: NY, at: at(2026, 11, 20, 12) });
		assert.notEqual(desc.state, 'error', doc.name + ': ' + desc.detail);
	});
});

/* =========================================================================================== *
 * 4. Lint
 * =========================================================================================== */

test('lint flags the things worth showing on the canvas', function() {
	var codes = function(doc) { return T.lintRule(doc).map(function(i) { return i.code; }); };
	assert.ok(codes({ cycle: 'weekly', wdays: ['monday'], time_window_start: 79200, time_window_stop: 7200 }).indexOf('overnight-window') !== -1);
	assert.ok(codes({ cycle: 'weekly', wdays: ['fryday'] }).indexOf('unknown-weekday') !== -1);
	assert.ok(codes({ cycle: 'weekly', wdays: [] }).indexOf('weekly-all-days') !== -1);
	assert.ok(codes({ cycle: 'monthly', wdays: ['monday', 'friday'] }).indexOf('ordinal-needs-one-weekday') !== -1);
	assert.ok(codes({ cycle: 'weekly', wdays: ['monday'], start_date: gsec(2019, 1, 1), end_date: gsec(2020, 1, 1) }).indexOf('ended') !== -1);
	assert.ok(codes({ cycle: 'weekly', wdays: ['monday'], start_date: gsec(2020, 1, 1), end_date: gsec(2019, 1, 1) }).indexOf('end-before-start') !== -1);
	assert.deepEqual(codes({ cycle: 'weekly', wdays: ['monday'], time_window_start: 0, time_window_stop: 3600 }), []);
});

test('lint dry-run catches rules that hang or crash Kazoo', function() {
	var codes = function(doc) { return T.lintRule(doc, { nowMs: Date.UTC(2026, 10, 20) }).map(function(i) { return i.code; }); };
	// Every 4 years from 2025 never visits a leap year, so February never has a fifth Sunday:
	// Kazoo's find_next_yearly_ordinal_weekday loops forever (confirmed in the Erlang oracle).
	assert.ok(codes({ cycle: 'yearly', interval: 4, month: 2, ordinal: 'fifth', wdays: ['sunday'], start_date: gsec(2025, 1, 1) })
		.indexOf('kazoo-hang') !== -1);
	// Yearly "every Tuesday in June" probes {Y, June, D1} with today's day-of-month — on the 31st
	// that's June 31, and Erlang's calendar crashes.
	assert.ok(codes({ cycle: 'yearly', interval: 1, month: 6, ordinal: 'every', wdays: ['tuesday'], start_date: gsec(2025, 1, 1) })
		.indexOf('kazoo-crash') !== -1);
	// Real rules are clean.
	Object.keys(REAL).forEach(function(id) {
		var c = T.lintRule(REAL[id], { timezone: NY, nowMs: Date.UTC(2026, 10, 20) }).map(function(i) { return i.code; });
		assert.equal(c.indexOf('kazoo-crash'), -1, REAL[id].name);
		assert.equal(c.indexOf('kazoo-hang'), -1, REAL[id].name);
	});
});
