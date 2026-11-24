'use strict';
/**
 * Tests for app/lib/graph.js against the FICTIONAL synthetic account
 * (regenerate with: node tools/make-synthetic-fixture.js).
 * Branch semantics under test are the Kazoo 4.3 behaviours documented in graph.js.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var G = require('../app/lib/graph');
var SNAP = require('./fixtures/synthetic-account.json');

var MAIN = 'num:+18455550100';
var MENU = 'cf:cf_main:r_open';
var FRI_10AM = { local: { y: 2026, m: 11, d: 20, hour: 10 } };   // Friday, open hours
var FRI_1230 = { local: { y: 2026, m: 11, d: 20, hour: 12, minute: 30 } }; // lunch
var SAT_10AM = { local: { y: 2026, m: 11, d: 21, hour: 10 } };   // weekend
var XMAS = { local: { y: 2026, m: 12, d: 25, hour: 10 } };       // a Friday, but a holiday
var JUL4 = { local: { y: 2026, m: 7, d: 4, hour: 10 } };         // a Saturday holiday

var graph = G.build(SNAP, { type: 'account', categories: ['did', 'extension', 'featurecode'] });

function sim(start, opts) { return G.simulate(graph, SNAP, Object.assign({ start: start }, opts)); }
function labels(r) { return r.steps.map(function(s) { return s.label; }); }
function nodeByLabel(label) {
	var id = Object.keys(graph.nodes).filter(function(k) { return graph.nodes[k].label === label; })[0];
	assert.ok(id, 'node labelled ' + label);
	return graph.nodes[id];
}
function edgesFrom(id) { return graph.edges.filter(function(e) { return e.from === id; }); }
function issueCodes(id) { return (graph.nodes[id].issues || []).map(function(i) { return i.code; }); }

/* ---------------- Building ---------------- */

test('every synthetic callflow builds on its own', function() {
	Object.keys(SNAP.callflows).forEach(function(id) {
		var g = G.build(SNAP, { type: 'callflow', id: id });
		assert.equal(g.roots.length, 1, id);
	});
});

test('listEntries classifies numbers and finds unassigned ones', function() {
	var byCat = {};
	G.listEntries(SNAP).forEach(function(e) {
		var k = e.category + (e.callflowId ? '' : '-unassigned');
		(byCat[k] = byCat[k] || []).push(e.number);
	});
	assert.deepEqual(byCat['did-unassigned'].sort(), ['+18455550155', '+18455550166']);
	assert.deepEqual(byCat.extension.sort(), ['0', '103', '8001', '8002']);
	assert.deepEqual(byCat.featurecode.sort(), ['*3', '*55']);
	assert.equal(byCat.did.length, 9);
});

test('nodes get human labels, types, icons and playable media', function() {
	assert.equal(graph.nodes[MAIN].label, '(845) 555-0100');
	assert.equal(graph.nodes[MENU].label, 'Main Menu');
	assert.equal(graph.nodes[MENU].type, 'AUTO-ATTENDANT');
	assert.equal(graph.nodes[MENU].icon, 'menu1');
	assert.deepEqual(graph.nodes[MENU].media.map(function(m) { return [m.role, m.mediaId]; }), [['greeting', 'm_greet']]);
	assert.match(graph.nodes[MENU].sublabel, /Dial by extension/);

	var alice = nodeByLabel('Alice Adams (101)');
	assert.equal(alice.type, 'EXTENSION');
	var queue = nodeByLabel('Front Desk Queue');
	assert.equal(queue.sublabel, 'round-robin');
	assert.deepEqual(queue.media.map(function(m) { return m.role; }), ['hold']);
	assert.deepEqual(nodeByLabel('General Mailbox (200)').media.map(function(m) { return m.label; }), ['Mailbox greeting']);
	assert.equal(nodeByLabel('Alice Adams (101)').module, 'user');
	var aliceVm = Object.keys(graph.nodes).map(function(k) { return graph.nodes[k]; })
		.filter(function(n) { return n.module === 'voicemail' && n.data.id === 'vm_alice'; })[0];
	assert.equal(aliceVm.sublabel, 'Default greeting'); // no custom greeting -> say so, and play Kazoo's own prompts
	assert.deepEqual(aliceVm.media.map(function(m) { return m.prompts; }), [['vm-person', 'vm-not_available']]);
});

