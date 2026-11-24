/**
 * graph.js — turns a Kazoo account snapshot into a call-routing graph, and walks one simulated
 * call through it.
 *
 * Pure functions, no DOM, no network: the Monster app fetches the snapshot and renders the
 * result. Branch semantics follow Kazoo 4.3's callflow modules (cf_callflow, cf_menu, cf_user,
 * cf_ring_group, cf_offnet, cf_temporal_route) — see SEMANTICS below.
 *
 * Snapshot shape (every collection is { id: doc }):
 *   { account: { timezone }, callflows, menus, users, devices, vmboxes, groups, media,
 *     temporal_rules, temporal_rules_sets, qubicle_queues, directories, faxboxes, conferences,
 *     phone_numbers: { "+1555...": { ... } } }
 *
 * UMD, ES5 — loads under Monster UI's RequireJS and under Node for tests.
 */
(function(root, factory) {
	if (typeof define === 'function' && define.amd) {
		define(['./temporal'], factory);
	} else if (typeof module === 'object' && module.exports) {
		module.exports = factory(require('./temporal'));
	} else {
		root.crvGraph = factory(root.crvTemporal);
	}
}(this, function(temporal) {
	'use strict';

	var MAX_SIM_STEPS = 500;          // safety net only; Kazoo's own limit below ends loops first
	var DEFAULT_MAX_BRANCH_COUNT = 50; // cf_exe ?MAX_BRANCH_COUNT (system_config callflow.max_branch_count)

	/* ---------------------------------------------------------------------------------------- *
	 * SEMANTICS — what each module's `_` child means, verified against the Kazoo 4.3 source.
	 *   continue : sequential — the next step after this one
	 *   failure  : taken only when the module fails (no answer / busy / bridge failed)
	 *   nomatch  : taken when no branch matched
	 *   menu     : after max retries, unless a `max_retries` child exists (cf_menu)
	 *   return   : callflow jumps are SUBROUTINE CALLS. cf_exe:branch/2 pushes the jump node's
	 *              `_` onto a flow stack; when the target callflow runs out of steps, Kazoo
	 *              resumes there instead of hanging up. If the target is missing, `_` runs
	 *              straight away (cf_callflow -> cf_exe:continue).
	 *   terminal : the call ends here; any `_` is unreachable
	 *
	 * cf_exe:continue(Key) with no such child falls back to `_`; with no `_` either, Kazoo stops —
	 * which pops the flow stack if a jump is pending, and hangs up otherwise. cf_exe:attempt(Key)
	 * (menu digits) does NOT fall back. After max_branch_count jumps (default 50) Kazoo
	 * terminates the call — that is its loop protection.
	 * ---------------------------------------------------------------------------------------- */
	var MODULES = {
		user:              { type: 'EXTENSION',      icon: 'user',            underscore: 'failure',  ref: 'users' },
		device:            { type: 'DEVICE',         icon: 'phone',           underscore: 'failure',  ref: 'devices' },
		ring_group:        { type: 'RING GROUP',     icon: 'ring_group',      underscore: 'failure' },
		page_group:        { type: 'PAGE GROUP',     icon: 'ring_group',      underscore: 'failure' },
		menu:              { type: 'AUTO-ATTENDANT', icon: 'menu1',           underscore: 'menu',     ref: 'menus' },
		temporal_route:    { type: 'TIME OF DAY',    icon: 'temporal_route',  underscore: 'nomatch' },
		voicemail:         { type: 'MAILBOX',        icon: 'voicemail',       underscore: 'continue', ref: 'vmboxes' },
		callflow:          { type: 'CALLFLOW',       icon: 'callflow',        underscore: 'return',   ref: 'callflows' },
		qubicle:           { type: 'QUEUE',          icon: 'support',         underscore: 'failure',  ref: 'qubicle_queues' },
		acdc_member:       { type: 'QUEUE',          icon: 'support',         underscore: 'failure' },
		conference:        { type: 'CONFERENCE',     icon: 'conference',      underscore: 'continue', ref: 'conferences' },
		directory:         { type: 'DIRECTORY',      icon: 'book',            underscore: 'continue', ref: 'directories' },
		play:              { type: 'ANNOUNCEMENT',   icon: 'play',            underscore: 'continue', ref: 'media' },
		tts:               { type: 'ANNOUNCEMENT',   icon: 'chat_circle',     underscore: 'continue' },
		faxbox:            { type: 'FAX',            icon: 'printer2',        underscore: 'continue', ref: 'faxboxes' },
		receive_fax:       { type: 'FAX',            icon: 'sip',             underscore: 'continue' },
		offnet:            { type: 'EXTERNAL',       icon: 'offnet',          underscore: 'failure' },
		resources:         { type: 'EXTERNAL',       icon: 'resource',        underscore: 'failure' },
		pivot:             { type: 'EXTERNAL LOGIC', icon: 'conference',      underscore: 'failure' },
		check_cid:         { type: 'ROUTE BY ANI',   icon: 'rightarrow',      underscore: 'nomatch' },
		branch_variable:   { type: 'BRANCH',         icon: 'rightarrow',      underscore: 'nomatch' },
		prepend_cid:       { type: 'CALLER-ID',      icon: 'plus_circle',     underscore: 'continue' },
		dynamic_cid:       { type: 'CALLER-ID',      icon: 'rightarrow',      underscore: 'continue' },
		set_variables:     { type: 'ACTION',         icon: 'settings2',       underscore: 'continue' },
		set_alert_info:    { type: 'ACTION',         icon: 'play',            underscore: 'continue' },
		language:          { type: 'ACTION',         icon: 'earth',           underscore: 'continue' },
		sleep:             { type: 'ACTION',         icon: 'dot_chat',        underscore: 'continue' },
		record_call:       { type: 'ACTION',         icon: 'conference',      underscore: 'continue' },
		manual_presence:   { type: 'ACTION',         icon: 'lightbulb_on',    underscore: 'continue' },
		missed_call_alert: { type: 'ACTION',         icon: 'bell1',           underscore: 'continue' },
		webhook:           { type: 'ACTION',         icon: 'to_cloud',        underscore: 'continue' },
		collect_dtmf:      { type: 'ACTION',         icon: 'conference',      underscore: 'continue' },
		response:          { type: 'ACTION',         icon: 'rightarrow',      underscore: 'terminal' },
		disa:              { type: 'FEATURE',        icon: 'conference',      underscore: 'terminal' }
	};
	// Anything else (park, intercom, hotdesk, call_forward, move, qubicle_recipient, ...) is
	// rendered generically as a FEATURE and assumed to continue with `_` if it has one.
	var GENERIC = { type: 'FEATURE', icon: 'settings2', underscore: 'continue' };

	function moduleInfo(name) { return MODULES[name] || GENERIC; }

	/**
	 * Material Symbols glyph per module — DT-Callflows' own `google_icon` values, so steps look
	 * exactly like they do in the Callflows app. Keys are module or "module:action".
	 */
	var GLYPHS = {
		user: 'person', device: 'deskphone', ring_group: 'group', page_group: 'adaptive_audio_mic',
		menu: 'dialpad', voicemail: 'voicemail', callflow: 'alt_route', qubicle: 'support_agent',
		acdc_member: 'support_agent', conference: 'diversity_3', directory: 'folder_shared',
		play: 'library_music', tts: 'text_to_speech', faxbox: 'fax', receive_fax: 'fax',
		offnet: 'cell_tower', resources: 'cell_tower', pivot: 'cloud_upload', check_cid: 'call_split',
		branch_variable: 'fork_right', prepend_cid: 'add_circle', 'prepend_cid:reset': 'change_circle',
		dynamic_cid: 'playlist_add_check_circle', set_variables: 'manufacturing',
		set_alert_info: 'notifications_active', language: 'language', sleep: 'pause',
		record_call: 'volume_up', 'record_call:stop': 'volume_off', manual_presence: 'online_prediction',
		missed_call_alert: 'call_missed', webhook: 'webhook', collect_dtmf: 'pin', response: 'reply',
		disa: 'login', group_pickup: 'step_out', group_pickup_feature: 'step_out',
		call_forward: 'phone_forwarded', 'call_forward:deactivate': 'phone_paused',
		do_not_disturb: 'do_not_disturb_on', 'do_not_disturb:deactivate': 'do_not_disturb_off',
		hotdesk: 'desk', park: 'local_parking', eavesdrop: 'hearing', intercom: 'campaign',
		move: 'move_up', privacy: 'visibility_off', qubicle_recipient: 'support_agent',
		ring_group_toggle: 'group_add', 'ring_group_toggle:logout': 'group_remove',
		acdc_agent: 'login', 'acdc_agent:logout': 'logout',
		temporal_route: 'schedule', 'temporal_route:enable': 'schedule',
		'temporal_route:disable': 'history_toggle_off', 'temporal_route:reset': 'history'
	};
	var DEVICE_GLYPHS = { cellphone: 'smartphone', smartphone: 'smartphone', mobile: 'smartphone', softphone: 'devices',
		fax: 'fax', landline: 'home_work', sip_uri: 'sip', application: 'settop_component', meta: 'devices' };

	function glyphFor(module, data, doc) {
		if (module === 'device' && doc && DEVICE_GLYPHS[doc.device_type]) { return DEVICE_GLYPHS[doc.device_type]; }
		return GLYPHS[module + ':' + (data && data.action)] || GLYPHS[module] || 'settings';
	}

	/**
	 * Routing-only steps: things the caller never hears or sees, they only decide where the call
	 * goes next (time of day, jumps, caller-ID tweaks...). Drawn as slim pills on the canvas.
	 */
	var LOGIC_MODULES = {
		temporal_route: true, callflow: true, check_cid: true, branch_variable: true, prepend_cid: true,
		dynamic_cid: true, set_variables: true, set_alert_info: true, language: true, sleep: true,
		record_call: true, manual_presence: true, missed_call_alert: true, webhook: true
	};

	/** Modules that wait for the caller — a loop through one of these is the caller's choice. */
	var INPUT_MODULES = { menu: true, collect_dtmf: true, directory: true, disa: true };

	// cf_temporal_route with action enable/disable/reset/menu doesn't route by time — it flips the
	// rules' `enabled` flag (feature-code style) and then continues with `_`.
	var TEMPORAL_CONTROL = { enable: 'Force time rules ON', disable: 'Force time rules OFF', reset: 'Reset time rules to schedule', menu: 'Time rules menu' };
	function temporalControl(module, data) {
		return module === 'temporal_route' && data && TEMPORAL_CONTROL[data.action] ? data.action : null;
	}
	var TEMPORAL_CONTROL_INFO = { type: 'FEATURE', icon: 'temporal_route', underscore: 'continue' };
	function effectiveInfo(module, data) {
		return temporalControl(module, data) ? TEMPORAL_CONTROL_INFO : moduleInfo(module);
	}

	var UNDERSCORE_LABEL = {
		'continue': 'Then',
		failure: 'No answer / fails',
		nomatch: 'No match',
		menu: 'After max retries',
		'return': 'When it finishes',
		terminal: 'Unreachable'
	};

	/* ---------------------------------------------------------------------------------------- *
	 * Small helpers
	 * ---------------------------------------------------------------------------------------- */

	function get(obj, path, dflt) {
		var cur = obj, parts = path.split('.');
		for (var i = 0; i < parts.length; i++) {
			if (cur === null || cur === undefined) { return dflt; }
			cur = cur[parts[i]];
		}
		return cur === undefined ? dflt : cur;
	}

	function humanize(module) {
		return String(module).replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
	}

	function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

	/** "+13475551234" -> "(347) 555-1234"; anything else is returned as-is. */
	function formatNumber(num) {
		var m = /^\+?1?(\d{3})(\d{3})(\d{4})$/.exec(String(num));
		return m ? '(' + m[1] + ') ' + m[2] + '-' + m[3] : String(num);
	}

	/**
	 * What kind of DID a number is: tollfree (NANP 800/833/844/855/866/877/888), international
	 * (an E.164 number outside +1), or local.
	 */
	function numberKind(num) {
		var s = String(num), digits = s.replace(/\D/g, '');
		if (s.charAt(0) === '+' && digits.charAt(0) !== '1') { return 'international'; }
		if (digits.length === 11 && digits.charAt(0) === '1') { digits = digits.slice(1); }
		if (digits.length !== 10) { return s.charAt(0) === '+' ? 'international' : 'local'; }
		return /^8(00|33|44|55|66|77|88)/.test(digits) ? 'tollfree' : 'local';
	}

	/** Classifies a callflow number: did | extension | featurecode | no_match | other. */
	function classifyNumber(num) {
		num = String(num);
		if (num === 'no_match') { return 'no_match'; }
		if (num.indexOf('*') !== -1) { return 'featurecode'; }
		if (/^\+?\d{10,15}$/.test(num)) { return 'did'; }
		if (/^\d{1,7}$/.test(num)) { return 'extension'; }
		return 'other';
	}

	/**
	 * Live registration, when the snapshot carries `device_status` ({ deviceId: { registered,
	 * registrable } } from GET devices/status). Returns null when unknown.
	 *   { online, total } for a user (their registrable devices) or a single device.
	 */
	function presence(snap, module, id) {
		var status = snap.device_status;
		if (!status || !id) { return null; }
		var ids = module === 'device' ? [id] : Object.keys(snap.devices || {}).filter(function(d) { return snap.devices[d].owner_id === id; });
		ids = ids.filter(function(d) { return status[d] && status[d].registrable; });
		if (!ids.length) { return null; }
		return { online: ids.filter(function(d) { return status[d].registered; }).length, total: ids.length };
	}

	function userName(user) {
		var name = ((user.first_name || '') + ' ' + (user.last_name || '')).trim() || user.username || 'User';
		return user.presence_id ? name + ' (' + user.presence_id + ')' : name;
	}

	/* ---------------------------------------------------------------------------------------- *
	 * Node description: label, sublabel, playable media, issues
	 * ---------------------------------------------------------------------------------------- */

	function mediaItem(snap, role, mediaId, fallbackLabel) {
		if (!mediaId) { return null; }
		var doc = get(snap, 'media.' + mediaId);
		return {
			role: role, mediaId: mediaId,
			label: doc ? (doc.name || fallbackLabel) : fallbackLabel,
			source: doc ? doc.media_source : null,
			missing: !doc
		};
	}

	/** A string that is a Kazoo media document id (not a tone_stream or URL). */
	function isMediaId(v) { return typeof v === 'string' && /^[0-9a-f]{32}$/i.test(v); }

	/** The prompt language Kazoo uses for this account ("en-us"). */
	function promptLanguage(snap) { return String(get(snap, 'account.language') || 'en-us').toLowerCase(); }

	/**
	 * Kazoo's built-in voicemail greeting for a box without its own: "vm-person", the mailbox
	 * number, then "vm-not_available" (cf_voicemail play_greeting). We play the two prompts.
	 */
	function defaultVmGreeting(snap, doc) {
		return {
			role: 'unavailable', system: true, prompts: ['vm-person', 'vm-not_available'], language: promptLanguage(snap),
			label: 'Default greeting', text: 'The person at extension ' + (doc.mailbox || '…') + ' is not available'
		};
	}

	function describe(module, data, snap, childKeys) {
		var info = moduleInfo(module),
			out = { label: humanize(module), sublabel: null, media: [], issues: [], ref: null },
			ref = info.ref && data && data.id ? { collection: info.ref, id: data.id } : null,
			doc = ref ? get(snap, ref.collection + '.' + ref.id) : null;

		if (ref) {
			out.ref = ref;
			if (!doc) {
				out.issues.push({ level: 'error', code: 'missing-ref', message: humanize(module) + ' points at ' + ref.collection + '/' + ref.id + ', which does not exist.' });
			}
		}

		switch (module) {
			case 'user':
				out.label = doc ? userName(doc) : 'Missing user';
				out.presence = doc ? presence(snap, 'user', data.id) : null;
				if (out.presence) { out.sublabel = out.presence.online + '/' + out.presence.total + ' devices online'; }
				break;
			case 'device':
				out.label = doc ? (doc.name || 'Device') : 'Missing device';
				out.presence = doc ? presence(snap, 'device', data.id) : null;
				out.sublabel = (doc && doc.device_type ? doc.device_type : '') +
					(out.presence ? (doc && doc.device_type ? ' · ' : '') + (out.presence.online ? 'online' : 'offline') : '') || null;
				break;
			case 'menu':
				out.label = doc ? (doc.name || 'Menu') : 'Missing menu';
				if (doc) {
					var g = mediaItem(snap, 'greeting', get(doc, 'media.greeting'), 'Greeting');
					if (g) { out.media.push(g); } else { out.sublabel = 'Default greeting'; }
					if (doc.hunt) { out.sublabel = (out.sublabel ? out.sublabel + ' · ' : '') + 'Dial by extension'; }
				}
				break;
			case 'voicemail':
				if (data && data.action === 'check') {
					out.label = 'Check voicemail';
				} else {
					out.label = doc ? (doc.name || 'Voicemail') + (doc.mailbox ? ' (' + doc.mailbox + ')' : '') : 'Missing voicemail box';
					if (doc) {
						var vm = mediaItem(snap, 'unavailable', get(doc, 'media.unavailable'), 'VM greeting'), notes = [];
						if (doc.skip_greeting === true) { notes.push('Greeting skipped'); }
						else if (vm) { out.media.push(vm); }
						else { out.media.push(defaultVmGreeting(snap, doc)); notes.push('Default greeting'); }
						if (doc.announcement_only === true) { notes.push('Greeting only, no messages'); }
						out.sublabel = notes.join(' · ') || null;
					}
				}
				break;
			case 'callflow':
				out.label = doc ? 'Go to: ' + (doc.name || (doc.numbers || [])[0] || 'callflow') : 'Missing callflow';
				break;
			case 'qubicle':
				out.label = doc ? (doc.name || doc.queue_name || 'Queue') : 'Missing queue';
				if (doc) {
					out.sublabel = String(doc.queue_router || '').replace(/^route_/, '').replace(/_/g, '-') || null;
					var hold = mediaItem(snap, 'hold', get(doc, 'hold_treatment.1.play_file'), 'Hold music');
					if (hold) { out.media.push(hold); }
				}
				break;
			case 'ring_group':
			case 'page_group':
				out.label = (data && data.name) || humanize(module);
				out.sublabel = ((data && data.strategy) ? data.strategy + ' · ' : '') + ((data && data.endpoints) || []).length + ' endpoints';
				if (data && isMediaId(data.ringback)) { var rb = mediaItem(snap, 'ringback', data.ringback, 'Ringback'); if (rb) { out.media.push(rb); } }
				break;
			case 'temporal_route':
				if (temporalControl(module, data)) {
					out.label = TEMPORAL_CONTROL[data.action];
					out.sublabel = ((data && data.rules) || []).length + ' rules';
				} else {
					// Kazoo also checks branch keys that aren't listed in data.rules (cf_temporal_route).
					var ruleIds = ((data && data.rules) || []).slice();
					(childKeys || []).forEach(function(k) { if (k !== '_' && ruleIds.indexOf(k) === -1) { ruleIds.push(k); } });
					out.label = 'Time of day';
					out.sublabel = ruleIds.length + (ruleIds.length === 1 ? ' rule' : ' rules') + (data && data.rule_set ? ' + set' : '');
				}
				break;
			case 'play':
				out.label = doc ? (doc.name || 'Announcement') : 'Missing media';
				if (data && data.id) { var p = mediaItem(snap, 'play', data.id, 'Announcement'); if (p) { out.media.push(p); } }
				break;
			case 'tts':
				out.label = 'Say: "' + truncate(data && data.text, 40) + '"';
				if (data && data.text) {
					// Kazoo speaks it with its own TTS engine; we can only preview with the browser's voice.
					out.media.push({ role: 'tts', speak: String(data.text), language: data.language || promptLanguage(snap), voice: data.voice || null, label: 'Preview (browser voice)' });
				}
				break;
			case 'conference':
				out.label = doc ? (doc.name || 'Conference') : (data && data.id ? 'Missing conference' : 'Conference service');
				break;
			case 'directory':
				out.label = doc ? (doc.name || 'Directory') : 'Missing directory';
				break;
			case 'faxbox':
				out.label = doc ? (doc.name || 'Fax box') : 'Missing fax box';
				break;
			case 'offnet':
			case 'resources':
				out.label = 'Outbound call';
				out.sublabel = module === 'offnet' ? 'Carrier (offnet)' : 'Account resources';
				break;
			case 'pivot':
				out.label = 'Pivot (external logic)';
				out.sublabel = data && data.voice_url ? truncate(String(data.voice_url).replace(/^https?:\/\//, ''), 40) : null;
				out.issues.push({ level: 'info', code: 'pivot', message: 'Routing is decided at call time by an external server — it cannot be shown in advance.' });
				break;
			case 'prepend_cid':
				out.label = data && data.action === 'reset' ? 'Reset caller ID prefix' : 'Prefix caller ID "' + truncate(data && (data.caller_id_name_prefix || data.caller_id_number_prefix), 24) + '"';
				break;
			default:
				if (data && data.action) { out.sublabel = humanize(data.action); }
		}
		return out;
	}

	/* ---------------------------------------------------------------------------------------- *
	 * Edge labels
	 * ---------------------------------------------------------------------------------------- */

	function ruleName(snap, id) {
		var r = get(snap, 'temporal_rules.' + id);
		if (r) { return r.name || id; }
		var s = get(snap, 'temporal_rules_sets.' + id);
		if (s) { return 'Set: ' + (s.name || id); }
		return null;
	}

	function edgeLabel(module, key, data, snap) {
		if (temporalControl(module, data)) {
			return key === '_' ? UNDERSCORE_LABEL['continue'] : humanize(key);
		}
		if (module === 'temporal_route') {
			if (key === '_') { return 'No rule matches'; }
			return ruleName(snap, key) || 'Unknown rule';
		}
		if (module === 'menu') {
			if (key === '_') { return UNDERSCORE_LABEL.menu; }
			if (key === 'timeout') { return 'No input'; }
			if (key === 'max_retries') { return 'After max retries'; }
			return 'Press ' + key;
		}
		if (key === '_') { return UNDERSCORE_LABEL[moduleInfo(module).underscore]; }
		return humanize(key);
	}

	/* ---------------------------------------------------------------------------------------- *
	 * Build
	 * ---------------------------------------------------------------------------------------- */

	function Builder(snap) {
		this.snap = snap;
		this.nodes = {};
		this.edges = [];
		this.edgeSeq = 0;
		this.issues = [];
		this.expanded = {};   // callflowId -> root node id
		this.stack = [];      // callflow ids currently being expanded (loop detection)
		this.path = [];       // { cfId, module } for every step on the current walk, across jumps
	}

	Builder.prototype.addNode = function(node) {
		if (!this.nodes[node.id]) { this.nodes[node.id] = node; }
		return this.nodes[node.id];
	};

	Builder.prototype.addEdge = function(from, to, props) {
		var e = { id: 'e' + (++this.edgeSeq), from: from, to: to };
		for (var k in props) { if (Object.prototype.hasOwnProperty.call(props, k)) { e[k] = props[k]; } }
		this.edges.push(e);
		return e;
	};

	/** Expands a callflow once; returns the id of its root node (or null if it doesn't exist). */
	Builder.prototype.expandCallflow = function(cfId) {
		if (this.expanded[cfId]) { return this.expanded[cfId]; }
		var cf = get(this.snap, 'callflows.' + cfId);
		if (!cf) { return null; }
		var rootId = 'cf:' + cfId + ':';
		this.expanded[cfId] = rootId; // set first, so a loop back here just links to it
		this.stack.push(cfId);
		if (cf.flow && cf.flow.module) {
			this.walk(cf.flow, cfId, '');
		} else {
			this.addNode({ id: rootId, kind: 'module', module: 'empty', type: 'CALLFLOW', icon: 'callflow', glyph: 'alt_route', role: 'logic',
				label: 'Empty callflow', callflowId: cfId, path: '', data: {}, media: [],
				issues: [{ level: 'warning', code: 'empty-callflow', message: 'This callflow has no steps.' }] });
		}
		this.stack.pop();
		return rootId;
	};

	Builder.prototype.walk = function(flowNode, cfId, path) {
		var self = this,
			module = flowNode.module,
			data = flowNode.data || {},
			info = effectiveInfo(module, data),
			d = describe(module, data, self.snap, Object.keys(flowNode.children || {})),
			id = 'cf:' + cfId + ':' + path,
			children = flowNode.children || {},
			keys = Object.keys(children);

		var refDoc = d.ref ? get(self.snap, d.ref.collection + '.' + d.ref.id) : null;
		var node = self.addNode({
			id: id, kind: 'module', module: module, type: info.type, icon: info.icon,
			glyph: glyphFor(module, data, refDoc),
			role: LOGIC_MODULES[module] && !temporalControl(module, data) ? 'logic' : 'call',
			label: d.label, sublabel: d.sublabel, callflowId: cfId, path: path,
			data: data, ref: d.ref, media: d.media, issues: d.issues, presence: d.presence || null
		});
		self.path.push({ cfId: cfId, module: module });

		var jumpTargetExists = false;
		if (module === 'callflow' && data.id) {
			var looping = self.stack.indexOf(data.id) !== -1,
				target = self.expandCallflow(data.id);
			if (target) {
				jumpTargetExists = true;
				// A loop that passes through a menu (e.g. "press 9 to hear the options again")
				// only repeats when the caller asks for it — that's a feature, not a problem.
				var callerDriven = false;
				if (looping) {
					var startAt = -1;
					for (var i = 0; i < self.path.length; i++) { if (self.path[i].cfId === data.id) { startAt = i; break; } }
					callerDriven = startAt !== -1 && self.path.slice(startAt).some(function(p) { return INPUT_MODULES[p.module]; });
				}
				self.addEdge(id, target, {
					kind: looping ? 'loop' : 'jump', key: null,
					label: looping ? (callerDriven ? 'Back to start' : 'Loops back') : 'Goes to',
					callerDriven: looping ? callerDriven : undefined
				});
				if (looping && !callerDriven) {
					node.issues.push({ level: 'warning', code: 'loop', message: 'This jump loops back with no caller choice in between — Kazoo gives up after 50 jumps.' });
				}
			}
		}

		// cf_menu: `_` is unreachable when a `max_retries` child exists.
		var menuUnderscoreDead = module === 'menu' && keys.indexOf('max_retries') !== -1;

		keys.forEach(function(key) {
			var childPath = path === '' ? key : path + '/' + key,
				childId = self.walk(children[key], cfId, childPath),
				dead = key === '_' && (info.underscore === 'terminal' || menuUnderscoreDead),
				kind = dead ? 'dead' : (key === '_' ? info.underscore : 'branch'),
				label = dead ? 'Never runs' : edgeLabel(module, key, data, self.snap);
			if (module === 'callflow' && key === '_') {
				label = jumpTargetExists ? 'When it finishes' : 'Target missing — continues';
			}
			var edge = self.addEdge(id, childId, { kind: kind, key: key, label: label });
			if (module === 'temporal_route' && key !== '_' && !temporalControl(module, data)) { edge.ruleId = key; }
			if (dead) {
				node.issues.push({ level: 'warning', code: 'dead-branch', message: 'The "' + key + '" branch can never be reached.' });
			}
		});

		if (module === 'temporal_route') { self.lintTemporal(node, data, keys, !!temporalControl(module, data)); }
		self.path.pop();
		return id;
	};

	Builder.prototype.lintTemporal = function(node, data, keys, isControl) {
		var snap = this.snap, tz = temporal.resolveTimezone(data, get(snap, 'account.timezone', 'UTC'));
		var ids = (data.rules || []).concat(keys.filter(function(k) { return k !== '_'; }));
		var seen = {};
		ids.forEach(function(id) {
			if (seen[id]) { return; } seen[id] = true;
			var doc = get(snap, 'temporal_rules.' + id);
			if (!doc && !get(snap, 'temporal_rules_sets.' + id)) {
				node.issues.push({ level: 'warning', code: 'missing-rule', message: 'Temporal rule ' + id + ' does not exist — Kazoo skips it.' });
				return;
			}
			if (doc) {
				temporal.lintRule(doc, { timezone: tz }).forEach(function(issue) {
					if (issue.level === 'info') { return; }
					node.issues.push({ level: issue.level, code: 'rule-' + issue.code, message: (doc.name || id) + ': ' + issue.message });
				});
			}
		});
		if (isControl) { return; } // control actions don't branch by rule
		// cf_exe:continue(RuleId) with no such child falls back to `_`.
		var hasDefault = keys.indexOf('_') !== -1;
		(data.rules || []).forEach(function(id) {
			if (keys.indexOf(id) === -1 && (get(snap, 'temporal_rules.' + id) || get(snap, 'temporal_rules_sets.' + id))) {
				node.issues.push(hasDefault
					? { level: 'info', code: 'rule-without-branch', message: '"' + (ruleName(snap, id) || id) + '" has no branch of its own — when it matches, calls take the default ("No rule matches") branch, so it changes nothing.' }
					: { level: 'warning', code: 'rule-without-branch', message: '"' + (ruleName(snap, id) || id) + '" has no branch and there is no default — when it matches, Kazoo hangs up (or returns to a calling callflow).' });
			}
		});
	};

	Builder.prototype.addEntry = function(number, cfId, category) {
		var entryId = 'num:' + number;
		this.addNode({ id: entryId, kind: 'entry', module: null, type: category === 'did' ? 'DID' : category.toUpperCase(),
			icon: category === 'did' ? 'phone' : 'callflow', glyph: cfId ? 'call' : 'phone_disabled', role: 'entry',
			label: category === 'did' ? formatNumber(number) : number,
			number: number, category: category, callflowId: cfId || null, media: [], issues: [] });
		if (cfId) {
			var root = this.expandCallflow(cfId);
			if (root) { this.addEdge(entryId, root, { kind: 'entry', key: null, label: 'Destination' }); }
		} else {
			this.nodes[entryId].issues.push({ level: 'info', code: 'unassigned', message: 'This number is not used by any callflow.' });
		}
		return entryId;
	};

	/**
	 * Callflow summaries ({ id: { name, numbers, featurecode } }). With lazy loading the full docs
	 * arrive later, so the light `callflow_list` (from callflow.list) is preferred when present.
	 */
	function callflowSummaries(snap) { return snap.callflow_list || snap.callflows || {}; }

	/** number -> callflow id, from every callflow's `numbers`. */
	function numberIndex(snap) {
		var idx = {}, list = callflowSummaries(snap);
		Object.keys(list).forEach(function(id) {
			(list[id].numbers || []).forEach(function(n) { if (!idx[n]) { idx[n] = id; } });
		});
		return idx;
	}

	/**
	 * Lists every entry point: numbers on callflows plus account numbers nobody routes.
	 * @returns [{ number, callflowId|null, category, label }]
	 */
	function listEntries(snap) {
		var idx = numberIndex(snap), list = callflowSummaries(snap), out = [], seen = {};
		Object.keys(idx).forEach(function(n) {
			seen[n] = true;
			var cf = list[idx[n]], category = cf.featurecode ? 'featurecode' : classifyNumber(n);
			out.push({ number: n, callflowId: idx[n], category: category, kind: category === 'did' ? numberKind(n) : null, label: category === 'did' ? formatNumber(n) : n, name: cf.name || null });
		});
		Object.keys(snap.phone_numbers || {}).forEach(function(n) {
			if (!seen[n]) { out.push({ number: n, callflowId: null, category: 'did', kind: numberKind(n), label: formatNumber(n), name: null }); }
		});
		out.sort(function(a, b) { return a.category === b.category ? (a.number < b.number ? -1 : 1) : (a.category < b.category ? -1 : 1); });
		return out;
	}

	/**
	 * @param {Object} snap     account snapshot
	 * @param {Object} entry    { type: 'did', number } | { type: 'dids', numbers: [] } |
	 *                          { type: 'callflow', id } |
	 *                          { type: 'account', categories?: ['did'], includeUnassigned?: false }
	 *                          (categories also: 'extension', 'featurecode', 'no_match', 'other')
	 * @param {Object} [opts]   { mergeLeaves: true }
	 * @returns {Object} { nodes, edges, roots, issues, timezone }
	 */
	function build(snap, entry, opts) {
		opts = opts || {};
		var b = new Builder(snap), idx = numberIndex(snap), roots = [];
		entry = entry || { type: 'account' };

		if (entry.type === 'callflow') {
			var root = b.expandCallflow(entry.id);
			if (root) { roots.push(root); } else { b.issues.push({ level: 'error', code: 'missing-callflow', message: 'Callflow ' + entry.id + ' does not exist.' }); }
		} else {
			var numbers;
			if (entry.type === 'did') { numbers = [entry.number]; }
			else if (entry.type === 'dids') { numbers = entry.numbers || []; }
			else {
				var cats = entry.categories || ['did'];
				numbers = listEntries(snap).filter(function(e) {
					return cats.indexOf(e.category) !== -1 && (e.callflowId || entry.includeUnassigned);
				}).map(function(e) { return e.number; });
			}
			var summaries = callflowSummaries(snap);
			numbers.forEach(function(n) {
				var cfId = idx[n] || null,
					cat = cfId && (summaries[cfId] || {}).featurecode ? 'featurecode' : classifyNumber(n);
				roots.push(b.addEntry(n, cfId, cat));
			});
		}

		var graph = { nodes: b.nodes, edges: b.edges, roots: roots, issues: b.issues, timezone: get(snap, 'account.timezone', 'UTC') };
		if (opts.mergeLeaves !== false) { mergeEquivalentLeaves(graph); }
		return graph;
	}

	/**
	 * Merges leaf module nodes (no outgoing edges) that do exactly the same thing — e.g. the
	 * same voicemail box reached from twenty callflows. Safe: a leaf has no downstream behaviour,
	 * so merging cannot change any path. Non-leaf nodes are never merged, because in Kazoo the
	 * same user can fall through differently in different callflows.
	 */
	function mergeEquivalentLeaves(graph) {
		var hasOut = {}, canon = {}, replace = {};
		graph.edges.forEach(function(e) { hasOut[e.from] = true; });
		Object.keys(graph.nodes).sort().forEach(function(id) {
			var n = graph.nodes[id];
			// Never merge a callflow's root: jumps target it, and it must stay "in" its callflow.
			if (n.kind !== 'module' || hasOut[id] || n.path === '') { return; }
			var key = n.module + '|' + JSON.stringify(n.data || {});
			if (canon[key]) { replace[id] = canon[key]; } else { canon[key] = id; }
		});
		Object.keys(replace).forEach(function(id) {
			var keep = graph.nodes[replace[id]];
			keep.mergedFrom = (keep.mergedFrom || []).concat(id);
			delete graph.nodes[id];
		});
		graph.edges.forEach(function(e) { if (replace[e.to]) { e.to = replace[e.to]; } });
		return graph;
	}

	/* ---------------------------------------------------------------------------------------- *
	 * Focus: what a node reaches, and what reaches it ("Click any step")
	 * ---------------------------------------------------------------------------------------- */

	function traverse(graph, start, forward) {
		var adj = {}, seen = {}, edgesOut = {}, queue = [start];
		graph.edges.forEach(function(e) {
			var a = forward ? e.from : e.to, b = forward ? e.to : e.from;
			(adj[a] = adj[a] || []).push({ node: b, edge: e.id });
		});
		seen[start] = true;
		while (queue.length) {
			var cur = queue.shift();
			(adj[cur] || []).forEach(function(x) {
				edgesOut[x.edge] = true;
				if (!seen[x.node]) { seen[x.node] = true; queue.push(x.node); }
			});
		}
		return { nodes: Object.keys(seen), edges: Object.keys(edgesOut) };
	}

	function downstream(graph, nodeId) { return traverse(graph, nodeId, true); }
	function upstream(graph, nodeId) { return traverse(graph, nodeId, false); }

	/* ---------------------------------------------------------------------------------------- *
	 * Simulate one call
	 * ---------------------------------------------------------------------------------------- */

	var TERMINAL_STOP = {
		voicemail: 'Caller leaves a voicemail.',
		conference: 'Caller joins the conference.',
		directory: 'Caller searches the directory.',
		faxbox: 'Fax is received.',
		receive_fax: 'Fax is received.',
		disa: 'Caller gets a dial tone (DISA).',
		pivot: 'An external server decides what happens next.',
		response: 'Kazoo sends a response and ends the call.'
	};
	var ANSWERABLE = { user: true, device: true, ring_group: true, page_group: true, qubicle: true, acdc_member: true, offnet: true, resources: true };

	/**
	 * @param {Object} graph   from build()
	 * @param {Object} snap    the same snapshot
	 * @param {Object} sim     {
	 *   start:    node id to start from (an entry or callflow root),
	 *   at:       { local: {...} } | { instant } — when the call arrives (default now),
	 *   outcome:  default for answerable steps: 'answered' | 'no-answer'   (default 'answered'),
	 *   outcomes: { nodeId: 'answered' | 'no-answer' } per-step overrides,
	 *   digits:   { menuNodeId: '1' | 'timeout' | 'invalid' } caller input per menu,
	 *   force:    { ruleId: true|false } simulate rule enable/disable
	 * }
	 * @returns {Object} { steps: [{ nodeId, edgeId, label, detail }], end: { reason, nodeId, detail }, nodes, edges }
	 */
	function simulate(graph, snap, sim) {
		var out = {}, steps = [], visitedNodes = {}, visitedEdges = {}, cur = sim.start, guard = 0,
			stack = [],      // pending "return" edges pushed by callflow jumps (cf_exe flows)
			menuVisits = {},
			jumps = 0,
			maxBranch = sim.maxBranchCount || DEFAULT_MAX_BRANCH_COUNT;
		graph.edges.forEach(function(e) { (out[e.from] = out[e.from] || []).push(e); });
		var edgeByKey = function(id, key) { return (out[id] || []).filter(function(e) { return e.key === key && e.kind !== 'dead'; })[0] || null; };
		var edgeOfKind = function(id, kind) { return (out[id] || []).filter(function(e) { return e.kind === kind; })[0] || null; };

		function finish(reason, nodeId, detail) {
			return { steps: steps, end: { reason: reason, nodeId: nodeId, detail: detail }, nodes: Object.keys(visitedNodes), edges: Object.keys(visitedEdges) };
		}

		while (cur) {
			if (++guard > MAX_SIM_STEPS) { return finish('loop', cur, 'Stopped after ' + MAX_SIM_STEPS + ' steps.'); }
			var node = graph.nodes[cur];
			if (!node) { return finish('error', cur, 'Missing node ' + cur); }
			visitedNodes[cur] = true;
			var step = { nodeId: cur, edgeId: null, label: node.label, type: node.type, detail: null },
				next = null,
				noNext = null; // why the flow has nowhere to go (Kazoo "stops": pops the stack or hangs up)
			steps.push(step);

			if (node.kind === 'entry') {
				next = edgeOfKind(cur, 'entry');
				if (!next) { return finish('unassigned', cur, 'This number is not routed anywhere.'); }
				step.detail = 'Destination';
			} else if (temporalControl(node.module, node.data)) {
				step.detail = TEMPORAL_CONTROL[node.data.action] + ' (' + ((node.data.rules || []).length) + ' rules) — changes the rules, not this call\'s route';
				next = edgeByKey(cur, '_');
				if (!next) { noNext = 'Nothing after this step.'; }
			} else if (node.module === 'temporal_route') {
				var keys = (out[cur] || []).filter(function(e) { return e.kind !== 'dead'; }).map(function(e) { return e.key; }).filter(function(k) { return k !== null; });
				var res = temporal.evaluateRoute({
					node: node.data, childKeys: keys, ruleDocs: snap.temporal_rules || {}, ruleSets: snap.temporal_rules_sets || {},
					accountTimezone: graph.timezone, at: sim.at, force: sim.force
				});
				step.temporal = res;
				if (res.kazooError) {
					return finish('kazoo-error', cur, (res.kazooError.kind === 'hang' ? 'Kazoo hangs here: ' : 'Kazoo fails the call here: ') + res.kazooError.message);
				}
				step.detail = res.matched ? 'Matched "' + (res.matched.name || res.branch) + '"' : 'No rule matches';
				next = edgeByKey(cur, res.branch);
				if (!next && res.branch !== '_') {
					next = edgeByKey(cur, '_'); // cf_exe:continue falls back to the wildcard
					if (next) { step.detail += ' (it has no branch, so the default is used)'; }
				}
				if (!next) { noNext = step.detail + ' — and there is no branch for it.'; }
			} else if (node.module === 'menu') {
				// A key press answers one visit to the menu. Coming back (e.g. "press 9 to repeat")
				// means the caller is choosing again, so wait for a new key.
				menuVisits[cur] = (menuVisits[cur] || 0) + 1;
				var choice = menuVisits[cur] === 1 ? (sim.digits && sim.digits[cur]) : null;
				if (!choice) {
					return finish('awaiting-input', cur, menuVisits[cur] > 1 ? 'Back at the menu — waiting for the caller to press a key.' : 'Waiting for the caller to press a key.');
				}
				if (choice === 'timeout') {
					next = edgeByKey(cur, 'timeout') || edgeByKey(cur, 'max_retries') || edgeByKey(cur, '_');
					step.detail = 'Caller presses nothing';
				} else {
					next = edgeByKey(cur, choice); // cf_exe:attempt — no wildcard fallback
					step.detail = 'Caller presses ' + choice;
					if (!next) {
						// Invalid until retries run out (dial-by-extension hunting is not simulated).
						next = edgeByKey(cur, 'max_retries') || edgeByKey(cur, '_');
						step.detail += ' (invalid) — after retries';
					}
				}
				if (!next) { noNext = step.detail + ' — nothing configured, so Kazoo says goodbye.'; }
			} else if (node.module === 'callflow') {
				var jump = edgeOfKind(cur, 'jump') || edgeOfKind(cur, 'loop');
				if (jump) {
					if (jumps >= maxBranch) {
						return finish('kazoo-limit', cur, 'Kazoo terminates the call after ' + maxBranch + ' callflow jumps (max_branch_count).');
					}
					jumps++;
					var ret = edgeByKey(cur, '_');
					if (ret) { stack.push(ret); } // cf_exe:branch pushes the `_` child
					next = jump;
				} else {
					next = edgeByKey(cur, '_');
					step.detail = 'Target callflow is missing';
					if (!next) { noNext = 'Target callflow is missing and there is nothing after it.'; }
				}
			} else if (ANSWERABLE[node.module]) {
				var missing = (node.issues || []).some(function(i) { return i.code === 'missing-ref'; }),
					outcome = missing ? 'no-answer' : ((sim.outcomes && sim.outcomes[cur]) || sim.outcome || 'answered');
				if (missing) { step.missing = true; }
				// 'live': ring things as they are right now — nobody registered means no answer.
				if (outcome === 'live') {
					outcome = node.presence && node.presence.online === 0 ? 'no-answer' : 'answered';
					if (outcome === 'no-answer') { step.offline = true; }
				}
				if (outcome === 'answered') {
					return finish('answered', cur, (node.module === 'offnet' || node.module === 'resources' ? 'Call goes out to the carrier.' : 'Answered by ' + node.label + '.'));
				}
				next = edgeByKey(cur, '_');
				step.detail = missing ? 'Points at something that no longer exists — Kazoo can\'t ring it'
					: (step.offline ? 'No device registered right now' : 'No answer');
				if (!next) { noNext = step.detail + ', and nothing configured after it.'; }
			} else if (TERMINAL_STOP[node.module]) {
				return finish('terminal', cur, TERMINAL_STOP[node.module]);
			} else {
				next = edgeByKey(cur, '_');
				if (!next) { noNext = 'Nothing after this step.'; }
			}

			if (!next) {
				// cf_exe "stop": resume a pending jump's `_` if there is one, otherwise hang up.
				if (!stack.length) { return finish('ends', cur, noNext + ' The call ends.'); }
				next = stack.pop();
				step.detail = (step.detail ? step.detail + ' · ' : '') + 'Callflow finished — returns to the step after the jump';
				step.returned = true;
			}

			step.edgeId = next.id;
			visitedEdges[next.id] = true;
			cur = next.to;
		}
		return finish('ends', null, 'The call ends.');
	}

	return {
		build: build,
		listEntries: listEntries,
		simulate: simulate,
		upstream: upstream,
		downstream: downstream,
		classifyNumber: classifyNumber,
		isMediaId: isMediaId,
		defaultVmGreeting: defaultVmGreeting,
		numberKind: numberKind,
		formatNumber: formatNumber,
		MODULES: MODULES
	};
}));
