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
		define(['./temporal', './modules'], factory);
	} else if (typeof module === 'object' && module.exports) {
		module.exports = factory(require('./temporal'), require('./modules'));
	} else {
		root.crvGraph = factory(root.crvTemporal, root.crvModules);
	}
}(this, function(temporal, catalog) {
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
	// Every module's type, icon, colour and `_` meaning lives in modules.js (the catalogue).
	function moduleInfo(name) { return catalog.info(name); }

	/**
	 * Material Symbols glyph per module — DT-Callflows' own `google_icon` values, so steps look
	 * exactly like they do in the Callflows app. "module:action" overrides the catalogue's glyph.
	 */
	var GLYPHS = {
		'prepend_cid:reset': 'change_circle', 'record_call:stop': 'volume_off',
		'call_forward:deactivate': 'phone_paused', 'do_not_disturb:deactivate': 'do_not_disturb_off',
		'ring_group_toggle:logout': 'group_remove', 'acdc_agent:logout': 'logout', 'hotdesk:logout': 'logout',
		'temporal_route:enable': 'schedule', 'temporal_route:disable': 'history_toggle_off', 'temporal_route:reset': 'history',
		'voicemail:check': 'voicemail', 'park:retrieve': 'local_parking'
	};
	var DEVICE_GLYPHS = { cellphone: 'smartphone', smartphone: 'smartphone', mobile: 'smartphone', softphone: 'devices',
		fax: 'fax', landline: 'home_work', sip_uri: 'sip', application: 'settop_component', meta: 'devices' };

	function glyphFor(module, data, doc) {
		if (module === 'device' && doc && DEVICE_GLYPHS[doc.device_type]) { return DEVICE_GLYPHS[doc.device_type]; }
		return GLYPHS[module + ':' + (data && data.action)] || moduleInfo(module).glyph || 'settings';
	}

	/** Routing-only steps (time of day, jumps, caller ID, variables...): drawn as slim pills. */
	function isLogicModule(module) { return !!moduleInfo(module).logic; }

	/** Modules that wait for the caller — a loop through one of these is the caller's choice. */
	function isInputModule(module) { return !!moduleInfo(module).input; }

	/**
	 * What kind of step this is, for colour coding (one colour per family on the canvas):
	 *   bridge   connects the caller to someone: users, devices, groups, queues, conferences...
	 *   outside  leaves the account: carrier (offnet/resources), outside numbers, Pivot
	 *   input    waits for the caller: menus, directory, DTMF collection, DISA
	 *   media    plays something: announcements, text-to-speech
	 *   mailbox  stores a message: voicemail, fax
	 *   end      ends the call: hang up, SIP response, silence
	 *   feature  changes a setting or does something else (feature codes, ...)
	 *   logic    routing only: time of day, jumps, caller-ID... (the slim pills)
	 */
	function familyFor(module, data, role) {
		if (role === 'logic') { return 'logic'; }
		if (temporalControl(module, data) || (module === 'voicemail' && data && data.action === 'check')) { return 'feature'; }
		return moduleInfo(module).family || 'feature';
	}

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

	// cf_exe:maybe_start_cf_module — `skip_module: true` (kz_json:is_true) on any step: Kazoo
	// doesn't run it and continues with its `_` child, exactly as for an unknown module.
	function isSkipped(data) { return !!data && (data.skip_module === true || data.skip_module === 'true'); }

	// How end_date is read (see temporal.endLsecOf). The app sets it from the whitelabel's
	// DT-Callflows temporalRuleEndDateExclusive; Teklink's is exclusive.
	function endDateMode(snap) { return get(snap, 'settings.endDate') || 'exclusive'; }

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

	/**
	 * A user's or device's call forwarding, as Kazoo applies it (kz_endpoint), or null:
	 *   { number, mode: 'substitute' | 'parallel' | 'failover', directOnly, keypress, keepCallerId, viaDevice }
	 * `call_forward.enabled` forwards every call — instead of the phones (substitute, Kazoo's
	 * default) or as well as them. SmartPBX's "Failover" mode is `call_failover.enabled`: it only
	 * forwards when none of the user's devices is registered. Cell phone and landline devices are
	 * themselves a forward to their number.
	 */
	function forwardOf(doc) {
		if (!doc) { return null; }
		var cf = doc.call_forward || {}, fo = doc.call_failover || {}, src = null, mode = null;
		if (cf.enabled === true && cf.number) { src = cf; mode = cf.substitute === false ? 'parallel' : 'substitute'; }
		else if (fo.enabled === true && (fo.number || cf.number)) { src = $extend({}, cf, fo); src.number = fo.number || cf.number; mode = 'failover'; }
		if (!src) { return null; }
		return {
			number: String(src.number).replace(/[^\d+*#]/g, '') || String(src.number), mode: mode,
			directOnly: src.direct_calls_only === true, keypress: src.require_keypress === true, keepCallerId: src.keep_caller_id !== false,
			viaDevice: !!(doc.device_type && /^(cellphone|landline)$/.test(doc.device_type))
		};
	}
	function $extend(a) { for (var i = 1; i < arguments.length; i++) { for (var k in arguments[i]) { if (Object.prototype.hasOwnProperty.call(arguments[i], k)) { a[k] = arguments[i][k]; } } } return a; }

	/** The ways Kazoo may match a dialled number to a callflow: as dialled, then E.164 / 10-digit forms. */
	function dialVariants(num) {
		var s = String(num || ''), digits = s.replace(/\D/g, ''), out = [s];
		if (s.charAt(0) === '+') { out.push(digits); }
		if (digits.length === 10) { out.push('+1' + digits, '1' + digits); }
		if (digits.length === 11 && digits.charAt(0) === '1') { out.push('+' + digits, digits.slice(1)); }
		return out.filter(function(v, i) { return v && out.indexOf(v) === i; });
	}

	/**
	 * Where a forwarded call goes. Kazoo forwards through a loopback into the account's own
	 * callflows, so an extension or one of the account's numbers routes there (another user, a
	 * ring group, a main number...); anything else goes out to the carrier.
	 * @returns { callflowId, number } | null (outside number)
	 */
	function resolveDialed(snap, number) {
		var idx = numberIndex(snap), v = dialVariants(number);
		for (var i = 0; i < v.length; i++) { if (idx[v[i]]) { return { callflowId: idx[v[i]], number: v[i] }; } }
		return null;
	}

	var FORWARD_LABEL = { substitute: 'Forwards all calls', parallel: 'Also forwards to', failover: 'If phones offline' };

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
				out.issues.push({ level: 'info', code: 'pivot', message: 'Routing is decided at call time by an external server — it isn\'t known in advance. "Test this pivot" asks the server what it would answer now.' });
				break;
			case 'prepend_cid':
				out.label = data && data.action === 'reset' ? 'Reset caller ID prefix' : 'Prefix caller ID "' + truncate(data && (data.caller_id_name_prefix || data.caller_id_number_prefix), 24) + '"';
				break;
			default:
				var cinfo = moduleInfo(module), cctx = catalogCtx(snap), cd = data || {};
				if (cinfo.label) { out.label = cinfo.label(cd, cctx); }
				out.sublabel = cinfo.sub ? cinfo.sub(cd, cctx) : (cd.action && !cinfo.label ? humanize(cd.action) : null);
				if (!catalog.known(module)) {
					out.issues.push({ level: 'info', code: 'unknown-module', message: 'Kazoo has no "' + module + '" module that this app knows — it may be custom or from a newer Kazoo. If Kazoo doesn\'t have it either, it skips the step and goes to what comes after it.' });
				}
				if (cinfo.service) {
					out.issues.push({ level: 'info', code: 'needs-service', message: 'Needs ' + cinfo.service + ', a separate Kazoo service. Without it Kazoo skips this step.' });
				}
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
		var info = moduleInfo(module);
		if (key === '_') { return info.decision ? 'Otherwise' : UNDERSCORE_LABEL[info.underscore]; }
		if (info.causes && catalog.isCause(key)) { return catalog.causeLabel(key); }
		if (info.key) { return info.key(key, data || {}); }
		return humanize(key);
	}

	/** Helpers the catalogue's label/rows functions get (see modules.js). */
	function catalogCtx(snap) {
		return {
			name: function(col, id) {
				var d = get(snap, col + '.' + id);
				if (!d) { return id; }
				return col === 'users' ? userName(d) : (d.name || id);
			},
			num: function(n) { return formatNumber(String(n)); },
			cut: truncate
		};
	}

	/* ---------------------------------------------------------------------------------------- *
	 * Build
	 * ---------------------------------------------------------------------------------------- */

	function Builder(snap, opts) {
		this.snap = snap;
		this.opts = opts || {};
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
			this.addNode({ id: rootId, kind: 'module', module: 'empty', type: 'CALLFLOW', icon: 'callflow', glyph: 'alt_route', role: 'logic', family: 'logic',
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

		var refDoc = d.ref ? get(self.snap, d.ref.collection + '.' + d.ref.id) : null,
			role = isLogicModule(module) && !temporalControl(module, data) ? 'logic' : 'call',
			fwd = (module === 'user' || module === 'device') ? forwardOf(refDoc) : null;
		if (fwd) { d.sublabel = (d.sublabel ? d.sublabel + ' · ' : '') + (fwd.mode === 'failover' ? 'If offline → ' : 'Forwards to ') + formatNumber(fwd.number); }
		var skipped = isSkipped(data);
		if (skipped) {
			d.sublabel = 'Skipped' + (d.sublabel ? ' · ' + d.sublabel : '');
			d.issues.push({ level: 'info', code: 'skipped', message: 'Skip is on (skip_module): Kazoo doesn\'t run this step and goes straight to what comes after it.' });
		}
		var node = self.addNode({
			id: id, kind: 'module', module: module, type: info.type, icon: info.icon,
			glyph: glyphFor(module, data, refDoc),
			role: role, family: familyFor(module, data, role),
			label: d.label, sublabel: d.sublabel, callflowId: cfId, path: path,
			data: data, ref: d.ref, media: d.media, issues: d.issues, presence: d.presence || null,
			forward: fwd, skipped: skipped || undefined,
			pivotReply: get(self.snap, 'callflows.' + cfId + '._virtual') ? true : undefined
		});
		self.path.push({ cfId: cfId, module: module });

		if (fwd && !skipped) { self.addForward(node, fwd); }

		// A pivot tested from the details panel: draw the server's reply after it.
		var replyCf = module === 'pivot' && !skipped && self.opts.pivotReplies && self.opts.pivotReplies[id];
		if (replyCf) {
			var replyRoot = self.expandCallflow(replyCf);
			if (replyRoot) { self.addEdge(id, replyRoot, { kind: 'pivot', key: null, label: 'Test reply' }); }
		}

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
					callerDriven = startAt !== -1 && self.path.slice(startAt).some(function(p) { return isInputModule(p.module); });
				}
				self.addEdge(id, target, {
					kind: looping ? 'loop' : 'jump', key: null,
					label: skipped ? 'Skipped' : (looping ? (callerDriven ? 'Back to start' : 'Loops back') : 'Goes to'),
					callerDriven: looping ? callerDriven : undefined,
					inactive: skipped || undefined
				});
				if (looping && !callerDriven && !skipped) {
					node.issues.push({ level: 'warning', code: 'loop', message: 'This jump loops back with no caller choice in between — Kazoo gives up after 50 jumps.' });
				}
			}
		}

		// cf_menu: `_` is unreachable when a `max_retries` child exists.
		var menuUnderscoreDead = module === 'menu' && keys.indexOf('max_retries') !== -1;

		keys.forEach(function(key) {
			var childPath = path === '' ? key : path + '/' + key,
				childId = self.walk(children[key], cfId, childPath),
				// A skipped step goes to `_` whatever it is — even after voicemail or a menu.
				dead = !skipped && key === '_' && (info.underscore === 'terminal' || menuUnderscoreDead),
				kind = dead ? 'dead' : (key === '_' ? (skipped ? 'continue' : info.underscore) : (info.causes && catalog.isCause(key) ? 'failure' : 'branch')),
				label = dead ? 'Never runs' : edgeLabel(module, key, data, self.snap);
			if (module === 'callflow' && key === '_') {
				label = jumpTargetExists ? 'When it finishes' : 'Target missing — continues';
			}
			if (skipped) { label = key === '_' ? 'Skipped — goes here' : label + ' (skipped)'; }
			var edge = self.addEdge(id, childId, { kind: kind, key: key, label: label, inactive: (skipped && key !== '_') || undefined });
			if (module === 'temporal_route' && key !== '_' && !temporalControl(module, data)) { edge.ruleId = key; }
			if (dead) {
				node.issues.push({ level: 'warning', code: 'dead-branch', message: info.causes
					? 'Kazoo never goes to the next step after an outbound call: when it fails, Kazoo only takes a branch named after the failure (for example USER_BUSY or NO_ANSWER); otherwise the call ends.'
					: (menuUnderscoreDead ? 'The "' + key + '" branch can never be reached.' : 'The "' + key + '" branch can never be reached — the call doesn\'t come back from this step.') });
			}
		});

		if (module === 'temporal_route') { self.lintTemporal(node, data, keys, !!temporalControl(module, data)); }
		self.path.pop();
		return id;
	};

	/**
	 * Draws a user's / device's call forward: an edge to the callflow the number routes to (an
	 * extension, another user, one of the account's numbers) or to an outside-number step.
	 */
	Builder.prototype.addForward = function(node, fwd) {
		var target = resolveDialed(this.snap, fwd.number),
			label = fwd.viaDevice ? 'Rings' : FORWARD_LABEL[fwd.mode];
		if (target) {
			var looping = this.stack.indexOf(target.callflowId) !== -1,
				root = this.expandCallflow(target.callflowId);
			if (root) {
				fwd.callflowId = target.callflowId;
				this.addEdge(node.id, root, { kind: 'forward', key: null, label: label, forwardMode: fwd.mode, loops: looping || undefined });
				if (looping) {
					node.issues.push({ level: 'warning', code: 'forward-loop', message: 'Call forward to ' + fwd.number + ' routes back into the same callflow — the call loops until Kazoo gives up.' });
				}
				return;
			}
		}
		var extId = 'ext:' + fwd.number;
		this.addNode({ id: extId, kind: 'module', module: 'external', type: 'OUTSIDE NUMBER', icon: 'offnet', glyph: 'call_made',
			role: 'call', family: 'outside', label: formatNumber(fwd.number), sublabel: 'Through the carrier',
			number: fwd.number, data: { number: fwd.number }, media: [], issues: [] });
		fwd.external = true;
		this.addEdge(node.id, extId, { kind: 'forward', key: null, label: label, forwardMode: fwd.mode });
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
				temporal.lintRule(doc, { timezone: tz, endDate: endDateMode(snap) }).forEach(function(issue) {
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
			icon: category === 'did' ? 'phone' : 'callflow', glyph: cfId ? 'call' : 'phone_disabled', role: 'entry', family: 'entry',
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
		var b = new Builder(snap, opts), idx = numberIndex(snap), roots = [];
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

	// Where the simulated call stops; the other modules' endings are in modules.js (`end`).
	var TERMINAL_STOP = {
		voicemail: 'Caller leaves a voicemail.',
		pivot: 'An external server decides what happens next.'
	};
	var ANSWERABLE = { user: true, device: true, ring_group: true, page_group: true, qubicle: true, acdc_member: true, offnet: true, resources: true, external: true };

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
	 *   callerId: the caller's number, for caller-ID checks (check_cid); optional
	 * }
	 * Steps decided at call time (check_cid without callerId, branch_variable, fax_detect, ...) read
	 * their branch from `digits` too; until one is chosen the call stops with 'awaiting-choice' and
	 * end.choices = [{ key, label }].
	 * @returns {Object} { steps: [{ nodeId, edgeId, label, detail }], end: { reason, nodeId, detail }, nodes, edges }
	 */
	/**
	 * cf_check_cid with a known caller number: regex match -> "match" (or, in absolute mode, the
	 * branch named after the number); no match -> "nomatch"; either missing -> `_`. Kazoo's
	 * regexes are PCRE; JavaScript reads the usual ones the same way. null = can't tell.
	 */
	function cidBranch(node, callerId, live) {
		if (node.module !== 'check_cid' || !callerId) { return null; }
		var d = node.data || {}, matched;
		try { matched = new RegExp(d.regex || '.*').test(String(callerId)); } catch (e) { return null; }
		var has = function(k) { return live.some(function(e) { return e.key === k; }); };
		if (matched) {
			var want = d.use_absolute_mode === true || d.use_absolute_mode === 'true' ? String(callerId) : 'match';
			return has(want) ? want : '_';
		}
		return has('nomatch') ? 'nomatch' : '_';
	}

	function simulate(graph, snap, sim) {
		var out = {}, steps = [], visitedNodes = {}, visitedEdges = {}, cur = sim.start, guard = 0,
			stack = [],      // pending "return" edges pushed by callflow jumps (cf_exe flows)
			menuVisits = {},
			jumps = 0,
			maxBranch = sim.maxBranchCount || DEFAULT_MAX_BRANCH_COUNT;
		graph.edges.forEach(function(e) { (out[e.from] = out[e.from] || []).push(e); });
		var edgeByKey = function(id, key) { return (out[id] || []).filter(function(e) { return e.key === key && e.kind !== 'dead'; })[0] || null; };
		var edgeOfKind = function(id, kind) { return (out[id] || []).filter(function(e) { return e.kind === kind; })[0] || null; };

		function finish(reason, nodeId, detail, extra) {
			var end = { reason: reason, nodeId: nodeId, detail: detail };
			for (var k in extra || {}) { if (Object.prototype.hasOwnProperty.call(extra, k)) { end[k] = extra[k]; } }
			return { steps: steps, end: end, nodes: Object.keys(visitedNodes), edges: Object.keys(visitedEdges) };
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
			} else if (node.skipped) {
				step.detail = 'Skipped (skip is on) — Kazoo goes straight to what comes after it';
				step.skipped = true;
				next = edgeByKey(cur, '_');
				if (!next) { noNext = 'Skipped, and nothing comes after it.'; }
			} else if (temporalControl(node.module, node.data)) {
				step.detail = TEMPORAL_CONTROL[node.data.action] + ' (' + ((node.data.rules || []).length) + ' rules) — changes the rules, not this call\'s route';
				next = edgeByKey(cur, '_');
				if (!next) { noNext = 'Nothing after this step.'; }
			} else if (node.module === 'temporal_route') {
				var keys = (out[cur] || []).filter(function(e) { return e.kind !== 'dead'; }).map(function(e) { return e.key; }).filter(function(k) { return k !== null; });
				var res = temporal.evaluateRoute({
					node: node.data, childKeys: keys, ruleDocs: snap.temporal_rules || {}, ruleSets: snap.temporal_rules_sets || {},
					accountTimezone: graph.timezone, at: sim.at, force: sim.force, endDate: endDateMode(snap)
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
			} else if (moduleInfo(node.module).decision) {
				// Decided at call time by something we can't see: the caller's number (unless given),
				// a variable, fax tones, a spam score... cf_exe:continue/attempt, then `_`.
				var live = (out[cur] || []).filter(function(e) { return e.kind !== 'dead' && e.key !== null; }),
					pick = (sim.digits && sim.digits[cur]) || cidBranch(node, sim.callerId, live);
				if (!pick) {
					return finish('awaiting-choice', cur, 'Kazoo decides this when the call comes in — pick which way it goes.', {
						choices: live.map(function(e) { return { key: e.key, label: e.label || e.key }; })
					});
				}
				next = edgeByKey(cur, pick);
				step.detail = next ? next.label || pick : pick;
				if (!next && pick !== '_') { next = edgeByKey(cur, '_'); if (next) { step.detail += ' — no branch for it, so "Otherwise"'; } }
				if (!next) { noNext = step.detail + ' — and nothing configured for it.'; }
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
			} else if (ANSWERABLE[node.module] || moduleInfo(node.module).answer) {
				var missing = (node.issues || []).some(function(i) { return i.code === 'missing-ref'; }),
					outcome = missing ? 'no-answer' : ((sim.outcomes && sim.outcomes[cur]) || sim.outcome || 'answered');
				if (missing) { step.missing = true; }
				// 'live': ring things as they are right now — nobody registered means no answer.
				if (outcome === 'live') {
					outcome = node.presence && node.presence.online === 0 ? 'no-answer' : 'answered';
					if (outcome === 'no-answer') { step.offline = true; }
				}
				// Call forward: all calls (substitute), when nobody picks up the phones it rings
				// alongside (parallel), or only when no phone is registered (failover).
				var fwdEdge = missing ? null : edgeOfKind(cur, 'forward'), fwd = node.forward;
				if (fwdEdge && fwd && (fwd.mode === 'substitute' || (fwd.mode === 'parallel' && outcome !== 'answered') || (fwd.mode === 'failover' && step.offline))) {
					step.detail = (fwd.viaDevice ? 'Rings ' : 'Forwarded to ') + formatNumber(fwd.number) +
						(fwd.mode === 'failover' ? ' — no phone registered' : (fwd.mode === 'parallel' ? ' — rang their phones too' : ''));
					step.forwarded = true;
					// If the forwarded call isn't answered, Kazoo carries on after this step.
					var after = edgeByKey(cur, '_');
					if (after) { stack.push(after); }
					next = fwdEdge;
				} else if (outcome === 'answered') {
					return finish('answered', cur, node.module === 'offnet' || node.module === 'resources' ? 'Call goes out to the carrier.'
						: (node.module === 'external' ? 'Answered at ' + node.label + ' (outside number).' : 'Answered by ' + node.label + '.'));
				}
				if (!next) {
					// cf_util:handle_bridge_failure: a branch named after the failure cause first.
					var causeEdge = moduleInfo(node.module).causes && !missing ? edgeByKey(cur, 'NO_ANSWER') : null;
					next = causeEdge || edgeByKey(cur, '_');
					step.detail = missing ? 'Points at something that no longer exists — Kazoo can\'t ring it'
						: (step.offline ? 'No device registered right now' : 'No answer');
					if (causeEdge) { step.detail += ' — takes the "' + causeEdge.label + '" branch'; }
					if (!next) {
						noNext = moduleInfo(node.module).underscore === 'terminal'
							? step.detail + '. After a failed outbound call Kazoo only continues on a branch named after the failure, and there is none'
							: step.detail + ', and nothing configured after it';
						noNext += '.';
					}
				}
			} else if (node.module === 'pivot' && edgeOfKind(cur, 'pivot')) {
				// A reply from "Test this pivot". cf_exe:continue_with_flow replaces this callflow's
				// remaining steps with it, but keeps pending jump returns (the flow stack).
				step.detail = 'The server\'s test reply takes over from here';
				next = edgeOfKind(cur, 'pivot');
			} else if (TERMINAL_STOP[node.module] || moduleInfo(node.module).end) {
				return finish('terminal', cur, TERMINAL_STOP[node.module] || moduleInfo(node.module).end(node.data || {}, catalogCtx(snap)));
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
		forwardOf: forwardOf,
		resolveDialed: resolveDialed,
		familyFor: familyFor,
		MODULES: catalog
	};
}));