test('edge labels: rule names, rule sets, menu keys and module-specific "_"', function() {
	var tod = edgesFrom('cf:cf_main:').map(function(e) { return e.label; }).sort();
	assert.deepEqual(tod, ['Lunch', 'No rule matches', 'Open Hours', 'Set: Holidays']);
	var menu = edgesFrom(MENU).map(function(e) { return e.label; }).sort();
	assert.deepEqual(menu, ['After max retries', 'No input', 'Press 0', 'Press 1', 'Press 2', 'Press 3', 'Press 9']);
	var aliceNoAnswer = edgesFrom('cf:cf_main:r_open/1')[0];
	assert.equal(aliceNoAnswer.label, 'No answer / fails');
	assert.equal(aliceNoAnswer.kind, 'failure');
});

test('callflow jumps are linked to the target root; the step after a jump is a live "return"', function() {
	var lunchJump = edgesFrom('cf:cf_main:r_lunch');
	var j = lunchJump.filter(function(e) { return e.kind === 'jump'; })[0];
	var r = lunchJump.filter(function(e) { return e.key === '_'; })[0];
	assert.equal(j.to, 'cf:cf_lunch:');
	assert.equal(r.kind, 'return');
	assert.equal(r.label, 'When it finishes');
});

test('issues: deleted references, loops, dead branches, rules that crash Kazoo', function() {
	assert.ok(issueCodes('cf:cf_missing:').indexOf('missing-ref') !== -1);
	assert.equal(edgesFrom('cf:cf_missing:_').filter(function(e) { return e.key === '_'; })[0].label, 'Target missing — continues');
	var loopEdge = graph.edges.filter(function(e) { return e.kind === 'loop'; })[0];
	assert.ok(loopEdge, 'the A->B->A jump is marked as a loop');
	assert.equal(edgesFrom('cf:cf_dead:')[0].kind, 'dead');                        // `_` after `response`
	var retries = edgesFrom('cf:cf_menu_retries:').filter(function(e) { return e.key === '_'; })[0];
	assert.equal(retries.kind, 'dead');                                               // shadowed by max_retries
	// The broken weekday is reported once (static check), not again by the dry run.
	var tod = issueCodes('cf:cf_broken_tod:');
	assert.ok(tod.indexOf('rule-unknown-weekday') !== -1);
	assert.equal(tod.indexOf('rule-kazoo-crash'), -1);
});

test('a loop back through a menu ("press 9 to repeat") is not a problem; one with no caller choice is', function() {
	var repeat = edgesFrom('cf:cf_main:r_open/9').filter(function(e) { return e.kind === 'loop'; })[0];
	assert.ok(repeat, 'press 9 jumps back to the main line');
	assert.equal(repeat.callerDriven, true);
	assert.equal(repeat.label, 'Back to start');
	assert.equal(issueCodes('cf:cf_main:r_open/9').indexOf('loop'), -1);
	var endless = graph.edges.filter(function(e) { return e.kind === 'loop' && !e.callerDriven; })[0];
	assert.ok(endless, 'Loop A -> Loop B -> Loop A has no caller input');
	assert.ok(issueCodes(endless.from).indexOf('loop') !== -1);
});

test('sim: pressing 9 goes back to the menu and waits for a new choice', function() {
	var digits = {}; digits[MENU] = '9';
	var r = sim(MAIN, { at: FRI_10AM, digits: digits });
	assert.equal(r.end.reason, 'awaiting-input');
	assert.equal(r.end.nodeId, MENU);
	assert.match(r.end.detail, /^Back at the menu/);
});

