/**
 * modules.js — every Kazoo callflow module the simulator knows, in one place.
 *
 * Callflows can use any module — the Callflows app only offers some of them, and a Pivot server or
 * a Kazoo Function can answer with any. So each module here gets a proper step on the map: a
 * type, icon and colour, what its `_` child means, a plain-language label, its settings for the
 * details panel, names for its branches, and how a call ends there.
 *
 * Semantics come from Kazoo's source (applications/callflow/src/module/cf_*.erl, 4.3 and master):
 *   cf_exe:continue(Key)  — that child, else `_`, else stop
 *   cf_exe:attempt(Key)   — that child only (no fallback)
 *   cf_exe:stop           — pops a pending jump return, otherwise the call ends
 *   cf_exe:hard_stop / control_usurped / transfer — the call leaves the callflow for good
 *
 * Entry fields (all optional except type):
 *   type        the small caps type line on the step            icon   Monster sprite (fallback)
 *   glyph       Material Symbols icon (DT-Callflows' look)        family colour group, see graph.js
 *   logic       true: a routing-only step, drawn as a slim pill
 *   underscore  what the `_` child is: continue | failure | nomatch | menu | return | terminal
 *   ref         collection the module's data.id points at
 *   label(d,c)  step title          sub(d,c) step subtitle        c = { name(col, id), num(n), cut(s, n) }
 *   rows(d,c)   [label, value] pairs for the details panel (null values are dropped)
 *   key(k,d)    label for a branch named k (not `_`)
 *   decision    the branch depends on something only known at call time: the simulator asks
 *   answer      rings someone (answer / no answer applies)
 *   causes      a failed call takes a branch named after the failure cause (USER_BUSY, sip:486...)
 *   end(d,c)    the call ends here (text for the simulator); the module never uses `_`
 *   hunts       after this step Kazoo may route a number the caller dialled (text for details)
 *   service     needs a separate Kazoo service or app (text for details)
 *
 * UMD, ES5, no dependencies.
 */
