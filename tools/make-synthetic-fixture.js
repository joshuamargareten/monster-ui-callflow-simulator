'use strict';
/**
 * Writes test/fixtures/synthetic-account.json — a FICTIONAL account for graph/simulator tests.
 * Shapes mirror real-world callflows; every name and number is made up, so no
 * real customer or staff data ever lives in the repo.
 *
 *   node tools/make-synthetic-fixture.js
 */
var fs = require('fs');
var path = require('path');

var G = 62167219200;
function gsecUtc(y, m, d) { return Date.UTC(y, m - 1, d) / 1000 + G; }
// Local midnight in New York for a date in EDT (UTC-4) — how Monster stores one-off dates.
function gsecNyEdt(y, m, d) { return Date.UTC(y, m - 1, d, 4) / 1000 + G; }

var WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
function weekly(name, wdays, start, stop) {
	return { name: name, cycle: 'weekly', interval: 1, wdays: wdays, start_date: gsecUtc(2020, 1, 1), time_window_start: start, time_window_stop: stop };
}
function h(hours, minutes) { return hours * 3600 + (minutes || 0) * 60; }

// Flow helpers
function node(module, data, children) { var n = { module: module, data: data || {} }; if (children) { n.children = children; } return n; }
function user(id, then) { return node('user', { id: id, timeout: 20, can_call_self: false }, then ? { _: then } : null); }
function vm(id) { return node('voicemail', { id: id, action: 'compose' }); }
function jump(id, then) { return node('callflow', { id: id }, then ? { _: then } : null); }
function play(id, then) { return node('play', { id: id }, then ? { _: then } : null); }

