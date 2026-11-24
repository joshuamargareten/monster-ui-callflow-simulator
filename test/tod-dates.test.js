'use strict';
/**
 * Time of day: start/end dates and manual switches, the way rules are really written.
 *   - DT-Callflows writes start_date/end_date as midnight of the chosen day in the browser's
 *     timezone; with temporalRuleEndDateExclusive (Teklink) the end day is not included.
 *   - SmartPBX holidays write end_date as 23:59:59 of the last day.
 *   - DT "manual" rules (night mode) are daily rules whose `enabled` a feature code flips.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var T = require('../app/lib/temporal');

var NY = 'America/New_York';
var G_UNIX = 62167219200;

// Gregorian seconds of a New York wall-clock moment (what Monster writes for "that day").
function nyG(y, m, d, h, mi, s) {
	// Find the UTC instant whose New York wall clock is y-m-d h:mi:s (two passes cover DST).
	var guess = Date.UTC(y, m - 1, d, h || 0, mi || 0, s || 0);
	for (var i = 0; i < 2; i++) {
		var l = T._internals.toLocal(guess, NY),
			diff = Date.UTC(l.y, l.m - 1, l.d, l.hour, l.minute, l.second) - Date.UTC(y, m - 1, d, h || 0, mi || 0, s || 0);
		guess -= diff;
	}
	return guess / 1000 + G_UNIX;
}
function at(y, m, d, hour, minute, second) {
	return { local: { y: y, m: m, d: d, hour: hour || 0, minute: minute || 0, second: second || 0 } };
}
function route(rule, when, opts) {
	opts = opts || {};
	var docs = {}; docs[rule.id] = rule;
	return T.evaluateRoute({
		node: { rules: [rule.id] }, childKeys: [rule.id, '_'], ruleDocs: docs,
		accountTimezone: NY, at: when, force: opts.force, endDate: opts.endDate
	});
}

// Business hours Mon–Fri 9–5, Dec 1 2026 through Dec 24 2026 (end date Dec 25, exclusive).
var SEASON = {
	id: 'season', name: 'Holiday season hours', cycle: 'weekly', interval: 1,
	wdays: ['monday', 'tuesday', 'wensday', 'thursday', 'friday'],
	time_window_start: 32400, time_window_stop: 61200,
	start_date: nyG(2026, 12, 1), end_date: nyG(2026, 12, 25)
};

test('DT end date (exclusive): the end day itself is not included', function() {
	assert.equal(route(SEASON, at(2026, 12, 24, 10)).branch, 'season');       // Thu, last day
	var after = route(SEASON, at(2026, 12, 28, 10));                           // Mon after
	assert.equal(after.branch, '_');
	assert.equal(after.trace[0].outcome, 'ended');
	assert.match(after.trace[0].detail, /2026-12-24/);
	assert.equal(route(SEASON, at(2026, 11, 30, 10)).trace[0].outcome, 'future-start');
});

test('end date "inclusive" mode includes a midnight end day', function() {
	var r = Object.assign({}, SEASON, { end_date: nyG(2026, 12, 24) });         // Thu
	assert.equal(route(r, at(2026, 12, 24, 10)).trace[0].outcome, 'ended');
	assert.equal(route(r, at(2026, 12, 24, 10), { endDate: 'inclusive' }).branch, r.id);
	assert.equal(route(r, at(2026, 12, 25, 10), { endDate: 'inclusive' }).trace[0].outcome, 'ended');
});

test('SmartPBX holiday: end_date 23:59:59 of its last day, a multi-day range', function() {
	var xmas = { id: 'xmas', name: 'Christmas break', cycle: 'daily', interval: 1,
		start_date: nyG(2026, 12, 24), end_date: nyG(2026, 12, 26, 23, 59, 59) };
	assert.equal(route(xmas, at(2026, 12, 24, 0)).branch, 'xmas');
	assert.equal(route(xmas, at(2026, 12, 26, 23, 59, 59)).branch, 'xmas');
	assert.equal(route(xmas, at(2026, 12, 27, 0, 0, 1)).trace[0].outcome, 'ended');
	assert.equal(route(xmas, at(2026, 12, 23, 23, 59)).trace[0].outcome, 'future-start');
});

test('a rule that has ended no longer matches even if forced on', function() {
	var r = Object.assign({}, SEASON, { enabled: true });
	assert.equal(route(r, at(2026, 12, 20, 3)).branch, 'season');               // forced, in range
	assert.equal(route(r, at(2027, 1, 4, 10)).trace[0].outcome, 'ended');
});

test('end dates use the route timezone, not UTC', function() {
	// 11:30 PM New York on the last day is already the next day in UTC.
	assert.equal(route(SEASON, at(2026, 12, 24, 16, 59)).branch, 'season');
	var night = Object.assign({}, SEASON, { cycle: 'daily', time_window_start: 0, time_window_stop: 86400 });
	assert.equal(route(night, at(2026, 12, 24, 23, 30)).branch, 'season');
	assert.equal(route(night, at(2026, 12, 25, 0, 0, 1)).trace[0].outcome, 'ended');
});

test('end_date 0 or empty means no end date', function() {
	[0, '0', '', null].forEach(function(v) {
		var r = Object.assign({}, SEASON, { end_date: v });
		assert.equal(route(r, at(2030, 1, 7, 10)).branch, 'season', JSON.stringify(v));
	});
});

test('describeRule and lint know about end dates', function() {
	assert.equal(T.describeRule(SEASON, { timezone: NY, at: at(2027, 1, 4, 10) }).state, 'ended');
	assert.deepEqual(T.describeRule(SEASON, { timezone: NY, at: at(2027, 1, 4, 10) }).endedOn, { y: 2026, m: 12, d: 24 });
	assert.equal(T.describeRule(SEASON, { timezone: NY, at: at(2026, 12, 24, 18) }).state, 'never');
	assert.equal(T.describeRule(SEASON, { timezone: NY, at: at(2026, 12, 23, 18) }).state, 'upcoming');
	var codes = function(doc, ms) { return T.lintRule(doc, { timezone: NY, nowMs: ms }).map(function(i) { return i.code; }); };
	assert.ok(codes(SEASON, Date.UTC(2027, 0, 5)).indexOf('ended') !== -1);
	assert.equal(codes(SEASON, Date.UTC(2026, 11, 10)).indexOf('ended'), -1);
	assert.deepEqual(T.ruleDates(SEASON, NY), { start: { y: 2026, m: 12, d: 1 }, lastDay: { y: 2026, m: 12, d: 24 }, manual: false });
	assert.deepEqual(T.ruleDates(SEASON, NY, 'inclusive').lastDay, { y: 2026, m: 12, d: 25 });
});

/* ---------------------------------- manual switches ---------------------------------- */

