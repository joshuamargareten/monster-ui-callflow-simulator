'use strict';
/**
 * Differential test: app/lib/temporal.js vs Kazoo's REAL next_rule_date/2, run in Docker.
 *
 *   node tools/kazoo-oracle/diff.js <oracle-dir> [caseCount]
 *
 * <oracle-dir> is produced by build_oracle.py (see README.md). Every case is a (rule, date)
 * pair; both sides compute normalize(next_rule_date(Rule, Date)) — or crash — and must agree
 * exactly, crash-for-crash.
 */
var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var T = require('../../app/lib/temporal');
var I = T._internals;

var oracleDir = path.resolve(process.argv[2] || '');
var RANDOM_CASES = parseInt(process.argv[3] || '40000', 10);
if (!fs.existsSync(path.join(oracleDir, 'crv_oracle.erl'))) {
	console.error('usage: node diff.js <oracle-dir> [caseCount]  (run build_oracle.py first)');
	process.exit(2);
}

// Deterministic PRNG (mulberry32) so failures are reproducible. Optional 3rd arg = seed.
var seed = parseInt(process.argv[4] || String(0xC0FFEE), 10);
function rnd() {
	seed |= 0; seed = seed + 0x6D2B79F5 | 0;
	var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
	t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
	return ((t ^ t >>> 14) >>> 0) / 4294967296;
}
function pick(a) { return a[Math.floor(rnd() * a.length)]; }
function randInt(lo, hi) { return lo + Math.floor(rnd() * (hi - lo + 1)); }
function randDate(fromY, toY) {
	var from = Date.UTC(fromY, 0, 1), to = Date.UTC(toY, 11, 31);
	var x = new Date(from + Math.floor(rnd() * ((to - from) / 864e5 + 1)) * 864e5);
	return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() };
}
function eachDay(from, to, fn) {
	for (var t = Date.UTC(from.y, from.m - 1, from.d); t <= Date.UTC(to.y, to.m - 1, to.d); t += 864e5) {
		var x = new Date(t); fn({ y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() });
	}
}

var WD = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
// Only valid ordinals: an unknown one makes Kazoo itself loop forever.
var ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'every', 'last'];

var cases = [];
function add(rule, date) { cases.push({ rule: rule, date: date }); }

// A. Random rules x random dates, all cycles.
for (var n = 0; n < RANDOM_CASES; n++) {
	var wdays = [];
	var k = pick([0, 1, 1, 1, 2, 3]);
	for (var j = 0; j < k; j++) { wdays.push(rnd() < 0.08 ? 'wensday' : pick(WD)); }
	var days = [];
	if (rnd() < 0.5) {
		var kd = randInt(1, 3);
		for (j = 0; j < kd; j++) { days.push(randInt(1, 31)); }
		if (rnd() < 0.7) { days.sort(function(a, b) { return a - b; }); } // sometimes unsorted (GOTCHA)
	}
	add({
		cycle: pick(['daily', 'weekly', 'weekly', 'monthly', 'monthly', 'yearly', 'yearly', 'date']),
		interval: pick([1, 1, 1, 2, 3, 4]),
		start: randDate(2015, 2026),
		month: randInt(1, 12),
		ordinal: pick(ORDINALS),
		days: days,
		wdays: wdays
	}, randDate(2024, 2028));
}

// B. Day-by-day sweeps over the shapes that are easy to get wrong.
var SWEEP = [
	{ cycle: 'monthly', interval: 1, ordinal: 'fifth', wdays: ['monday'], days: [] },
	{ cycle: 'monthly', interval: 2, ordinal: 'fifth', wdays: ['monday'], days: [] },
	{ cycle: 'monthly', interval: 1, ordinal: 'last', wdays: ['friday'], days: [] },
	{ cycle: 'monthly', interval: 3, ordinal: 'every', wdays: ['sunday'], days: [] },
	{ cycle: 'monthly', interval: 1, ordinal: 'first', wdays: [], days: [31] },
	{ cycle: 'monthly', interval: 2, ordinal: 'first', wdays: [], days: [30, 15] },
	{ cycle: 'yearly', interval: 1, month: 2, ordinal: 'first', wdays: [], days: [29, 30] },
	{ cycle: 'yearly', interval: 1, month: 11, ordinal: 'fourth', wdays: ['thursday'], days: [] },
	{ cycle: 'yearly', interval: 2, month: 3, ordinal: 'fifth', wdays: ['sunday'], days: [] },
	{ cycle: 'yearly', interval: 1, month: 6, ordinal: 'every', wdays: ['tuesday'], days: [] },
	{ cycle: 'weekly', interval: 2, ordinal: 'first', wdays: ['monday', 'wensday', 'friday'], days: [] },
	{ cycle: 'weekly', interval: 3, ordinal: 'first', wdays: [], days: [] },
	{ cycle: 'daily', interval: 3, ordinal: 'first', wdays: [], days: [] }
];
SWEEP.forEach(function(shape) {
	var rule = Object.assign({ month: 1, start: { y: 2024, m: 1, d: 17 } }, shape);
	eachDay({ y: 2024, m: 12, d: 1 }, { y: 2027, m: 1, d: 31 }, function(date) { add(rule, date); });
});

