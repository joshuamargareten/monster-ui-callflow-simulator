'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var D = require('../app/lib/details');
var G = require('../app/lib/graph');
var SNAP = require('./fixtures/synthetic-account.json');
var REAL_RULES = require('./fixtures/real-world-temporal-rules.json');

function rule(name) { var id = Object.keys(REAL_RULES).filter(function(k) { return REAL_RULES[k].name === name; })[0]; return REAL_RULES[id]; }
function rows(details, title) {
	var s = details.sections.filter(function(x) { return x.title === title || x.title.indexOf(title) === 0; })[0];
	assert.ok(s, 'section ' + title + ' in ' + JSON.stringify(details.sections.map(function(x) { return x.title; })));
	return s.rows;
}
function items(details, title) { var s = details.sections.filter(function(x) { return x.title.indexOf(title) === 0; })[0]; assert.ok(s && s.items, 'list ' + title); return s.items; }
function titles(list) { return list.map(function(x) { return x.title; }); }
function value(rs, label) { var r = rs.filter(function(x) { return x.label === label; })[0]; return r && r.value; }

test('rule summaries read like plain language', function() {
	assert.equal(D.ruleSummary(SNAP.temporal_rules.r_open), 'Mon–Fri · 9:00 AM – 5:00 PM');
	assert.equal(D.ruleSummary(SNAP.temporal_rules.r_xmas), 'Every December 25 · all day');
	assert.equal(D.ruleSummary(rule('Night test')), 'Every day · 1:15 PM – 11:55 PM');      // all 7 incl. "wensday"
	assert.equal(D.ruleSummary(rule('Holiday 2026')), 'Sep 11, 2026 · all day');
	assert.match(D.ruleSummary(rule('Forced-on test')), /^Forced ON .*First Sun of January/);
	assert.match(D.ruleSummary(rule('Forced-off test')), /^Forced OFF/);
	assert.equal(D.ruleSummary({ cycle: 'weekly', wdays: ['monday', 'wednesday', 'friday'], time_window_start: 0, time_window_stop: 86400 }), 'Mon, Wed, Fri · all day');
	assert.equal(D.ruleSummary({ cycle: 'monthly', ordinal: 'last', wdays: ['friday'] }), 'Last Fri of every month · all day');
	assert.equal(D.daysText(['saturday', 'sunday']), 'Sat, Sun');
});

var graph = G.build(SNAP, { type: 'account', categories: ['did', 'extension', 'featurecode'] });
function node(id) { assert.ok(graph.nodes[id], id); return graph.nodes[id]; }

test('ring group lists every endpoint by name with timing', function() {
	var d = D.forNode(node('cf:cf_main:r_open/0'), SNAP, graph);
	assert.equal(value(rows(d, 'Ring group'), 'Strategy'), 'Ring all at once');
	var eps = items(d, 'Rings');
	assert.deepEqual(titles(eps), ['Alice Adams (101)', 'Bob Brown (102)']);
	assert.equal(eps[0].glyph, 'person');
	assert.equal(eps[0].cells.length, 2); // delay, rings for
});

test('menu shows greeting, settings and each option with its destination', function() {
	var d = D.forNode(node('cf:cf_main:r_open'), SNAP, graph), main = rows(d, 'Auto-attendant');
	assert.equal(value(main, 'Greeting'), 'Main greeting (uploaded file)');
	assert.equal(main.filter(function(r) { return r.label === 'Greeting'; })[0].media.mediaId, 'm_greet');
	assert.match(value(main, 'Dial by extension'), /^Yes/);
	var opts = items(d, 'Options'), by = function(label) { return opts.filter(function(o) { return o.label === label; })[0]; };
	assert.equal(by('Press 2').title, 'Front Desk Queue');
	assert.equal(by('Press 2').key, '2');
	assert.equal(by('No input').title, 'Go to: Operator');
	assert.ok(by('No input').keyWide);
	assert.ok(opts.indexOf(by('Press 2')) < opts.indexOf(by('No input')), 'digits first, keypad order');
});