(function(root, factory) {
	if (typeof define === 'function' && define.amd) {
		define([], factory);
	} else if (typeof module === 'object' && module.exports) {
		module.exports = factory();
	} else {
		root.crvModules = factory();
	}
}(this, function() {
	'use strict';

	function yes(v) { return v === true || v === 'true'; }
	function on(v, text) { return yes(v) ? (text || 'Yes') : null; }
	function list(v) { return Array.isArray(v) ? v.join(', ') : (v === undefined || v === null || v === '' ? null : String(v)); }
	function secs(v) { return v === undefined || v === null || v === '' ? null : v + ' sec'; }
	function word(s) { return s ? String(s).replace(/_/g, ' ').replace(/^\w/, function(c) { return c.toUpperCase(); }) : null; }
	function pick(d, keys) { for (var i = 0; i < keys.length; i++) { if (d[keys[i]] !== undefined && d[keys[i]] !== null && d[keys[i]] !== '') { return d[keys[i]]; } } return null; }
	function approved(d) {
		var parts = [];
		if (d.approved_user_id) { parts.push('user'); }
		if (d.approved_device_id) { parts.push('device'); }
		if (d.approved_group_id) { parts.push('group'); }
		return parts.length ? 'Only an approved ' + parts.join(' / ') : null;
	}
	function target(d, c) {
		if (d.user_id) { return c.name('users', d.user_id); }
		if (d.device_id) { return c.name('devices', d.device_id); }
		if (d.group_id) { return c.name('groups', d.group_id); }
		return null;
	}
	var ACTION = {
		activate: 'Turn on', deactivate: 'Turn off', toggle: 'Toggle', update: 'Change', menu: 'Menu',
		login: 'Log in', logout: 'Log out', paused: 'Pause', resume: 'Resume', bridge: 'Connect',
		park: 'Park', retrieve: 'Pick up a parked call', direct_park: 'Park in a chosen slot', auto: 'Park or pick up',
		start: 'Start', stop: 'Stop', compose: 'Leave a message', check: 'Check messages'
	};
	function act(d, dflt) { var a = d.action || dflt; return a ? (ACTION[a] || word(a)) : null; }

	// Kazoo hangup causes that can name a failure branch (cf_util:handle_bridge_failure).
	var CAUSES = {
		NO_ANSWER: 'If nobody answers', USER_BUSY: 'If busy', CALL_REJECTED: 'If rejected',
		NO_USER_RESPONSE: 'If no response', UNALLOCATED_NUMBER: 'If the number doesn\'t exist',
		NO_ROUTE_DESTINATION: 'If there is no route', NORMAL_TEMPORARY_FAILURE: 'If it fails',
		ORIGINATOR_CANCEL: 'If the caller hangs up', SUBSCRIBER_ABSENT: 'If unavailable',
		INVALID_NUMBER_FORMAT: 'If the number is invalid', RECOVERY_ON_TIMER_EXPIRE: 'If it times out',
		USER_NOT_REGISTERED: 'If not registered', DESTINATION_OUT_OF_ORDER: 'If out of order',
		INCOMPATIBLE_DESTINATION: 'If incompatible', MEDIA_TIMEOUT: 'If media times out'
	};
	function causeLabel(k) {
		if (CAUSES[k]) { return CAUSES[k]; }
		var m = /^sip:(\d{3})$/.exec(k);
		if (m) { return 'If SIP ' + m[1]; }
		return /^[A-Z_]+$/.test(k) ? 'If ' + word(k.toLowerCase()) : null;
	}
	function isCause(k) { return !!causeLabel(k); }

	var M = {
		/* ---------------------------------- routing & ringing ---------------------------------- */
		user:          { type: 'EXTENSION', icon: 'user', glyph: 'person', family: 'bridge', underscore: 'failure', ref: 'users', answer: true, causes: true,
			rows: function(d) { return [['Rings for', secs(d.timeout)], ['Strategy', word(d.strategy)], ['Delay', secs(d.delay)], ['Caller ID hidden', on(d.suppress_clid)],
				['Stops on first reject', on(d.fail_on_single_reject)], ['Can call itself', on(d.can_call_self)], ['Static INVITE', d.static_invite || null]]; } },
		device:        { type: 'DEVICE', icon: 'phone', glyph: 'deskphone', family: 'bridge', underscore: 'failure', ref: 'devices', answer: true, causes: true },
		ring_group:    { type: 'RING GROUP', icon: 'ring_group', glyph: 'group', family: 'bridge', underscore: 'failure', answer: true, causes: true },
		group:         { type: 'GROUP', icon: 'ring_group', glyph: 'groups', family: 'bridge', underscore: 'failure', ref: 'groups', answer: true, causes: true,
			label: function(d, c) { return d.id ? c.name('groups', d.id) : 'Group'; },
			sub: function(d) { return [word(d.strategy), d.timeout ? d.timeout + 's' : null].filter(Boolean).join(' · ') || null; },
			rows: function(d) { return [['Strategy', word(d.strategy)], ['Rings for', secs(d.timeout)], ['Repeats', d.repeats || null], ['Ignores call forward', on(d.ignore_forward)]]; } },
		page_group:    { type: 'PAGE GROUP', icon: 'ring_group', glyph: 'adaptive_audio_mic', family: 'bridge', underscore: 'failure', answer: true },
		route_to_cid:  { type: 'ROUTE BY CALLER ID', icon: 'user', glyph: 'person_search', family: 'bridge', underscore: 'failure', answer: true,
			label: function() { return 'Ring whoever has the dialled number'; },
			sub: function(d) { return list(d.cid_types) ? 'Matches ' + list(d.cid_types) + ' caller ID' : null; },
			rows: function(d) { return [['Matches', list(d.cid_types) || 'Internal caller ID'], ['Endpoints', list(d.endpoint_types)], ['Rings for', secs(d.timeout)], ['Delay', secs(d.delay)]]; } },
		resources:     { type: 'EXTERNAL', icon: 'resource', glyph: 'cell_tower', family: 'outside', underscore: 'terminal', answer: true, causes: true },
		offnet:        { type: 'EXTERNAL', icon: 'offnet', glyph: 'cell_tower', family: 'outside', underscore: 'terminal', answer: true, causes: true },
		callflow:      { type: 'CALLFLOW', icon: 'callflow', glyph: 'alt_route', family: 'logic', logic: true, underscore: 'return', ref: 'callflows' },
		transfer:      { type: 'TRANSFER', icon: 'rightarrow', glyph: 'phone_forwarded', family: 'bridge', underscore: 'terminal',
			label: function(d, c) { return d.target ? 'Transfer to ' + c.num(d.target) : 'Transfer to the dialled number'; },
			sub: function(d) { return word(d.transfer_type || 'blind'); },
			rows: function(d) { return [['To', d.target || 'The number dialled'], ['Type', word(d.transfer_type || 'blind')], ['Leg', word(d.leg)]]; },
			end: function(d, c) { return 'The call is transferred to ' + (d.target ? c.num(d.target) : 'the number dialled') + '.'; } },
		after_bridge:  { type: 'AFTER THE CALL', icon: 'settings2', glyph: 'call_end', family: 'logic', logic: true, underscore: 'continue',
			label: function(d) { return { park: 'After the call: park it', transfer: 'After the call: transfer', hangup: 'After the call: hang up' }[d.action] || 'After the call'; },
			sub: function(d) { return d.action === 'transfer' && d.data ? String(d.data) : null; },
			rows: function(d) { return [['When the other side hangs up', { park: 'Park the caller', transfer: 'Transfer the caller to ' + (d.data || '?'), hangup: yes(d.data) ? 'Hang up' : 'Don\'t hang up' }[d.action] || word(d.action)]]; } },
		branch_bnumber:{ type: 'ROUTE DIALLED', icon: 'rightarrow', glyph: 'fork_right', family: 'logic', logic: true, underscore: 'continue', decision: true,
			hunts: 'Routes the number the caller dialled (the feature code\'s capture) like a new call.',
			label: function(d) { return yes(d.hunt) ? 'Route the dialled number' : 'Branch on the dialled number'; },
			rows: function(d) { return [['Hunts a callflow', on(d.hunt) || 'No — branches by the digits'], ['Allowed', d.hunt_allow || null], ['Denied', d.hunt_deny || null]]; },
			key: function(k) { return 'Dialled ' + k; } },
		move:          { type: 'FEATURE', icon: 'settings2', glyph: 'move_up', family: 'bridge', underscore: 'terminal',
			label: function() { return 'Move the call to this phone'; }, end: function() { return 'The caller\'s active call moves to this phone.'; } },

		/* ---------------------------------- branching & decisions ---------------------------------- */
		temporal_route:{ type: 'TIME OF DAY', icon: 'temporal_route', glyph: 'schedule', family: 'logic', logic: true, underscore: 'nomatch' },
		menu:          { type: 'AUTO-ATTENDANT', icon: 'menu1', glyph: 'dialpad', family: 'input', underscore: 'menu', ref: 'menus', input: true },
		check_cid:     { type: 'ROUTE BY ANI', icon: 'rightarrow', glyph: 'call_split', family: 'logic', logic: true, underscore: 'nomatch', decision: true,
			label: function(d) { return yes(d.use_absolute_mode) ? 'Route by caller\'s number' : 'Check caller ID'; },
			sub: function(d, c) { return yes(d.use_absolute_mode) ? 'One branch per number' : (d.regex ? c.cut(d.regex, 30) : 'Any caller ID'); },
			rows: function(d) { return [['Matches', yes(d.use_absolute_mode) ? 'Each branch is a caller\'s number' : (d.regex || 'Any caller ID (.*)')],
				['Sets caller ID name', d.caller_id && d.caller_id.external && d.caller_id.external.name || null],
				['Sets caller ID number', d.caller_id && d.caller_id.external && d.caller_id.external.number || null]]; },
			key: function(k) { return k === 'match' ? 'Caller ID matches' : (k === 'nomatch' ? 'Doesn\'t match' : 'Caller is ' + k); } },
		cidlistmatch:  { type: 'CALLER ID LIST', icon: 'rightarrow', glyph: 'checklist', family: 'logic', logic: true, underscore: 'nomatch', decision: true,
			label: function(d, c) { return 'Caller on list: ' + (d.id ? c.name('lists', d.id) : '?'); },
			rows: function(d, c) { return [['List', d.id ? c.name('lists', d.id) : null]]; },
			key: function(k) { return k === 'match' ? 'On the list' : (k === 'nomatch' ? 'Not on the list' : k); } },
		branch_variable:{ type: 'BRANCH', icon: 'rightarrow', glyph: 'fork_right', family: 'logic', logic: true, underscore: 'nomatch', decision: true,
			label: function(d) { return 'Branch on ' + (d.variable || 'a variable'); },
			sub: function(d) { return d.scope ? word(d.scope) : null; },
			rows: function(d) { return [['Variable', d.variable], ['Looked up in', word(d.scope || 'merged')]]; },
			key: function(k, d) { return (d.variable || 'value') + ' = ' + k; } },
		fax_detect:    { type: 'FAX DETECT', icon: 'printer2', glyph: 'fax', family: 'logic', logic: true, underscore: 'continue', decision: true,
			label: function() { return 'Fax or voice?'; }, sub: function(d) { return d.duration ? 'Listens ' + d.duration + 's' : null; },
			rows: function(d) { return [['Listens for', secs(d.duration || 3)]]; },
			key: function(k) { return k === 'ON_FAX' ? 'Fax' : (k === 'ON_VOICE' ? 'Voice' : k); } },
		acdc_wait_time:{ type: 'QUEUE WAIT', icon: 'support', glyph: 'hourglass', family: 'logic', logic: true, underscore: 'continue', decision: true, service: 'ACDc',
			label: function() { return 'Branch on queue wait time'; },
			rows: function(d) { return [['Queue', d.id || null], ['Measured over', secs(d.window)]]; },
			key: function(k) { return /^\d+$/.test(k) ? 'Wait ≥ ' + k + 's' : k; } },
		nomorobo:      { type: 'SPAM CHECK', icon: 'rightarrow', glyph: 'gpp_maybe', family: 'logic', logic: true, underscore: 'continue', decision: true, service: 'NoMoRobo',
			label: function() { return 'Spam score (NoMoRobo)'; },
			key: function(k) { return /^\d+$/.test(k) ? 'Score ≥ ' + k : k; } },

		/* ---------------------------------- caller ID ---------------------------------- */
		set_cid:       { type: 'CALLER-ID', icon: 'rightarrow', glyph: 'badge', family: 'logic', logic: true, underscore: 'continue',
			label: function(d) { return 'Set caller ID ' + [d.caller_id_name, d.caller_id_number].filter(Boolean).join(' '); },
			rows: function(d) { return [['Name', d.caller_id_name || null], ['Number', d.caller_id_number || null]]; } },
		dynamic_cid:   { type: 'CALLER-ID', icon: 'rightarrow', glyph: 'playlist_add_check_circle', family: 'logic', logic: true, underscore: 'continue',
			hunts: 'For manual and list modes the caller then dials a number, which is routed like a new call.',
			label: function(d) { return { 'static': 'Set caller ID', manual: 'Caller enters a caller ID', list: 'Caller ID from a list', lists: 'Caller ID from lists' }[d.action] || 'Dynamic caller ID'; },
			sub: function(d) { return d.action === 'static' && d.caller_id ? [d.caller_id.name, d.caller_id.number].filter(Boolean).join(' ') : null; },
			rows: function(d) { return [['Mode', word(d.action || 'manual')], ['Name', d.caller_id && d.caller_id.name || null], ['Number', d.caller_id && d.caller_id.number || null],
				['List', d.id || null], ['Allowed numbers', d.whitelist_regex || null], ['Digits', d.min_digits || d.max_digits ? (d.min_digits || '?') + '–' + (d.max_digits || '?') : null],
				['Enforces call restrictions', on(d.enforce_call_restriction)]]; } },
		prepend_cid:   { type: 'CALLER-ID', icon: 'plus_circle', glyph: 'add_circle', family: 'logic', logic: true, underscore: 'continue' },
		lookupcidname: { type: 'CALLER-ID', icon: 'rightarrow', glyph: 'person_search', family: 'logic', logic: true, underscore: 'continue',
			label: function() { return 'Look up caller name'; },
			rows: function(d) { return [['Lists', list(d.lists) || 'All']]; } },
		privacy:       { type: 'PRIVACY', icon: 'rightarrow', glyph: 'visibility_off', family: 'logic', logic: true, underscore: 'continue',
			hunts: 'Then routes the number dialled after the code, with caller ID hidden.',
			label: function(d) { return 'Hide caller ' + ({ name: 'name', number: 'number' }[d.mode] || 'ID'); },
			rows: function(d) { return [['Hides', word(d.mode || 'full')], ['Device settings', word(d.endpoint_strategy)]]; } },

		/* ---------------------------------- media & call control ---------------------------------- */
		play:          { type: 'ANNOUNCEMENT', icon: 'play', glyph: 'library_music', family: 'media', underscore: 'continue', ref: 'media' },
		tts:           { type: 'ANNOUNCEMENT', icon: 'chat_circle', glyph: 'text_to_speech', family: 'media', underscore: 'continue' },
		audio_macro:   { type: 'ANNOUNCEMENT', icon: 'play', glyph: 'queue_music', family: 'media', underscore: 'continue',
			label: function(d) { return 'Play ' + ((d.macros || []).length || 'several') + ' prompts'; },
			rows: function(d) { return [['Plays', (d.macros || []).map(function(m) { return (m.macro || '?') + (m.id ? ' ' + m.id : (m.text ? ' "' + m.text + '"' : '')); }).join(' · ') || null], ['Language', d.language || null]]; } },
		language:      { type: 'ACTION', icon: 'earth', glyph: 'language', family: 'logic', logic: true, underscore: 'continue',
			label: function(d) { return 'Language: ' + (d.language || '?'); } },
		sleep:         { type: 'ACTION', icon: 'dot_chat', glyph: 'pause', family: 'logic', logic: true, underscore: 'continue',
			label: function(d) { return 'Wait ' + (d.duration || 0) + ' ' + ({ ms: 'ms', s: 's', m: 'min', h: 'h' }[d.unit] || 's'); } },
		response:      { type: 'RESPONSE', icon: 'rightarrow', glyph: 'reply', family: 'end', underscore: 'terminal',
			label: function(d) { return 'Reply ' + (d.code || 486) + (d.message ? ' ' + d.message : ''); },
			rows: function(d) { return [['SIP code', d.code || '486 (default)'], ['Reason', d.message || null], ['Plays first', d.media || null]]; },
			end: function(d) { return 'Kazoo answers with SIP ' + (d.code || 486) + (d.message ? ' "' + d.message + '"' : '') + ' and the call ends.'; } },
		hangup:        { type: 'HANG UP', icon: 'rightarrow', glyph: 'call_end', family: 'end', underscore: 'terminal',
			label: function() { return 'Hang up'; }, end: function() { return 'Kazoo hangs up.'; } },
		answer:        { type: 'ACTION', icon: 'phone', glyph: 'call', family: 'logic', logic: true, underscore: 'continue', label: function() { return 'Answer the call'; } },
		send_dtmf:     { type: 'ACTION', icon: 'menu1', glyph: 'dialpad', family: 'media', underscore: 'continue',
			label: function(d) { return 'Send tones ' + (d.digits || ''); }, rows: function(d) { return [['Digits', d.digits], ['Each tone', d.duration_ms ? d.duration_ms + ' ms' : null]]; } },
		collect_dtmf:  { type: 'COLLECT DIGITS', icon: 'conference', glyph: 'pin', family: 'input', underscore: 'continue', input: true,
			label: function(d) { return 'Collect digits' + (d.collection_name ? ' as "' + d.collection_name + '"' : ''); },
			sub: function(d) { return d.max_digits ? 'Up to ' + d.max_digits : null; },
			rows: function(d) { return [['Saved as', d.collection_name || 'Default (sent to Pivot as Digits)'], ['Up to', d.max_digits || null], ['Waits', secs(d.timeout && d.timeout / 1000)],
				['Between digits', secs(d.interdigit_timeout && d.interdigit_timeout / 1000)], ['Ends with', list(d.terminators)]]; } },
		flush_dtmf:    { type: 'ACTION', icon: 'menu1', glyph: 'backspace', family: 'logic', logic: true, underscore: 'continue',
			label: function(d) { return 'Clear collected digits' + (d.collection_name ? ' "' + d.collection_name + '"' : ''); } },
		set_alert_info:{ type: 'ACTION', icon: 'play', glyph: 'notifications_active', family: 'logic', logic: true, underscore: 'continue',
			label: function(d) { return 'Ring tone: ' + (d.alert_info || '?'); } },

		/* ---------------------------------- voicemail, fax, conference, directory ---------------------------------- */
		voicemail:     { type: 'MAILBOX', icon: 'voicemail', glyph: 'voicemail', family: 'mailbox', underscore: 'continue', ref: 'vmboxes' },
		receive_fax:   { type: 'FAX', icon: 'sip', glyph: 'fax', family: 'mailbox', underscore: 'terminal',
			label: function(d, c) { return 'Receive fax' + (d.owner_id ? ' for ' + c.name('users', d.owner_id) : ''); },
			rows: function(d) { return [['T.38', word(d.media && d.media.fax_option)]]; }, end: function() { return 'The fax is received.'; } },
		faxbox:        { type: 'FAX', icon: 'printer2', glyph: 'fax', family: 'mailbox', underscore: 'terminal', ref: 'faxboxes', end: function() { return 'The fax is received.'; } },
		conference:    { type: 'CONFERENCE', icon: 'conference', glyph: 'diversity_3', family: 'bridge', underscore: 'terminal', ref: 'conferences', end: function() { return 'The caller joins the conference.'; } },
		conference_feature: { type: 'CONFERENCE', icon: 'conference', glyph: 'diversity_3', family: 'bridge', underscore: 'terminal',
			label: function() { return 'Join the conference dialled'; }, end: function() { return 'The caller joins the conference whose number they dialled.'; } },
		directory:     { type: 'DIRECTORY', icon: 'book', glyph: 'folder_shared', family: 'input', underscore: 'continue', ref: 'directories', input: true,
			hunts: 'The caller picks a name, and that person\'s callflow is run.', end: function() { return 'The caller searches the directory.'; } },

		/* ---------------------------------- feature codes ---------------------------------- */
		call_forward:  { type: 'FEATURE', icon: 'settings2', glyph: 'phone_forwarded', family: 'feature', underscore: 'continue',
			label: function(d) { return 'Call forward: ' + (act(d, 'toggle') || '').toLowerCase(); } },
		call_waiting:  { type: 'FEATURE', icon: 'settings2', glyph: 'phone_callback', family: 'feature', underscore: 'continue',
			label: function(d) { return 'Call waiting: ' + (act(d, 'toggle') || '').toLowerCase(); }, rows: function(d) { return [['Does', act(d, 'toggle')], ['For', word(d.scope || 'device')]]; } },
		do_not_disturb:{ type: 'FEATURE', icon: 'settings2', glyph: 'do_not_disturb_on', family: 'feature', underscore: 'continue',
			label: function(d) { return 'Do not disturb: ' + (act(d, 'toggle') || '').toLowerCase(); } },
		hotdesk:       { type: 'FEATURE', icon: 'settings2', glyph: 'desk', family: 'feature', underscore: 'continue',
			label: function(d) { return 'Hot desk: ' + (act(d, 'login') || '').toLowerCase(); } },
		park:          { type: 'PARK', icon: 'settings2', glyph: 'local_parking', family: 'bridge', underscore: 'continue',
			label: function(d) { return { retrieve: 'Pick up a parked call', direct_park: 'Park in a chosen slot', park: 'Park the call' }[d.action] || 'Park / pick up'; },
			sub: function(d) { return d.slot ? 'Slot ' + d.slot : null; },
			rows: function(d) { return [['Does', act(d, 'auto')], ['Slot', d.slot || null], ['Highest slot', d.max_slot_number || null],
				['Rings back after', secs(d.default_callback_timeout)], ['Rings back for', secs(d.default_ringback_timeout)]]; },
			key: function(k) { return k === 'MAX_SLOT_EXCEEDED' ? 'All slots taken' : 'Slot ' + k; },
			end: function(d) { return d.action === 'retrieve' ? 'The caller picks up the parked call.' : 'The call is parked.'; } },
		intercept:     { type: 'PICKUP', icon: 'settings2', glyph: 'call_merge', family: 'bridge', underscore: 'terminal',
			label: function(d, c) { return 'Pick up ' + (target(d, c) || 'a ringing call'); }, rows: function(d) { return [['Restricted to', approved(d)]]; },
			end: function(d, c) { return 'The caller picks up the call ringing ' + (target(d, c) || 'there') + '.'; } },
		intercept_feature: { type: 'PICKUP', icon: 'settings2', glyph: 'call_merge', family: 'bridge', underscore: 'terminal',
			label: function(d) { return 'Pick up the ' + (d.type || 'extension') + ' dialled'; }, rows: function(d) { return [['Type', word(d.type)], ['Restricted to', approved(d)]]; },
			end: function() { return 'The caller picks up the call ringing at the extension they dialled.'; } },
		group_pickup:  { type: 'PICKUP', icon: 'settings2', glyph: 'step_out', family: 'bridge', underscore: 'terminal',
			label: function(d, c) { return 'Group pickup' + (target(d, c) ? ': ' + target(d, c) : ''); }, rows: function(d) { return [['Restricted to', approved(d)]]; },
			end: function() { return 'The caller picks up a ringing call.'; } },
		group_pickup_feature: { type: 'PICKUP', icon: 'settings2', glyph: 'step_out', family: 'bridge', underscore: 'terminal',
			label: function(d) { return 'Pick up the ' + (d.type || 'extension') + ' dialled'; }, end: function() { return 'The caller picks up a ringing call.'; } },
		eavesdrop:     { type: 'EAVESDROP', icon: 'settings2', glyph: 'hearing', family: 'bridge', underscore: 'terminal',
			label: function(d, c) { return 'Listen in on ' + (target(d, c) || '?'); }, rows: function(d) { return [['Restricted to', approved(d)]]; },
			end: function(d, c) { return 'The caller listens in on ' + (target(d, c) || 'the call') + '.'; } },
		eavesdrop_feature: { type: 'EAVESDROP', icon: 'settings2', glyph: 'hearing', family: 'bridge', underscore: 'terminal',
			label: function() { return 'Listen in on the extension dialled'; }, rows: function(d) { return [['Restricted to', approved(d)]]; },
			end: function() { return 'The caller listens in on the extension they dialled.'; } },
		intercom:      { type: 'INTERCOM', icon: 'settings2', glyph: 'campaign', family: 'bridge', underscore: 'failure', answer: true,
			hunts: 'Calls the extension dialled after the code, which answers automatically.',
			label: function() { return 'Intercom the extension dialled'; }, rows: function(d) { return [['Barges into calls', on(d.barge_calls)]]; } },
		camping_feature:{ type: 'FEATURE', icon: 'settings2', glyph: 'phone_in_talk', family: 'feature', underscore: 'terminal',
			label: function() { return 'Call me back when free'; }, end: function() { return 'Camp-on: the caller is called back when the extension is free.'; } },
		ring_group_toggle: { type: 'FEATURE', icon: 'settings2', glyph: 'group_add', family: 'feature', underscore: 'continue',
			label: function(d, c) { return 'Ring group ' + (act(d, 'login') || '').toLowerCase() + (d.callflow_id ? ': ' + c.name('callflows', d.callflow_id) : ''); } },
		manual_presence:{ type: 'ACTION', icon: 'lightbulb_on', glyph: 'online_prediction', family: 'logic', logic: true, underscore: 'continue',
			label: function(d) { return 'Light ' + (d.presence_id || '?') + ': ' + (d.status || 'idle'); } },
		disa:          { type: 'FEATURE', icon: 'conference', glyph: 'login', family: 'input', underscore: 'terminal', input: true,
			hunts: 'After the PIN the caller dials a number, which is routed like a call from the account.',
			label: function() { return 'Dial-in (DISA)'; },
			rows: function(d) { return [['PIN required', d.pin ? 'Yes' : 'No'], ['Tries', d.retries || null], ['Caller hears', word(d.preconnect_audio)], ['Uses account caller ID', on(d.use_account_caller_id)], ['Enforces call restrictions', on(d.enforce_call_restriction)]]; },
			end: function() { return 'The caller gets a dial tone (DISA).'; } },

		/* ---------------------------------- integrations, data & recording ---------------------------------- */
		pivot:         { type: 'EXTERNAL LOGIC', icon: 'conference', glyph: 'cloud_upload', family: 'outside', underscore: 'failure' },
		webhook:       { type: 'ACTION', icon: 'to_cloud', glyph: 'webhook', family: 'logic', logic: true, underscore: 'continue',
			label: function(d, c) { return 'Webhook ' + (d.uri ? c.cut(String(d.uri).replace(/^https?:\/\//, ''), 30) : ''); },
			rows: function(d) { return [['URL', d.uri || null], ['Method', (d.http_verb || 'post').toUpperCase()], ['Retries', d.retries || null], ['Extra data', d.custom_data ? JSON.stringify(d.custom_data) : null]]; } },
		notification:  { type: 'ACTION', icon: 'bell1', glyph: 'mail', family: 'logic', logic: true, underscore: 'continue',
			label: function() { return 'Send an email'; },
			rows: function(d) { return [['To', (d.recipients || []).map(function(r) { return r.id || r.type; }).join(', ') || null], ['Template', d.template_id || null], ['When', d.send_at === 'channel_destroy' ? 'After the call' : 'Right away']]; } },
		missed_call_alert: { type: 'ACTION', icon: 'bell1', glyph: 'call_missed', family: 'logic', logic: true, underscore: 'continue',
			label: function() { return 'Email if missed'; }, rows: function(d) { return [['To', (d.recipients || []).map(function(r) { return r.id || r.type; }).join(', ') || null]]; } },
		record_call:   { type: 'ACTION', icon: 'conference', glyph: 'volume_up', family: 'logic', logic: true, underscore: 'continue',
			label: function(d) { return d.action === 'stop' ? 'Stop recording' : 'Record the call'; },
			rows: function(d) { return [['Does', act(d, 'start')], ['Format', d.format || null], ['Up to', secs(d.time_limit)], ['Starts on answer', on(d.record_on_answer)], ['Saves to', d.url || null]]; } },
		record_caller: { type: 'ACTION', icon: 'conference', glyph: 'mic', family: 'mailbox', underscore: 'continue',
			label: function() { return 'Record the caller'; }, rows: function(d) { return [['Format', d.format || null], ['Up to', secs(d.time_limit)], ['Saves to', d.url || null]]; } },
		set_variable:  { type: 'ACTION', icon: 'settings2', glyph: 'data_object', family: 'logic', logic: true, underscore: 'continue',
			label: function(d) { return 'Set ' + (d.variable || '?') + ' = ' + (d.value === undefined ? '' : d.value); },
			rows: function(d) { return [['Variable', d.variable], ['Value', d.value === undefined ? null : String(d.value)], ['On', word(d.channel || 'a')]]; } },
		set_variables: { type: 'ACTION', icon: 'settings2', glyph: 'manufacturing', family: 'logic', logic: true, underscore: 'continue',
			label: function(d) { var k = Object.keys(d.custom_application_vars || {}); return k.length ? 'Set ' + k.join(', ') : 'Set variables'; },
			rows: function(d) { var v = d.custom_application_vars || {}; return Object.keys(v).map(function(k) { return [k, String(v[k])]; }).concat([['Exported to the other leg', on(d.export)]]); } },
		'function':    { type: 'FUNCTION', icon: 'to_cloud', glyph: 'function', family: 'outside', underscore: 'continue', service: 'Kazoo Functions',
			label: function() { return 'Run a function'; }, rows: function(d) { return [['Function', d.id || null]]; },
			end: function() { return 'A Kazoo Function decides what happens next.'; } },

		/* ---------------------------------- call center & internal ---------------------------------- */
		qubicle:       { type: 'QUEUE', icon: 'support', glyph: 'support_agent', family: 'bridge', underscore: 'failure', ref: 'qubicle_queues', answer: true },
		qubicle_recipient: { type: 'QUEUE', icon: 'support', glyph: 'support_agent', family: 'bridge', underscore: 'continue' },
		acdc_member:   { type: 'QUEUE', icon: 'support', glyph: 'support_agent', family: 'bridge', underscore: 'failure', answer: true, service: 'ACDc',
			rows: function(d) { return [['Queue', d.id || null], ['Priority', d.priority || null]]; } },
		acdc_agent:    { type: 'FEATURE', icon: 'support', glyph: 'login', family: 'feature', underscore: 'continue', service: 'ACDc',
			label: function(d) { return 'Agent: ' + (act(d, 'login') || '').toLowerCase(); } },
		acdc_queue:    { type: 'FEATURE', icon: 'support', glyph: 'group_add', family: 'feature', underscore: 'continue', service: 'ACDc',
			label: function(d) { return 'Queue ' + (act(d, 'login') || '').toLowerCase(); } },
		dead_air:      { type: 'ACTION', icon: 'rightarrow', glyph: 'volume_mute', family: 'end', underscore: 'terminal',
			label: function() { return 'Answer and stay silent'; }, end: function() { return 'The call is answered and stays silent until someone hangs up.'; } },
		wait_for_hangup:{ type: 'ACTION', icon: 'rightarrow', glyph: 'hourglass_empty', family: 'end', underscore: 'terminal',
			label: function() { return 'Wait for the caller to hang up'; }, end: function() { return 'Kazoo waits for the caller to hang up.'; } },
		noop:          { type: 'INTERNAL', icon: 'settings2', glyph: 'more_horiz', family: 'logic', logic: true, underscore: 'continue', label: function() { return 'No-op'; } },
		edr:           { type: 'INTERNAL', icon: 'settings2', glyph: 'more_horiz', family: 'logic', logic: true, underscore: 'continue', label: function() { return 'Event record'; } },
		set:           { type: 'INTERNAL', icon: 'settings2', glyph: 'more_horiz', family: 'logic', logic: true, underscore: 'continue', label: function() { return 'Placeholder'; } },
		skel:          { type: 'INTERNAL', icon: 'settings2', glyph: 'more_horiz', family: 'logic', logic: true, underscore: 'continue', label: function() { return 'Template step'; } }
	};

	// Anything else (a module from a newer Kazoo, or a custom one) — shown as a generic feature.
	var GENERIC = { type: 'FEATURE', icon: 'settings2', glyph: 'settings', family: 'feature', underscore: 'continue' };

	function info(name) { return M[name] || GENERIC; }

	return {
		info: info,
		known: function(name) { return Object.prototype.hasOwnProperty.call(M, name); },
		names: function() { return Object.keys(M); },
		causeLabel: causeLabel,
		isCause: isCause,
		GENERIC: GENERIC
	};
}));
