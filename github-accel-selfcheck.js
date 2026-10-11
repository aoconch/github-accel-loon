/**
 * github-accel-selfcheck.js —— Loon generic 脚本（在 Loon「脚本」页手动点运行）
 *
 * 一键体检，分辨「下载没被加速」到底是哪种原因：
 *   ① 还没跑过测速（gh_accel_best 为空）→ 这是最常见原因，改写脚本会直接放行
 *   ② 最优节点已失效（存的域名现在拉不动）
 *   ③ 链路正常 → 那问题就在 MITM / 脚本触发层（给出具体检查项）
 *
 * 无参数，直接运行即可。
 */

var KEY_BEST = 'gh_accel_best';
var UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/* 用于链路自检的小文件（与测速脚本同款） */
var TEST_URL = 'https://raw.githubusercontent.com/microsoft/vscode/refs/heads/main/resources/linux/code.png';

function readJSON(key) {
  try {
    var s = $persistentStore.read(key);
    if (!s) return null;
    return JSON.parse(s);
  } catch (e) { return null; }
}

function httpGet(url, timeoutMs) {
  return new Promise(function (resolve) {
    var opt = {
      url: url,
      timeout: timeoutMs,
      node: 'DIRECT',   // 与改写后的请求走同一通道，才叫“体检”
      headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' }
    };
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
        resolve({ ok: status >= 200 && status < 300, status: status, ms: ms, bytes: len });
      });
    } catch (e) {
      resolve({ ok: false, err: String(e), ms: Date.now() - t0 });
    }
  });
}

function finish(content, subtitle) {
  try { $notification.post('GitHub 加速自检', subtitle || '', content || ''); } catch (e) { /* ignore */ }
  try { console.log('[GH加速自检] ' + subtitle + ' | ' + content); } catch (e) { /* ignore */ }
  $done();
}

function main() {
  var best = readJSON(KEY_BEST);

  // ---- ① 最常见：从来没跑过测速 ----
  if (!best || !best.domain) {
    finish(
      '✗ 还没跑过测速，这就是改写不生效的原因。\n' +
      '改写脚本读不到最优节点时会直接放行（不报错、也不加速）。\n' +
      '现在去「脚本」页运行「GitHub加速节点测速」，弹通知后再试下载。'
    );
    return;
  }

  var ageH = best.testedAt ? ((Date.now() - best.testedAt) / 3600000) : -1;
  var ageTxt = ageH >= 0 ? (ageH < 1 ? Math.round(ageH * 60) + ' 分钟前' : Math.round(ageH) + ' 小时前') : '未知';

  // ---- ② 实测加速链路（DIRECT 直连最优节点拉 GitHub 文件）----
  httpGet('https://' + best.domain + '/' + TEST_URL + '?t=' + Date.now(), 8000).then(function (r) {
    var head = '当前最优：' + best.domain + '（' + ageTxt + '测速）\n' +
      '记录指标：延迟 ' + best.latency + 'ms' + (best.speed > 0 ? ' · ' + best.speed + 'Mbps' : '') + '\n';

    if (r.ok && r.bytes > 0) {
      finish(
        head +
        '✓ 链路自检通过：经该节点拉取 GitHub 文件成功（' + r.status + '，' + r.bytes + 'B，' + r.ms + 'ms）\n\n' +
        '如果下载仍然没被加速，问题在「脚本是否被触发」，逐项检查：\n' +
        '1. MITM 页面的 hostname 里是否含 raw.githubusercontent.com、github.com、codeload.github.com\n' +
        '2. 证书是否已安装并在 iOS「证书信任设置」中开启信任\n' +
        '3. 插件里「GitHub下载加速」这条 http-request 脚本是否为启用状态\n' +
        '4. 是否装的是最新版插件（点插件右上的更新）',
        '链路正常'
      );
    } else {
      finish(
        head +
        '✗ 链路自检失败：' + (r.err ? r.err : ('HTTP ' + r.status)) + '（' + r.ms + 'ms）\n' +
        '该节点现在拉不动 GitHub 文件，需要重新选节点。\n' +
        '去「脚本」页运行「GitHub加速节点测速」重选；若测速也全失败，多半是当前网络环境到这些镜像都不通。'
      );
    }
  });
}

main();
