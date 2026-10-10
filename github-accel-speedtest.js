/**
 * github-accel-speedtest.js  —— Loon 定时(cron)脚本
 *
 * 作用：从 https://github.akams.cn/ 同步 GitHub 加速节点列表 → 逐个测延迟 → 取前几名测真实下载速度
 *      → 选出最优节点，写入 Loon 本地存储，供 github-accel-rewrite.js 改写下载链接使用。
 *
 * 数据来源：github.akams.cn 前端 chunk 中的节点数组（label:"contribute|search",value:"域名"）
 * 加速格式：https://<节点域名>/https://github.com/<owner>/<repo>/releases/download/...
 *
 * 存储 key：
 *   gh_accel_best  { domain, latency, speed, testedAt, picks[] }  最优节点
 *   gh_accel_nodes { at, list[] }                                 节点列表缓存(带时间戳)
 *   gh_accel_stat  { lastRunAt, total, winner, switchedAt }        运行统计
 *
 * 可在插件 [Argument] / http-request 的 argument 中覆盖的配置（也可用插件 #!input 定义，脚本会读本地存储）：
 *   remoteList=true|false    是否实时从 akams 同步节点列表（失败自动回落内置列表）
 *   listTtlHours=12          节点列表缓存有效期(小时)
 *   includeSearch=true       是否把「测绘」类节点也纳入测速
 *   latencyTimeout=3000      单节点延迟测试超时(ms)
 *   latencyPassMax=2500      延迟高于该值(ms)的节点不进入速度测试
 *   speedCount=4             进入速度测试的节点数量
 *   speedTimeout=15000       速度测试超时(ms)
 *   keepRatio=0.3            稳定性：旧节点指标在新最优的 1.3 倍以内则不切换
 *   notify=true              是否发送 iOS 通知
 *   debug=false              是否输出详细日志到 Loon 日志
 */

/* ------------------------------------------------------------------ */
/* 内置节点列表（akams 站点快照，作为同步失败时的兜底）                  */
/* ------------------------------------------------------------------ */
var DEFAULT_NODES = [
  'gh.dpik.top', 'github.tbap.top', 'ghfile.geekertao.top', 'ghproxy.net', 'gh-proxy.com',
  'cdn.gh-proxy.com', 'github.dpik.top', 'j.1lin.dpdns.org', 'github.starrlzy.cn',
  'github-proxy.memory-echoes.cn', 'git.yylx.win', 'ghm.078465.xyz', 'gh.927223.xyz',
  'gh.felicity.ac.cn', 'gh.bugdey.us.kg', 'cdn.akaere.online', 'jiashu.1win.eu.org', 'tvv.tw',
  'j.1win.ggff.net', 'gitproxy.127731.xyz', 'gh.inkchills.cn', 'gh.catmak.name', 'gh.b52m.cn',
  'down.mxw.xx.kg', 'down.mxw.qzz.io', 'github.mxw.qzz.io', 'gh.acmsz.top', 'gh.jjj.gv.uy',
  'slink.ltd', 'github.tmby.shop', 'ghpr.cc', 'gh.tryxd.cn', 'gitproxy.click', 'github.chenc.dev',
  'gh.ddlc.top', 'gitproxy.mrhjx.cn', 'gh.sixyin.com', 'gh.monlor.com', 'ghpxy.hwinzniej.top',
  'git.669966.xyz', 'ghfast.top', 'gh.jasonzeng.dev', 'github.geekery.cn', 'gp.zkitefly.eu.org',
  'fastgit.cc', 'ghproxy.1888866.xyz', 'ghp.arslantu.xyz', 'github.ednovas.xyz',
  'ghproxy.imciel.com', 'ghproxy.cxkpro.top', 'github.xxlab.tech', 'gh.idayer.com', 'free.cn.eu.org',
  'gh.chjina.com', 'ghp.keleyaa.com', 'proxy.yaoyaoling.net', 'ghproxy.monkeyray.net', 'gh.noki.icu',
  'g.blfrp.cn', 'githubdog.com', 'gh.meali.top', '777.z321.cc.cd', 'gg.z321.cc.cd', 'g.z321.cc.cd',
  'js.jiangss.shop', 'gap.andyjin.website', 'gh.my-website.ccwu.cc', 'github.ikgy.top',
  'gh.07150721.xyz', 'cfgh.ikgy.top', 'xsadwsd.kdns.fr', 'gh.ruan.dpdns.org', 'ghproxy.felicity.land',
  'github.nswrz.cn', 'gh.zhai.edu.pl', 'gh.qfmc0721.cc.cd', 'github-cf.947563.xyz',
  'github.gohj99.site', 'githubproxy.gohj99.site', 'ghproxy.icu'
];