function line(c) {
	var r = c.rule;
	return [r.cycle, r.interval, r.start.y + ' ' + r.start.m + ' ' + r.start.d, r.month, r.ordinal,
		r.days.length ? r.days.join(',') : '-', r.wdays.length ? r.wdays.join(',') : '-',
		c.date.y + ' ' + c.date.m + ' ' + c.date.d].join('\t');
}

function jsResult(c) {
	var r = c.rule;
	try {
		var rule = {
			cycle: r.cycle, interval: r.interval, startDate: r.start, month: r.month,
			ordinal: r.ordinal, days: r.days.slice(), wdays: I.sortWdays(r.wdays.slice())
		};
		var d = I.normalize(I.nextRuleDate(rule, c.date));
		I.gdays(d); // Erlang's {Y,M,D} pattern + format would not accept a garbage date either
		return 'ok ' + d.y + ' ' + d.m + ' ' + d.d;
	} catch (e) {
		if (e instanceof T.KazooCrash) { return e.kind === 'hang' ? 'hang' : 'crash'; }
		throw e;
	}
}

fs.writeFileSync(path.join(oracleDir, 'cases.tsv'), cases.map(line).join('\n') + '\n');
console.log('cases:', cases.length, '(random ' + RANDOM_CASES + ', sweeps ' + (cases.length - RANDOM_CASES) + ')');

var t0 = Date.now();
var docker = cp.spawnSync('docker', ['run', '--rm', '-v', oracleDir + ':/w', '-w', '/w', 'erlang:26-alpine', 'sh', '-c',
	'erlc +nowarn_unused_function +nowarn_unused_vars *.erl >/dev/null 2>&1 && erl -noshell -eval "crv_driver:main(), init:stop()."'],
	{ encoding: 'utf8', env: Object.assign({}, process.env, { MSYS_NO_PATHCONV: '1' }) });
if (docker.status !== 0) {
	console.error('docker failed:', docker.stderr || docker.stdout);
	process.exit(2);
}
console.log('erlang ran in', ((Date.now() - t0) / 1000).toFixed(1) + 's');

var erl = fs.readFileSync(path.join(oracleDir, 'results.tsv'), 'utf8').trim().split('\n');
if (erl.length !== cases.length) {
	console.error('result count mismatch', erl.length, cases.length);
	process.exit(2);
}

var stats = { agree: 0, agreeCrash: 0, agreeHang: 0, mismatch: 0 }, byCycle = {}, examples = [];
cases.forEach(function(c, idx) {
	var e = erl[idx].startsWith('crash') ? 'crash' : erl[idx].trim();
	var j = jsResult(c);
	var key = c.rule.cycle;
	byCycle[key] = byCycle[key] || { n: 0, bad: 0 };
	byCycle[key].n++;
	if (e === j) {
		if (e === 'crash') { stats.agreeCrash++; } else if (e === 'hang') { stats.agreeHang++; } else { stats.agree++; }
	} else {
		stats.mismatch++;
		byCycle[key].bad++;
		if (examples.length < 15) { examples.push({ case: line(c), erlang: erl[idx], js: j }); }
	}
});

console.log('\nagree (same date):  ', stats.agree);
console.log('agree (both crash): ', stats.agreeCrash);
console.log('agree (both hang):  ', stats.agreeHang);
console.log('MISMATCH:           ', stats.mismatch);
console.log('\nby cycle:');
Object.keys(byCycle).sort().forEach(function(k) {
	console.log('  ' + (k + '        ').slice(0, 8) + ' ' + byCycle[k].n + ' cases, ' + byCycle[k].bad + ' mismatches');
});
if (examples.length) {
	console.log('\nfirst mismatches:');
	examples.forEach(function(x) { console.log('  ' + x.case.replace(/\t/g, ' | ') + '\n    erlang: ' + x.erlang + '\n    js:     ' + x.js); });
}
process.exit(stats.mismatch ? 1 : 0);
