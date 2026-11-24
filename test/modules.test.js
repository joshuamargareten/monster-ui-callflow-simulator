'use strict';
/**
 * Every Kazoo callflow module gets a proper step, and the simulator follows Kazoo's semantics for
 * the ones that branch at call time, end the call, or fail with a named cause.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var G = require('../app/lib/graph');
var D = require('../app/lib/details');
var M = require('../app/lib/modules');
var SNAP = require('./fixtures/synthetic-account.json');

function step(module, data, children) { return { module: module, data: data || {}, children: children || {} }; }
function snapWith(flow) {
	var s = JSON.parse(JSON.stringify(SNAP));
	s.callflows.cf_t = { name: 'T', numbers: ['8990'], flow: flow };
	return s;
}
function at() { return { local: { y: 2026, m: 11, d: 24, hour: 10, minute: 0 } }; }
function run(flow, extra) {
	var s = snapWith(flow), g = G.build(s, { type: 'callflow', id: 'cf_t' });
	return { g: g, s: s, r: G.simulate(g, s, Object.assign({ start: 'cf:cf_t:', at: at(), outcome: 'answered' }, extra || {})) };
}

// The 78 modules in Kazoo's code (4.3 + master), plus Teklink's Qubicle ones.
var ALL = ['user', 'device', 'ring_group', 'group', 'page_group', 'route_to_cid', 'resources', 'offnet', 'callflow', 'transfer',
	'after_bridge', 'branch_bnumber', 'move', 'temporal_route', 'menu', 'check_cid', 'cidlistmatch', 'branch_variable', 'fax_detect',
	'acdc_wait_time', 'nomorobo', 'set_cid', 'dynamic_cid', 'prepend_cid', 'lookupcidname', 'privacy', 'play', 'tts', 'audio_macro',
	'language', 'sleep', 'response', 'hangup', 'answer', 'send_dtmf', 'collect_dtmf', 'flush_dtmf', 'set_alert_info', 'voicemail',
	'receive_fax', 'faxbox', 'conference', 'conference_feature', 'directory', 'call_forward', 'call_waiting', 'do_not_disturb',
	'hotdesk', 'park', 'intercept', 'intercept_feature', 'group_pickup', 'group_pickup_feature', 'eavesdrop', 'eavesdrop_feature',
	'intercom', 'camping_feature', 'ring_group_toggle', 'manual_presence', 'disa', 'pivot', 'webhook', 'notification',
	'missed_call_alert', 'record_call', 'record_caller', 'set_variable', 'set_variables', 'function', 'acdc_member', 'acdc_agent',
	'acdc_queue', 'dead_air', 'wait_for_hangup', 'noop', 'edr', 'set', 'skel', 'qubicle', 'qubicle_recipient'];

test('the catalogue knows all 78 Kazoo modules', function() {
	ALL.forEach(function(m) { assert.ok(M.known(m), m); });
	assert.equal(ALL.length, 80);
});

test('every module renders a labelled, coloured step with readable details', function() {
	ALL.forEach(function(m) {
		var r = run(step(m, { action: 'start', variable: 'x', regex: '.*' }, { _: step('hangup') })), n = r.g.nodes['cf:cf_t:'];
		assert.ok(n.label && n.label !== 'undefined', m + ' label');
		assert.ok(n.family, m + ' family');
		assert.ok(n.type, m + ' type');
		var d = D.forNode(n, r.s, r.g);
		if (M.info(m).rows || M.info(m).end) { assert.ok(d.sections.length, m + ' details'); } // hand-built details list only what is set
		assert.ok(!n.issues.some(function(i) { return i.code === 'unknown-module'; }), m + ' known');
	});
});

test('labels read like the Callflows app would say them', function() {
	var label = function(m, data) { return run(step(m, data)).g.nodes['cf:cf_t:'].label; };
	assert.equal(label('sleep', { duration: 5, unit: 's' }), 'Wait 5 s');
	assert.equal(label('response', { code: 404, message: 'Not here' }), 'Reply 404 Not here');
	assert.equal(label('set_cid', { caller_id_name: 'Sales', caller_id_number: '+18455550100' }), 'Set caller ID Sales +18455550100');
	assert.equal(label('set_variables', { custom_application_vars: { tier: 'gold' } }), 'Set tier');
	assert.equal(label('collect_dtmf', { collection_name: 'account' }), 'Collect digits as "account"');
	assert.equal(label('receive_fax', { owner_id: 'u_alice' }), 'Receive fax for Alice Adams (101)');
	assert.equal(label('intercept', { device_id: 'nope' }), 'Pick up nope');
});

test('an unknown module is shown with all its settings and a note', function() {
	var r = run(step('dimensions_call_tag', { tag: 'VIP' }, { _: step('hangup') }));
	var n = r.g.nodes['cf:cf_t:'];
	assert.ok(n.issues.some(function(i) { return i.code === 'unknown-module'; }));
	assert.equal(r.r.end.reason, 'terminal'); // continues with `_` to the hang-up
});

test('steps that hand the call over never use "_"', function() {
	['conference', 'faxbox', 'receive_fax', 'hangup', 'response', 'transfer', 'eavesdrop', 'group_pickup', 'move', 'dead_air'].forEach(function(m) {
		var g = run(step(m, {}, { _: step('play', { id: 'm_greet' }) })).g;
		var e = g.edges.filter(function(x) { return x.from === 'cf:cf_t:' && x.key === '_'; })[0];
		assert.equal(e.kind, 'dead', m);
	});
});

test('hang up ends the call even inside a jump', function() {
	var s = snapWith(step('callflow', { id: 'cf_h' }, { _: step('play', { id: 'm_greet' }) }));
	s.callflows.cf_h = { name: 'H', numbers: [], flow: step('hangup') };
	var g = G.build(s, { type: 'callflow', id: 'cf_t' }), r = G.simulate(g, s, { start: 'cf:cf_t:', at: at() });
	assert.equal(r.end.reason, 'terminal');
	assert.equal(r.end.detail, 'Kazoo hangs up.');
});

test('outbound calls: no "_" fallback, but a branch named after the failure cause', function() {
	var flow = step('resources', {}, { NO_ANSWER: step('play', { id: 'm_after' }), USER_BUSY: step('play', { id: 'm_closed' }), _: step('voicemail', { id: 'vm_main' }) });
	var r = run(flow, { outcome: 'no-answer' });
	var under = r.g.edges.filter(function(e) { return e.from === 'cf:cf_t:' && e.key === '_'; })[0];
	assert.equal(under.kind, 'dead');
	assert.equal(r.g.edges.filter(function(e) { return e.key === 'USER_BUSY'; })[0].label, 'If busy');
	assert.equal(r.r.end.nodeId, 'cf:cf_t:NO_ANSWER');
	var bare = run(step('resources', {}, { _: step('voicemail', { id: 'vm_main' }) }), { outcome: 'no-answer' });
	assert.equal(bare.r.end.reason, 'ends');
	assert.match(bare.r.end.detail, /named after the failure/);
	// A user's NO_ANSWER branch is taken before its "_".
	var u = run(step('user', { id: 'u_alice' }, { NO_ANSWER: step('play', { id: 'm_after' }), _: step('voicemail', { id: 'vm_main' }) }), { outcome: 'no-answer' });
	assert.equal(u.r.end.nodeId, 'cf:cf_t:NO_ANSWER');
});

test('call-time decisions wait for a choice, then follow it', function() {
	var flow = step('fax_detect', {}, { ON_FAX: step('receive_fax', {}), ON_VOICE: step('user', { id: 'u_bob' }) });
	var first = run(flow).r;
	assert.equal(first.end.reason, 'awaiting-choice');
	assert.deepEqual(first.end.choices.map(function(c) { return c.label; }).sort(), ['Fax', 'Voice']);
	var fax = run(flow, { digits: { 'cf:cf_t:': 'ON_FAX' } }).r;
	assert.equal(fax.end.detail, 'The fax is received.');
	// branch_variable: a value with no branch falls back to "_"
	var bv = step('branch_variable', { variable: 'tier' }, { gold: step('hangup'), _: step('play', { id: 'm_greet' }) });
	assert.equal(run(bv, { digits: { 'cf:cf_t:': 'gold' } }).r.end.detail, 'Kazoo hangs up.');
	assert.equal(run(bv).g.edges.filter(function(e) { return e.key === 'gold'; })[0].label, 'tier = gold');
});

test('check_cid follows the caller\'s number when it is given', function() {
	var orders = G.build(SNAP, { type: 'did', number: '+18455550191' });
	var sim = function(cid) { return G.simulate(orders, SNAP, { start: 'num:+18455550191', at: at(), callerId: cid }); };
	assert.equal(sim('+18455551234').end.nodeId, 'cf:cf_orders:match/_/_/_/_'); // stops at the pivot
	assert.equal(sim('+12125551234').end.reason, 'awaiting-choice');           // fax or voice?
	assert.equal(G.simulate(orders, SNAP, { start: 'num:+18455550191', at: at() }).end.reason, 'awaiting-choice');
	var abs = step('check_cid', { use_absolute_mode: true }, { '+15551112222': step('hangup'), _: step('play', { id: 'm_greet' }) });
	assert.equal(run(abs, { callerId: '+15551112222' }).r.end.detail, 'Kazoo hangs up.');
});

test('details list named branches and what the step needs', function() {
	var r = run(step('nomorobo', {}, { '0': step('user', { id: 'u_alice' }), '7': step('hangup') }));
	var d = D.forNode(r.g.nodes['cf:cf_t:'], r.s, r.g);
	var br = d.sections.filter(function(x) { return x.title === 'Branches'; })[0];
	assert.deepEqual(br.items.map(function(i) { return i.title; }), ['Score ≥ 0', 'Score ≥ 7']);
	assert.ok(d.sections[0].rows.some(function(x) { return x.label === 'Needs' && /NoMoRobo/.test(x.value); }));
});
