/**
 * details.js — human-readable details for a step, per module (what the Callflows app would show
 * when you open the action), instead of raw JSON.
 *
 *   crvDetails.forNode(node, snapshot, graph) -> {
 *     sections: [{ title, rows?: [{ label, value, media? }]   (settings table, like a Callflows dialog)
 *                  items?: [{ glyph, key?, title, sub?, lines?, cells?, nodeId?, muted? }], columns? }]
 *   media: { role, mediaId } | { role, prompts, language } (Kazoo system prompts) | { role: "tts", speak } (browser preview)
 *   }
 *   crvDetails.ruleSummary(ruleDoc) -> "Mon–Fri · 9:00 AM – 5:00 PM"
 *
 * Never shows secrets (PINs, passwords, SIP credentials). UMD, ES5; uses temporal.js for dates.
 */
(function(root, factory) {
	if (typeof define === 'function' && define.amd) {
		define(['./temporal', './modules'], factory);
	} else if (typeof module === 'object' && module.exports) {
		module.exports = factory(require('./temporal'), require('./modules'));
	} else {
		root.crvDetails = factory(root.crvTemporal, root.crvModules);
	}
}(this, function(temporal, catalog) {
	'use strict';

	var DOW_SHORT = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', wensday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' };
	var DOW_ORDER = { monday: 1, tuesday: 2, wednesday: 3, wensday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };
	var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
	var GREGORIAN_UNIX_OFFSET = 62167219200;
	var SECRET = /pin|pass|secret|token|sip_password|realm_password/i;

	function get(obj, path) {
		var cur = obj, parts = path.split('.');
		for (var i = 0; i < parts.length && cur !== null && cur !== undefined; i++) { cur = cur[parts[i]]; }
		return cur;
	}
	function humanize(s) { return String(s).replace(/_/g, ' ').replace(/^\w/, function(c) { return c.toUpperCase(); }); }
	function yesNo(v) { return v ? 'Yes' : 'No'; }
	function ordinalWord(o) { return humanize(o || 'first'); }

	/** Seconds from midnight -> "9:00 AM". */
	function clock(sec) {
		sec = parseInt(sec, 10) || 0;
		if (sec >= 86400) { return '12:00 AM'; }
		var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
		return ((h % 12) || 12) + ':' + (m < 10 ? '0' : '') + m + ' ' + (h < 12 ? 'AM' : 'PM');
	}

	/** ["monday","tuesday",...] -> "Mon–Fri" or "Mon, Wed, Fri". */
	function daysText(wdays) {
		if (!wdays || !wdays.length) { return 'Every day'; }
		var d = wdays.map(function(w) { return DOW_ORDER[w]; }).filter(Boolean).sort();
		d = d.filter(function(x, i) { return d.indexOf(x) === i; });
		if (d.length === 7) { return 'Every day'; }
		var names = [null, 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], parts = [], start = d[0], prev = d[0];
		for (var i = 1; i <= d.length; i++) {
			if (d[i] === prev + 1) { prev = d[i]; continue; }
			parts.push(start === prev ? names[start] : (prev === start + 1 ? names[start] + ', ' + names[prev] : names[start] + '–' + names[prev]));
			start = prev = d[i];
		}
		return parts.join(', ');
	}

	function dateText(gsec) {
		if (!gsec) { return ''; }
		var dt = new Date((gsec - GREGORIAN_UNIX_OFFSET) * 1000);
		return MONTHS[dt.getUTCMonth()].slice(0, 3) + ' ' + dt.getUTCDate() + ', ' + dt.getUTCFullYear();
	}

	function ymdText(d) { return d ? MONTHS[d.m - 1].slice(0, 3) + ' ' + d.d + ', ' + d.y : ''; }
	function sameDay(a, b) { return !!a && !!b && a.y === b.y && a.m === b.m && a.d === b.d; }

	/**
	 * Plain-language schedule for a temporal rule. opts: { timezone, endDate } — dates are shown in
	 * the route's timezone, and end_date read the way Kazoo reads it (see temporal.endLsecOf).
	 */
	function ruleSummary(doc, opts) {
		if (!doc) { return 'Deleted rule'; }
		opts = opts || {};
		var dates = temporal.ruleDates(doc, opts.timezone || 'UTC', opts.endDate);
		if (dates.manual) {
			return 'Manual switch · ' + (doc.enabled === true || doc.enabled === 'true' ? 'ON'
				: (doc.enabled === false || doc.enabled === 'false' ? 'OFF' : 'no position set (acts as always on)'));
		}
		var start = parseInt(doc.time_window_start, 10), stop = parseInt(doc.time_window_stop, 10),
			hasWindow = !isNaN(start) || !isNaN(stop),
			allDay = !hasWindow || ((isNaN(start) || start <= 0) && (isNaN(stop) || stop >= 86399)),
			time = allDay ? 'all day' : clock(isNaN(start) ? 0 : start) + ' – ' + clock(isNaN(stop) ? 86400 : stop),
			every = parseInt(doc.interval, 10) > 1 ? parseInt(doc.interval, 10) : 1,
			days = (doc.days || []).map(function(x) { return parseInt(x, 10); }),
			when;
		switch (doc.cycle) {
			case 'weekly':
				when = (every > 1 ? 'Every ' + every + ' weeks: ' : '') + daysText(doc.wdays);
				break;
			case 'daily':
				when = every > 1 ? 'Every ' + every + ' days' : 'Every day';
				break;
			case 'date':
				when = dates.start ? ymdText(dates.start) : dateText(doc.start_date);
				if (dates.lastDay && !sameDay(dates.lastDay, dates.start)) { when += ' – ' + ymdText(dates.lastDay); }
				break;
			case 'monthly':
				if (days.length) {
					when = 'Day ' + days.join(', ') + ' of ' + (every > 1 ? 'every ' + every + ' months' : 'every month');
				} else {
					when = (doc.ordinal === 'every' ? 'Every ' : ordinalWord(doc.ordinal) + ' ') +
						((doc.wdays || []).map(function(w) { return DOW_SHORT[w] || w; }).join('/') || '?') +
						(doc.ordinal === 'every' ? '' : ' of ' + (every > 1 ? 'every ' + every + ' months' : 'every month'));
				}
				break;
			case 'yearly':
				var month = MONTHS[(parseInt(doc.month, 10) || 1) - 1];
				if (days.length) {
					when = 'Every ' + month + ' ' + days.join(', ') + (every > 1 ? ' (every ' + every + ' years)' : '');
				} else {
					when = (doc.ordinal === 'every' ? 'Every ' : ordinalWord(doc.ordinal) + ' ') +
						((doc.wdays || []).map(function(w) { return DOW_SHORT[w] || w; }).join('/') || '?') +
						' of ' + month + (every > 1 ? ' (every ' + every + ' years)' : '');
				}
				break;
			default:
				when = 'No schedule';
		}
		var text = when + ' · ' + time;
		if (dates.lastDay && doc.cycle !== 'date') { text += ' · until ' + ymdText(dates.lastDay); }
		if (doc.enabled === true || doc.enabled === 'true') { text = 'Forced ON (ignores schedule) · ' + text; }
		if (doc.enabled === false || doc.enabled === 'false') { text = 'Forced OFF · ' + text; }
		return text;
	}

	/** Where a rule stands right now, for the rules list: { text, status: ok|warn|muted }. */
	function ruleState(doc, opts) {
		var d;
		try { d = temporal.describeRule(doc, { timezone: opts.timezone || 'UTC', endDate: opts.endDate }); } catch (e) { return null; }
		var day = function(w) { return w ? ymdText(w.start) : ''; };
		switch (d.state) {
			case 'active': return { text: 'Now: active', status: 'ok' };
			case 'forced-on': return { text: 'Now: on (' + (d.manual ? 'switched on' : 'forced') + ')', status: 'ok' };
			case 'forced-off': return { text: 'Now: off (' + (d.manual ? 'switched off' : 'forced') + ')', status: 'muted' };
			case 'upcoming': return { text: 'Next: ' + day(d.window), status: 'muted' };
			case 'not-started': return { text: 'Starts ' + day(d.window), status: 'muted' };
			case 'ended': return { text: 'Ended ' + ymdText(d.endedOn), status: 'muted' };
			case 'never': return { text: d.detail, status: 'warn' };
			case 'invalid': case 'error': return { text: d.detail, status: 'warn' };
		}
		return null;
	}

	function edgeFor2(edges, key) { return edges.filter(function(e) { return e.key === key; })[0] || null; }

	/** How to flip a DT manual switch: *<TimeServiceToggle code>*<feature_code_id>. */
	function switchCode(snap, doc) {
		var id = get(doc, 'dimension.feature_code_id'), list = snap.callflow_list || snap.callflows || {}, code = null;
		Object.keys(list).forEach(function(k) {
			var cf = list[k];
			if (cf && cf.name === 'DimensionsFeatureCode_TimeServiceToggle') { code = get(cf, 'featurecode.number') || code; }
		});
		if (id === undefined || id === null || id === '') { return 'Switched with a feature code'; }
		return code ? 'Switch it: dial *' + String(code).replace(/^\*/, '') + '*' + id : 'Switch number ' + id + ' (feature code)';
	}

	function userName(u) {
		if (!u) { return null; }
		var n = ((u.first_name || '') + ' ' + (u.last_name || '')).trim() || u.username || 'User';
		return u.presence_id ? n + ' (' + u.presence_id + ')' : n;
	}

	var DEVICE_GLYPHS = { cellphone: 'smartphone', smartphone: 'smartphone', mobile: 'smartphone', softphone: 'devices',
		fax: 'fax', landline: 'home_work', sip_uri: 'sip', application: 'settop_component', meta: 'devices', sip_device: 'deskphone' };

	function isMediaId(v) { return typeof v === 'string' && /^[0-9a-f]{32}$/i.test(v); }

	/** A settings row for a media reference, with a play button when there is something to play. */
	function mediaRow(snap, label, mediaId, fallback) {
		if (!mediaId) { return { label: label, value: fallback || 'System default' }; }
		var m = get(snap, 'media.' + mediaId);
		var src = m ? ({ upload: 'uploaded file', tts: 'text-to-speech', recording: 'recording' }[m.media_source] || m.media_source || '') : '';
		return { label: label, value: m ? (m.name || 'Media') + (src ? ' (' + src + ')' : '') : 'Deleted media', media: m ? { role: 'play', mediaId: mediaId, label: m.name || label } : null };
	}

	/** Menu media that may be an id, false (off) or absent (Kazoo's default). */
	function optionalMediaRow(snap, label, v) {
		if (v === undefined || v === null) { return null; }
		if (v === false || v === 'false') { return { label: label, value: 'Off' }; }
		if (v === true || v === 'true') { return { label: label, value: 'System default' }; }
		return isMediaId(v) ? mediaRow(snap, label, v) : { label: label, value: String(v) };
	}

	function seconds(v, unit) {
		if (v === undefined || v === null || v === '') { return null; }
		var n = parseInt(v, 10);
		if (isNaN(n)) { return String(v); }
		if (unit === 'ms') { n = Math.round(n / 1000); }
		return n + ' sec';
	}

	function presenceText(snap, deviceIds) {
		var st = snap.device_status;
		if (!st) { return null; }
		var reg = deviceIds.filter(function(id) { return st[id] && st[id].registrable; });
		if (!reg.length) { return null; }
		return reg.filter(function(id) { return st[id].registered; }).length + ' of ' + reg.length + ' online now';
	}

	function devicesOf(snap, userId) {
		return Object.keys(snap.devices || {}).filter(function(id) { return snap.devices[id].owner_id === userId; });
	}

	function deviceItem(snap, id) {
		var d = get(snap, 'devices.' + id), st = snap.device_status && snap.device_status[id];
		if (!d) { return { glyph: 'phone_disabled', title: 'Deleted device', muted: true }; }
		var online = st && st.registrable ? (st.registered ? 'online' : 'offline') : null;
		return { glyph: DEVICE_GLYPHS[d.device_type] || 'deskphone', title: d.name || 'Device',
			sub: humanize(d.device_type || 'device') + (online ? ' · ' + online : ''), status: online };
	}

	function userItem(snap, id) {
		var u = get(snap, 'users.' + id);
		if (!u) { return { glyph: 'person_off', title: 'Deleted user', muted: true }; }
		var f = forwardText(u), item = { glyph: 'person', title: userName(u), sub: presenceText(snap, devicesOf(snap, id)) };
		if (f) { item.lines = [f]; }
		return item;
	}

	/** "Forwards all calls to (845) 555-1234" for a user or device with call forwarding on. */
	function forwardText(doc) {
		if (!doc) { return null; }
		var cf = doc.call_forward || {}, fo = doc.call_failover || {};
		if (cf.enabled === true && cf.number) { return (cf.substitute === false ? 'Also forwards to ' : 'Forwards all calls to ') + phone(cf.number); }
		if (fo.enabled === true && (fo.number || cf.number)) { return 'If offline, forwards to ' + phone(fo.number || cf.number); }
		return null;
	}
	function phone(n) { var m = /^\+?1?(\d{3})(\d{3})(\d{4})$/.exec(String(n).replace(/[^\d+]/g, '')); return m ? '(' + m[1] + ') ' + m[2] + '-' + m[3] : String(n); }

	var FORWARD_MODE = {
		substitute: 'All calls — instead of ringing the phones',
		parallel: 'All calls — rings the phones at the same time',
		failover: 'Only when none of the phones is registered (failover)'
	};

	/** A user's or device's call forward (graph.js forwardOf) and where the forwarded call goes. */
	function forwardSections(node, snap, graph) {
		var f = node.forward;
		if (!f) { return []; }
		var edge = graph ? graph.edges.filter(function(e) { return e.from === node.id && e.kind === 'forward'; })[0] : null,
			target = edge ? graph.nodes[edge.to] : null,
			list = snap.callflow_list || snap.callflows || {},
			cf = f.callflowId ? list[f.callflowId] : null,
			goes = f.external ? 'Outside number — goes out through the carrier'
				: (cf ? 'Routes through the callflow "' + (cf.name || (cf.numbers || [])[0] || f.callflowId) + '"' : null);
		var rows = [
			{ label: f.viaDevice ? 'Rings' : 'Forwards to', value: phone(f.number) },
			{ label: 'When', value: f.viaDevice ? 'Every call to this device' : FORWARD_MODE[f.mode] },
			{ label: 'Where it goes', value: goes },
			{ label: 'Direct calls only', value: f.directOnly ? 'Yes — calls through a ring group or queue aren\'t forwarded' : null },
			{ label: 'Caller must press 1', value: f.keypress ? 'Yes — the person answering presses 1 to accept' : null },
			{ label: 'Caller ID', value: f.viaDevice ? null : (f.keepCallerId ? 'The original caller\'s' : 'This user\'s') }
		];
		var out = [section(f.viaDevice ? 'Rings an outside phone' : 'Call forwarding', rows)];
		if (target) {
			out.push(itemList('Forwarded calls go to', [{ glyph: target.glyph || 'arrow_forward', title: target.label,
				sub: target.type ? humanize(String(target.type).toLowerCase()) : null, nodeId: target.id }]));
		}
		return out;
	}

	function endpointItem(snap, ep) {
		var type = ep.endpoint_type || 'device';
		if (type === 'user') { return userItem(snap, ep.id); }
		if (type === 'group') {
			var g = get(snap, 'groups.' + ep.id);
			return g ? { glyph: 'groups', title: g.name || 'Group', sub: Object.keys(g.endpoints || {}).length + ' members' } : { glyph: 'group_off', title: 'Deleted group', muted: true };
		}
		return deviceItem(snap, ep.id);
	}

	function compact(rows) { return rows.filter(function(r) { return r && r.value !== null && r.value !== undefined && r.value !== ''; }); }

	/** Generic, readable rendering of a step's data (fallback for modules without a recipe). */
	function catalogCtx(snap) {
		return {
			name: function(col, id) { var d = get(snap, col + '.' + id); return d ? (col === 'users' ? (userName(d) || id) : (d.name || id)) : id; },
			num: function(n) { return String(n); },
			cut: function(t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
		};
	}

	function genericRows(data) {
		return Object.keys(data || {}).filter(function(k) { return !SECRET.test(k) && k !== 'id'; }).map(function(k) {
			var v = data[k];
			if (typeof v === 'boolean') { v = yesNo(v); }
			else if (v && typeof v === 'object') { v = Array.isArray(v) ? v.join(', ') : Object.keys(v).map(function(x) { return humanize(x) + ': ' + v[x]; }).join(' · '); }
			return { label: humanize(k), value: String(v) };
		});
	}

	/** A settings table (label -> value), like a Callflows dialog. */
	function section(title, rows) { rows = compact(rows); return rows.length ? { title: title, rows: rows } : null; }
	/** A list of things (endpoints, agents, options, rules): icon, name, detail, optional columns. */
	function itemList(title, items, columns) { return items.length ? { title: title, items: items, columns: columns || null } : null; }

	function promptLanguage(snap) { return String(get(snap, 'account.language') || 'en-us').toLowerCase(); }

	/**
	 * @returns {{ sections: Array }}
	 */
	function forNode(node, snap, graph) {
		var data = node.data || {}, doc = node.ref ? get(snap, node.ref.collection + '.' + node.ref.id) : null, s = [];
		var outgoing = graph ? graph.edges.filter(function(e) { return e.from === node.id && e.kind !== 'dead'; }) : [];
		var targetItem = function(e) {
			var n = graph.nodes[e.to];
			return { glyph: n ? (n.glyph || 'arrow_forward') : 'help', title: n ? n.label : '—', sub: n && n.type ? humanize(String(n.type).toLowerCase()) : null, nodeId: e.to };
		};

		if (node.kind === 'entry') {
			var cf = node.callflowId ? (get(snap, 'callflow_list.' + node.callflowId) || get(snap, 'callflows.' + node.callflowId)) : null;
			var meta = get(snap, 'phone_numbers.' + node.number) || {};
			s.push(section('Number', [
				{ label: 'Number', value: node.label },
				{ label: 'Type', value: ({ did: 'DID', extension: 'Extension', featurecode: 'Feature code', no_match: 'No match (outbound)' }[node.category]) || humanize(node.category) },
				{ label: 'Routed to', value: cf ? (cf.name || 'Callflow') : 'Not used by any callflow' },
				{ label: 'Other numbers on it', value: cf ? (cf.numbers || []).filter(function(n) { return n !== node.number; }).join(', ') : null },
				{ label: 'Features', value: (meta.features || []).join(', ') || null },
				{ label: 'State', value: meta.state ? humanize(meta.state) : null }
			]));
			return { sections: s.filter(Boolean) };
		}

		if (node.skipped) {
			var after = edgeFor2(outgoing, '_');
			s.push(section('Skipped', [
				{ label: 'Kazoo', value: 'Does not run this step (skip is on)' },
				{ label: 'Goes to', value: after ? targetItem(after).title : 'Nothing — the call ends here' }
			]));
		}

		switch (node.module) {
			case 'user':
				var devs = doc ? devicesOf(snap, data.id) : [];
				s.push(section('User', [
					{ label: 'Name', value: doc ? ((doc.first_name || '') + ' ' + (doc.last_name || '')).trim() : 'Deleted user' },
					{ label: 'Extension', value: doc && doc.presence_id },
					{ label: 'Email', value: doc && (doc.email || doc.username) },
					{ label: 'Caller ID', value: doc && get(doc, 'caller_id.external.number') ? (get(doc, 'caller_id.external.name') || '') + ' ' + get(doc, 'caller_id.external.number') : null },
					{ label: 'Rings for', value: seconds(data.timeout) },
					{ label: 'Can call self', value: data.can_call_self !== undefined ? yesNo(data.can_call_self) : null },
					{ label: 'Status now', value: presenceText(snap, devs) },
					doc && get(doc, 'music_on_hold.media_id') ? mediaRow(snap, 'Hold music', get(doc, 'music_on_hold.media_id')) : null
				]));
				s.push(itemList('Rings these devices (' + devs.length + ')', devs.map(function(id) { return deviceItem(snap, id); })));
				s = s.concat(forwardSections(node, snap, graph));
				break;

			case 'device':
				var owner = doc && doc.owner_id ? userName(get(snap, 'users.' + doc.owner_id)) : null;
				s.push(section('Device', [
					{ label: 'Name', value: doc ? doc.name : 'Deleted device' },
					{ label: 'Type', value: doc && humanize(doc.device_type || 'device') },
					{ label: 'Owner', value: owner },
					{ label: 'Rings for', value: seconds(data.timeout) },
					{ label: 'Status now', value: doc ? presenceText(snap, [data.id]) : null },
					doc && get(doc, 'music_on_hold.media_id') ? mediaRow(snap, 'Hold music', get(doc, 'music_on_hold.media_id')) : null
				]));
				s = s.concat(forwardSections(node, snap, graph));
				break;

			case 'external':
				var from = graph ? graph.edges.filter(function(e) { return e.to === node.id && e.kind === 'forward'; }).map(function(e) { return graph.nodes[e.from]; }).filter(Boolean) : [];
				s.push(section('Outside number', [
					{ label: 'Number', value: node.label },
					{ label: 'How', value: 'Kazoo calls it out through the carrier, like any outbound call (the account\'s no-match route)' }
				]));
				var cfs = snap.callflow_list || snap.callflows || {};
				s.push(itemList('Forwarded here by', from.map(function(n) {
					var cfName = n.callflowId && cfs[n.callflowId] ? (cfs[n.callflowId].name || (cfs[n.callflowId].numbers || [])[0]) : null;
					return { glyph: n.glyph || 'person', title: n.label, sub: (n.type ? humanize(String(n.type).toLowerCase()) : '') + (cfName ? ' · in ' + cfName : ''), nodeId: n.id };
				})));
				break;

			case 'ring_group':
			case 'page_group':
				var isRing = node.module === 'ring_group';
				s.push(section(isRing ? 'Ring group' : 'Page group', [
					{ label: 'Name', value: data.name },
					{ label: 'Strategy', value: data.strategy ? (data.strategy === 'simultaneous' ? 'Ring all at once' : data.strategy === 'single' ? 'Ring one at a time' : humanize(data.strategy)) : null },
					{ label: 'Total ring time', value: seconds(data.timeout) },
					{ label: 'Repeats', value: data.repeats > 1 ? data.repeats + ' times' : null },
					isRing ? (isMediaId(data.ringback) ? mediaRow(snap, 'Ringback', data.ringback) : { label: 'Ringback', value: data.ringback ? 'Tone' : 'Default ring' }) : null
				]));
				var eps = data.endpoints || [];
				s.push(itemList((isRing ? 'Rings' : 'Pages') + ' (' + eps.length + ')', eps.map(function(ep) {
					var it = endpointItem(snap, ep);
					if (isRing) { it.cells = [(parseInt(ep.delay, 10) || 0) + ' s', ep.timeout ? parseInt(ep.timeout, 10) + ' s' : '—']; }
					return it;
				}), isRing ? ['Delay', 'Rings for'] : null));
				break;

			case 'menu':
				s.push(section('Auto-attendant', [
					{ label: 'Name', value: doc ? doc.name : 'Deleted menu' },
					doc ? mediaRow(snap, 'Greeting', get(doc, 'media.greeting'), 'System default') : null,
					{ label: 'Waits for input', value: doc ? seconds(doc.timeout, 'ms') : null },
					{ label: 'Retries', value: doc && doc.retries !== undefined ? String(doc.retries) : null },
					{ label: 'Dial by extension', value: doc ? (doc.hunt ? 'Yes' + (doc.hunt_allow ? ' (allowed: ' + doc.hunt_allow + ')' : '') : 'No') : null },
					{ label: 'Max digits', value: doc && doc.max_extension_length ? String(doc.max_extension_length) : null },
					doc ? optionalMediaRow(snap, 'Invalid entry message', get(doc, 'media.invalid_media')) : null,
					doc ? optionalMediaRow(snap, 'Transfer message', get(doc, 'media.transfer_media')) : null,
					doc ? optionalMediaRow(snap, 'Goodbye message', get(doc, 'media.exit_media')) : null
				]));
				var keyOrder = function(k) { var i = '1234567890*#'.indexOf(k); return i === -1 ? 100 + (k === 'timeout' ? 1 : k === 'max_retries' ? 2 : 3) : i; };
				s.push(itemList('Options', outgoing.slice().sort(function(a, b) { return keyOrder(a.key) - keyOrder(b.key); }).map(function(e) {
					var it = targetItem(e), digit = /^[0-9*#]$/.test(e.key);
					it.key = digit ? e.key : e.label;
					it.keyWide = !digit;
					it.label = e.label;
					return it;
				})));
				break;

			case 'voicemail':
				if (data.action === 'check') {
					s.push(section('Check voicemail', [{ label: 'Action', value: 'Caller logs in to listen to messages' }]));
					break;
				}
				var vmOwner = doc && doc.owner_id ? userName(get(snap, 'users.' + doc.owner_id)) : null;
				var greeting = null;
				if (doc) {
					if (doc.skip_greeting === true) { greeting = { label: 'Greeting', value: 'Skipped (caller hears only the beep)' }; }
					else if (get(doc, 'media.unavailable')) { greeting = mediaRow(snap, 'Greeting', get(doc, 'media.unavailable')); }
					else {
						// cf_voicemail's generic greeting: "vm-person" + mailbox number + "vm-not_available".
						greeting = { label: 'Greeting', value: 'System default — "The person at extension ' + (doc.mailbox || '…') + ' is not available"',
							media: { role: 'unavailable', system: true, prompts: ['vm-person', 'vm-not_available'], language: promptLanguage(snap), label: 'Default greeting' } };
					}
				}
				s.push(section('Voicemail box', [
					{ label: 'Name', value: doc ? doc.name : 'Deleted box' },
					{ label: 'Box number', value: doc && doc.mailbox },
					{ label: 'Owner', value: vmOwner },
					greeting,
					doc && get(doc, 'media.temporary_unavailable') ? mediaRow(snap, 'Temporary greeting', get(doc, 'media.temporary_unavailable')) : null,
					{ label: 'Takes messages', value: doc ? (doc.announcement_only === true ? 'No — plays the greeting and hangs up' : 'Yes') : null },
					{ label: 'Transcription', value: doc && doc.transcribe !== undefined ? yesNo(doc.transcribe) : null },
					{ label: 'Email notifications', value: doc && doc.notify_email_addresses && doc.notify_email_addresses.length ? doc.notify_email_addresses.join(', ') : null },
					{ label: 'Delete after emailing', value: doc && doc.delete_after_notify !== undefined ? yesNo(doc.delete_after_notify) : null }
				]));
				break;

			case 'qubicle':
				s.push(section('Queue', [
					{ label: 'Name', value: doc ? (doc.name || doc.queue_name) : 'Deleted queue' },
					{ label: 'Routing', value: doc && doc.queue_router ? humanize(String(doc.queue_router).replace(/^route_/, '')) : null },
					{ label: 'Rings each agent for', value: doc ? seconds(doc.ring_timeout) : null },
					{ label: 'Wrap-up time', value: doc ? seconds(doc.agent_wrapup_time) : null },
					{ label: 'Max wait', value: doc ? seconds(get(doc, 'timeout.seconds')) : null },
					doc ? mediaRow(snap, 'Hold music', get(doc, 'hold_treatment.1.play_file'), 'System default') : null
				]));
				var members = doc ? Object.keys(doc.members || {}) : [];
				s.push(itemList('Agents (' + members.length + ')', members.map(function(id) { return userItem(snap, id); })));
				break;

			case 'temporal_route':
				var tz = data.timezone && data.timezone !== 'inherit' ? data.timezone : get(snap, 'account.timezone');
				var control = data.action && data.action !== 'menu';
				if (control) {
					s.push(section('Feature code', [
						{ label: 'Does', value: { enable: 'Forces these rules ON', disable: 'Forces these rules OFF', reset: 'Returns these rules to their schedule' }[data.action] || humanize(data.action) },
						{ label: 'Timezone', value: tz }
					]));
				} else {
					s.push(section('Time of day', [{ label: 'Timezone', value: tz }, { label: 'Checked', value: 'In order — the first matching rule wins' }]));
				}
				var edgeFor = function(key) { return outgoing.filter(function(e) { return e.key === key; })[0]; };
				// data.rules plus branch keys not listed there (Kazoo checks both, in that order).
				var ruleIds = (data.rules || []).slice();
				outgoing.forEach(function(e) { if (e.key && e.key !== '_' && ruleIds.indexOf(e.key) === -1) { ruleIds.push(e.key); } });
				var ropts = { timezone: tz, endDate: get(snap, 'settings.endDate') || 'exclusive' };
				var ruleItems = ruleIds.map(function(id, i) {
					var set = get(snap, 'temporal_rules_sets.' + id), r = set ? null : get(snap, 'temporal_rules.' + id), e = edgeFor(id), it;
					if (set) {
						it = { glyph: 'event_repeat', title: 'Set: ' + (set.name || id), lines: (set.temporal_rules || []).map(function(rid) {
							var rr = get(snap, 'temporal_rules.' + rid); return (rr ? rr.name + ' — ' : '') + ruleSummary(rr, ropts);
						}) };
					} else {
						var manual = r && temporal.isManual(r);
						it = { glyph: r ? (manual ? 'toggle_on' : 'schedule') : 'error', title: r ? r.name : 'Deleted rule', sub: ruleSummary(r, ropts), muted: !r, lines: [] };
						if (r) {
							var st = ruleState(r, ropts);
							if (st) { it.lines.push(st.text); it.status = st.status; }
							if (manual) { it.lines.push(switchCode(snap, r)); }
						}
					}
					it.key = String(i + 1);
					if (!control) {
						it.cells = [e ? '→ ' + targetItem(e).title : 'No branch — skipped'];
						if (e) { it.nodeId = e.to; }
					}
					return it;
				});
				var other = edgeFor('_');
				if (!control && other) { ruleItems.push({ glyph: 'alt_route', key: '·', title: 'No rule matches', cells: ['→ ' + targetItem(other).title], nodeId: other.to }); }
				s.push(itemList(control ? 'Rules' : 'Rules and where they go', ruleItems));
				break;

			case 'callflow':
				var tcf = doc;
				s.push(section('Go to another callflow', [
					{ label: 'Callflow', value: tcf ? (tcf.name || 'Unnamed') : 'Deleted callflow' },
					{ label: 'Its numbers', value: tcf ? (tcf.numbers || []).join(', ') : null },
					{ label: 'Afterwards', value: outgoing.some(function(e) { return e.key === '_'; }) ? 'Comes back and continues here when it finishes' : 'Ends where that callflow ends' }
				]));
				break;

			case 'play':
				var pm = doc;
				s.push(section('Play', [
					mediaRow(snap, 'Plays', data.id),
					{ label: 'Spoken text', value: pm && get(pm, 'tts.text') },
					{ label: 'Voice', value: pm && get(pm, 'tts.voice') ? humanize(get(pm, 'tts.voice')) : null },
					{ label: 'Repeats until answered', value: data.endless_playback ? 'Yes' : null },
					{ label: 'Caller can skip with', value: data.terminators ? [].concat(data.terminators).join(' ') : null }
				]));
				break;

			case 'tts':
				s.push(section('Say', [
					{ label: 'Text', value: data.text, media: data.text ? { role: 'tts', speak: String(data.text), language: data.language || promptLanguage(snap), label: 'Preview (browser voice)' } : null },
					{ label: 'Voice', value: data.voice ? humanize(data.voice) : null },
					{ label: 'Language', value: data.language },
					{ label: 'Note', value: data.text ? 'The preview uses your browser’s voice; callers hear Kazoo’s.' : null }
				]));
				break;

			case 'conference':
				s.push(section('Conference', [
					{ label: 'Room', value: doc ? doc.name : (data.id ? 'Deleted conference' : 'Conference service (caller enters a room number)') },
					{ label: 'Numbers', value: doc && doc.conference_numbers ? doc.conference_numbers.join(', ') : null },
					{ label: 'Entry tone', value: data.play_entry_tone !== undefined ? yesNo(data.play_entry_tone) : null },
					{ label: 'Exit tone', value: data.play_exit_tone !== undefined ? yesNo(data.play_exit_tone) : null }
				]));
				break;

			case 'directory':
				s.push(section('Dial by name', [
					{ label: 'Directory', value: doc ? doc.name : 'Deleted directory' },
					{ label: 'Searches by', value: doc && doc.sort_by ? humanize(doc.sort_by) + ' name' : null },
					{ label: 'Letters needed', value: doc && doc.min_dtmf ? String(doc.min_dtmf) : null }
				]));
				break;

			case 'offnet':
			case 'resources':
				s.push(section('Outbound', [
					{ label: 'Sends the call to', value: node.module === 'offnet' ? 'The carrier (system resources)' : 'This account’s own carriers' },
					{ label: 'Caller ID used', value: data.caller_id_type ? humanize(data.caller_id_type) : null },
					{ label: 'Destination', value: data.to_did || null },
					{ label: 'Emergency calls only', value: data.emergency ? 'Yes' : null }
				]));
				break;

			case 'pivot':
				// cf_pivot.erl: method (default get), req_format, req_body_format (POST: form|json),
				// req_timeout_ms, debug, cdr_url. On failure or timeout Kazoo continues with `_`.
				var pmethod = String(data.method || 'get').toUpperCase(), pfail = edgeFor2(outgoing, '_');
				s.push(section('Pivot (external server decides)', [
					{ label: 'URL', value: data.voice_url || 'Not set' },
					{ label: 'Method', value: pmethod + (data.method ? '' : ' (default)') },
					{ label: 'Reply format', value: data.req_format ? ({ kazoo: 'Kazoo JSON (callflow)', twiml: 'TwiML (XML)' }[data.req_format] || data.req_format) : 'TwiML (default)' },
					{ label: 'Body format', value: pmethod === 'POST' ? (data.req_body_format === 'json' ? 'JSON' : 'Form') : null },
					{ label: 'Timeout', value: data.req_timeout_ms ? (data.req_timeout_ms / 1000) + ' sec' : (data.req_timeout ? data.req_timeout + ' sec' : null) },
					{ label: 'Debug log', value: data.debug ? 'On' : null },
					{ label: 'Sends call records to', value: data.cdr_url || null },
					{ label: 'If the server fails', value: pfail ? 'Goes to ' + targetItem(pfail).title : 'The call ends' }
				]));
				break;

			case 'prepend_cid':
				s.push(section('Caller ID prefix', data.action === 'reset' ? [{ label: 'Does', value: 'Removes any prefix added earlier' }] : [
					{ label: 'Name prefix', value: data.caller_id_name_prefix },
					{ label: 'Number prefix', value: data.caller_id_number_prefix },
					{ label: 'Applies to', value: data.apply_to ? humanize(data.apply_to) : null }
				]));
				break;

			case 'faxbox':
				s.push(section('Fax box', [
					{ label: 'Name', value: doc ? doc.name : 'Deleted fax box' },
					{ label: 'Emails faxes to', value: doc && get(doc, 'notifications.inbound.email.send_to') ? [].concat(get(doc, 'notifications.inbound.email.send_to')).join(', ') : null }
				]));
				break;

			default:
				var cinfo = catalog.info(node.module), title = node.type ? humanize(String(node.type).toLowerCase()) : humanize(node.module || 'Step');
				var crows = cinfo.rows ? cinfo.rows(data, catalogCtx(snap)).map(function(r) { return { label: r[0], value: r[1] }; }) : genericRows(data);
				if (cinfo.end) { crows.push({ label: 'Then', value: cinfo.end(data, catalogCtx(snap)) }); }
				else if (cinfo.hunts) { crows.push({ label: 'Then', value: cinfo.hunts }); }
				if (cinfo.service) { crows.push({ label: 'Needs', value: cinfo.service + ' (a separate Kazoo service)' }); }
				if (!catalog.known(node.module)) { crows.unshift({ label: 'Module', value: node.module + ' (not one this app knows)' }); }
				s.push(section(title, crows));
				if (cinfo.rows && genericRows(data).length) {
					s.push(section('All settings', genericRows(data)));
				}
		}

		// Named branches the sections above don't list: decisions (match / nomatch, values, fax or
		// voice...) and failure causes (USER_BUSY...).
		if (['menu', 'temporal_route'].indexOf(node.module) === -1) {
			var named = outgoing.filter(function(e) { return e.key && e.key !== '_' && e.kind !== 'forward' && e.kind !== 'pivot'; });
			if (named.length) {
				var other = outgoing.filter(function(e) { return e.key === '_'; })[0];
				s.push(itemList('Branches', named.map(function(e) {
					var it = targetItem(e); return { glyph: e.kind === 'failure' ? 'error' : 'fork_right', title: e.label || e.key, cells: ['→ ' + it.title], nodeId: e.to };
				}).concat(other ? [{ glyph: 'alt_route', title: other.label || 'Otherwise', cells: ['→ ' + targetItem(other).title], nodeId: other.to }] : [])));
			}
		}
		return { sections: s.filter(Boolean) };
	}

	return { forNode: forNode, ruleSummary: ruleSummary, clock: clock, daysText: daysText };
}));
