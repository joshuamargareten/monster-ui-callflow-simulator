'use strict';
/**
 * skip_module, manual switches in the simulator, and pivot test replies — on the synthetic
 * "Support line" (+18455550190):
 *   temporal_route [Night mode (manual, OFF), Winter hours (Dec 1 – Dec 31 2026)]
 *     Night mode  -> play "closed"
 *     Winter hrs  -> pivot (GET, kazoo) -> on failure: Alice
 *     no match    -> Bob (skip_module: true) -> voicemail
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var G = require('../app/lib/graph');
var D = require('../app/lib/details');
var SNAP = require('./fixtures/synthetic-account.json');

var ENTRY = 'num:+18455550190', TOD = 'cf:cf_support:', PIVOT = 'cf:cf_support:r_winter', BOB = 'cf:cf_support:_';
function at(y, m, d, h, mi) { return { local: { y: y, m: m, d: d, hour: h, minute: mi || 0 } }; }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function sim(graph, snap, when, extra) {
	return G.simulate(graph, snap, Object.assign({ start: ENTRY, at: when, outcome: 'answered' }, extra || {}));
}
function labels(r) { return r.steps.map(function(s) { return s.nodeId; }); }

var graph = G.build(SNAP, { type: 'did', number: '+18455550190' });

test('a skipped step is drawn as skipped and the call goes straight past it', function() {
	var bob = graph.nodes[BOB];
	assert.equal(bob.skipped, true);
	assert.match(bob.sublabel, /^Skipped/);
	assert.ok(bob.issues.some(function(i) { return i.code === 'skipped'; }));
	// A Saturday in November: no rule matches -> Bob is skipped -> voicemail.
	var r = sim(graph, SNAP, at(2026, 11, 28, 12));
	var bobStep = r.steps.filter(function(s) { return s.nodeId === BOB; })[0];
	assert.equal(bobStep.skipped, true);
	assert.equal(r.end.reason, 'terminal');
	assert.equal(graph.nodes[r.end.nodeId].module, 'voicemail');
});

test('skip makes a terminal step\'s "_" reachable and other branches inactive', function() {
	var snap = clone(SNAP);
	snap.callflows.cf_skipmenu = { name: 'Skipped menu', numbers: ['8999'], flow: { module: 'menu', data: { id: 'menu_main', skip_module: 'true' }, children: {
		'1': { module: 'user', data: { id: 'u_alice' }, children: {} },
		'_': { module: 'user', data: { id: 'u_bob' }, children: {} } } } };
	var g = G.build(snap, { type: 'callflow', id: 'cf_skipmenu' }), root = 'cf:cf_skipmenu:';
	var out = g.edges.filter(function(e) { return e.from === root; });
	assert.ok(out.filter(function(e) { return e.key === '1'; })[0].inactive);
	var under = out.filter(function(e) { return e.key === '_'; })[0];
	assert.notEqual(under.kind, 'dead');
	assert.ok(!under.inactive);
	var r = G.simulate(g, snap, { start: root, at: at(2026, 11, 24, 10), outcome: 'answered' });
	assert.equal(r.end.reason, 'answered');
	assert.equal(r.end.nodeId, 'cf:cf_skipmenu:_');
});

test('manual switch: OFF as saved, flipped ON in the simulator', function() {
	var off = sim(graph, SNAP, at(2026, 11, 28, 12));
	assert.ok(labels(off).indexOf('cf:cf_support:r_night') === -1);
	var on = sim(graph, SNAP, at(2026, 11, 28, 12), { force: { r_night: true } });
	assert.equal(on.steps[1].detail, 'Matched "Night mode"');
	assert.equal(on.end.nodeId, 'cf:cf_support:r_night');
});

test('end date: Winter hours applies in December 2026, not in January 2027', function() {
	var dec = sim(graph, SNAP, at(2026, 12, 15, 10));
	assert.equal(dec.end.nodeId, PIVOT);
	assert.equal(dec.end.reason, 'terminal');
	var jan = sim(graph, SNAP, at(2027, 1, 5, 10));
	var tod = jan.steps.filter(function(s) { return s.nodeId === TOD; })[0];
	assert.equal(tod.temporal.trace.filter(function(t) { return t.ruleId === 'r_winter'; })[0].outcome, 'ended');
});

test('end date setting: inclusive keeps the end day', function() {
	var snap = clone(SNAP); snap.settings = { endDate: 'inclusive' };
	var g = G.build(snap, { type: 'did', number: '+18455550190' });
	// Jan 1 2027 is a Friday: excluded by default, included in inclusive mode.
	assert.equal(sim(graph, SNAP, at(2027, 1, 1, 10)).end.nodeId !== PIVOT, true);
	assert.equal(sim(g, snap, at(2027, 1, 1, 10)).end.nodeId, PIVOT);
});

test('a pivot test reply is drawn after the pivot and the simulation follows it', function() {
	var snap = clone(SNAP);
	snap.callflows['crv-pivot-reply-x'] = { id: 'crv-pivot-reply-x', name: 'Test pivot', numbers: [], _virtual: true,
		flow: { module: 'play', data: { id: 'm_greet' }, children: { _: { module: 'user', data: { id: 'u_carol' }, children: {} } } } };
	var replies = {}; replies[PIVOT] = 'crv-pivot-reply-x';
	var g = G.build(snap, { type: 'did', number: '+18455550190' }, { pivotReplies: replies });
	var e = g.edges.filter(function(x) { return x.from === PIVOT && x.kind === 'pivot'; })[0];
	assert.ok(e, 'reply edge');
	assert.equal(g.nodes[e.to].pivotReply, true);
	var r = sim(g, snap, at(2026, 12, 15, 10));
	assert.ok(labels(r).indexOf(e.to) !== -1);
	assert.equal(r.end.reason, 'answered');
	assert.ok(labels(r).indexOf('cf:crv-pivot-reply-x:_') !== -1); // Carol — who forwards to her cell
	// The virtual callflow never shows up as a number.
	assert.ok(G.listEntries(snap).every(function(x) { return x.callflowId !== 'crv-pivot-reply-x'; }));
});

test('details: pivot settings, skipped step, rule dates and the switch code', function() {
	var p = D.forNode(graph.nodes[PIVOT], SNAP, graph).sections.filter(function(s) { return /^Pivot/.test(s.title); })[0];
	var val = function(label) { return p.rows.filter(function(r) { return r.label === label; })[0].value; };
	assert.equal(val('Method'), 'GET');
	assert.equal(val('Reply format'), 'Kazoo JSON (callflow)');
	assert.equal(val('Timeout'), '5 sec');
	assert.match(val('If the server fails'), /Alice/);

	var b = D.forNode(graph.nodes[BOB], SNAP, graph).sections[0];
	assert.equal(b.title, 'Skipped');
	assert.match(b.rows[1].value, /Mailbox/);

	var rules = D.forNode(graph.nodes[TOD], SNAP, graph).sections.filter(function(s) { return /^Rules/.test(s.title); })[0].items;
	assert.equal(rules[0].sub, 'Manual switch · OFF');
	assert.ok(rules[0].lines.indexOf('Switch it: dial *57*7') !== -1);
	assert.match(rules[1].sub, /until Dec 31, 2026$/);
});