test('every step carries a DT-Callflows glyph and a role; routing-only steps are "logic"', function() {
	Object.keys(graph.nodes).forEach(function(id) { assert.ok(graph.nodes[id].glyph, 'glyph for ' + id); });
	assert.equal(graph.nodes['cf:cf_main:'].glyph, 'schedule');
	assert.equal(graph.nodes['cf:cf_main:'].role, 'logic');
	assert.equal(graph.nodes[MENU].glyph, 'dialpad');
	assert.equal(graph.nodes[MENU].role, 'call');
	assert.equal(graph.nodes['cf:cf_main:r_lunch'].glyph, 'alt_route');
	assert.equal(graph.nodes['cf:cf_main:r_lunch'].role, 'logic');
	var control = G.build(SNAP, { type: 'callflow', id: 'cf_control' }).nodes['cf:cf_control:'];
	assert.equal(control.glyph, 'history_toggle_off');
	assert.equal(control.role, 'call', 'a feature code\'s action is its whole point, so it is not a slim pill');
});

test('temporal_route used as a control action is a FEATURE step, not a time branch', function() {
	var g = G.build(SNAP, { type: 'callflow', id: 'cf_control' });
	var n = g.nodes['cf:cf_control:'];
	assert.equal(n.label, 'Force time rules OFF');
	assert.equal(n.type, 'FEATURE');
	assert.equal(g.edges[0].label, 'Then');
});

test('identical leaves are merged, so the shared mailbox is one node', function() {
	var mains = Object.keys(graph.nodes).filter(function(k) {
		var n = graph.nodes[k]; return n.module === 'voicemail' && n.data.id === 'vm_main';
	});
	assert.equal(mains.length, 1);
	assert.ok(graph.nodes[mains[0]].mergedFrom.length >= 5);
});

test('focus: upstream of the shared mailbox reaches the main number; downstream of main reaches the queue', function() {
	var mailbox = Object.keys(graph.nodes).filter(function(k) { var n = graph.nodes[k]; return n.module === 'voicemail' && n.data.id === 'vm_main'; })[0];
	assert.ok(G.upstream(graph, mailbox).nodes.indexOf(MAIN) !== -1);
	assert.ok(G.downstream(graph, MAIN).nodes.indexOf('cf:cf_main:r_open/2') !== -1);
	assert.equal(G.upstream(graph, MAIN).nodes.length, 1); // nothing routes INTO a DID
});

/* ---------------- Simulation ---------------- */

test('sim: Friday 10am — open hours, waits at the main menu', function() {
	var r = sim(MAIN, { at: FRI_10AM });
	assert.equal(r.end.reason, 'awaiting-input');
	assert.equal(r.end.nodeId, MENU);
	assert.deepEqual(labels(r), ['(845) 555-0100', 'Time of day', 'Main Menu']);
	assert.equal(r.steps[1].detail, 'Matched "Open Hours"');
});

test('sim: press 1 — Alice answers; no answer — Alice\'s voicemail', function() {
	var digits = {}; digits[MENU] = '1';
	assert.equal(sim(MAIN, { at: FRI_10AM, digits: digits }).end.detail, 'Answered by Alice Adams (101).');
	var r = sim(MAIN, { at: FRI_10AM, digits: digits, outcome: 'no-answer' });
	assert.equal(r.end.reason, 'terminal');
	assert.equal(r.steps[r.steps.length - 1].label, 'Alice Adams (101)');
	assert.equal(graph.nodes[r.end.nodeId].module, 'voicemail');
});

test('sim: press 2 — queue answers; queue no-answer falls to the general mailbox', function() {
	var digits = {}; digits[MENU] = '2';
	assert.equal(sim(MAIN, { at: FRI_10AM, digits: digits }).end.detail, 'Answered by Front Desk Queue.');
	var r = sim(MAIN, { at: FRI_10AM, digits: digits, outcome: 'no-answer' });
	assert.equal(graph.nodes[r.end.nodeId].label, 'General Mailbox (200)');
});

test('sim: no input — jumps to the operator callflow; invalid key — after retries, `_`', function() {
	var digits = {}; digits[MENU] = 'timeout';
	var r = sim(MAIN, { at: FRI_10AM, digits: digits });
	assert.equal(r.end.detail, 'Answered by Bob Brown (102).');
	digits[MENU] = '7'; // not an option
	r = sim(MAIN, { at: FRI_10AM, digits: digits });
	assert.match(r.steps[2].detail, /invalid/);
	assert.equal(graph.nodes[r.end.nodeId].label, 'General Mailbox (200)');
});

