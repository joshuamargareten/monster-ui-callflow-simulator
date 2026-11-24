/**
 * Call Routing Visualizer — Monster UI app.
 *
 * Monster glue only. Start-up fetches five lists (account, callflow names, numbers, devices,
 * device status) so the list appears straight away; everything else is fetched on demand by
 * lib/loader.js when the user opens something, and cached. Rendering lives in lib/view.js;
 * routing logic (lib/temporal.js, lib/graph.js) is pure and unit-tested outside Monster.
 */
define(function(require) {
	var $ = require('jquery'),
		_ = require('lodash'),
		monster = require('monster'),
		crvView = require('./lib/view'),
		crvLoader = require('./lib/loader');

	// DT-Callflows' stylesheet + Material Symbols font: reused (not copied) so the visualizer
	// looks exactly like the Callflows app and follows any Dimensions change to it. On a Monster
	// without DT-Callflows these 404; the app then switches to its own fallback layout
	// (`.crv-standalone` in style/app.css) and to text icons when the font is missing.
	var SHARED_CSS = ['apps/dt-callflows/style/app.css', 'apps/dt-callflows/style/fonts.css'];

	// snapshot collection -> [Kazoo SDK resource or custom request, id parameter]
	var FETCH = {
		callflows: ['callflow.get', 'callflowId'],
		users: ['user.get', 'userId'],
		devices: ['device.get', 'deviceId'],
		groups: ['group.get', 'groupId'],
		menus: ['menu.get', 'menuId'],
		vmboxes: ['voicemail.get', 'voicemailId'],
		media: ['media.get', 'mediaId'],
		temporal_rules: ['temporalRule.get', 'ruleId'],
		conferences: ['conference.get', 'conferenceId'],
		temporal_rules_sets: ['crv.ruleSets.get', 'setId'],
		qubicle_queues: ['crv.qubicle.get', 'queueId'],
		directories: ['crv.directories.get', 'directoryId'],
		faxboxes: ['crv.faxboxes.get', 'faxboxId']
	};

	var app = {
		name: 'call-route-visualizer',

		// Follows masquerading: re-renders for the account you switch to (also needs
		// `masqueradable: true` on the app-store record for `#/apps/...?m=<accountId>`).
		isMasqueradable: true,

		css: ['app', 'icons'],

		i18n: {
			'en-US': { customCss: false }
		},

		// Kazoo endpoints the JS SDK has no method for. `generateError: false` lives on the
		// definition (monster.request ignores it in the call's data): a deleted object is normal
		// here and is shown as a problem on the map, not as an error dialog.
		requests: {
			'crv.ruleSets.list': { url: 'accounts/{accountId}/temporal_rules_sets?paginate=false', verb: 'GET', generateError: false },
			'crv.ruleSets.get': { url: 'accounts/{accountId}/temporal_rules_sets/{setId}', verb: 'GET', generateError: false },
			'crv.qubicle.get': { url: 'accounts/{accountId}/qubicle_queues/{queueId}', verb: 'GET', generateError: false },
			'crv.directories.get': { url: 'accounts/{accountId}/directories/{directoryId}', verb: 'GET', generateError: false },
			'crv.faxboxes.get': { url: 'accounts/{accountId}/faxboxes/{faxboxId}', verb: 'GET', generateError: false }
		},

		subscribe: {},

		load: function(callback) {
			var self = this;
			self.initApp(function() {
				callback && callback(self);
			});
		},

		initApp: function(callback) {
			var self = this;
			monster.pub('auth.initApp', {
				app: self,
				callback: callback
			});
		},

		render: function(container) {
			var self = this,
				$container = _.isEmpty(container) ? $('#monster_content') : container,
				i18n = self.i18n.active().callRouteVisualizer || {},
				$root = $('<div class="crv-host"></div>');

			if (self.view) { self.view.destroy(); self.view = null; }
			$container.empty().append($root);
			self.crvLinkSharedCss(function(available) { $root.toggleClass('crv-standalone', !available); });
			self.crvFitHeight($root);
			$root.html('<div class="crv-loading">' + _.escape(i18n.loading || 'Loading') + '…</div>');

			// A re-render (e.g. after masquerading) supersedes a load still in flight.
			var token = self.crvRenderToken = (self.crvRenderToken || 0) + 1;
			self.crvLoadStartup(function(err, snapshot) {
				if (token !== self.crvRenderToken) { return; }
				if (err) {
					$root.html('<div class="crv-loading crv-loading--error">' + _.escape(i18n.loadFailed || 'Could not load this account\'s call routing.') + '</div>');
					return;
				}
				var loader = crvLoader.create({
					snapshot: snapshot,
					fetch: function(kind, id, cb) { self.crvFetch(kind, id, cb); }
				});
				var $view = $('<div></div>').appendTo($root.empty());
				self.view = crvView.mount($view, {
					snapshot: snapshot,
					i18n: i18n,
					ensure: function(entry, onProgress, done) {
						loader.ensure(entry, self.view ? self.view.entries : [], onProgress, done);
					},
					mediaUrl: function(mediaId) {
						// <audio> can't send X-Auth-Token, so the token goes in the query string —
						// the same approach Monster uses for voicemail playback.
						return self.apiUrl + 'accounts/' + self.accountId + '/media/' + mediaId +
							'/raw?auth_token=' + encodeURIComponent(monster.util.getAuthToken());
					},
					promptUrl: function(promptId, language) {
						// Kazoo's system prompts (e.g. the default voicemail greeting) live in the
						// system media db as "<lang>/<prompt>": GET /v2/media/en-us%2Fvm-person/raw
						return self.apiUrl + 'media/' + encodeURIComponent(language + '/' + promptId) +
							'/raw?auth_token=' + encodeURIComponent(monster.util.getAuthToken());
					},
					pickers: self.crvPickers()
				});
			});
		},

		/**
		 * Monster's own date and time pickers — the same widgets (and the user's date format and
		 * 12/24h setting) as Callflows' time of day and SmartPBX's call logs.
		 */
		crvPickers: function() {
			return {
				date: function($input, onChange) {
					monster.ui.datepicker($input, {
						onSelect: function() {
							var d = $input.datepicker('getDate');
							if (d) { onChange(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
						}
					});
					$input.on('change', function() {
						var d = $input.datepicker('getDate');
						if (d) { onChange(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
					});
					return { set: function(at) { $input.datepicker('setDate', new Date(at.y, at.m - 1, at.d)); } };
				},
				time: function($input, onChange) {
					var quiet = false; // setTime may fire changeTime itself; don't echo it back
					monster.ui.timepicker($input, { step: 15, listWidth: 1 });
					$input.on('changeTime', function() {
						var sec = $input.timepicker('getSecondsFromMidnight');
						if (!quiet && sec !== null && sec !== undefined) { onChange(Math.floor(sec / 3600), Math.floor((sec % 3600) / 60)); }
					});
					return { set: function(at) { quiet = true; $input.timepicker('setTime', at.hour * 3600 + at.minute * 60); quiet = false; } };
				}
			};
		},

		/**
		 * Fills the window below wherever the app starts — Monster's top bar is 64px in the regular
		 * portal and absent in the embedded one, so a fixed offset doesn't fit both.
		 */
		crvFitHeight: function($root) {
			var fit = function() {
				if (!$.contains(document.documentElement, $root[0])) { $(window).off('resize.crvHeight'); return; }
				$root.css('height', Math.max(560, window.innerHeight - Math.max(0, $root[0].getBoundingClientRect().top)) + 'px');
			};
			$(window).off('resize.crvHeight').on('resize.crvHeight', fit);
			fit();
			setTimeout(fit, 300); // after embedded scripts remove the top bar
		},

		/**
		 * Links DT-Callflows' stylesheets once; calls back(available) when we know whether its
		 * layout stylesheet loaded (immediately on later renders).
		 */
		crvLinkSharedCss: function(callback) {
			var self = this;
			if (self.crvSharedCssState) {
				return self.crvSharedCssState.then ? self.crvSharedCssState.then(callback) : callback(self.crvSharedCssState.ok);
			}
			var waiting = [callback], finish = function(ok) {
				self.crvSharedCssState = { ok: ok };
				_.each(waiting, function(cb) { cb(ok); });
			};
			self.crvSharedCssState = { then: function(cb) { waiting.push(cb); } };
			_.each(SHARED_CSS, function(href, i) {
				var main = i === 0, $existing = $('link[href*="' + href + '"]');
				if ($existing.length) {
					// Already on the page (e.g. DT-Callflows itself was opened first).
					if (main) { finish(true); }
					return;
				}
				var link = $('<link rel="stylesheet">').attr('href', href)[0];
				if (main) {
					link.onload = function() { finish(true); };
					link.onerror = function() { $(link).remove(); finish(false); };
				} else {
					link.onerror = function() { $(link).remove(); };
				}
				document.head.appendChild(link);
			});
		},

		/** The few lists the left panel needs; all in parallel. */
		crvLoadStartup: function(callback) {
			var self = this, accountId = self.accountId;
			monster.parallel({
				account: function(next) { self.crvCallApi('account.get', { accountId: accountId }, next); },
				callflows: function(next) { self.crvCallApi('callflow.list', { accountId: accountId, filters: { paginate: 'false' } }, next); },
				numbers: function(next) { self.crvCallApi('numbers.list', { accountId: accountId }, next); },
				devices: function(next) { self.crvCallApi('device.list', { accountId: accountId, filters: { paginate: 'false' } }, next); },
				deviceStatus: function(next) { self.crvCallApi('device.getStatus', { accountId: accountId }, next); },
				// Tells the loader which time-of-day ids are rule SETS, so it never has to guess.
				ruleSets: function(next) { self.crvRequest('crv.ruleSets.list', { accountId: accountId }, next); }
			}, function(err, r) {
				if (err || !r.account || !r.callflows) { return callback(err || 'startup'); }
				callback(null, {
					account: r.account,
					temporal_rules_set_ids: _.mapValues(_.keyBy(r.ruleSets || [], 'id'), _.constant(true)),
					callflow_list: _.keyBy(r.callflows, 'id'),
					phone_numbers: _.get(r, 'numbers.numbers', {}),
					devices: _.keyBy(r.devices || [], 'id'),
					device_status: _.isEmpty(r.deviceStatus) ? null : _.keyBy(r.deviceStatus, 'device_id')
				});
			});
		},

		/** One doc for the lazy loader; cb(null, doc|null). */
		crvFetch: function(kind, id, cb) {
			var self = this, spec = FETCH[kind];
			if (!spec) { return cb(null, null); }
			var data = { accountId: self.accountId };
			data[spec[1]] = id;
			if (spec[0].indexOf('crv.') === 0) { self.crvRequest(spec[0], data, cb); } else { self.crvCallApi(spec[0], data, cb); }
		},

		/** callApi that never pops Monster's error dialog; failures resolve to null. */
		crvCallApi: function(resource, data, next) {
			this.callApi({
				resource: resource,
				data: _.merge({ generateError: false }, data),
				bypassProgressIndicator: true,
				success: function(res) { next(null, res.data); },
				error: function() { next(null, null); }
			});
		},

		/** Same, for the custom endpoints in `requests`. Missing modules (404) resolve to null. */
		crvRequest: function(resource, data, next) {
			monster.request({
				resource: resource,
				data: _.merge({ generateError: false }, data),
				bypassProgressIndicator: true,
				success: function(res) { next(null, res.data); },
				error: function() { next(null, null); }
			});
		}
	};

	return app;
});