var account = {
	account: { id: 'acct-synthetic', name: 'Maple Dental (synthetic)', timezone: 'America/New_York', realm: 'maple.example', language: 'en-us' },

	temporal_rules: {
		r_open:  weekly('Open Hours', WEEKDAYS, h(9), h(17)),
		r_lunch: weekly('Lunch', WEEKDAYS, h(12), h(13)),
		r_xmas:  { name: 'Christmas', cycle: 'yearly', interval: 1, month: 12, days: [25], start_date: gsecUtc(2020, 1, 1) },
		r_jul4:  { name: 'July 4th 2026', cycle: 'date', interval: 1, wdays: ['sunday'], start_date: gsecNyEdt(2026, 7, 4) },
		r_bad:   weekly('Broken rule', ['fryday'], h(9), h(17))
	},
	temporal_rules_sets: {
		s_holidays: { name: 'Holidays', temporal_rules: ['r_xmas', 'r_jul4'] }
	},

	users: {
		u_alice: { first_name: 'Alice', last_name: 'Adams', presence_id: '101', username: 'alice' },
		u_bob:   { first_name: 'Bob', last_name: 'Brown', presence_id: '102', username: 'bob' },
		u_carol: { first_name: 'Carol', last_name: 'Chen', presence_id: '103', username: 'carol' }
	},
	devices: {
		d_lobby: { name: 'Lobby phone', device_type: 'sip_device' }
	},
	vmboxes: {
		vm_main:  { name: 'General Mailbox', mailbox: '200', media: { unavailable: 'm_vm' } },
		vm_alice: { name: 'Alice Adams', mailbox: '101' }
	},
	media: {
		m_greet:  { name: 'Main greeting', media_source: 'upload' },
		m_after:  { name: 'After hours greeting', media_source: 'tts' },
		m_hold:   { name: 'Hold music', media_source: 'upload' },
		m_vm:     { name: 'Mailbox greeting', media_source: 'recording' },
		m_closed: { name: 'We are closed', media_source: 'tts' }
	},
	menus: {
		menu_main:  { name: 'Main Menu', media: { greeting: 'm_greet' }, hunt: true },
		menu_after: { name: 'After Hours Menu', media: { greeting: 'm_after' } }
	},
	qubicle_queues: {
		q_front: { name: 'Front Desk Queue', queue_router: 'route_round_robin', hold_treatment: { 1: { play_file: 'm_hold' } }, members: { u_alice: {}, u_bob: {} } }
	},
	directories: {
		dir_main: { name: 'Company Directory' }
	},
	groups: {}, faxboxes: {}, conferences: {},

	callflows: {
		// Main line: holidays (rule set) > lunch > open hours > otherwise after-hours menu.
		cf_main: {
			name: 'Main Line', numbers: ['+18455550100'],
			flow: node('temporal_route', { rules: ['s_holidays', 'r_lunch', 'r_open'] }, {
				s_holidays: play('m_closed', vm('vm_main')),
				r_lunch: jump('cf_lunch', vm('vm_main')), // subroutine: plays, returns, then voicemail
				r_open: node('menu', { id: 'menu_main' }, {
					1: user('u_alice', vm('vm_alice')),
					2: node('qubicle', { id: 'q_front' }, { _: vm('vm_main') }),
					3: node('directory', { id: 'dir_main' }),
					9: jump('cf_main'), // "press 9 to hear the options again" — a caller-driven loop

					0: node('ring_group', { name: 'Everyone', strategy: 'simultaneous', endpoints: [{ id: 'u_alice', endpoint_type: 'user' }, { id: 'u_bob', endpoint_type: 'user' }] }, { _: vm('vm_main') }),
					timeout: jump('cf_operator'),
					_: vm('vm_main')
				}),
				_: node('menu', { id: 'menu_after' }, { 1: jump('cf_oncall'), _: vm('vm_main') })
			})
		},
		cf_lunch:    { name: 'Lunch message', numbers: ['8001'], flow: play('m_closed') },
		cf_operator: { name: 'Operator', numbers: ['0'], flow: user('u_bob', vm('vm_main')) },
		cf_oncall:   { name: 'On-call', numbers: ['+18455550199'], flow: node('device', { id: 'd_lobby', timeout: 20 }, { _: node('offnet', {}) }) },

		// A jump loop: Kazoo gives up after max_branch_count (50) jumps.
		cf_loop_a: { name: 'Loop A', numbers: ['+18455550111'], flow: jump('cf_loop_b') },
		cf_loop_b: { name: 'Loop B', numbers: [], flow: jump('cf_loop_a') },

		// Deleted references: a user that's gone, then a jump to a callflow that's gone.
		cf_missing: { name: 'Stale config', numbers: ['+18455550122'],
			flow: user('u_ghost', jump('cf_deleted', vm('vm_main'))) },

		// A temporal route containing a rule Kazoo crashes on.
		cf_broken_tod: { name: 'Broken schedule', numbers: ['+18455550133'],
			flow: node('temporal_route', { rules: ['r_open', 'r_bad'] }, { r_open: user('u_alice'), _: vm('vm_main') }) },

		// Dead branches: after a terminal module, and a menu `_` shadowed by max_retries.
		cf_dead: { name: 'Busy signal', numbers: ['+18455550144'],
			flow: node('response', { code: 486 }, { _: user('u_carol') }) },
		cf_menu_retries: { name: 'Retries menu', numbers: ['8002'],
			flow: node('menu', { id: 'menu_after' }, { 1: user('u_alice'), max_retries: vm('vm_main'), _: user('u_carol') }) },

		// Feature codes, incl. a temporal_route used as a control action.
		cf_park:    { name: 'Park', numbers: ['*3'], featurecode: { name: 'park', number: '3' }, flow: node('park', { action: 'park' }) },
		cf_control: { name: 'Close office', numbers: ['*55'], featurecode: { name: 'close', number: '55' },
			flow: node('temporal_route', { action: 'disable', rules: ['r_open'] }, { _: play('m_closed') }) }
	},

	phone_numbers: {
		'+18455550100': {}, '+18455550199': {}, '+18455550111': {}, '+18455550122': {},
		'+18455550133': {}, '+18455550144': {},
		'+18455550155': {}, '+18455550166': {} // owned but not routed anywhere
	}
};

var out = path.join(__dirname, '..', 'test', 'fixtures', 'synthetic-account.json');
fs.writeFileSync(out, JSON.stringify(account, null, 1) + '\n');
console.log('wrote', path.relative(process.cwd(), out));
