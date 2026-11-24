'use strict';
/**
 * Call forwarding (users and devices) is drawn to where the forwarded call really goes, steps are
 * colour-coded by family, and the loader fetches what forwards lead to.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var G = require('../app/lib/graph');
var D = require('../app/lib/details');
var L = require('../app/lib/loader');
var SNAP = require('./fixtures/synthetic-account.json');

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function fwdEdges(g, from) { return g.edges.filter(function(e) { return e.from === from && e.kind === 'forward'; }); }

test('a user forwarding to an outside number points at that number', function() {
	var g = G.build(SNAP, { type: 'callflow', id: 'cf_ext_carol' }), carol = g.nodes['cf:cf_ext_carol:'];
	assert.equal(carol.forward.mode, 'substitute');
	assert.match(carol.sublabel, /Forwards to \(914\) 555-0177/);
	var e = fwdEdges(g, carol.id);
	assert.equal(e.length, 1);
	assert.equal(e[0].to, 'ext:9145550177');
	assert.equal(e[0].label, 'Forwards all calls');
	assert.equal(g.nodes['ext:9145550177'].family, 'outside');
	assert.equal(g.nodes['ext:9145550177'].label, '(914) 555-0177');
});

test('a forward to an extension routes through that extension\'s callflow', function() {
	var g = G.build(SNAP, { type: 'callflow', id: 'cf_operator' }), bob = g.nodes['cf:cf_operator:'];
	assert.equal(bob.forward.mode, 'failover');
	var e = fwdEdges(g, bob.id)[0];
	assert.equal(e.to, 'cf:cf_ext_carol:', 'Bob → Carol\'s extension callflow (Carol herself)');
	assert.equal(e.label, 'If phones offline');
	// ...and on from there: Carol forwards out.
	assert.equal(fwdEdges(g, 'cf:cf_ext_carol:')[0].to, 'ext:9145550177');
});

test('E.164 and 10-digit forms of the account\'s own numbers route internally', function() {
	assert.equal(G.resolveDialed(SNAP, '8455550100').callflowId, 'cf_main');
	assert.equal(G.resolveDialed(SNAP, '18455550100').callflowId, 'cf_main');
	assert.equal(G.resolveDialed(SNAP, '103').callflowId, 'cf_ext_carol');
	assert.equal(G.resolveDialed(SNAP, '9145550177'), null);
});

test('forwarding back into the same callflow is flagged as a loop', function() {
	var snap = clone(SNAP);
	snap.users.u_carol.call_forward.number = '103';
	var g = G.build(snap, { type: 'callflow', id: 'cf_ext_carol' });
	assert.ok(g.nodes['cf:cf_ext_carol:'].issues.some(function(i) { return i.code === 'forward-loop'; }));
});

test('sim: forwarded calls follow the forward; unanswered ones come back', function() {
	var g = G.build(SNAP, { type: 'callflow', id: 'cf_ext_carol' }), start = 'cf:cf_ext_carol:';
	var yes = G.simulate(g, SNAP, { start: start, outcome: 'answered' });
	assert.equal(yes.end.reason, 'answered');
	assert.match(yes.end.detail, /\(914\) 555-0177 \(outside number\)/);
	assert.match(yes.steps[0].detail, /^Forwarded to \(914\) 555-0177/);
	var no = G.simulate(g, SNAP, { start: start, outcome: 'no-answer' });
	assert.equal(no.end.reason, 'terminal', 'nobody answers the forward → Carol\'s voicemail');
	assert.equal(g.nodes[no.end.nodeId].module, 'voicemail');
});

test('sim: failover only forwards when no phone is registered', function() {
	var snap = clone(SNAP);
	snap.devices.d_bob = { name: 'Bob desk', device_type: 'sip_device', owner_id: 'u_bob' };
	snap.device_status = { d_bob: { registrable: true, registered: true } };
	var g = G.build(snap, { type: 'callflow', id: 'cf_operator' });
	assert.equal(G.simulate(g, snap, { start: 'cf:cf_operator:', outcome: 'live' }).end.nodeId, 'cf:cf_operator:');
	snap.device_status.d_bob.registered = false;
	g = G.build(snap, { type: 'callflow', id: 'cf_operator' });
	var r = G.simulate(g, snap, { start: 'cf:cf_operator:', outcome: 'live' });
	assert.match(r.steps[0].detail, /no phone registered/);
	assert.ok(r.nodes.indexOf('cf:cf_ext_carol:') !== -1);
});

test('a cell phone device rings its number', function() {
	var g = G.build(SNAP, { type: 'callflow', id: 'cf_cell' }), dev = g.nodes['cf:cf_cell:'];
	assert.ok(dev.forward.viaDevice);
	assert.equal(fwdEdges(g, dev.id)[0].label, 'Rings');
	assert.match(G.simulate(g, SNAP, { start: dev.id }).end.detail, /\(914\) 555-0188/);
});

test('details explain the forward and link to where it goes', function() {
	var g = G.build(SNAP, { type: 'callflow', id: 'cf_operator' }), d = D.forNode(g.nodes['cf:cf_operator:'], SNAP, g);
	var sec = d.sections.filter(function(x) { return x.title === 'Call forwarding'; })[0];
	assert.ok(sec);
	var when = sec.rows.filter(function(r) { return r.label === 'When'; })[0].value;
	assert.match(when, /failover/);
	assert.match(sec.rows.filter(function(r) { return r.label === 'Where it goes'; })[0].value, /Carol direct/);
	var to = d.sections.filter(function(x) { return x.title === 'Forwarded calls go to'; })[0];
	assert.equal(to.items[0].nodeId, 'cf:cf_ext_carol:');
});

test('every step has a family for colour coding', function() {
	var g = G.build(SNAP, { type: 'account', categories: ['did', 'extension', 'featurecode'] }), fam = {};
	Object.keys(g.nodes).forEach(function(id) { var n = g.nodes[id]; if (!(n.data && n.data.action && n.module === 'temporal_route')) { fam[n.kind === 'entry' ? 'entry' : n.module] = n.family; } });
	assert.equal(g.nodes['cf:cf_control:'].family, 'feature', 'a time-rules switch is a feature, not routing');
	assert.equal(fam.entry, 'entry');
	assert.equal(fam.user, 'bridge');
	assert.equal(fam.ring_group, 'bridge');
	assert.equal(fam.qubicle, 'bridge');
	assert.equal(fam.menu, 'input');
	assert.equal(fam.play, 'media');
	assert.equal(fam.voicemail, 'mailbox');
	assert.equal(fam.temporal_route, 'logic');
	assert.equal(fam.external, 'outside');
	assert.equal(fam.park, 'bridge');
	assert.equal(fam.response, 'end');
	Object.keys(g.nodes).forEach(function(id) { assert.ok(g.nodes[id].family, id + ' has a family'); });
});

test('loader: a forward pulls in its target callflow; device summaries are refetched', function(t, done) {
	var list = {};
	Object.keys(SNAP.callflows).forEach(function(id) { list[id] = { name: SNAP.callflows[id].name, numbers: SNAP.callflows[id].numbers }; });
	var snap = { account: SNAP.account, phone_numbers: SNAP.phone_numbers, callflow_list: list,
		devices: { d_cell: { name: 'Alice cell', device_type: 'cellphone', owner_id: 'u_alice', _summary: true } } };
	var calls = [], loader = L.create({ snapshot: snap, fetch: function(kind, id, cb) {
		calls.push(kind + ':' + id);
		setTimeout(function() { cb(null, SNAP[kind] && SNAP[kind][id] ? clone(SNAP[kind][id]) : null); }, 1);
	} });
	loader.ensure({ type: 'callflow', id: 'cf_operator' }, G.listEntries(snap), null, function() {
		assert.ok(calls.indexOf('callflows:cf_ext_carol') !== -1, 'Bob forwards to 103 → its callflow is fetched');
		var full = G.build(SNAP, { type: 'callflow', id: 'cf_operator' }), lazy = G.build(snap, { type: 'callflow', id: 'cf_operator' });
		assert.deepEqual(Object.keys(lazy.nodes).sort(), Object.keys(full.nodes).sort());
		loader.ensure({ type: 'callflow', id: 'cf_cell' }, G.listEntries(snap), null, function() {
			assert.ok(calls.indexOf('devices:d_cell') !== -1, 'the list summary is replaced by the full device');
			assert.ok(snap.devices.d_cell.call_forward);
			assert.ok(G.build(snap, { type: 'callflow', id: 'cf_cell' }).nodes['ext:+19145550188']);
			done();
		});
	});
});