test('queue shows routing, hold music and agents', function() {
	var d = D.forNode(node('cf:cf_main:r_open/2'), SNAP, graph);
	assert.equal(value(rows(d, 'Queue'), 'Routing'), 'Round robin');
	assert.equal(value(rows(d, 'Queue'), 'Hold music'), 'Hold music (uploaded file)');
	assert.deepEqual(titles(items(d, 'Agents')), ['Alice Adams (101)', 'Bob Brown (102)']);
});

test('time of day lists each rule (and rule set members) with its schedule', function() {
	var d = D.forNode(node('cf:cf_main:'), SNAP, graph), rs = items(d, 'Rules');
	assert.equal(rs[0].title, 'Set: Holidays');
	assert.match(rs[0].lines.join(' | '), /Christmas — Every December 25/);
	var open = rs.filter(function(r) { return r.title === 'Open Hours'; })[0];
	assert.equal(open.sub, 'Mon–Fri · 9:00 AM – 5:00 PM');
	assert.match(open.cells[0], /^→ /);
	assert.equal(rs[rs.length - 1].title, 'No rule matches');
	assert.equal(value(rows(d, 'Time of day'), 'Timezone'), 'America/New_York');
});

test('callflow jump says whether the call comes back', function() {
	assert.equal(value(rows(D.forNode(node('cf:cf_main:r_lunch'), SNAP, graph), 'Go to another callflow'), 'Afterwards'), 'Comes back and continues here when it finishes');
});

test('voicemail shows the box, greeting and never a PIN', function() {
	var snap = JSON.parse(JSON.stringify(SNAP));
	snap.vmboxes.vm_main.pin = '1234';
	var g = G.build(snap, { type: 'did', number: '+18455550100' });
	var id = Object.keys(g.nodes).filter(function(k) { return g.nodes[k].module === 'voicemail' && g.nodes[k].data.id === 'vm_main'; })[0];
	var d = D.forNode(g.nodes[id], snap, g);
	assert.equal(value(rows(d, 'Voicemail box'), 'Box number'), '200');
	assert.equal(rows(d, 'Voicemail box').filter(function(r) { return r.label === 'Greeting'; })[0].media.mediaId, 'm_vm');
	assert.ok(JSON.stringify(d).indexOf('1234') === -1);
});

test('numbers and unknown modules still get readable rows', function() {
	assert.equal(value(rows(D.forNode(node('num:+18455550100'), SNAP, graph), 'Number'), 'Routed to'), 'Main Line');
	var park = G.build(SNAP, { type: 'callflow', id: 'cf_park' });
	var d = D.forNode(park.nodes['cf:cf_park:'], SNAP, park);
	assert.equal(d.sections[0].rows[0].label, 'Action');
	assert.equal(d.sections[0].rows[0].value, 'park');
});

test('a box without its own greeting plays Kazoo’s default prompts', function() {
	var g = G.build(SNAP, { type: 'account', categories: ['did', 'extension'] });
	var id = Object.keys(g.nodes).filter(function(k) { return g.nodes[k].module === 'voicemail' && g.nodes[k].data.id === 'vm_alice'; })[0];
	var greet = rows(D.forNode(g.nodes[id], SNAP, g), 'Voicemail box').filter(function(r) { return r.label === 'Greeting'; })[0];
	assert.match(greet.value, /^System default/);
	assert.deepEqual(greet.media.prompts, ['vm-person', 'vm-not_available']);
	assert.deepEqual(g.nodes[id].media[0].prompts, ['vm-person', 'vm-not_available']);
});

test('inline text-to-speech gets a browser preview', function() {
	var snap = JSON.parse(JSON.stringify(SNAP));
	snap.callflows.cf_tts = { name: 'TTS test', numbers: ['555'], flow: { module: 'tts', data: { text: 'Hello there' }, children: {} } };
	var g = G.build(snap, { type: 'callflow', id: 'cf_tts' }), n = g.nodes['cf:cf_tts:'];
	assert.equal(n.media[0].speak, 'Hello there');
	assert.equal(rows(D.forNode(n, snap, g), 'Say')[0].media.role, 'tts');
});
