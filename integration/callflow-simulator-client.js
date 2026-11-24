/**
 * Callflow Simulator — client helper for other Monster apps (copy into your app).
 *
 * Monster only binds an app's pub/sub listeners once that app is loaded, so a caller can't just
 * `monster.pub(...)` and hope. This helper:
 *   isAvailable()   whether this user can use the simulator — synchronous, for templates
 *   showRoute(args) loads the simulator if needed (without taking over the page), then opens its
 *                   dialog with one route at one moment
 *
 *   var crv = require('./callflow-simulator-client')(monster);   // or paste the function body into your app
 *   if (crv.isAvailable()) { ... }
 *   crv.showRoute({ number: cdr.to, gregorian: cdr.timestamp, title: 'Call from ' + cdr.caller_id_number });
 *
 * showRoute args (see docs/INTEGRATION.md):
 *   callflowId | number    which route: a callflow id, or the dialled number ("+18455550100",
 *                          "8455550100", "+18455550100@realm" and extensions all work)
 *   gregorian | timestamp | date   when (Kazoo gregorian seconds, Unix s/ms, Date or string)
 *   accountId?             default: the account Monster is on (follows masquerading)
 *   callerId?              the caller's number (cdr.caller_id_number), for caller-ID checks
 *   title?                 dialog title
 *   callback?(err, { close })
 */
(function(root, factory) {
	if (typeof define === 'function' && define.amd) { define([], function() { return factory; }); }
	else if (typeof module === 'object' && module.exports) { module.exports = factory; }
	else { root.callflowSimulatorClient = factory; }
}(this, function(monster) {
	'use strict';
	var NAME = 'callflow-simulator';

	function isAvailable() {
		if (monster.apps[NAME]) { return true; }
		var meta = monster.util.getAppStoreMetadata(NAME), user = monster.apps.auth && monster.apps.auth.currentUser;
		// The same check Monster's app launcher uses: in the account's app store, and allowed for this user.
		return !!meta && !!user && monster.util.isUserPermittedApp(user, meta);
	}

	function showRoute(args) {
		args = args || {};
		if (monster.apps[NAME]) { monster.pub('callflowSimulator.showRoute', args); return; }
		var active = monster.apps.getActiveApp();
		monster.apps.load(NAME, function(err) {
			// monster.apps.load makes the loaded app the "active" one (routing, re-render on
			// masquerade, alt+ shortcuts). The simulator only opens a dialog: give it back.
			if (active && monster.apps[active]) {
				monster.apps.lastLoadedApp = active;
				monster.apps.changeAppShortcuts(monster.apps[active]);
			}
			if (err) { if (typeof args.callback === 'function') { args.callback(err); } return; }
			monster.pub('callflowSimulator.showRoute', args);
		});
	}

	return { isAvailable: isAvailable, showRoute: showRoute };
}));