function manual(enabled) {
	var r = { id: 'night', name: 'Night mode', cycle: 'daily', start_date: nyG(2025, 1, 1),
		dimension: { rule_type: 'manual', feature_code_id: 12, tts_on: 'Night mode is now enabled.' } };
	if (enabled !== undefined) { r.enabled = enabled; }
	return r;
}

test('manual switch ON matches at any time, OFF never does', function() {
	var on = route(manual(true), at(2026, 11, 24, 11));
	assert.equal(on.branch, 'night');
	assert.equal(on.trace[0].manual, true);
	assert.match(on.trace[0].detail, /Manual switch is ON/);
	var off = route(manual(false), at(2026, 11, 24, 23));
	assert.equal(off.branch, '_');
	assert.match(off.trace[0].detail, /Manual switch is OFF/);
});

test('flipping a switch in the simulator (force) overrides the stored position', function() {
	assert.equal(route(manual(false), at(2026, 11, 24, 11), { force: { night: true } }).branch, 'night');
	assert.equal(route(manual(true), at(2026, 11, 24, 11), { force: { night: false } }).branch, '_');
	// "Schedule": the rule's enabled flag removed — a manual rule then always matches (daily, all day).
	assert.equal(route(manual(false), at(2026, 11, 24, 11), { force: { night: undefined } }).branch, 'night');
});

test('manual switches: describe, lint and dates', function() {
	var d = T.describeRule(manual(true), { timezone: NY, at: at(2026, 11, 24, 11) });
	assert.equal(d.state, 'forced-on');
	assert.equal(d.manual, true);
	assert.equal(T.describeRule(manual(false), { timezone: NY, at: at(2026, 11, 24, 11) }).state, 'forced-off');
	assert.ok(T.lintRule(manual(), { timezone: NY }).some(function(i) { return i.code === 'manual-unset'; }));
	assert.equal(T.isManual(manual(true)), true);
	assert.equal(T.isManual(SEASON), false);
});
