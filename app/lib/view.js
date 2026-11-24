/**
 * view.js — the visualizer UI.
 *
 * Built on DT-Callflows' own markup (#callflow_container, .left-bar-container, li.list-element,
 * .entity-header, .search-box, .monster-button) so that DT-Callflows' stylesheet and the
 * Dimensions overrides style it exactly like the Callflows app — no second copy of that styling.
 *
 *   crvView.mount($root, {
 *     snapshot,                       // shared cache: account, callflow_list, phone_numbers, ...
 *     ensure: function(entry, onProgress, done) {},  // fetch what `entry` needs (lazy loading);
 *                                     // omit when the snapshot is already complete
 *     i18n, now: function() -> ms,
 *     mediaUrl:  function(mediaId) -> url|null,          // an account media file
 *     promptUrl: function(promptId, lang) -> url|null,   // a Kazoo system prompt (en-us/vm-person)
 *     pickers: { date: fn($input, onChange(y, m, d)) -> { set(at) },
 *                time: fn($input, onChange(hour, minute)) -> { set(at) } }
 *                                     // Monster's own pickers; native inputs when omitted
 *   });
 *
 * UMD, ES5.
 */
(function(root, factory) {
	if (typeof define === 'function' && define.amd) {
		define(['jquery', './graph', './temporal', './canvas', './details'], factory);
	} else {
		root.crvView = factory(root.jQuery, root.crvGraph, root.crvTemporal, root.crvCanvas, root.crvDetails);
	}
}(this, function($, crvGraph, crvTemporal, crvCanvas, crvDetails) {
	'use strict';

	var EN = {
		title: 'Call Routing',
		search: 'Search...',
		modeNumbers: 'Numbers', modeCallflows: 'Callflows', modeAccount: 'Whole account',
		filterAll: 'All', filterLocal: 'Local', filterTollfree: 'Toll-free', filterInternational: 'International', unassigned: 'Not assigned to a callflow',
		listEmpty: 'Nothing matches.',
		pickSomething: 'Pick a number or callflow on the left to see where its calls go.',
		empty: 'Nothing to show.',
		loading: 'Loading', loadFailed: 'Could not load this account\'s call routing.',
		fit: 'Fit to screen', zoomIn: 'Zoom in', zoomOut: 'Zoom out', direction: 'Switch between left-to-right and top-to-bottom',
		simulation: 'Simulate a call',
		simHint: 'Pick when the call comes in. The path it takes lights up — press keys on a menu\'s keypad to choose.',
		simNeedsStart: 'Pick one number or callflow — or click a number on the map — to simulate a call to it.',
		accountSearch: 'Find on the map...', accountNoMatch: 'Nothing on the map matches.',
		date: 'Date', time: 'Time', now: 'Now', nowHint: 'Set the date and time to right now',
		currentOnly: 'Hide routes this call doesn\'t take',
		outcome: 'When phones ring', answered: 'Someone answers', noAnswer: 'Nobody answers',
		live: 'Right now', liveHint: 'Uses each phone\'s real status right now: users whose phones are all offline don\'t answer.',
		callPath: 'Call path', reset: 'Start over', noInput: 'Caller presses nothing',
		details: 'Details', close: 'Close',
		problems: 'Problems', noProblems: 'No problems found here.',
		media_greeting: 'Greeting', media_unavailable: 'Greeting', media_hold: 'Hold music', media_play: 'Play', media_ringback: 'Ringback', media_tts: 'Listen',
		nowPlaying: 'Playing', stop: 'Stop', playFailed: 'Could not play this recording.', speechUnavailable: 'This browser cannot preview text-to-speech.',
		browserVoice: 'Browser voice preview', systemPrompt: 'Kazoo system prompt',
		press: 'Press', notSet: 'Not set', keypad: 'Keypad', noInputShort: 'No input',
		noAudio: 'Audio playback is not available here.',
		timezone: 'Times are in',
		exportPdf: 'Export PDF', exportHint: 'Opens a print view — choose "Save as PDF" to share it with someone who can\'t log in.',
		exportTitle: 'Call routing', exportAccount: 'Account', exportShowing: 'Showing', exportSimulated: 'Simulated call',
		exportGenerated: 'Generated', exportNothing: 'Pick something to export first.'
	};

	var WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
	// Numbers mode lists DIDs only (extensions and feature codes are reached through Callflows).
	// Unassigned DIDs are listed under All only, after the assigned ones.
	var FILTERS = [['all', 'filterAll'], ['local', 'filterLocal'], ['tollfree', 'filterTollfree'], ['international', 'filterInternational']];

	function esc(s) {
		return String(s === null || s === undefined ? '' : s)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}
	function pad2(n) { return (n < 10 ? '0' : '') + n; }
	function ymd(d) { return d.y + '-' + pad2(d.m) + '-' + pad2(d.d); }
	function jsDay(d) { return new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay(); }
	function norm(s) { return String(s || '').toLowerCase().replace(/[()\s.+-]/g, ''); }
	function clockText(sec) { sec = Math.max(0, Math.floor(sec || 0)); return Math.floor(sec / 60) + ':' + pad2(sec % 60); }

	/** Plain browser inputs, for when the host (the preview page) has no Monster pickers. */
	var NATIVE_PICKERS = {
		date: function($input, onChange) {
			$input.attr('type', 'date').on('change', function() {
				var v = (this.value || '').split('-');
				if (v.length === 3) { onChange(+v[0], +v[1], +v[2]); }
			});
			return { set: function(at) { $input.val(ymd(at)); } };
		},
		time: function($input, onChange) {
			$input.attr('type', 'time').on('change', function() {
				var v = (this.value || '').split(':');
				if (v.length >= 2) { onChange(+v[0], +v[1]); }
			});
			return { set: function(at) { $input.val(pad2(at.hour) + ':' + pad2(at.minute)); } };
		}
	};

	function View($root, opts) {
		this.$root = $root;
		this.snap = opts.snapshot;
		this.ensureFn = opts.ensure || null;
		this.i18n = $.extend({}, EN, opts.i18n || {});
		this.mediaUrl = opts.mediaUrl || function() { return null; };
		this.promptUrl = opts.promptUrl || function() { return null; };
		this.pickers = $.extend({}, NATIVE_PICKERS, opts.pickers || {});
		this.playing = null;
		this.nowMs = opts.now || function() { return Date.now(); };
		this.tz = (this.snap.account && this.snap.account.timezone) || 'UTC';
		this.entries = crvGraph.listEntries(this.snap);
		this.graph = { nodes: {}, edges: [], roots: [], issues: [], timezone: this.tz };
		this.loadToken = 0;
		this.state = {
			mode: 'numbers', filter: 'all', query: '', selected: null,
			simStart: null, at: null, outcome: 'answered', digits: {}, hideOffPath: false,
			selectedNode: null, direction: 'LR'
		};
		this._render();
	}

	View.prototype.t = function(k) { return this.i18n[k] || k; };

	/* ---------------------------------- layout ----------------------------------------- */

	View.prototype._render = function() {
		var self = this, t = function(k) { return esc(self.t(k)); };
		self.$root.attr('id', 'callflow_container').addClass('crv-app').html(
			'<div class="callflow-edition callflow-app-section">' +
			'<div class="callflow-manager">' +
				'<div class="left-bar-container">' +
					'<div class="embedded-list-title"><div class="entity-title crv-list-title"></div></div>' +
					'<div class="crv-filters"></div>' +
					'<div class="list-container clearfix"><ul class="list crv-list"></ul></div>' +
				'</div>' +
				'<div class="callflow-content edition-mode">' +
					'<div class="entity-header">' +
						'<div class="search-box"><i class="material-symbols-icon-search-small">search</i><input type="text" class="search-query crv-search" placeholder="' + t('search') + '"></div>' +
						'<div class="crv-mode"><select class="crv-mode__select" aria-label="' + t('title') + '">' +
							'<option value="numbers">' + t('modeNumbers') + '</option>' +
							'<option value="callflows">' + t('modeCallflows') + '</option>' +
							'<option value="account">' + t('modeAccount') + '</option>' +
						'</select></div>' +
						'<div class="buttons crv-header-buttons">' +
							'<span class="crv-tz">' + t('timezone') + ' ' + esc(self.tz) + '</span>' +
							'<button type="button" class="monster-button monster-button-primary crv-export" title="' + t('exportHint') + '">' + t('exportPdf') + '</button>' +
						'</div>' +
					'</div>' +
					'<div class="callflow-view clearfix">' +
						'<div class="real-content crv-body">' +
							'<div class="crv-main">' +
								'<div class="crv-canvas-host"></div>' +
								'<div class="crv-busy" hidden><span class="crv-busy__dots"></span><span class="crv-busy__text"></span></div>' +
								'<div class="crv-zoom">' +
									'<button type="button" data-zoom="in" data-alt="+" title="' + t('zoomIn') + '"><span class="crv-glyph-sm">zoom_in</span></button>' +
									'<button type="button" data-zoom="out" data-alt="−" title="' + t('zoomOut') + '"><span class="crv-glyph-sm">zoom_out</span></button>' +
									'<button type="button" data-zoom="fit" data-alt="⤢" title="' + t('fit') + '"><span class="crv-glyph-sm">fit_screen</span></button>' +
									'<button type="button" data-zoom="dir" data-alt="⇄" title="' + t('direction') + '"><span class="crv-glyph-sm">swap_calls</span></button>' +
								'</div>' +
								'<div class="crv-player" hidden role="status" aria-live="polite">' +
									'<span class="crv-player__eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>' +
									'<div class="crv-player__info"><div class="crv-player__title"></div><div class="crv-player__bar" title=""><span></span></div></div>' +
									'<span class="crv-player__time"></span>' +
									'<button type="button" class="crv-player__stop" data-alt="■" title="' + t('stop') + '" aria-label="' + t('stop') + '"><span class="crv-glyph-sm">stop</span></button>' +
								'</div>' +
							'</div>' +
							'<div class="crv-side">' +
								'<section class="crv-panel crv-sim"></section>' +
								'<section class="crv-panel crv-details" hidden></section>' +
								'<section class="crv-panel crv-problems"></section>' +
							'</div>' +
						'</div>' +
					'</div>' +
				'</div>' +
			'</div>' +
			'</div>' +
			'<audio class="crv-audio" preload="none"></audio>' +
			'<div class="crv-toast" hidden></div>'
		);

		self.canvas = crvCanvas.create(self.$root.find('.crv-canvas-host'), {
			i18n: self.i18n,
			direction: self.state.direction,
			onNodeClick: function(node) { self._onNodeClick(node); },
			onPlay: function(media, node) { self._play(media, node); },
			onDigit: function(nodeId, key) { self._press(nodeId, key); },
			onBackgroundClick: function() { self.state.selectedNode = null; self._renderDetails(); self._paintState(); }
		});

		self._bind();
		self._setNow();
		self._renderList();
		self._renderSim();
		self._renderProblems();
		self.canvas.render(self.graph, self.t('pickSomething'));
		self._shownKey = 'full';
		self._detectGlyphFont();
	};

	/** DT-Callflows' Material Symbols font may be absent (e.g. app used without it): fall back to sprites. */
	View.prototype._detectGlyphFont = function() {
		var self = this;
		if (!document.fonts || !document.fonts.load) { return; }
		document.fonts.load('24px "Material Symbols Outlined"', 'schedule').then(function(list) {
			self.$root.toggleClass('crv-no-glyphs', !list || !list.length);
		}, function() { self.$root.addClass('crv-no-glyphs'); });
	};

	View.prototype._bind = function() {
		var self = this, $r = self.$root;
		$r.find('.crv-mode__select').on('change', function() { self.setMode(this.value); });
		$r.find('.crv-search').on('input', function() { self.state.query = this.value; self.state.findIndex = -1; if (self.state.mode !== 'account') { self._renderList(); } })
			.on('keydown', function(e) {
				if (self.state.mode === 'account') {
					// No list in the whole-account view: the search finds steps on the map.
					if (e.key === 'Enter') { self._findOnMap(e.shiftKey ? -1 : 1); e.preventDefault(); }
					else if (e.key === 'Escape') { this.value = ''; self.state.query = ''; }
					return;
				}
				if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { self._step(e.key === 'ArrowDown' ? 1 : -1); e.preventDefault(); }
				else if (e.key === 'Enter') { var items = self._items(); if (items.length && !self.state.selected) { self._select(items[0].value); } e.preventDefault(); }
				else if (e.key === 'Escape') { this.value = ''; self.state.query = ''; self._renderList(); }
			});
		$r.on('click', '.crv-list .list-element', function() { self._select($(this).attr('data-value')); });
		$r.on('click', '.crv-filters [data-filter]', function() { self.state.filter = $(this).attr('data-filter'); self._renderList(); });
		$r.on('click', '.crv-zoom [data-zoom]', function() {
			var z = $(this).attr('data-zoom');
			if (z === 'in') { self.canvas.zoomBy(1.25); }
			else if (z === 'out') { self.canvas.zoomBy(0.8); }
			else if (z === 'dir') { self.state.direction = self.state.direction === 'LR' ? 'TB' : 'LR'; self.canvas.setDirection(self.state.direction); self._paintState(); }
			else { self.canvas.fit(); }
		});
		$r.on('click', '.crv-export', function() { self.exportPdf(); });
		$r.on('click', '.crv-details [data-close]', function() { self.state.selectedNode = null; self._renderDetails(); self._paintState(); });
		$r.on('click', '.crv-details [data-dmedia]', function(e) {
			e.stopPropagation();
			var n = self.graph.nodes[self.state.selectedNode];
			self._play((self._detailMedia || [])[+$(this).attr('data-dmedia')], n);
		});
		$r.on('click', '.crv-details [data-node]', function() {
			var id = $(this).attr('data-node');
			if (!self.graph.nodes[id]) { return; }
			self._onNodeClick(self.graph.nodes[id]);
			self.canvas.fit([id]);
		});
		// Player: stop, seek, and the audio element's own events.
		$r.on('click', '.crv-player__stop', function() { self._stop(); });
		$r.on('click', '.crv-player__bar', function(e) {
			var audio = self.$root.find('.crv-audio')[0], p = self.playing;
			if (!p || p.speech || !audio.duration || p.urls.length > 1) { return; }
			var rect = this.getBoundingClientRect();
			audio.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * audio.duration;
		});
		$r.find('.crv-audio')
			.on('timeupdate loadedmetadata', function() { self._paintPlayer(); })
			.on('ended', function() {
				var p = self.playing;
				if (p && !p.speech && p.i < p.urls.length - 1) { p.i++; this.src = p.urls[p.i]; this.play().catch(function() {}); return; }
				self._stop();
			})
			.on('error', function() { if (self.playing && !self.playing.speech) { self._toast(self.t('playFailed')); self._stop(); } });
		$r.on('click', '.crv-problems [data-goto]', function(e) {
			e.preventDefault();
			var id = $(this).attr('data-goto');
			self._onNodeClick(self.graph.nodes[id]);
			self.canvas.fit([id]);
		});
	};

	/* ---------------------------------- left list --------------------------------------- */

	View.prototype.setMode = function(mode) {
		var s = this.state;
		s.mode = mode; s.selected = null; s.simStart = null; s.digits = {}; s.selectedNode = null; s.query = '';
		this.$root.find('.crv-mode__select').val(mode);
		this.$root.toggleClass('crv-mode-account', mode === 'account');
		this.$root.find('.crv-search').val('').attr('placeholder', this.t(mode === 'account' ? 'accountSearch' : 'search'));
		this.graph = { nodes: {}, edges: [], roots: [], issues: [], timezone: this.tz };
		this._renderList();
		if (mode === 'account') { this._open({ type: 'account', categories: ['did'] }); }
		else { this.canvas.render(this.graph, this.t('pickSomething')); this._shownKey = 'full'; this._renderSim(); this._renderProblems(); this._renderDetails(); }
	};

	/** Whole-account view: jump to the next (dir 1) or previous (-1) step on the map matching the search. */
	View.prototype._findOnMap = function(dir) {
		var self = this, s = self.state, q = norm(s.query);
		if (!q) { return; }
		var ids = Object.keys(self.graph.nodes).filter(function(id) {
			var n = self.graph.nodes[id];
			return norm(n.label).indexOf(q) !== -1 || norm(n.sublabel).indexOf(q) !== -1 || norm(n.number).indexOf(q) !== -1;
		});
		if (!ids.length) { self._toast(self.t('accountNoMatch')); return; }
		var i = s.findIndex === undefined || s.findIndex < 0 ? (dir > 0 ? -1 : 0) : s.findIndex;
		s.findIndex = (i + dir + ids.length) % ids.length;
		var id = ids[s.findIndex];
		self._onNodeClick(self.graph.nodes[id]);
		self.canvas.fit([id]);
	};

	/** The items the left list shows for the current mode, filter and search. */
	View.prototype._items = function() {
		var self = this, s = self.state, q = norm(s.query);
		var match = function() { for (var i = 0; i < arguments.length; i++) { if (!q || norm(arguments[i]).indexOf(q) !== -1) { return true; } } return false; };
		if (s.mode === 'callflows') {
			var list = self.snap.callflow_list || self.snap.callflows || {};
			return Object.keys(list).map(function(id) {
				var cf = list[id], nums = (cf.numbers || []);
				return { value: id, title: cf.name || nums[0] || id, description: nums.join(', ') };
			}).filter(function(x) { return match(x.title, x.description); })
				.sort(function(a, b) { return a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1; });
		}
		var dids = self.entries.filter(function(e) {
			return e.category === 'did' && (s.filter === 'all' || (e.callflowId && e.kind === s.filter)) && match(e.number, e.label, e.name);
		});
		// Assigned first, then the unassigned ones (All only).
		return dids.filter(function(e) { return e.callflowId; }).concat(dids.filter(function(e) { return !e.callflowId; })).map(function(e) {
			return { value: e.number, title: e.label, description: e.callflowId ? (e.name || '') : self.t('unassigned'), off: !e.callflowId };
		});
	};

	View.prototype._renderList = function() {
		var self = this, s = self.state, $r = self.$root;
		$r.find('.crv-list-title').text(self.t(s.mode === 'callflows' ? 'modeCallflows' : 'modeNumbers'));
		// Filters (numbers mode only)
		if (s.mode === 'numbers') {
			var counts = { all: 0, local: 0, tollfree: 0, international: 0 };
			self.entries.forEach(function(e) {
				if (e.category !== 'did') { return; }
				counts.all++;
				if (e.callflowId) { counts[e.kind]++; }
			});
			$r.find('.crv-filters').html(FILTERS.filter(function(f) { return f[0] === 'all' || counts[f[0]]; }).map(function(f) {
				return '<button type="button" data-filter="' + f[0] + '" class="' + (s.filter === f[0] ? 'is-active' : '') + '">' + esc(self.t(f[1])) + ' <span>' + counts[f[0]] + '</span></button>';
			}).join('')).prop('hidden', false);
		} else {
			$r.find('.crv-filters').empty().prop('hidden', true);
		}
		var items = self._items();
		$r.find('.crv-list').html(items.length ? items.map(function(x) {
			return '<li class="list-element' + (x.value === s.selected ? ' selected-element' : '') + (x.off ? ' crv-list__off' : '') + '" data-value="' + esc(x.value) + '">' +
				'<div class="link">' + (x.description
					? '<div class="title">' + esc(x.title) + '</div><div class="description">' + esc(x.description) + '</div>'
					: '<div class="title standalone">' + esc(x.title) + '</div>') + '</div></li>';
		}).join('') : '<li class="crv-list__empty">' + esc(self.t('listEmpty')) + '</li>');
	};

	View.prototype._step = function(delta) {
		var items = this._items();
		if (!items.length) { return; }
		var i = -1;
		for (var k = 0; k < items.length; k++) { if (items[k].value === this.state.selected) { i = k; break; } }
		i = Math.max(0, Math.min(items.length - 1, i + delta));
		this._select(items[i].value);
		var el = this.$root.find('.crv-list .selected-element')[0];
		if (el && el.scrollIntoView) { el.scrollIntoView({ block: 'nearest' }); }
	};

	View.prototype._select = function(value) {
		var s = this.state;
		s.selected = value;
		this.$root.find('.crv-list .list-element').each(function() { $(this).toggleClass('selected-element', this.getAttribute('data-value') === value); });
		this._open(s.mode === 'callflows' ? { type: 'callflow', id: value } : { type: 'did', number: value });
	};

	/* ---------------------------------- loading + graph --------------------------------- */

	/** Fetch what `entry` needs (if a loader was given), then build and draw it. */
	View.prototype._open = function(entry) {
		var self = this, token = ++self.loadToken, $busy = self.$root.find('.crv-busy');
		var finish = function() {
			if (token !== self.loadToken) { return; } // the user already picked something else
			$busy.prop('hidden', true);
			self.entries = crvGraph.listEntries(self.snap);
			self.graph = crvGraph.build(self.snap, entry);
			var s = self.state;
			s.simStart = self.graph.roots.length === 1 ? self.graph.roots[0] : null;
			s.digits = {}; s.selectedNode = null;
			self.canvas.render(self.graph, self.t('empty'));
			self._shownKey = 'full';
			self._markPlaying();
			self._renderSim();
			self._renderProblems();
			self._renderDetails();
			self._simulate();
		};
		if (!self.ensureFn) { return finish(); }
		var shown = setTimeout(function() { if (token === self.loadToken) { $busy.prop('hidden', false); } }, 150);
		$busy.find('.crv-busy__text').text(self.t('loading') + '…');
		self.ensureFn(entry, function(done, total) {
			if (token === self.loadToken && total) { $busy.find('.crv-busy__text').text(self.t('loading') + '… ' + done + ' / ' + total); }
		}, function() { clearTimeout(shown); finish(); });
	};

	View.prototype._onNodeClick = function(node) {
		if (!node) { return; }
		var s = this.state;
		s.selectedNode = node.id;
		if (node.kind === 'entry' && s.simStart !== node.id) { s.simStart = node.id; s.digits = {}; this._renderSim(); this._simulate(); }
		this._renderDetails();
		this._paintState();
	};

	/* ---------------------------------- simulation -------------------------------------- */

	View.prototype._setNow = function() {
		var l = crvTemporal._internals.toLocal(this.nowMs(), this.tz);
		this.state.at = { y: l.y, m: l.m, d: l.d, hour: l.hour, minute: l.minute };
	};

	View.prototype._renderSim = function() {
		var self = this, s = self.state, t = function(k) { return esc(self.t(k)); }, $p = self.$root.find('.crv-sim');
		self._simPickers = null;
		if (!s.simStart) {
			$p.html('<h3>' + t('simulation') + '</h3><p class="crv-muted">' + t('simNeedsStart') + '</p>');
			return;
		}
		var hasLive = self.snap.device_status && Object.keys(self.snap.device_status).length;
		$p.html(
			'<h3>' + t('simulation') + '</h3>' +
			'<p class="crv-muted">' + t('simHint') + '</p>' +
			'<div class="crv-when">' +
				'<label class="crv-field"><span>' + t('date') + '</span><input type="text" class="crv-sim__date" autocomplete="off"></label>' +
				'<label class="crv-field"><span>' + t('time') + '</span><input type="text" class="crv-sim__time" autocomplete="off"></label>' +
				'<div class="crv-field crv-field--now"><span>&nbsp;</span><button type="button" class="monster-button monster-button-secondary crv-now" title="' + t('nowHint') + '">' + t('now') + '</button></div>' +
			'</div>' +
			'<input type="range" class="crv-sim__slider" min="0" max="1439" step="5">' +
			'<div class="crv-days">' + WEEKDAY_LETTERS.map(function(l, i) { return '<button type="button" data-day="' + i + '">' + l + '</button>'; }).join('') + '</div>' +
			'<div class="crv-field"><span>' + t('outcome') + '</span><div class="crv-seg">' +
				'<button type="button" data-outcome="answered">' + t('answered') + '</button>' +
				'<button type="button" data-outcome="no-answer">' + t('noAnswer') + '</button>' +
				(hasLive ? '<button type="button" data-outcome="live" title="' + t('liveHint') + '">' + t('live') + '</button>' : '') +
			'</div></div>' +
			'<label class="crv-check"><input type="checkbox" class="crv-sim__hide"> ' + t('currentOnly') + '</label>' +
			'<h4>' + t('callPath') + '</h4><ol class="crv-path"></ol><div class="crv-path__end"></div>' +
			'<button type="button" class="monster-button crv-btn crv-sim__reset">' + t('reset') + '</button>'
		);
		var changed = function() { self._syncSim(); self._simulate(); };
		self._simPickers = {
			date: self.pickers.date($p.find('.crv-sim__date'), function(y, m, d) { $.extend(s.at, { y: y, m: m, d: d }); changed(); }),
			time: self.pickers.time($p.find('.crv-sim__time'), function(h, mi) { s.at.hour = h; s.at.minute = mi; changed(); })
		};
		$p.find('.crv-now').on('click', function() { self._setNow(); changed(); });
		$p.find('.crv-sim__slider').on('input', function() {
			var m = +this.value; s.at.hour = Math.floor(m / 60); s.at.minute = m % 60;
			self._simPickers.time.set(s.at);
			self._simulate();
		});
		$p.find('[data-day]').on('click', function() {
			var want = +$(this).attr('data-day'), delta = (want - jsDay(s.at) + 7) % 7;
			var nd = new Date(Date.UTC(s.at.y, s.at.m - 1, s.at.d + delta));
			$.extend(s.at, { y: nd.getUTCFullYear(), m: nd.getUTCMonth() + 1, d: nd.getUTCDate() });
			changed();
		});
		$p.find('.crv-sim__hide').on('change', function() { s.hideOffPath = this.checked; self._paintState(); });
		$p.find('[data-outcome]').on('click', function() { s.outcome = $(this).attr('data-outcome'); changed(); });
		$p.find('.crv-sim__reset').on('click', function() { s.digits = {}; s.outcome = 'answered'; s.hideOffPath = false; self._setNow(); changed(); });
		self._syncSim();
	};

	/** Puts the simulator's controls in line with state (without rebuilding them, so pickers stay put). */
	View.prototype._syncSim = function() {
		var s = this.state, $p = this.$root.find('.crv-sim'), at = s.at;
		if (!this._simPickers) { return; }
		this._simPickers.date.set(at);
		this._simPickers.time.set(at);
		$p.find('.crv-sim__slider').val(at.hour * 60 + at.minute);
		var day = jsDay(at);
		$p.find('[data-day]').each(function() { $(this).toggleClass('is-active', +this.getAttribute('data-day') === day); });
		$p.find('[data-outcome]').each(function() { $(this).toggleClass('is-active', this.getAttribute('data-outcome') === s.outcome); });
		$p.find('.crv-sim__hide').prop('checked', !!s.hideOffPath);
	};

	View.prototype._press = function(nodeId, key) {
		if (!this.state.simStart) { return; }
		this.state.digits[nodeId] = key;
		this._simulate();
	};

	View.prototype._simulate = function() {
		var self = this, s = self.state;
		if (!s.simStart || !self.graph.nodes[s.simStart]) { self.lastSim = null; self._paintState(); return; }
		self.lastSim = crvGraph.simulate(self.graph, self.snap, { start: s.simStart, at: { local: s.at }, outcome: s.outcome, digits: s.digits });
		var r = self.lastSim;
		self.$root.find('.crv-path').html(r.steps.map(function(step) {
			return '<li class="' + (step.returned ? 'is-return' : '') + '"><b>' + esc(step.label) + '</b>' + (step.detail ? '<small>' + esc(step.detail) + '</small>' : '') + '</li>';
		}).join(''));
		var end = r.end, html = '<div class="crv-end crv-end--' + esc(end.reason) + '">' + esc(end.detail || end.reason) + '</div>';
		if (end.reason === 'awaiting-input') {
			var keys = self.graph.edges.filter(function(e) { return e.from === end.nodeId && e.kind === 'branch' && e.key !== 'timeout' && e.key !== 'max_retries'; })
				.map(function(e) { return e.key; }).sort();
			html += '<div class="crv-keys">' + keys.map(function(k) { return '<button type="button" data-key="' + esc(k) + '">' + esc(k) + '</button>'; }).join('') +
				'<button type="button" data-key="timeout" class="crv-keys__none">' + esc(self.t('noInput')) + '</button></div>';
		}
		self.$root.find('.crv-path__end').html(html).find('[data-key]').on('click', function() { self._press(end.nodeId, $(this).attr('data-key')); });
		self._paintState();
	};

	/**
	 * The call's path on its own, laid out compactly — used for "Hide routes this call doesn't
	 * take", so a large callflow collapses to a readable chain instead of a sparse full layout.
	 */
	View.prototype._pathGraph = function(sim) {
		var g = this.graph, nodes = {}, edgeIds = {};
		sim.nodes.forEach(function(id) { if (g.nodes[id]) { nodes[id] = g.nodes[id]; } });
		sim.edges.forEach(function(id) { edgeIds[id] = true; });
		return {
			nodes: nodes,
			edges: g.edges.filter(function(e) { return edgeIds[e.id] && nodes[e.from] && nodes[e.to]; }),
			roots: g.roots.filter(function(id) { return nodes[id]; }),
			issues: [], timezone: g.timezone, keySource: g
		};
	};

	View.prototype._paintState = function() {
		var hide = !!(this.lastSim && this.state.hideOffPath),
			key = hide ? 'path:' + this.lastSim.nodes.join(',') + '|' + this.lastSim.edges.join(',') : 'full';
		if (this._shownKey && key !== this._shownKey) {
			this._shownKey = key;
			this.canvas.render(hide ? this._pathGraph(this.lastSim) : this.graph, this.t('empty'));
			this._markPlaying();
		}
		this.canvas.setState({
			path: this.lastSim || null,
			focus: this.lastSim ? null : this.state.selectedNode,
			selected: this.state.selectedNode,
			hideOffPath: !!(this.lastSim && this.state.hideOffPath),
			pressed: this.state.digits
		});
	};

	/* ---------------------------------- details / problems ------------------------------ */

	View.prototype._renderDetails = function() {
		var self = this, $d = self.$root.find('.crv-details'), n = self.graph && self.graph.nodes[self.state.selectedNode];
		self._detailMedia = [];
		if (!n) { $d.prop('hidden', true).empty(); return; }
		var info = crvDetails.forNode(n, self.snap, self.graph);
		var play = function(m) {
			if (!m) { return ''; }
			var i = self._detailMedia.push(m) - 1;
			return '<button type="button" class="crv-chip crv-chip--play' + (m.system ? ' is-system' : '') + '" data-dmedia="' + i + '" data-media-key="' + esc(crvCanvas.mediaKey(m)) + '" title="' +
				esc(m.system ? self.t('systemPrompt') : m.speak ? self.t('browserVoice') : m.label || '') + '"><span class="crv-chip__glyph" aria-hidden="true">play_arrow</span><span class="crv-chip__text">' +
				esc(self.t(m.speak ? 'media_tts' : 'media_play')) + '</span></button>';
		};
		var table = function(rows) {
			return '<table class="crv-dtable"><tbody>' + rows.map(function(r) {
				return '<tr><th scope="row">' + esc(r.label) + '</th><td><span class="crv-dtable__v">' + esc(r.value) + '</span>' + play(r.media) + '</td></tr>';
			}).join('') + '</tbody></table>';
		};
		var items = function(sec) {
			var cols = sec.columns || [];
			return '<div class="crv-ditems' + (cols.length ? ' has-cols' : '') + '">' +
				(cols.length ? '<div class="crv-ditem crv-ditem--head"><span class="crv-ditem__main"></span>' + cols.map(function(c) { return '<span class="crv-ditem__cell">' + esc(c) + '</span>'; }).join('') + '</div>' : '') +
				sec.items.map(function(it) {
					var sub = (it.sub ? [it.sub] : []).concat(it.lines || []);
					return '<div class="crv-ditem' + (it.muted ? ' is-muted' : '') + (it.nodeId ? ' is-link' : '') + '"' + (it.nodeId ? ' data-node="' + esc(it.nodeId) + '" role="button" tabindex="0"' : '') + '>' +
						(it.key ? '<span class="crv-keycap' + (it.keyWide ? ' crv-keycap--wide' : '') + '">' + esc(it.key) + '</span>' : '') +
						'<span class="crv-glyph-sm crv-ditem__icon" aria-hidden="true">' + esc(it.glyph || 'radio_button_unchecked') + '</span>' +
						'<span class="crv-ditem__main"><span class="crv-ditem__title">' + esc(it.title) + '</span>' +
							sub.map(function(l) { return '<span class="crv-ditem__sub' + (it.status ? ' is-' + esc(it.status) : '') + '">' + esc(l) + '</span>'; }).join('') +
							// Without columns (rules), where it goes reads as the item's last line.
							(cols.length ? '' : (it.cells || []).map(function(c) { return '<span class="crv-ditem__to">' + esc(c) + '</span>'; }).join('')) +
						'</span>' +
						(cols.length ? (it.cells || []).map(function(c) { return '<span class="crv-ditem__cell">' + esc(c) + '</span>'; }).join('') : '') +
					'</div>';
				}).join('') + '</div>';
		};
		var issues = (n.issues || []).filter(function(i) { return i.level !== 'info' || i.code === 'pivot'; });
		$d.prop('hidden', false).html(
			'<div class="crv-dhead"><span class="crv-dhead__icon crv-glyph-sm" aria-hidden="true">' + esc(n.glyph || 'settings') + '</span>' +
				'<div class="crv-dhead__titles"><div class="crv-dtype">' + esc(n.type || '') + '</div><h3>' + esc(n.label) + '</h3></div>' +
				'<button type="button" class="crv-x" data-close aria-label="' + esc(self.t('close')) + '">&times;</button></div>' +
			info.sections.map(function(sec) { return '<h4>' + esc(sec.title) + '</h4>' + (sec.items ? items(sec) : table(sec.rows || [])); }).join('') +
			(issues.length ? '<h4>' + esc(self.t('problems')) + '</h4><ul class="crv-issues">' + issues.map(function(i) { return '<li class="crv-issue crv-issue--' + esc(i.level) + '">' + esc(i.message) + '</li>'; }).join('') + '</ul>' : '')
		);
		self._markPlaying();
	};

	View.prototype._renderProblems = function() {
		var self = this, list = [];
		Object.keys(self.graph.nodes).forEach(function(id) {
			(self.graph.nodes[id].issues || []).forEach(function(i) {
				if (i.level === 'error' || i.level === 'warning') { list.push({ id: id, issue: i, node: self.graph.nodes[id] }); }
			});
		});
		list.sort(function(a, b) { return (a.issue.level === 'error' ? 0 : 1) - (b.issue.level === 'error' ? 0 : 1); });
		self.$root.find('.crv-problems').prop('hidden', !Object.keys(self.graph.nodes).length).html(
			'<h3>' + esc(self.t('problems')) + (list.length ? ' <span class="crv-count">' + list.length + '</span>' : '') + '</h3>' +
			(list.length ? '<ul class="crv-issues">' + list.map(function(x) {
				return '<li class="crv-issue crv-issue--' + esc(x.issue.level) + '"><a href="#" data-goto="' + esc(x.id) + '">' + esc(x.node.label) + '</a> — ' + esc(x.issue.message) + '</li>';
			}).join('') + '</ul>' : '<p class="crv-muted">' + esc(self.t('noProblems')) + '</p>')
		);
	};

	/**
	 * Plays an account recording, a sequence of Kazoo system prompts, or (inline TTS) a preview in
	 * the browser's voice. Pressing the same play button again stops it.
	 */
	View.prototype._play = function(media, node) {
		var self = this;
		if (!media) { return; }
		var key = crvCanvas.mediaKey(media);
		if (self.playing && self.playing.key === key) { self._stop(); return; }
		self._stop();
		var what = media.speak ? self.t('browserVoice') : (media.label || self.t('media_' + media.role)),
			title = node && node.label && node.label !== what ? node.label + ' — ' + what : what;
		if (media.speak) {
			var synth = window.speechSynthesis;
			if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') { self._toast(self.t('speechUnavailable')); return; }
			var u = new window.SpeechSynthesisUtterance(media.speak);
			if (media.language) { u.lang = media.language; }
			u.onend = u.onerror = function() { if (self.playing && self.playing.utterance === u) { self._stop(); } };
			self.playing = { key: key, title: title, speech: true, utterance: u };
			synth.speak(u);
		} else {
			var urls = media.mediaId ? [self.mediaUrl(media.mediaId)]
				: (media.prompts || []).map(function(p) { return self.promptUrl(p, media.language || 'en-us'); });
			urls = urls.filter(Boolean);
			if (!urls.length) { self._toast(self.t('noAudio')); return; }
			var audio = self.$root.find('.crv-audio')[0];
			self.playing = { key: key, title: title, urls: urls, i: 0 };
			audio.src = urls[0];
			var started = audio.play();
			if (started && started.catch) { started.catch(function(err) { if (err && err.name !== 'AbortError' && self.playing && self.playing.key === key) { self._toast(self.t('playFailed')); self._stop(); } }); }
		}
		self._markPlaying();
		self._paintPlayer();
	};

	View.prototype._stop = function() {
		var p = this.playing;
		this.playing = null;
		if (p) {
			if (p.speech) { try { window.speechSynthesis.cancel(); } catch (e) {} }
			else { var audio = this.$root.find('.crv-audio')[0]; audio.pause(); audio.removeAttribute('src'); try { audio.load(); } catch (e) {} }
		}
		this._markPlaying();
		this._paintPlayer();
	};

	/** Every play button for what's playing turns into a stop button. */
	View.prototype._markPlaying = function() {
		var key = this.playing ? this.playing.key : null, stop = this.t('stop');
		this.$root.find('[data-media-key]').each(function() {
			var on = !!key && this.getAttribute('data-media-key') === key, $text = $(this).find('.crv-chip__text');
			if (!this.hasAttribute('data-label')) { this.setAttribute('data-label', $text.text()); }
			$(this).toggleClass('is-playing', on).find('.crv-chip__glyph').text(on ? 'stop' : 'play_arrow');
			$text.text(on ? stop : this.getAttribute('data-label'));
		});
	};

	View.prototype._paintPlayer = function() {
		var p = this.playing, $pl = this.$root.find('.crv-player');
		if (!p) { $pl.prop('hidden', true); return; }
		var audio = this.$root.find('.crv-audio')[0], frac = 0, time = '';
		if (p.speech) {
			time = '';
		} else {
			var d = audio.duration, c = audio.currentTime || 0, seg = isFinite(d) && d > 0 ? Math.min(1, c / d) : 0;
			frac = (p.i + seg) / p.urls.length;
			time = p.urls.length > 1 ? (p.i + 1) + ' / ' + p.urls.length : clockText(c) + (isFinite(d) && d > 0 ? ' / ' + clockText(d) : '');
		}
		$pl.prop('hidden', false).toggleClass('is-speech', !!p.speech);
		$pl.find('.crv-player__title').text(p.title);
		$pl.find('.crv-player__bar span').css('width', (frac * 100).toFixed(1) + '%');
		$pl.find('.crv-player__time').text(time);
	};

	View.prototype._toast = function(msg) {
		var $t = this.$root.find('.crv-toast').text(msg).prop('hidden', false);
		clearTimeout(this._toastT);
		this._toastT = setTimeout(function() { $t.prop('hidden', true); }, 2600);
	};

	/* ---------------------------------- export ------------------------------------------ */

	/**
	 * Print view of what's on screen; the browser's "Save as PDF" renders every script (Hebrew
	 * names included) as vector text.
	 */
	View.prototype.exportPdf = function() {
		var self = this, s = self.state;
		if (!Object.keys(self.graph.nodes).length) { self._toast(self.t('exportNothing')); return; }
		var stage = self.$root.find('.crv-stage')[0].cloneNode(true), size = self.canvas.size,
			scale = Math.min(1, 960 / Math.max(size.w, 1)),
			showing = s.mode === 'account' ? self.t('modeAccount')
				: s.mode === 'callflows' ? (((self.snap.callflow_list || self.snap.callflows || {})[s.selected] || {}).name || s.selected)
				: crvGraph.formatNumber(s.selected),
			sim = self.lastSim, at = s.at,
			rows = [[self.t('exportAccount'), (self.snap.account && self.snap.account.name) || ''], [self.t('exportShowing'), showing], [self.t('timezone'), self.tz]];
		if (sim) { rows.push([self.t('exportSimulated'), ymd(at) + ' ' + pad2(at.hour) + ':' + pad2(at.minute) + ' · ' + self.t({ answered: 'answered', 'no-answer': 'noAnswer', live: 'live' }[s.outcome])]); }
		rows.push([self.t('exportGenerated'), new Date(self.nowMs()).toLocaleString()]);
		stage.style.transform = 'scale(' + scale + ')';
		var css = Array.prototype.map.call(document.querySelectorAll('link[rel="stylesheet"]'), function(l) { return '<link rel="stylesheet" href="' + esc(l.href) + '">'; }).join('');
		var html = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(self.t('exportTitle') + ' — ' + showing) + '</title>' + css +
			'<style>@page { size: landscape; margin: 12mm; } body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }' +
			'h1 { font-size: 18px; margin: 0 0 6px; } h2 { font-size: 14px; margin: 14px 0 6px; } .crv-print-meta td { padding: 1px 12px 1px 0; }' +
			'.crv-print-map { position: relative; overflow: hidden; margin-top: 10px; } .crv-print-map .crv-stage { transform-origin: 0 0; }</style></head>' +
			'<body class="crv-app crv-print' + (self.$root.hasClass('crv-no-glyphs') ? ' crv-no-glyphs' : '') + '"><h1>' + esc(self.t('exportTitle')) + '</h1>' +
			'<table class="crv-print-meta">' + rows.map(function(r) { return '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>' +
			'<div class="crv-print-map" style="width:' + Math.ceil(size.w * scale) + 'px;height:' + Math.ceil(size.h * scale) + 'px">' + stage.outerHTML + '</div>' +
			(sim ? '<h2>' + esc(self.t('callPath')) + '</h2><ol class="crv-path">' + sim.steps.map(function(st) { return '<li><b>' + esc(st.label) + '</b>' + (st.detail ? ' — ' + esc(st.detail) : '') + '</li>'; }).join('') + '</ol><p><b>' + esc(sim.end.detail || '') + '</b></p>' : '') +
			'</body></html>';
		var frame = document.createElement('iframe');
		frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
		document.body.appendChild(frame);
		var doc = frame.contentWindow.document;
		doc.open(); doc.write(html); doc.close();
		var printed = false, go = function() {
			if (printed) { return; } printed = true;
			frame.contentWindow.focus(); frame.contentWindow.print();
			setTimeout(function() { if (frame.parentNode) { document.body.removeChild(frame); } }, 1000);
		};
		frame.onload = go;
		setTimeout(go, 1500);
		self.lastExportHtml = html;
	};

	View.prototype.destroy = function() {
		this._stop();
		this.canvas.destroy();
		this.$root.off().empty().removeClass('crv-app').removeAttr('id');
	};

	return { mount: function($root, opts) { return new View($root, opts); }, EN: EN };
}));
