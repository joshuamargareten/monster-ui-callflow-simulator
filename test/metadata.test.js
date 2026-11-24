'use strict';
/*
 * The app installs cleanly: the checks that `sup crossbar_maintenance init_app` and Monster's app
 * loader make, run before anyone submits it.
 *   - init_app validates metadata/app.json against Kazoo's `app` schema (crossbar
 *     priv/couchdb/schemas/app.json, same in 4.3 and master), then uploads
 *     metadata/icon/<icon> and metadata/screenshots/<each>.
 *   - Monster loads apps/<name>/app.js, so the folder, app.json and app.js must agree on the name.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var APP = path.join(__dirname, '..', 'app');
var NAME = 'call-route-visualizer';
var meta = JSON.parse(fs.readFileSync(path.join(APP, 'metadata', 'app.json'), 'utf8'));
var appJs = fs.readFileSync(path.join(APP, 'app.js'), 'utf8');

function pngSize(file) {
	var b = fs.readFileSync(file);
	assert.equal(b.toString('ascii', 1, 4), 'PNG', file + ' is a PNG');
	return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

test('app.json has everything Kazoo\'s app schema requires', function() {
	['api_url', 'author', 'i18n', 'icon', 'license', 'name', 'price', 'version'].forEach(function(k) {
		assert.ok(Object.prototype.hasOwnProperty.call(meta, k), 'missing required property ' + k);
	});
	assert.match(meta.api_url, /^https?:\/\/[^\s/]+\/.*$/, 'api_url is a URI');
	assert.ok(meta.author.length >= 2 && meta.author.length <= 64, 'author 2-64 chars');
	assert.ok(meta.name.length >= 3 && meta.name.length <= 64, 'name 3-64 chars');
	assert.equal(typeof meta.price, 'number');
	assert.ok(meta.price >= 0);
	assert.equal(typeof meta.version, 'string');
	assert.equal(typeof meta.license, 'string');
	assert.equal(typeof meta.masqueradable, 'boolean');
	['tags', 'screenshots'].forEach(function(k) { assert.ok(Array.isArray(meta[k]), k + ' is a list'); });
});

test('texts are nested in i18n.<lang>, not at the top level', function() {
	['label', 'description', 'extended_description', 'features'].forEach(function(k) {
		assert.ok(!(k in meta), k + ' belongs in i18n.en-US, not at the top level');
	});
	var langs = Object.keys(meta.i18n);
	assert.ok(langs.indexOf('en-US') !== -1, 'has en-US');
	langs.forEach(function(lang) {
		assert.match(lang, /^[a-z]{2}-[A-Z]{2}$/);
		var t = meta.i18n[lang];
		assert.ok(t.label && t.label.length >= 3 && t.label.length <= 64, lang + ' label 3-64 chars');
		assert.ok(t.description && t.description.length >= 3, lang + ' description');
		assert.equal(typeof t.extended_description, 'string', lang + ' extended_description');
		assert.ok(Array.isArray(t.features), lang + ' features');
	});
});

test('one name everywhere: app.json, app.js, folder, wrapper, CSS', function() {
	assert.equal(meta.name, NAME);
	var m = /\bname:\s*'([^']+)'/.exec(appJs);
	assert.ok(m, 'app.js declares name');
	assert.equal(m[1], NAME, 'app.js name');
	assert.equal(require('../package.json').name, NAME, 'package.json name');
	// the wrapper Monster's #monster_content gets is built from self.name
	assert.match(appJs, /\$root = \$\('<div id="' \+ self\.name \+ '" class="' \+ self\.name \+ ' crv-host"><\/div>'\)/);
	assert.match(fs.readFileSync(path.join(APP, 'style', 'app.css'), 'utf8'), new RegExp('#' + NAME + '\\b'), 'app.css scopes the wrapper');
	// the release packs app/ as a folder named after the app (tools/make-release.sh)
	assert.match(fs.readFileSync(path.join(__dirname, '..', 'tools', 'make-release.sh'), 'utf8'), /--prefix="\$NAME\/"/);
});

test('every app.css selector is scoped to the app', function() {
	var css = fs.readFileSync(path.join(APP, 'style', 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
	var bad = [];
	css.replace(/([^{}]+)\{/g, function(_, sel) {
		sel.split(',').map(function(s) { return s.trim(); }).filter(Boolean).forEach(function(s) {
			if (/^(@|from$|to$|\d+%$)/.test(s)) { return; }
			if (!/crv-|call-route-visualizer/.test(s)) { bad.push(s); }
		});
	});
	assert.deepEqual(bad, []);
});

test('icon and screenshots named in app.json exist where init_app reads them', function() {
	var icon = path.join(APP, 'metadata', 'icon', meta.icon);
	assert.ok(fs.existsSync(icon), 'metadata/icon/' + meta.icon);
	assert.deepEqual(pngSize(icon), { w: 512, h: 512 }, 'store icon is 512x512');
	assert.ok(meta.screenshots.length > 0);
	meta.screenshots.forEach(function(s) {
		assert.ok(fs.existsSync(path.join(APP, 'metadata', 'screenshots', s)), 'metadata/screenshots/' + s);
	});
	// nothing stray that the record doesn't name
	assert.deepEqual(fs.readdirSync(path.join(APP, 'metadata', 'icon')), [meta.icon]);
	assert.deepEqual(fs.readdirSync(path.join(APP, 'metadata', 'screenshots')).sort(), meta.screenshots.slice().sort());
});

test('the files Monster asks for exist', function() {
	assert.equal(fs.readFileSync(path.join(APP, 'VERSION'), 'utf8').trim(), meta.version, 'VERSION matches app.json');
	var css = /css:\s*\[([^\]]*)\]/.exec(appJs);
	assert.ok(css, 'app.js lists its css');
	css[1].replace(/'([^']+)'/g, function(_, f) {
		assert.ok(fs.existsSync(path.join(APP, 'style', f + '.css')), 'style/' + f + '.css');
	});
	var i18n = /i18n:\s*\{([\s\S]*?)\n\t\t\}/.exec(appJs);
	assert.ok(i18n, 'app.js lists its languages');
	i18n[1].replace(/'([a-z]{2}-[A-Z]{2})'/g, function(_, lang) {
		JSON.parse(fs.readFileSync(path.join(APP, 'i18n', lang + '.json'), 'utf8'));
	});
	appJs.replace(/require\('\.\/([^']+)'\)/g, function(_, mod) {
		assert.ok(fs.existsSync(path.join(APP, mod + '.js')), mod + '.js');
	});
});
