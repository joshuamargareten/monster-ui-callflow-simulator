'use strict';
/**
 * The lazy loader must be invisible: for every entry point, a graph built from a snapshot the
 * loader filled on demand must equal the graph built from the complete snapshot.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var G = require('../app/lib/graph');
var L = require('../app/lib/loader');
var FULL = require('./fixtures/synthetic-account.json');

/** Fake Kazoo: answers fetch(kind, id) from the full snapshot, counting calls. */
function server() {
	var calls = [];
	return {
		calls: calls,
		fetch: function(kind, id, cb) {
			calls.push(kind + ':' + id);
			var doc = FULL[kind] && FULL[kind][id];
			setTimeout(function() { cb(null, doc ? JSON.parse(JSON.stringify(doc)) : null); }, 1);
		}
	};
}

/** What the app has right after start-up: account, numbers, callflow summaries only. */
function startupSnapshot() {
	var list = {};
	Object.keys(FULL.callflows).forEach(function(id) {
		var cf = FULL.callflows[id];
		list[id] = { name: cf.name, numbers: cf.numbers, featurecode: cf.featurecode };
	});
	return { account: FULL.account, phone_numbers: FULL.phone_numbers, callflow_list: list };
}

/** Graph shape that matters to the user: nodes with labels/issues, edges with labels. */
function shape(graph) {
	return {
		nodes: Object.keys(graph.nodes).sort().map(function(id) {
			var n = graph.nodes[id];
			return [id, n.label, n.sublabel || null, (n.issues || []).map(function(i) { return i.code; }).sort().join(','),
				(n.media || []).map(function(m) { return m.mediaId; }).join(',')];
		}),
		edges: graph.edges.map(function(e) { return [e.from, e.to, e.kind, e.label]; }).sort()
	};
}

function ensure(loader, snap, entry) {
	return new Promise(function(resolve) { loader.ensure(entry, G.listEntries(snap), null, resolve); });
}

var ENTRIES = [{ type: 'account', categories: ['did'] }]
	.concat(Object.keys(FULL.callflows).map(function(id) { return { type: 'callflow', id: id }; }))
	.concat(G.listEntries(FULL).map(function(e) { return { type: 'did', number: e.number }; }));

test('for every entry point, lazily-loaded graph === fully-loaded graph', async function() {
	for (var i = 0; i < ENTRIES.length; i++) {
		var entry = ENTRIES[i], srv = server(), snap = startupSnapshot();
		var loader = L.create({ snapshot: snap, fetch: srv.fetch });
		await ensure(loader, snap, entry);
		assert.deepEqual(shape(G.build(snap, entry)), shape(G.build(FULL, entry)), JSON.stringify(entry));
	}
});

test('never fetches the same doc twice, and caches across entries', async function() {
	var srv = server(), snap = startupSnapshot(), loader = L.create({ snapshot: snap, fetch: srv.fetch });
	await ensure(loader, snap, { type: 'did', number: '+18455550100' });
	var first = srv.calls.length;
	assert.equal(new Set(srv.calls).size, srv.calls.length, 'no duplicate fetches');
	await ensure(loader, snap, { type: 'did', number: '+18455550100' });
	assert.equal(srv.calls.length, first, 'second open is free');
	await ensure(loader, snap, { type: 'callflow', id: 'cf_operator' });
	assert.equal(srv.calls.length, first, 'cf_operator was already pulled in by the main line');
});

test('opening one number fetches only what it needs, not the whole account', async function() {
	var srv = server(), snap = startupSnapshot(), loader = L.create({ snapshot: snap, fetch: srv.fetch });
	await ensure(loader, snap, { type: 'did', number: '+18455550199' }); // on-call: device -> offnet
	assert.deepEqual(srv.calls.sort(), ['callflows:cf_oncall', 'devices:d_lobby']);
});

test('rule sets: a temporal route id that is not a rule is fetched as a set, with its members', async function() {
	var srv = server(), snap = startupSnapshot(), loader = L.create({ snapshot: snap, fetch: srv.fetch });
	await ensure(loader, snap, { type: 'callflow', id: 'cf_main' });
	assert.ok(snap.temporal_rules_sets.s_holidays);
	assert.ok(snap.temporal_rules.r_xmas && snap.temporal_rules.r_jul4);
	assert.ok(srv.calls.indexOf('temporal_rules:s_holidays') !== -1, 'tried as a rule first');
});

test('with the rule-set list known up front, nothing is probed on the sets endpoint', async function() {
	var srv = server(), snap = startupSnapshot();
	snap.temporal_rules_set_ids = { s_holidays: true };
	var loader = L.create({ snapshot: snap, fetch: srv.fetch });
	await ensure(loader, snap, { type: 'callflow', id: 'cf_main' });
	assert.deepEqual(srv.calls.filter(function(c) { return c.indexOf('temporal_rules_sets:') === 0; }), ['temporal_rules_sets:s_holidays']);
	assert.equal(srv.calls.indexOf('temporal_rules:s_holidays'), -1, 'the set is not tried as a rule first');
	assert.deepEqual(shape(G.build(snap, { type: 'callflow', id: 'cf_main' })), shape(G.build(FULL, { type: 'callflow', id: 'cf_main' })));
});

test('deleted references are fetched once and stay missing', async function() {
	var srv = server(), snap = startupSnapshot(), loader = L.create({ snapshot: snap, fetch: srv.fetch });
	await ensure(loader, snap, { type: 'did', number: '+18455550122' });
	assert.ok(srv.calls.indexOf('users:u_ghost') !== -1 && srv.calls.indexOf('callflows:cf_deleted') !== -1);
	var g = G.build(snap, { type: 'did', number: '+18455550122' });
	assert.ok(g.nodes['cf:cf_missing:'].issues.some(function(i) { return i.code === 'missing-ref'; }));
	var before = srv.calls.length;
	await ensure(loader, snap, { type: 'did', number: '+18455550122' });
	assert.equal(srv.calls.length, before);
});