/* 延迟测试用小图片（与 akams 站点同款，均为 raw.githubusercontent 小文件） */
var LATENCY_IMAGES = [
  'https://raw.githubusercontent.com/microsoft/vscode/refs/heads/main/resources/linux/code.png',
  'https://raw.githubusercontent.com/microsoft/terminal/refs/heads/main/res/terminal/images/SmallTile.scale-125.png',
  'https://raw.githubusercontent.com/facebook/react/refs/heads/main/fixtures/dom/public/favicon.ico',
  'https://raw.githubusercontent.com/python/cpython/refs/heads/main/PC/icons/python.ico'
];

/* 速度测试文件（约 1.2~1.7MB 的 Release/Archive，体积小、iOS 内存安全） */
var SPEED_FILE = 'https://github.com/pypa/pip/archive/refs/tags/24.3.1.zip';

var KEY_BEST = 'gh_accel_best';
var KEY_NODES = 'gh_accel_nodes';
var KEY_STAT = 'gh_accel_stat';
var UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/* ------------------------------------------------------------------ */
/* 配置解析                                                            */
/* ------------------------------------------------------------------ */
var DEFAULTS = {
  remoteList: 'true',
  listTtlHours: '12',
  includeSearch: 'true',
  latencyTimeout: '3000',
  latencyPassMax: '2500',
  speedCount: '4',
  speedTimeout: '15000',
  keepRatio: '0.3',
  notify: 'true',
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
    var s = $persistentStore.read(name);   // 插件 #!input / #!select 填写的值
    if (s !== undefined && s !== null && s !== '') return String(s);
  } catch (e) { /* ignore */ }
  return DEFAULTS[name];
}

function flag(name) {
  var v = String(cfg(name)).toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

function num(name) {
  var n = parseFloat(cfg(name));
  return isNaN(n) ? parseFloat(DEFAULTS[name]) : n;
}

function log() {
  if (!flag('debug')) return;
  try {
    var s = '[GH加速]';
    for (var i = 0; i < arguments.length; i++) s += ' ' + arguments[i];
    console.log(s);
  } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */
function httpGet(url, timeoutMs, extra) {
  return new Promise(function (resolve) {
    var opt = {
      url: url,
      timeout: timeoutMs,
      headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
    };
    if (extra) for (var k in extra) opt[k] = extra[k];
    var t0 = Date.now();
    try {
      $httpClient.get(opt, function (err, resp, data) {
        var ms = Date.now() - t0;
        if (err) return resolve({ ok: false, err: String(err), ms: ms });
        var status = resp && resp.status ? resp.status : 0;
        var len = 0;
        var h = (resp && resp.headers) ? resp.headers : {};
        var cl = h['Content-Length'] || h['content-length'];
        if (cl) len = parseInt(cl, 10) || 0;
        if (!len && data) len = data.length;
        resolve({
          ok: status >= 200 && status < 300,
          status: status,
          ms: ms,
          bytes: len,
          data: data,
          headers: h
        });
      });
    } catch (e) {
      resolve({ ok: false, err: String(e), ms: Date.now() - t0 });
    }
  });
}

/* 并发池：worker 必须永不 reject */
function pool(items, limit, worker) {
  return new Promise(function (resolve) {
    if (!items.length) return resolve([]);
    var results = new Array(items.length);
    var idx = 0;
    var done = 0;
    function next() {
      if (idx >= items.length) return;
      var i = idx++;
      Promise.resolve(worker(items[i], i)).then(function (r) {
        results[i] = r;
        done++;
        if (done === items.length) resolve(results);
        else next();
      }, function (e) {
        results[i] = { error: String(e) };
        done++;
        if (done === items.length) resolve(results);
        else next();
      });
    }
    for (var k = 0; k < Math.min(limit, items.length); k++) next();
  });
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

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

function isAsciiDomain(d) { return /^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}$/i.test(d); }

function done() { try { $done(); } catch (e) { /* ignore */ } }

/* ------------------------------------------------------------------ */
/* 1. 同步节点列表（远程优先，失败回落内置）                            */
/* ------------------------------------------------------------------ */
/**
 * 同步节点列表
 * @returns Promise<{list:Array|null, cached:boolean}>  cached=true 表示来自本地缓存（无需回写）
 */
function syncNodes() {
  if (!flag('remoteList')) {
    log('remoteList=false，使用内置列表');
    return Promise.resolve({ list: null, cached: true });
  }
  // 命中缓存则不重复同步
  var cached = readJSON(KEY_NODES);
  var ttl = num('listTtlHours') * 3600 * 1000;
  if (cached && cached.list && cached.list.length && (Date.now() - (cached.at || 0)) < ttl) {
    log('使用节点列表缓存：' + cached.list.length + ' 个');
    return Promise.resolve({ list: cached.list, cached: true });
  }

  return httpGet('https://github.akams.cn/', 15000).then(function (r) {
    if (!r.ok || !r.data) {
      log('站点拉取失败：', r.err || ('HTTP ' + r.status));
      return { list: null, cached: false };
    }
    var chunks = [];
    var re = /\/_next\/static\/chunks\/([A-Za-z0-9_\-]+)\.js/g;
    var m;
    while ((m = re.exec(r.data)) !== null) {
      if (chunks.indexOf(m[1]) < 0) chunks.push(m[1]);
    }
    if (!chunks.length) { log('未在首页找到 chunk'); return { list: null, cached: false }; }

    return pool(chunks, 4, function (h) {
      return httpGet('https://github.akams.cn/_next/static/chunks/' + h + '.js', 20000)
        .then(function (j) {
          if (!j.ok || !j.data) return [];
          var found = [];
          var re2 = /label:"(contribute|search)",value:"([^"]+)"/g;
          var m2;
          while ((m2 = re2.exec(j.data)) !== null) found.push({ domain: m2[2], label: m2[1] });
          return found;
        });
    }).then(function (arrs) {
      var seen = {};
      var out = [];
      for (var i = 0; i < arrs.length; i++) {
        var a = arrs[i];
        if (!a) continue;
        for (var j = 0; j < a.length; j++) {
          var d = a[j].domain;
          if (seen[d]) continue;
          seen[d] = 1;
          out.push(a[j]);
        }
      }
      return out.length ? out : null;
    }).then(function (list) {
      return { list: list, cached: false };
    });
  }).catch(function (e) {
    log('同步异常：', e);
    return { list: null, cached: false };
  });
}

