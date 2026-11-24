/**
 * loader.js — fetch-on-demand for the simulator.
 *
 * Start-up only needs the callflow list, the numbers and the account. When the user opens
 * something, `ensure(entry)` fetches exactly the docs that graph needs: the callflows it reaches
 * (following jumps), and everything they reference (users, menus and their greetings, mailboxes,
 * queues, time rules or rule sets, ring-group members...). Everything is cached in the shared
 * snapshot, so nothing is fetched twice.
 *
 *   var loader = crvLoader.create({ snapshot, fetch: function(kind, id, cb) {...} });
 *   loader.ensure({ type: 'callflow', id }, onProgress, function() { graph.build(snapshot, ...) });
 *
 * `fetch(kind, id, cb)` must call cb(null, doc) — or cb(null, null) when the doc doesn't exist.
 * kind is a snapshot collection name: callflows, users, devices, groups, menus, vmboxes, media,
 * temporal_rules, temporal_rules_sets, qubicle_queues, conferences, directories, faxboxes.
 *
 * UMD, ES5, no dependencies.
 */
(function(root, factory) {
	if (typeof define === 'function' && define.amd) {
		define([], factory);
	} else if (typeof module === 'object' && module.exports) {
		module.exports = factory();
	} else {
		root.crvLoader = factory();
	}
}(this, function() {
	'use strict';

	var DEFAULT_CONCURRENCY = 8;

	// Which collection each module's data.id points at.
	var MODULE_REFS = {
		callflow: 'callflows', user: 'users', device: 'devices', menu: 'menus', voicemail: 'vmboxes',
		play: 'media', qubicle: 'qubicle_queues', conference: 'conferences', directory: 'directories',
		faxbox: 'faxboxes', group: 'groups'
	};
	// Fields other modules point at docs with (receive_fax owner, pickup / eavesdrop targets,
	// ring_group_toggle's callflow...) — see modules.js.
	var FIELD_REFS = { owner_id: 'users', user_id: 'users', device_id: 'devices', group_id: 'groups', callflow_id: 'callflows' };
	var ENDPOINT_KINDS = { user: 'users', device: 'devices', group: 'groups' };

	function get(obj, path) {
		var cur = obj, parts = path.split('.');
		for (var i = 0; i < parts.length && cur !== null && cur !== undefined; i++) { cur = cur[parts[i]]; }
		return cur;
	}

	function Loader(opts) {
		this.snap = opts.snapshot;
		this.fetchFn = opts.fetch;
		this.concurrency = opts.concurrency || DEFAULT_CONCURRENCY;
		this.missing = {};   // "kind:id" -> true once Kazoo said it doesn't exist
		this.inflight = {};  // "kind:id" -> [callbacks]
	}

	/** A full doc is cached. List summaries (start-up's device list) are marked `_summary`. */
	function cached(snap, kind, id) { var d = snap[kind] && snap[kind][id]; return d && !d._summary ? d : null; }

	Loader.prototype.has = function(kind, id) {
		return !!cached(this.snap, kind, id) || !!this.missing[kind + ':' + id];
	};

	/** Fetches one doc (deduplicated, cached). cb(doc|null). */
	Loader.prototype.fetchOne = function(kind, id, cb) {
		var self = this, key = kind + ':' + id;
		if (cached(self.snap, kind, id)) { return cb(self.snap[kind][id]); }
		if (self.missing[key]) { return cb(null); }
		if (self.inflight[key]) { self.inflight[key].push(cb); return; }
		self.inflight[key] = [cb];
		self.fetchFn(kind, id, function(err, doc) {
			if (doc) {
				self.snap[kind] = self.snap[kind] || {};
				self.snap[kind][id] = doc;
			} else if (self.snap[kind] && self.snap[kind][id] && self.snap[kind][id]._summary) {
				doc = self.snap[kind][id]; // keep the summary rather than lose the device
			} else {
				self.missing[key] = true;
			}
			var cbs = self.inflight[key];
			delete self.inflight[key];
			cbs.forEach(function(fn) { fn(doc || null); });
		});
	};

	/** Every {kind, id} a callflow's steps reference (not following into other docs yet). */
	function isMediaId(v) { return typeof v === 'string' && /^[0-9a-f]{32}$/i.test(v); }
	function pushMedia(out, v) { if (isMediaId(v)) { out.push({ kind: 'media', id: v }); } }

	function refsOfFlow(flow, out) {
		if (!flow || !flow.module) { return out; }
		var data = flow.data || {}, kind = MODULE_REFS[flow.module];
		if (kind && data.id) { out.push({ kind: kind, id: data.id }); }
		Object.keys(FIELD_REFS).forEach(function(f) { if (typeof data[f] === 'string' && data[f]) { out.push({ kind: FIELD_REFS[f], id: data[f] }); } });
		if (flow.module === 'ring_group' || flow.module === 'page_group') {
			pushMedia(out, data.ringback);
			(data.endpoints || []).forEach(function(ep) {
				var k = ENDPOINT_KINDS[ep.endpoint_type || 'device'];
				if (k && ep.id) { out.push({ kind: k, id: ep.id }); }
			});
		}
		if (flow.module === 'temporal_route') {
			var ids = (data.rules || []).slice();
			Object.keys(flow.children || {}).forEach(function(k) { if (k !== '_') { ids.push(k); } });
			if (data.rule_set) { ids.push(data.rule_set); }
			ids.forEach(function(id) { out.push({ kind: 'rule-or-set', id: id }); });
		}
		Object.keys(flow.children || {}).forEach(function(k) { refsOfFlow(flow.children[k], out); });
		return out;
	}

	/**
	 * The callflow a user's / device's call forward routes to (Kazoo forwards through the
	 * account's own callflows) — same matching as graph.js resolveDialed.
	 */
	function forwardCallflow(snap, doc) {
		if (!snap || !doc) { return null; }
		var cf = doc.call_forward || {}, fo = doc.call_failover || {},
			num = cf.enabled === true ? cf.number : (fo.enabled === true ? (fo.number || cf.number) : null);
		if (!num) { return null; }
		var s = String(num).replace(/[^\d+*#]/g, ''), digits = s.replace(/\D/g, ''), v = [s, digits];
		if (digits.length === 10) { v.push('+1' + digits, '1' + digits); }
		if (digits.length === 11 && digits.charAt(0) === '1') { v.push('+' + digits, digits.slice(1)); }
		var list = snap.callflow_list || snap.callflows || {}, ids = Object.keys(list);
		for (var i = 0; i < v.length; i++) {
			for (var j = 0; j < ids.length; j++) { if ((list[ids[j]].numbers || []).indexOf(v[i]) !== -1) { return ids[j]; } }
		}
		return null;
	}

	/** References a fetched doc leads to (greetings, hold music, queue members, set members...). */
	function refsOfDoc(kind, doc, snap) {
		var out = [];
		if (!doc) { return out; }
		switch (kind) {
			case 'callflows': return refsOfFlow(doc.flow, out);
			case 'menus':
				if (get(doc, 'media.greeting')) { out.push({ kind: 'media', id: doc.media.greeting }); }
				['exit_media', 'invalid_media', 'transfer_media'].forEach(function(k) { pushMedia(out, get(doc, 'media.' + k)); });
				break;
			case 'users':
				pushMedia(out, get(doc, 'music_on_hold.media_id'));
				var ufw = forwardCallflow(snap, doc);
				if (ufw) { out.push({ kind: 'callflows', id: ufw }); }
				break;
			case 'vmboxes':
				if (get(doc, 'media.unavailable')) { out.push({ kind: 'media', id: doc.media.unavailable }); }
				pushMedia(out, get(doc, 'media.temporary_unavailable'));
				if (doc.owner_id) { out.push({ kind: 'users', id: doc.owner_id }); }
				break;
			case 'qubicle_queues':
				if (get(doc, 'hold_treatment.1.play_file')) { out.push({ kind: 'media', id: doc.hold_treatment['1'].play_file }); }
				Object.keys(doc.members || {}).forEach(function(uid) { out.push({ kind: 'users', id: uid }); });
				break;
			case 'temporal_rules_sets':
				(doc.temporal_rules || []).forEach(function(id) { out.push({ kind: 'temporal_rules', id: id }); });
				break;
			case 'devices':
				if (doc.owner_id) { out.push({ kind: 'users', id: doc.owner_id }); }
				pushMedia(out, get(doc, 'music_on_hold.media_id'));
				var dfw = forwardCallflow(snap, doc);
				if (dfw) { out.push({ kind: 'callflows', id: dfw }); }
				break;
			case 'groups':
				Object.keys(doc.endpoints || {}).forEach(function(id) {
					var k = ENDPOINT_KINDS[(doc.endpoints[id] || {}).type || 'device'];
					if (k) { out.push({ kind: k, id: id }); }
				});
				break;
		}
		return out;
	}

	/**
	 * Fetches the closure of `seeds` ({kind, id}[]): each doc, then whatever it references, until
	 * nothing new turns up. A temporal route's ids may be rules or rule sets — tried in that order.
	 */
	Loader.prototype.closure = function(seeds, onProgress, done) {
		var self = this, queue = seeds.slice(), seen = {}, active = 0, fetched = 0, finished = false;
		onProgress = onProgress || function() {};

		function pump() {
			while (active < self.concurrency && queue.length) {
				var job = queue.shift(), key = job.kind + ':' + job.id;
				if (seen[key]) { continue; }
				seen[key] = true;
				active++;
				run(job);
			}
			onProgress(fetched, fetched + active + queue.length);
			if (!active && !queue.length && !finished) { finished = true; done(); }
		}

		function settle(kind, doc) {
			refsOfDoc(kind, doc, self.snap).forEach(function(r) { queue.push(r); });
			fetched++;
			active--;
			pump();
		}

		function run(job) {
			if (job.kind === 'rule-or-set') {
				// When start-up loaded the list of rule sets, we know what each id is — no probing
				// (and no 404s for deleted rules on the sets endpoint).
				var setIds = self.snap.temporal_rules_set_ids;
				if (setIds) {
					var kind = setIds[job.id] ? 'temporal_rules_sets' : 'temporal_rules';
					self.fetchOne(kind, job.id, function(doc) { settle(kind, doc); });
					return;
				}
				self.fetchOne('temporal_rules', job.id, function(rule) {
					if (rule) { return settle('temporal_rules', rule); }
					self.fetchOne('temporal_rules_sets', job.id, function(set) { settle('temporal_rules_sets', set); });
				});
				return;
			}
			self.fetchOne(job.kind, job.id, function(doc) { settle(job.kind, doc); });
		}

		pump();
	};

	/** Callflow ids a graph entry starts from (same entry shape as graph.build). */
	Loader.prototype.seedsFor = function(entry, listEntries) {
		var ids = [];
		if (entry.type === 'callflow') {
			ids = [entry.id];
		} else {
			var numbers = entry.type === 'did' ? [entry.number] : (entry.numbers || null);
			listEntries.forEach(function(e) {
				if (!e.callflowId) { return; }
				if (numbers ? numbers.indexOf(e.number) !== -1 : (entry.categories || ['did']).indexOf(e.category) !== -1) {
					ids.push(e.callflowId);
				}
			});
		}
		return ids.filter(function(id, i) { return ids.indexOf(id) === i; }).map(function(id) { return { kind: 'callflows', id: id }; });
	};

	/**
	 * Makes sure everything `entry` needs is in the snapshot, then calls done().
	 * `listEntries` is graph.listEntries(snapshot), used to map numbers to callflows.
	 */
	Loader.prototype.ensure = function(entry, listEntries, onProgress, done) {
		this.closure(this.seedsFor(entry, listEntries), onProgress, done);
	};

	return {
		create: function(opts) { return new Loader(opts); },
		_refsOfFlow: function(flow) { return refsOfFlow(flow, []); },
		_refsOfDoc: refsOfDoc
	};
}));
