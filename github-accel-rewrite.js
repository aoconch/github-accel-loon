/**
 * github-accel-rewrite.js  —— Loon http-request 脚本
 *
 * 作用：把 GitHub 的「下载类」请求改写到 github-accel-speedtest.js 选出的最优加速节点。
 *   原始： https://github.com/owner/repo/releases/download/v1/file.zip
 *   改写： https://<最优节点域名>/https://github.com/owner/repo/releases/download/v1/file.zip
 *
 * 依赖：本地存储 gh_accel_best（由 github-accel-speedtest.js 定时写入）。
 *      若不存在 → 本脚本直接放行，不做任何改写（不会影响 GitHub 正常访问）。
 *
 * 只改写以下「纯下载」路径，绝不碰登录 / 网页 / API：
 *   - github.com/{owner}/{repo}/releases/download/...、releases/latest/download/...
 *   - github.com/{owner}/{repo}/archive/...
 *   - github.com/{owner}/{repo}/raw/...
 *   - raw.githubusercontent.com/...
 *   - codeload.github.com/...
 *   - gist.githubusercontent.com/...
 *
 * 可覆盖配置（argument 或插件 #!input）：
 *   nodePolicy=DIRECT    改写后的请求走哪个策略/节点（默认 DIRECT，加速节点多为国内 CDN）
 *   enable=true          总开关
 *   maxAgeDays=30        最优节点信息超过该天数则不再改写（防止长期失效节点）
 *   debug=false          输出日志到 Loon 日志
 */

var KEY_BEST = 'gh_accel_best';
var KEY_STAT = 'gh_accel_stat';

var DEFAULTS = {
  nodePolicy: 'DIRECT',
  enable: 'true',
  maxAgeDays: '30',
  debug: 'false'
};

function parseArgument() {
  var out = {};
  try {
    var a = typeof $argument === 'string' ? $argument : '';
    if (a) {
      var pairs = a.split('&');
      for (var i = 0; i < pairs.length; i++) {
        var kv = pairs[i].split('=');
        if (kv[0]) out[kv[0].trim()] = (kv[1] === undefined ? '' : kv[1]).trim();
      }
    }
  } catch (e) { /* ignore */ }
  return out;
}

var ARGS = parseArgument();

function cfg(name) {
  var v = ARGS[name];
  if (v !== undefined && v !== '') return v;
  try {
    var s = $persistentStore.read(name);
    if (s !== undefined && s !== null && s !== '') return String(s);
  } catch (e) { /* ignore */ }
  return DEFAULTS[name];
}

function flag(name) {
  var v = String(cfg(name)).toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

function log() {
  if (!flag('debug')) return;
  try {
    var s = '[GH加速改写]';
    for (var i = 0; i < arguments.length; i++) s += ' ' + arguments[i];
    console.log(s);
  } catch (e) { /* ignore */ }
}

function readJSON(key) {
  try {
    var s = $persistentStore.read(key);
    if (!s) return null;
    return JSON.parse(s);
  } catch (e) { return null; }
}

function writeJSON(key, obj) {
  try { return $persistentStore.write(JSON.stringify(obj), key); } catch (e) { return false; }
}

function pass() { try { $done({}); } catch (e) { /* ignore */ } }

/* 命中「可加速下载」白名单 */
function isDownloadUrl(url) {
  if (/^https:\/\/github\.com\/.+\/(releases\/download|releases\/latest\/download|archive|raw)\//.test(url)) return true;
  if (/^https:\/\/raw\.githubusercontent\.com\//.test(url)) return true;
  if (/^https:\/\/codeload\.github\.com\//.test(url)) return true;
  if (/^https:\/\/gist\.githubusercontent\.com\//.test(url)) return true;
  return false;
}

function main() {
  try {
    if (!flag('enable')) return pass();

    var url = (typeof $request !== 'undefined' && $request && $request.url) ? String($request.url) : '';
    if (!url) return pass();

    var best = readJSON(KEY_BEST);
    if (!best || !best.domain) { log('暂无最优节点，放行'); return pass(); }

    // 过期保护
    var maxAge = parseFloat(cfg('maxAgeDays')) * 86400000;
    if (best.testedAt && maxAge > 0 && (Date.now() - best.testedAt) > maxAge) {
      log('最优节点信息已过期（' + best.domain + '），放行');
      return pass();
    }

    // 已经是改写后的地址，避免二次改写
    if (url.indexOf('://' + best.domain + '/') > -1) return pass();

    if (!isDownloadUrl(url)) return pass();

    var newUrl = 'https://' + best.domain + '/' + url;
    var policy = String(cfg('nodePolicy') || 'DIRECT');

    // 统计（轻量，仅用于排查）
    var stat = readJSON(KEY_STAT) || {};
    stat.rewriteCount = (stat.rewriteCount || 0) + 1;
    stat.lastDomain = best.domain;
    stat.lastUrl = url;
    stat.lastAt = Date.now();
    writeJSON(KEY_STAT, stat);

    log('改写 → ' + best.domain + ' | ' + url);
    $done({ url: newUrl, node: policy });
  } catch (e) {
    // 任何异常都必须放行，不能阻断用户下载
    try { console.log('[GH加速改写] 异常：' + e); } catch (err) { /* ignore */ }
    pass();
  }
}

main();