/* ------------------------------------------------------------------ */
/* 2. 测延迟                                                            */
/* ------------------------------------------------------------------ */
function testLatency(domains) {
  var img = pick(LATENCY_IMAGES) + '?t=' + Date.now();
  var timeout = num('latencyTimeout');
  log('延迟测试开始，共 ' + domains.length + ' 个节点，超时 ' + timeout + 'ms');

  return pool(domains, 8, function (d) {
    var url = 'https://' + d + '/' + img + '&r=' + Math.random().toString(36).slice(2, 8);
    return httpGet(url, timeout).then(function (r) {
      // 镜像可能不回 200 但内容正确；只要拿到 body 就认为可达
      var ok = !r.err && r.bytes > 0 && r.status !== 404 && r.status !== 403;
      return { domain: d, latency: ok ? r.ms : -1, status: r.status, bytes: r.bytes, err: r.err || '' };
    }).catch(function () {
      return { domain: d, latency: -1, status: 0, bytes: 0, err: 'exception' };
    });
  });
}

/* ------------------------------------------------------------------ */
/* 3. 测速度                                                            */
/* ------------------------------------------------------------------ */
function testSpeed(domains) {
  var timeout = num('speedTimeout');
  return pool(domains, 2, function (d) {
    var url = 'https://' + d + '/' + SPEED_FILE + '?t=' + Date.now();
    var t0 = Date.now();
    return httpGet(url, timeout).then(function (r) {
      var ms = Date.now() - t0;
      if (!r.ok || !r.bytes) {
        log('速度测试失败 ' + d + '：' + (r.err || ('HTTP ' + r.status)));
        return { domain: d, speed: -1, ms: ms, bytes: r.bytes || 0 };
      }
      var mbps = (r.bytes * 8) / (ms / 1000) / 1000000;
      log('速度 ' + d + ' = ' + mbps.toFixed(2) + ' Mbps (' + r.bytes + 'B / ' + ms + 'ms)');
      return { domain: d, speed: Math.round(mbps * 100) / 100, ms: ms, bytes: r.bytes };
    }).catch(function (e) {
      return { domain: d, speed: -1, ms: 0, bytes: 0 };
    });
  });
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
function main() {
  var t0 = Date.now();
  log('开始，参数：' + JSON.stringify(ARGS));

  syncNodes().then(function (res) {
    var remote = res && res.list;
    var fromCache = res && res.cached;
    var list;
    if (remote && remote.length) {
      if (!fromCache) writeJSON(KEY_NODES, { at: Date.now(), list: remote });   // 仅新同步的才刷新缓存时间
      list = remote;
      log('节点列表：' + remote.length + ' 个' + (fromCache ? '（本地缓存）' : '（远程同步）'));
    } else {
      var inc = flag('includeSearch');
      list = [];
      for (var i = 0; i < DEFAULT_NODES.length; i++) list.push({ domain: DEFAULT_NODES[i], label: 'contribute' });
      log('回落内置节点列表：' + list.length + ' 个' + (inc ? '' : '（仅 contribute）'));
    }

    // 过滤：非 ASCII 域名（IDN 无法直接用于改写 URL）、非 contribute 节点（可选）、重复
    var includeSearch = flag('includeSearch');
    var domains = [];
    var seen = {};
    for (var j = 0; j < list.length; j++) {
      var item = list[j];
      var d = item.domain;
      if (!d || seen[d]) continue;
      if (!isAsciiDomain(d)) { log('跳过非 ASCII 域名：' + d); continue; }
      if (!includeSearch && item.label === 'search') continue;
      seen[d] = 1;
      domains.push(d);
    }
    if (!domains.length) {
      finish(false, '节点列表为空，测速中止');
      return;
    }

    return testLatency(domains).then(function (lat) {
      var alive = [];
      for (var i = 0; i < lat.length; i++) if (lat[i].latency > 0) alive.push(lat[i]);
      alive.sort(function (a, b) { return a.latency - b.latency; });

      log('可用节点 ' + alive.length + '/' + domains.length + '，最快：' +
        (alive[0] ? alive[0].domain + ' ' + alive[0].latency + 'ms' : '无'));

      if (!alive.length) {
        finish(false, '所有节点均不可达（共 ' + domains.length + ' 个）');
        return;
      }

      var passMax = num('latencyPassMax');
      var candidates = [];
      for (var k = 0; k < alive.length; k++) {
        if (alive[k].latency <= passMax) candidates.push(alive[k]);
      }
      if (!candidates.length) candidates = alive.slice(0, 3);

      var speedList = candidates.slice(0, Math.max(1, num('speedCount'))).map(function (x) { return x.domain; });
      log('进入速度测试：' + speedList.join(', '));

      return testSpeed(speedList).then(function (sp) {
        var byDomain = {};
        for (var i = 0; i < alive.length; i++) byDomain[alive[i].domain] = alive[i];
        for (var j = 0; j < sp.length; j++) {
          if (byDomain[sp[j].domain] && sp[j].speed > 0) byDomain[sp[j].domain].speed = sp[j].speed;
        }

        var tested = candidates.map(function (x) {
          var a = byDomain[x.domain];
          return { domain: x.domain, latency: a.latency, speed: a.speed || -1 };
        });

        var ok = tested.filter(function (x) { return x.speed > 0; });
        ok.sort(function (a, b) {
          if (b.speed !== a.speed) return b.speed - a.speed;
          return a.latency - b.latency;
        });
        var best = ok.length ? ok[0] : { domain: candidates[0].domain, latency: candidates[0].latency, speed: -1 };

        // 稳定性：新最优相比旧最优提升不明显时，保留旧节点，避免频繁切换
        var prev = readJSON(KEY_BEST);
        var keepRatio = num('keepRatio');
        if (prev && prev.domain && prev.domain !== best.domain) {
          var prevNow = byDomain[prev.domain];
          if (prevNow && prevNow.latency > 0) {
            var better = false;
            if (best.speed > 0 && prevNow.speed > 0) better = best.speed > prevNow.speed * (1 + keepRatio);
            else better = best.latency < prevNow.latency * (1 - keepRatio);
            if (!better) {
              log('提升不足，保留原节点 ' + prev.domain);
              best = { domain: prev.domain, latency: prevNow.latency, speed: prevNow.speed || -1 };
            }
          }
        }

        var picks = ok.slice(0, 5).concat(
          tested.filter(function (x) { return x.speed <= 0; }).slice(0, 3)
        ).slice(0, 5);
        if (!picks.length) picks = [best];

        var payload = {
          domain: best.domain,
          latency: best.latency,
          speed: best.speed,
          testedAt: Date.now(),
          total: domains.length,
          alive: alive.length,
          picks: picks
        };
        writeJSON(KEY_BEST, payload);

        var stat = readJSON(KEY_STAT) || {};
        stat.lastRunAt = Date.now();
        stat.total = domains.length;
        stat.alive = alive.length;
        stat.winner = best.domain;
        stat.scanned = alive.length;
        if (!prev || prev.domain !== best.domain) stat.switchedAt = Date.now();
        writeJSON(KEY_STAT, stat);

        var cost = ((Date.now() - t0) / 1000).toFixed(1);
        var content = '延迟 ' + best.latency + 'ms' +
          (best.speed > 0 ? ' · 速度 ' + best.speed + 'Mbps' : '') +
          '\n可用 ' + alive.length + '/' + domains.length + ' 个节点，耗时 ' + cost + 's' +
          (ok.length > 1 ? '\n备选：' + ok.slice(1, 4).map(function (x) { return x.domain; }).join(' ') : '');
        finish(true, content, best.domain + ' 最优');
      });
    });
  }).catch(function (e) {
    finish(false, '脚本异常：' + e);
  });
}

function finish(ok, content, subtitle) {
  if (flag('notify')) {
    try {
      $notification.post('GitHub 下载加速', subtitle || (ok ? '测速完成' : '测速失败'), content || '');
    } catch (e) { /* ignore */ }
  }
  log((ok ? '完成：' : '失败：') + content);
  done();
}

main();