test('sim: lunch — the jump plays a message, RETURNS, then goes to voicemail', function() {
	var r = sim(MAIN, { at: FRI_1230 });
	assert.deepEqual(labels(r), ['(845) 555-0100', 'Time of day', 'Go to: Lunch message', 'We are closed', 'General Mailbox (200)']);
	assert.equal(r.steps[1].detail, 'Matched "Lunch"');            // lunch is listed before open hours
	assert.equal(r.steps[3].returned, true);                        // Kazoo's flow stack
	assert.equal(r.end.reason, 'terminal');
});

test('sim: holidays via the rule set beat everything; weekends fall through to after-hours', function() {
	[XMAS, JUL4].forEach(function(at) {
		var r = sim(MAIN, { at: at });
		assert.equal(r.steps[1].detail, 'Matched "Christmas"'.replace('Christmas', SNAP.temporal_rules[at === XMAS ? 'r_xmas' : 'r_jul4'].name));
		assert.equal(r.steps[2].label, 'We are closed');
	});
	var r = sim(MAIN, { at: SAT_10AM });
	assert.equal(r.steps[1].detail, 'No rule matches');
	assert.equal(r.end.nodeId, 'cf:cf_main:_');
});

test('sim: forcing a rule off (feature code) changes the route', function() {
	var r = sim(MAIN, { at: FRI_10AM, force: { r_open: false } });
	assert.equal(r.end.nodeId, 'cf:cf_main:_'); // after-hours menu
});

test('sim: a jump loop ends where Kazoo ends it — after 50 jumps', function() {
	var r = sim('num:+18455550111', {});
	assert.equal(r.end.reason, 'kazoo-limit');
	assert.match(r.end.detail, /50 callflow jumps/);
	assert.equal(sim('num:+18455550111', { maxBranchCount: 3 }).steps.length, 1 + 3 + 1);
});

test('sim: deleted user can\'t ring; missing jump target continues; ends at the mailbox', function() {
	var r = sim('num:+18455550122', {});
	assert.equal(r.steps[1].missing, true);
	assert.equal(r.steps[2].detail, 'Target callflow is missing');
	assert.equal(graph.nodes[r.end.nodeId].label, 'General Mailbox (200)');
});

test('sim: a rule Kazoo crashes on fails the call, even when an earlier rule matches', function() {
	var r = sim('num:+18455550133', { at: FRI_10AM });
	assert.equal(r.end.reason, 'kazoo-error');
	assert.match(r.end.detail, /fryday/);
});

test('live registration: shown on the card, and "live" outcome skips users who are offline', function() {
	var snap = JSON.parse(JSON.stringify(SNAP));
	snap.devices.d_alice = { name: 'Alice desk phone', device_type: 'sip_device', owner_id: 'u_alice' };
	snap.devices.d_bob = { name: 'Bob desk phone', device_type: 'sip_device', owner_id: 'u_bob' };
	snap.device_status = {
		d_alice: { registered: false, registrable: true },
		d_bob: { registered: true, registrable: true }
	};
	var g = G.build(snap, { type: 'did', number: '+18455550100' });
	var aliceId = 'cf:cf_main:r_open/1';
	assert.equal(g.nodes[aliceId].sublabel, '0/1 devices online');
	var digits = {}; digits[MENU] = '1';
	var r = G.simulate(g, snap, { start: MAIN, at: FRI_10AM, digits: digits, outcome: 'live' });
	assert.equal(r.steps[3].detail, 'No device registered right now');
	assert.equal(g.nodes[r.end.nodeId].module, 'voicemail'); // Alice's voicemail
	digits[MENU] = 'timeout';                                 // operator = Bob, who IS online
	assert.equal(G.simulate(g, snap, { start: MAIN, at: FRI_10AM, digits: digits, outcome: 'live' }).end.detail, 'Answered by Bob Brown (102).');
});

test('sim: unassigned number', function() {
	var g = G.build(SNAP, { type: 'did', number: '+18455550155' });
	assert.equal(G.simulate(g, SNAP, { start: 'num:+18455550155' }).end.reason, 'unassigned');
});
