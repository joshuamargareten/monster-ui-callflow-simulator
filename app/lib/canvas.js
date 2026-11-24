/**
 * canvas.js — draws a graph.js graph: dagre layout, HTML node cards, SVG edges, pan & zoom.
 *
 * Steps look like DT-Callflows actions: Material Symbols glyphs (DT-Callflows' own icon per
 * module, from its MaterialSymbolsOutlined font), navy blocks. Routing-only steps (time of day,
 * jumps, caller-ID tweaks) are slim outlined pills, so what the caller actually experiences
 * stands out. Menus carry a phone keypad: configured keys are live, the rest disabled.
 *
 *   var c = crvCanvas.create($el, { onNodeClick, onPlay, onDigit, onBackgroundClick, i18n });
 *   c.render(graph, emptyText);
 *   c.setState({ path, focus, selected, hideOffPath, pressed: { menuNodeId: key } });
 *   c.setDirection('LR' | 'TB'); c.fit(ids?); c.zoomBy(f); c.destroy();
 *
 * No Monster globals. UMD, ES5.
 */
(function(root, factory) {
	if (typeof define === 'function' && define.amd) {
		define(['jquery', './vendor/dagre.min', './graph'], factory);
	} else {
		root.crvCanvas = factory(root.jQuery, root.dagre, root.crvGraph);
	}
}(this, function($, dagre, crvGraph) {
	'use strict';

	var CALL_W = 236, LOGIC_W = 196;
	var MIN_SCALE = 0.06, MAX_SCALE = 2.5;
	var GUTTER = 52; // width of the zoom-button column on the map's left edge
	var KEYPAD = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['*', '0', '#']];
	var KEYPAD_SET = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, '*': 1, 0: 1, '#': 1 };
	var EDGE_KINDS = ['entry', 'branch', 'continue', 'failure', 'nomatch', 'menu', 'jump', 'loop', 'return', 'dead'];

	function esc(s) {
		return String(s === null || s === undefined ? '' : s)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	/** Identifies a playable item, so every play button for the same audio shows when it is playing. */
	function mediaKey(m) {
		if (!m) { return ''; }
		if (m.mediaId) { return 'm:' + m.mediaId; }
		if (m.prompts) { return 'p:' + (m.language || '') + ':' + m.prompts.join('+'); }
		if (m.speak) { return 't:' + String(m.speak).slice(0, 120); }
		return '';
	}

	/** Smooth path through dagre's bend points (quadratic segments through midpoints). */
	function pathThrough(points) {
		if (!points || points.length < 2) { return ''; }
		var d = 'M' + points[0].x + ',' + points[0].y;
		if (points.length === 2) { return d + 'L' + points[1].x + ',' + points[1].y; }
		for (var i = 1; i < points.length - 1; i++) {
			var mx = (points[i].x + points[i + 1].x) / 2, my = (points[i].y + points[i + 1].y) / 2;
			d += 'Q' + points[i].x + ',' + points[i].y + ' ' + (i === points.length - 2 ? points[i + 1].x + ',' + points[i + 1].y : mx + ',' + my);
		}
		return d;
	}

	function Canvas($el, opts) {
		this.$el = $el;
		this.opts = opts || {};
		this.i18n = this.opts.i18n || {};
		this.direction = this.opts.direction || 'LR';
		this.view = { x: 0, y: 0, k: 1 };
		this.state = {};
		this.graph = null;
		this.size = { w: 0, h: 0 };
		this._build();
	}

	Canvas.prototype._uid = function() {
		this.__uid = this.__uid || Math.random().toString(36).slice(2);
		return this.__uid;
	};

	Canvas.prototype._build = function() {
		var self = this;
		self.$el.addClass('crv-canvas').empty();
		self.$stage = $('<div class="crv-stage"></div>').appendTo(self.$el);
		self.$svg = $(document.createElementNS('http://www.w3.org/2000/svg', 'svg')).attr('class', 'crv-edges').appendTo(self.$stage);
		self.$nodes = $('<div class="crv-nodes"></div>').appendTo(self.$stage);
		self.$empty = $('<div class="crv-empty"></div>').appendTo(self.$el).hide();

		var drag = null;
		self.$el.on('mousedown.crv', function(e) {
			if (e.button !== 0 || $(e.target).closest('.crv-node').length) { return; }
			drag = { x: e.clientX, y: e.clientY, vx: self.view.x, vy: self.view.y, moved: false };
			self.$el.addClass('is-panning');
			e.preventDefault();
		});
		$(window).on('mousemove.crv-' + self._uid(), function(e) {
			if (!drag) { return; }
			var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
			if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; }
			self.view.x = drag.vx + dx; self.view.y = drag.vy + dy;
			self._apply();
		}).on('mouseup.crv-' + self._uid(), function() {
			if (drag && !drag.moved && self.opts.onBackgroundClick) { self.opts.onBackgroundClick(); }
			drag = null;
			self.$el.removeClass('is-panning');
		});
		self.$el.on('wheel.crv', function(e) {
			var oe = e.originalEvent, rect = self.$el[0].getBoundingClientRect();
			self.zoomBy(Math.pow(1.0015, -oe.deltaY), oe.clientX - rect.left, oe.clientY - rect.top);
			e.preventDefault();
		});

		self.$nodes.on('click.crv', '.crv-node', function(e) {
			var id = $(this).attr('data-id'), $t = $(e.target);
			if ($t.closest('[data-play]').length) {
				var idx = +$t.closest('[data-play]').attr('data-play');
				if (self.opts.onPlay) { self.opts.onPlay(self.graph.nodes[id].media[idx], self.graph.nodes[id]); }
				return;
			}
			var $key = $t.closest('[data-digit]');
			if ($key.length) {
				if (!$key.prop('disabled') && self.opts.onDigit) { self.opts.onDigit(id, $key.attr('data-digit')); }
				return;
			}
			if (self.opts.onNodeClick) { self.opts.onNodeClick(self.graph.nodes[id]); }
		});
	};

	/** Menu branches: keypad keys plus anything else (multi-digit keys, "No input"). */
	Canvas.prototype._menuKeys = function(nodeId) {
		var keys = {}, extra = [], hasTimeout = false;
		// A path-only graph (view's "hide routes this call doesn't take") keeps the full graph
		// in `keySource`, so its keypads still show every configured key.
		(this.graph.keySource || this.graph).edges.forEach(function(e) {
			if (e.from !== nodeId || e.kind === 'dead') { return; }
			if (e.key === 'timeout') { hasTimeout = true; return; }
			if (e.kind !== 'branch' || e.key === 'max_retries') { return; }
			if (KEYPAD_SET[e.key]) { keys[e.key] = true; } else { extra.push(e.key); }
		});
		return { keys: keys, extra: extra.sort(), timeout: hasTimeout };
	};

	/** Card size must be known before layout; keep in sync with the CSS. */
	Canvas.prototype._size = function(node) {
		if (node.role === 'logic') {
			return { w: LOGIC_W, h: node.sublabel ? 46 : 34 };
		}
		var h = 56;
		if (node.sublabel) { h += 16; }
		if (node.media && node.media.length) { h += 30; }
		if (node.module === 'menu') {
			var mk = this._menuKeys(node.id);
			h += 4 * 28 + 10;                        // keypad
			if (mk.extra.length || mk.timeout) { h += 28; }
		}
		return { w: CALL_W, h: h };
	};

	Canvas.prototype._nodeHtml = function(n, pos, size) {
		var self = this, t = function(k, d) { return esc(self.i18n[k] || d); };
		var errors = (n.issues || []).filter(function(i) { return i.level === 'error'; }).length,
			warnings = (n.issues || []).filter(function(i) { return i.level === 'warning'; }).length,
			cls = ['crv-node', 'crv-role--' + (n.role || 'call'), 'crv-node--' + (n.kind === 'entry' ? 'entry' : String(n.module || 'x').replace(/[^a-z0-9_-]/gi, ''))];
		if (errors) { cls.push('has-error'); } else if (warnings) { cls.push('has-warning'); }
		if (n.kind === 'entry' && !n.callflowId) { cls.push('is-unassigned'); }

		var icon = '<span class="crv-glyph" aria-hidden="true">' + esc(n.glyph || 'settings') + '</span>' +
			'<span class="crv-sprite icon white ' + esc(n.icon || 'settings2') + '" aria-hidden="true"></span>';
		var badge = errors || warnings
			? '<div class="crv-node__badge" title="' + esc((n.issues || []).map(function(i) { return i.message; }).join('\n')) + '">' + (errors || warnings) + '</div>'
			: '';

		if (n.role === 'logic') {
			return '<div class="' + cls.join(' ') + '" data-id="' + esc(n.id) + '" style="left:' + (pos.x - size.w / 2) + 'px;top:' + (pos.y - size.h / 2) + 'px;width:' + size.w + 'px;height:' + size.h + 'px" title="' + esc((n.type || '') + ' — ' + n.label) + '">' +
				'<div class="crv-node__head">' + icon +
					'<div class="crv-node__titles"><div class="crv-node__label">' + esc(n.label) + '</div>' +
					(n.sublabel ? '<div class="crv-node__sub">' + esc(n.sublabel) + '</div>' : '') + '</div>' + badge +
				'</div></div>';
		}

		var media = (n.media && n.media.length) ? '<div class="crv-node__actions">' + n.media.map(function(m, i) {
			return '<button type="button" class="crv-chip crv-chip--play' + (m.missing ? ' is-missing' : '') + (m.system ? ' is-system' : '') + '" data-play="' + i + '" data-media-key="' + esc(mediaKey(m)) + '" title="' + esc(m.label) + '">' +
				'<span class="crv-chip__glyph" aria-hidden="true">play_arrow</span><span class="crv-chip__text">' + t('media_' + m.role, m.role) + '</span></button>';
		}).join('') + '</div>' : '';

		var keypad = '';
		if (n.module === 'menu') {
			var mk = self._menuKeys(n.id);
			keypad = '<div class="crv-keypad" role="group" aria-label="' + t('keypad', 'Keypad') + '">' + KEYPAD.map(function(row) {
				return '<div class="crv-keypad__row">' + row.map(function(k) {
					var on = !!mk.keys[k];
					return '<button type="button" class="crv-key' + (on ? '' : ' is-off') + '" data-digit="' + esc(k) + '"' +
						(on ? ' title="' + t('press', 'Press') + ' ' + esc(k) + '"' : ' disabled title="' + t('notSet', 'Not set') + '"') + '>' + esc(k) + '</button>';
				}).join('') + '</div>';
			}).join('') + '</div>';
			if (mk.extra.length || mk.timeout) {
				keypad += '<div class="crv-keypad__extra">' + mk.extra.map(function(k) {
					return '<button type="button" class="crv-chip crv-chip--digit" data-digit="' + esc(k) + '">' + esc(k) + '</button>';
				}).join('') + (mk.timeout ? '<button type="button" class="crv-chip crv-chip--digit" data-digit="timeout">' + t('noInputShort', 'No input') + '</button>' : '') + '</div>';
			}
		}

		return '<div class="' + cls.join(' ') + '" data-id="' + esc(n.id) + '" style="left:' + (pos.x - size.w / 2) + 'px;top:' + (pos.y - size.h / 2) + 'px;width:' + size.w + 'px;height:' + size.h + 'px">' +
			'<div class="crv-node__head">' + icon +
				'<div class="crv-node__titles">' +
					'<div class="crv-node__label" title="' + esc(n.label) + '">' + esc(n.label) + '</div>' +
					'<div class="crv-node__type">' + esc(n.type || '') + '</div>' +
				'</div>' + badge +
			'</div>' +
			(n.sublabel ? '<div class="crv-node__sub" title="' + esc(n.sublabel) + '">' + esc(n.sublabel) + '</div>' : '') +
			media + keypad +
			'</div>';
	};

	Canvas.prototype.render = function(graph, emptyText) {
		var self = this;
		self.graph = graph;
		self.$nodes.empty();
		self.$svg.empty();
		var ids = Object.keys(graph.nodes);
		if (!ids.length) {
			self.$empty.text(emptyText || self.i18n.empty || 'Nothing to show.').show();
			self.size = { w: 0, h: 0 };
			return;
		}
		self.$empty.hide();

		var g = new dagre.graphlib.Graph({ multigraph: true });
		var lr = self.direction === 'LR';
		g.setGraph({ rankdir: self.direction, nodesep: lr ? 22 : 36, ranksep: lr ? 90 : 64, edgesep: 14, marginx: 40, marginy: 40 });
		g.setDefaultEdgeLabel(function() { return {}; });
		var sizes = {};
		ids.forEach(function(id) { sizes[id] = self._size(graph.nodes[id]); g.setNode(id, { width: sizes[id].w, height: sizes[id].h }); });
		graph.edges.forEach(function(e) {
			var label = e.label || '';
			g.setEdge(e.from, e.to, { width: label ? Math.min(180, 12 + label.length * 5.6) : 0, height: label ? 16 : 0, labelpos: 'c' }, e.id);
		});
		dagre.layout(g);
		var gg = g.graph();
		self.size = { w: Math.ceil(gg.width || 0), h: Math.ceil(gg.height || 0) };

		// edges
		var svgNs = 'http://www.w3.org/2000/svg', defs = document.createElementNS(svgNs, 'defs');
		EDGE_KINDS.concat(['active']).forEach(function(kind) {
			var m = document.createElementNS(svgNs, 'marker');
			m.setAttribute('id', 'crv-arrow-' + kind + '-' + self._uid());
			m.setAttribute('viewBox', '0 0 10 10'); m.setAttribute('refX', '9'); m.setAttribute('refY', '5');
			m.setAttribute('markerWidth', '7'); m.setAttribute('markerHeight', '7'); m.setAttribute('orient', 'auto-start-reverse');
			m.setAttribute('class', 'crv-arrow crv-arrow--' + kind);
			var p = document.createElementNS(svgNs, 'path');
			p.setAttribute('d', 'M0,0 L10,5 L0,10 z');
			m.appendChild(p); defs.appendChild(m);
		});
		self.$svg[0].appendChild(defs);
		self.$svg.attr({ width: self.size.w, height: self.size.h, viewBox: '0 0 ' + self.size.w + ' ' + self.size.h });
		self.edgeEls = {};
		graph.edges.forEach(function(e) {
			var le = g.edge(e.from, e.to, e.id);
			if (!le) { return; }
			var grp = document.createElementNS(svgNs, 'g');
			grp.setAttribute('class', 'crv-edge crv-edge--' + e.kind + (e.callerDriven ? ' is-caller-loop' : ''));
			grp.setAttribute('data-id', e.id);
			var path = document.createElementNS(svgNs, 'path');
			path.setAttribute('d', pathThrough(le.points));
			path.setAttribute('marker-end', 'url(#crv-arrow-' + e.kind + '-' + self._uid() + ')');
			grp.appendChild(path);
			if (e.label) {
				var w = le.width || 0, txt = document.createElementNS(svgNs, 'text'), bg = document.createElementNS(svgNs, 'rect');
				bg.setAttribute('x', le.x - w / 2); bg.setAttribute('y', le.y - 8);
				bg.setAttribute('width', w); bg.setAttribute('height', 16); bg.setAttribute('rx', 4);
				bg.setAttribute('class', 'crv-edge-label-bg');
				txt.setAttribute('x', le.x); txt.setAttribute('y', le.y + 4);
				txt.setAttribute('text-anchor', 'middle');
				txt.setAttribute('class', 'crv-edge-label');
				txt.textContent = e.label.length > 32 ? e.label.slice(0, 31) + '…' : e.label;
				var title = document.createElementNS(svgNs, 'title'); title.textContent = e.label; txt.appendChild(title);
				grp.appendChild(bg); grp.appendChild(txt);
			}
			self.$svg[0].appendChild(grp);
			self.edgeEls[e.id] = grp;
		});

		// nodes
		self.$nodes.html(ids.map(function(id) { return self._nodeHtml(graph.nodes[id], g.node(id), sizes[id]); }).join(''));
		self.$nodes.css({ width: self.size.w, height: self.size.h });
		self._applyState();
		self.fit();
	};

	Canvas.prototype.setDirection = function(dir) {
		this.direction = dir === 'TB' ? 'TB' : 'LR';
		if (this.graph) { this.render(this.graph); }
	};

	/**
	 * state.path      simulate() result — lights the path, dims the rest
	 * state.focus     node id — lights what it reaches and what reaches it
	 * state.selected  node id — outline
	 * state.hideOffPath  hide (instead of dim) everything off the path
	 * state.pressed   { menuNodeId: key } — keys pressed in the simulation
	 */
	Canvas.prototype.setState = function(state) {
		this.state = $.extend({}, this.state, state);
		this._applyState();
	};

	Canvas.prototype._applyState = function() {
		var self = this, s = self.state, graph = self.graph;
		if (!graph || !self.edgeEls) { return; }
		var lit = null, litEdges = null, up = {};
		if (s.path) {
			lit = {}; litEdges = {};
			s.path.nodes.forEach(function(id) { lit[id] = true; });
			s.path.edges.forEach(function(id) { litEdges[id] = true; });
		} else if (s.focus && graph.nodes[s.focus]) {
			lit = {}; litEdges = {};
			var u = crvGraph.upstream(graph, s.focus), d = crvGraph.downstream(graph, s.focus);
			u.nodes.forEach(function(id) { lit[id] = true; up[id] = true; });
			d.nodes.forEach(function(id) { lit[id] = true; });
			u.edges.concat(d.edges).forEach(function(id) { litEdges[id] = true; });
		}
		var endId = s.path && s.path.end ? s.path.end.nodeId : null, pressed = s.pressed || {};
		self.$nodes.children('.crv-node').each(function() {
			var id = this.getAttribute('data-id'), $n = $(this);
			$n.toggleClass('is-lit', !!(lit && lit[id]))
				.toggleClass('is-dim', !!(lit && !lit[id]))
				.toggleClass('is-hidden', !!(lit && !lit[id] && s.hideOffPath))
				.toggleClass('is-end', id === endId)
				.toggleClass('is-focus', id === s.focus && !s.path)
				.toggleClass('is-upstream', !!(up[id] && id !== s.focus && !s.path))
				.toggleClass('is-selected', id === s.selected);
			$n.find('[data-digit]').each(function() {
				$(this).toggleClass('is-pressed', !!(s.path && pressed[id] === this.getAttribute('data-digit')));
			});
		});
		Object.keys(self.edgeEls).forEach(function(id) {
			var el = self.edgeEls[id], on = !!(litEdges && litEdges[id]), off = !!(litEdges && !litEdges[id]);
			var cls = el.getAttribute('class').replace(/\s*is-(lit|dim|hidden)/g, '');
			if (on) { cls += ' is-lit'; }
			if (off) { cls += ' is-dim'; }
			if (off && s.hideOffPath) { cls += ' is-hidden'; }
			el.setAttribute('class', cls);
			var kind = (cls.match(/crv-edge--([a-z]+)/) || [])[1];
			el.querySelector('path').setAttribute('marker-end', 'url(#crv-arrow-' + (on && s.path ? 'active' : kind) + '-' + self._uid() + ')');
		});
	};

	Canvas.prototype._apply = function() {
		this.$stage.css('transform', 'translate(' + this.view.x + 'px,' + this.view.y + 'px) scale(' + this.view.k + ')');
	};

	Canvas.prototype.zoomBy = function(factor, cx, cy) {
		var v = this.view, k = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.k * factor));
		if (cx === undefined) { cx = this.$el.width() / 2; cy = this.$el.height() / 2; }
		v.x = cx - (cx - v.x) * (k / v.k);
		v.y = cy - (cy - v.y) * (k / v.k);
		v.k = k;
		this._apply();
	};

	/** Fit the whole graph (or a set of node ids) into view. */
	Canvas.prototype.fit = function(nodeIds) {
		var W = this.$el.width() || 800, H = this.$el.height() || 600, box;
		if (nodeIds && nodeIds.length) {
			var self = this, xs = [], ys = [];
			nodeIds.forEach(function(id) {
				var el = self.$nodes.children('[data-id="' + String(id).replace(/"/g, '\\"') + '"]')[0];
				if (el) { xs.push(el.offsetLeft, el.offsetLeft + el.offsetWidth); ys.push(el.offsetTop, el.offsetTop + el.offsetHeight); }
			});
			if (xs.length) {
				box = { x: Math.min.apply(null, xs) - 40, y: Math.min.apply(null, ys) - 40 };
				box.w = Math.max.apply(null, xs) + 40 - box.x; box.h = Math.max.apply(null, ys) + 40 - box.y;
			}
		}
		box = box || { x: 0, y: 0, w: this.size.w || 1, h: this.size.h || 1 };
		// Keep clear of the zoom buttons down the left edge.
		var L = GUTTER, AW = Math.max(1, W - L), k = Math.max(MIN_SCALE, Math.min(1, Math.min(AW / box.w, H / box.h)));
		this.view = { k: k, x: L + (AW - box.w * k) / 2 - box.x * k, y: (H - box.h * k) / 2 - box.y * k };
		this._apply();
	};

	Canvas.prototype.destroy = function() {
		$(window).off('.crv-' + this._uid());
		this.$el.off('.crv').empty().removeClass('crv-canvas');
	};

	return {
		create: function($el, opts) { return new Canvas($el, opts); },
		mediaKey: mediaKey
	};
}));
