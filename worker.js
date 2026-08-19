// ==UserScript==
// @name         Sim Companies 聊天存档 · 词频统计
// @namespace    https://github.com/Hoshino-Saisho/simco-public
// @version      1.2.0
// @description  在聊天存档页面上统计多个关键词的出现分布：按小时、按天、按发送者、按房间；支持排除词、弱词、自定时区，可导出明细表格
// @author       —
// @match        https://simco-chat.cc.cd/*
// @match        https://simco-chat.garden-of-eden.workers.dev/*
// @match        https://hoshino-saisho.github.io/simco-public/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * ============================================================================
 * 这个脚本【完全独立】—— 存档站的代码一个字都没改，也不需要改。
 * ============================================================================
 *
 * 它是怎么拿到数据的
 * ---------------------------------------------------------------------------
 * 不扒 DOM，也不去读页面内存 —— 查看器整段代码包在 (function(){...})() 里，
 * 一个全局变量都没暴露，外面根本够不着。
 *
 * 改成自己去 fetch 那几个 JSON：
 *     data/index.json            索引：有哪些房间、哪些天、各多少条
 *     data/d/<房间>/<日期>.json   某天的全部消息
 * 同源请求，页面的 CSP（connect-src 'self'）放行，不需要 GM_xmlhttpRequest。
 *
 * 这样拿到的是结构化数据（id / 时间 / 公司 / 发送者 / 正文 / 领域），
 * 不是渲染后的文字，统计起来干净得多，也不会因为页面改版就失灵。
 *
 * 三个站点通用
 * ---------------------------------------------------------------------------
 * Cloudflare 两个域名和 GitHub Pages 用的是同一套路径结构。
 * GitHub Pages 挂在 /simco-public/ 子目录下，所以路径一律用【相对当前页面】
 * 解析（new URL(path, location.href)），三边都不用改。
 *
 * 安全
 * ---------------------------------------------------------------------------
 * 渲染聊天内容【完全不用 innerHTML】，一律 textContent / createTextNode ——
 * 和存档站本身同一套纪律。消息里就算写满 <script> 也只是普通文字。
 * ============================================================================
 */

(function () {
  'use strict';

  // ------------------------------------------------------------------ 常量
  /*
   * 手机和电脑的阈值不是一个量级 —— 一台手机载入几万条就可能被系统杀掉，
   * 而电脑上十几万条只是"慢一点"。所以这几个数按屏幕宽度分档，
   * 而不是全平台用同一个（那样必然对一边太松、对另一边太紧）。
   */
  function isNarrow() {
    try { return (window.innerWidth || 9999) <= 700; } catch (e) { return false; }
  }
  function DEFAULT_DAYS() { return isNarrow() ? 7 : 30; }
  function TABLE_LIMIT() { return isNarrow() ? 150 : 500; }   // 明细表行数（CSV 不受限）
  function WARN_MSGS() { return isNarrow() ? 20000 : 120000; } // 超过就先问一句
  var FETCH_PARALLEL = 4;         // 同时拉几个日文件（和查看器保持一致）
  var NARROW_AT_RENDER = null;    // 上次渲染时是不是窄屏，用来判断要不要重画

  /* 房间的中文名。左边的 key 是数据里的房间标识（日文件路径就是 d/<key>/…），
     这张表只管显示。没配的显示 key 本身，将来加新房间也不会开天窗。 */
  var ROOM_LABEL = { SALES: '交易', SOCIAL: '社交', X: '航天交易' };
  var MULTI = '\u0000multi';      // 「同时命中 ≥2 个词」这一类的内部键
  var PALETTE = ['#7dd3fc', '#86efac', '#fbbf24', '#f472b6', '#c4b5fd',
                 '#fb923c', '#34d399', '#a5b4fc', '#fda4af', '#fcd34d',
                 '#67e8f9', '#d8b4fe'];
  function catLabel(c) { return c === MULTI ? '同时命中 ≥2 个词' : c; }
  function catColor(c, terms) {
    if (c === MULTI) return '#e6e9ef';        // 白色，一眼区分于单词的彩色
    var i = terms.indexOf(c);
    return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
  }
  function roomLabel(r) { return ROOM_LABEL[r] || r; }

  var CACHE = new Map();          // '房间|日期' -> 消息数组，避免反复拉同一天
  var INDEX = null;
  var ABORT = false;
  var LAST = null;                // 完整结果（未按发送者筛选）
  var SHOWN = null;               // 当前正在看的结果（可能被发送者筛过）—— 导出的是它
  var SCOPE = null;               // 这次统计到底扫了哪些房间、哪段日期
  var VIEW_SID = null;            // 只看某个发送者；null = 全部
  /*
   * 弱词：搜是要搜的，但【只靠它命中不算数】。
   *
   * 场景：想找 "Creator of the Creation"，于是搜 Creator / of / the / Creation。
   * 可是 of 和 the 到处都是，光靠它俩命中的全是噪音。
   * 把 of 和 the 标成弱词之后，规则变成：
   *     一条消息至少要命中一个【非弱词】才算数
   * 只命中 of、只命中 the、只命中 of+the —— 全部丢掉；
   * 命中 Creator+of 的留下（因为 Creator 不是弱词）。
   *
   * 它和「排除词」是两回事：排除词是"含了就整条不要"，
   * 弱词是"这个词还要，只是它一个人说了不算"。
   */
  var WEAK = new Set();

  // ------------------------------------------------------------------ 工具
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function $(sel) { return document.querySelector(sel); }

  /** 相对当前页面解析 —— GitHub Pages 在子目录下，这样三个站点都对。 */
  function dataURL(path, bust) {
    var u = new URL('data/' + path, location.href);
    if (bust) u.searchParams.set('_', Date.now());
    return u.toString();
  }

  function getJSON(url, noStore) {
    return fetch(url, noStore ? { cache: 'no-store' } : {}).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /*
   * 时区。null = 跟浏览器本地时区走；否则是【相对 UTC 的分钟偏移】。
   *
   * 只认偏移量，不认地名 —— 不需要时区数据库，也就没有夏令时规则要维护。
   * 代价是选了 UTC+8 就一年到头都是 +8，对这个用途完全够。
   *
   * 所有拆时间的地方都走 parts()：小时分布、按天分布、明细表、导出的 CSV。
   * 少改一处就会出现"图按东八区、表按本地"这种最难发现的错。
   */
  var TZ_MIN = null;
  var TZ_KEY = 'simco.stats.tz';        // 单独的键，不碰查看器自己的 simco.pref

  function loadTZ() {
    try {
      var v = localStorage.getItem(TZ_KEY);
      if (v === null || v === '' || v === 'local') { TZ_MIN = null; return; }
      var n = Number(v);
      TZ_MIN = (isNaN(n) || n < -12 * 60 || n > 14 * 60) ? null : n;
    } catch (e) { TZ_MIN = null; }
  }
  function saveTZ() {
    try { localStorage.setItem(TZ_KEY, TZ_MIN == null ? 'local' : String(TZ_MIN)); }
    catch (e) { /* 存不了就算了 */ }
  }

  /** 当前时区的名字，写进「统计范围」里，免得结果截图出去说不清是哪个时区。 */
  function tzLabel() {
    if (TZ_MIN == null) {
      // 浏览器给的是"UTC 减本地"，符号和习惯相反，这里翻过来
      var off = -new Date().getTimezoneOffset();
      return '本地（' + offLabel(off) + '）';
    }
    return offLabel(TZ_MIN);
  }
  function offLabel(min) {
    var sign = min < 0 ? '−' : '+';
    var a = Math.abs(min);
    return 'UTC' + sign + Math.floor(a / 60) + (a % 60 ? ':' + pad(a % 60) : '');
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /** 按当前时区把时间戳拆开。之后所有格式化和分桶都只用它。 */
  function parts(t) {
    if (TZ_MIN == null) {
      var d = new Date(t);
      return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(),
               h: d.getHours(), mi: d.getMinutes() };
    }
    // 先把时间戳挪到目标时区，再一律用 UTC 读 —— 不依赖运行环境的本地时区
    var u = new Date(t + TZ_MIN * 60000);
    return { y: u.getUTCFullYear(), mo: u.getUTCMonth() + 1, d: u.getUTCDate(),
             h: u.getUTCHours(), mi: u.getUTCMinutes() };
  }

  function fmtTime(t) {
    var p = parts(t);
    return p.y + '-' + pad(p.mo) + '-' + pad(p.d) + ' ' + pad(p.h) + ':' + pad(p.mi);
  }
  function dayOf(t) {
    var p = parts(t);
    return p.y + '-' + pad(p.mo) + '-' + pad(p.d);
  }
  function hourOf(t) { return parts(t).h; }

  // ------------------------------------------------------------------ 取数
  /** 把日文件的列式数据摊平成对象。列名以文件里的 cols 为准，不写死顺序。 */
  function expand(pack) {
    var cols = pack.cols || [], ix = {};
    cols.forEach(function (c, i) { ix[c] = i; });
    var room = String(pack.room || '');
    return (pack.rows || []).map(function (r) {
      var t = Date.parse(r[ix.dt]);
      return {
        id: Number(r[ix.id]) || 0,
        room: room,
        t: isNaN(t) ? 0 : t,
        name: String(r[ix.co] || '(未知)'),
        sid: Number(r[ix.sid]) || 0,
        body: String(r[ix.body] || ''),
        realm: (Number(r[ix.realm]) || 0) + 1,
        retracted: !!Number(r[ix.ret]),
        deleted: !!Number(r[ix.del]),
      };
    });
  }

  function loadDay(room, day, onDone) {
    var key = room + '|' + day;
    if (CACHE.has(key)) return Promise.resolve(CACHE.get(key));
    return getJSON(dataURL('d/' + encodeURIComponent(room) + '/' +
                           encodeURIComponent(day) + '.json'))
      .then(function (pack) {
        var msgs = expand(pack);
        CACHE.set(key, msgs);
        return msgs;
      })
      .catch(function () { CACHE.set(key, []); return []; });
  }

  /** 顺序 N 路并发，边拉边报进度，可中断。 */
  function loadDays(items, onProgress) {
    var queue = items.slice(), out = [], done = 0;
    function worker() {
      if (ABORT) return Promise.resolve();
      var d = queue.shift();
      if (!d) return Promise.resolve();
      return loadDay(d.room, d.day).then(function (msgs) {
        out.push(msgs);
        done++;
        onProgress(done, items.length);
        return worker();
      });
    }
    var pool = [];
    for (var i = 0; i < Math.min(FETCH_PARALLEL, queue.length); i++) pool.push(worker());
    return Promise.all(pool).then(function () {
      var flat = [];
      out.forEach(function (a) { for (var i = 0; i < a.length; i++) flat.push(a[i]); });
      return flat;
    });
  }

  // ------------------------------------------------------------------ 统计
  /**
   * 一次扫描把所有统计都算出来。
   *
   * 关键词先统一转小写（除非勾了区分大小写），循环里只做 indexOf ——
   * 十几万条 × 几个词也就几十毫秒，不需要正则也不需要建索引。
   */
  function analyze(msgs, terms, opt) {
    var i, j;
    var norm = function (t) { return opt.caseSensitive ? t : t.toLowerCase(); };
    var keys = terms.map(norm);
    var bans = (opt.exclude || []).map(norm);
    var hits = [];
    var excluded = 0;

    for (i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (opt.skipRemoved && (m.retracted || m.deleted)) continue;

      var hay = opt.caseSensitive ? m.body : m.body.toLowerCase();
      if (opt.alsoName) hay += ' ' + (opt.caseSensitive ? m.name : m.name.toLowerCase());

      var matched = null;
      for (j = 0; j < keys.length; j++) {
        if (keys[j] && hay.indexOf(keys[j]) >= 0) (matched || (matched = [])).push(terms[j]);
      }
      if (!matched) continue;

      /*
       * 排除词：命中了，但含有排除词的整条丢掉。
       *
       * 放在【匹配之后】才判断，是为了能报出"滤掉了多少条" ——
       * 那个数就是你调排除词时唯一的反馈，没有它只能瞎试。
       * 一个词同时出现在关键词和排除词里时，排除赢（更符合直觉：想删就是想删）。
       */
      var banned = false;
      for (j = 0; j < bans.length; j++) {
        if (bans[j] && hay.indexOf(bans[j]) >= 0) { banned = true; break; }
      }
      if (banned) { excluded++; continue; }

      hits.push({ m: m, terms: matched });
    }
    return aggregate(hits, terms, msgs.length, excluded);
  }

  /**
   * 从命中列表算出全部统计。
   *
   * 单独拆出来是为了【点某个公司名只看他一个人】—— 那时候不用重新拉数据、
   * 也不用重新扫一遍正文，把已有的命中过滤一下再聚合就行，是瞬时的。
   */
  function aggregate(hits, terms, scanned, excluded) {
    /*
     * 分布要【分词看】，而且各段必须互不重叠 —— 否则叠起来的总高度会超过
     * 实际命中条数，图就骗人了。
     *
     * 所以每条命中只归到【一个】类别：
     *   只命中 buy      → 归到 "buy"
     *   只命中 bfr      → 归到 "bfr"
     *   两个都命中      → 归到 "同时命中"（单独一类，不重复计入前两类）
     * 这样每根柱子的总高度 = 那个时段真实的命中条数，一分不多一分不少。
     * 词再多也只有 N+1 类，不会爆炸。
     */
    var cats = terms.slice();
    cats.push(MULTI);

    var perTerm = {};        // 含这个词的条数（会重叠：同时含两个词的两边都算）
    var onlyTerm = {};       // 只含这个词的条数（互不重叠，就是上面那些类别）
    terms.forEach(function (t) { perTerm[t] = 0; onlyTerm[t] = 0; });
    onlyTerm[MULTI] = 0;

    var hoursBy = {}, daysBy = {};
    cats.forEach(function (c) { hoursBy[c] = new Array(24).fill(0); daysBy[c] = {}; });

    var hours = new Array(24).fill(0);
    var days = {}, rooms = {}, realms = {}, combo = 0;
    var senders = new Map();

    hits.forEach(function (h) {
      var m = h.m;
      h.terms.forEach(function (t) { perTerm[t] = (perTerm[t] || 0) + 1; });

      var cat = h.terms.length > 1 ? MULTI : h.terms[0];
      onlyTerm[cat] = (onlyTerm[cat] || 0) + 1;
      if (h.terms.length > 1) combo++;

      var hh = hourOf(m.t);
      var dk = dayOf(m.t);
      hours[hh]++;
      days[dk] = (days[dk] || 0) + 1;
      if (hoursBy[cat]) hoursBy[cat][hh]++;
      if (daysBy[cat]) daysBy[cat][dk] = (daysBy[cat][dk] || 0) + 1;

      rooms[m.room] = (rooms[m.room] || 0) + 1;
      realms[m.realm] = (realms[m.realm] || 0) + 1;

      var s = senders.get(m.sid);
      if (s) { s.n++; s.name = m.name; }
      else senders.set(m.sid, { sid: m.sid, name: m.name, n: 1 });
    });

    var senderList = [];
    senders.forEach(function (v) { senderList.push(v); });
    senderList.sort(function (a, b) { return b.n - a.n; });

    var sorted = hits.slice().sort(function (a, b) { return b.m.t - a.m.t; });  // 新的在前

    return {
      scanned: scanned, hit: sorted.length, combo: combo, excluded: excluded || 0,
      perTerm: perTerm, onlyTerm: onlyTerm, cats: cats,
      hours: hours, days: days, hoursBy: hoursBy, daysBy: daysBy,
      senders: senderList, rooms: rooms, realms: realms, hits: sorted,
    };
  }

  // ------------------------------------------------------------------ 画图
  /**
   * 分词堆叠柱状图。纯 div，不引任何库 —— 页面的 CSP 也不允许加载外部脚本。
   *
   * xs        横轴（小时或日期）
   * cats      类别（每个词 + 「同时命中」）
   * byCat     类别 -> (横轴值 -> 条数)
   * 各段互不重叠，所以每根柱子的总高度就是那一格真实的命中条数。
   */
  function stacked(box, xs, cats, byCat, terms, opt) {
    clear(box);
    if (!xs.length) { box.appendChild(el('div', 'scs-empty', '没有数据')); return; }

    var totals = xs.map(function (x) {
      var n = 0;
      cats.forEach(function (c) { n += (byCat[c] && byCat[c][x]) || 0; });
      return n;
    });
    var max = Math.max.apply(null, totals.concat([1]));

    var wrap = el('div', 'scs-bars');
    xs.forEach(function (x, i) {
      var col = el('div', 'scs-bar');
      var tip = [String(x) + '：共 ' + totals[i] + ' 条'];
      col.appendChild(el('div', 'scs-bar-n', totals[i] || ''));

      var stack = el('div', 'scs-stack');
      stack.style.height = Math.max(totals[i] ? 2 : 0,
        Math.round(totals[i] / max * 100)) + '%';
      // 从下往上按类别顺序堆
      cats.forEach(function (c) {
        var n = (byCat[c] && byCat[c][x]) || 0;
        if (!n) return;
        tip.push('  ' + catLabel(c) + '：' + n);
        var seg = el('div', 'scs-seg');
        seg.style.height = (n / totals[i] * 100) + '%';
        seg.style.background = catColor(c, terms);
        stack.appendChild(seg);
      });
      col.appendChild(stack);
      col.appendChild(el('div', 'scs-bar-x',
        opt && opt.shortLabel ? String(x).slice(opt.shortLabel) : String(x)));
      col.title = tip.join('\n');
      wrap.appendChild(col);
    });
    box.appendChild(wrap);
  }

  /** 图例。顺带把每一类的条数写出来，不用去数柱子。 */
  function legend(box, cats, terms, counts) {
    var lg = el('div', 'scs-legend');
    cats.forEach(function (c) {
      var n = (counts && counts[c]) || 0;
      if (!n) return;
      var item = el('span', 'scs-lg');
      var dot = el('i');
      dot.style.background = catColor(c, terms);
      item.appendChild(dot);
      item.appendChild(el('span', null, catLabel(c) + ' ' + n));
      lg.appendChild(item);
    });
    box.appendChild(lg);
    box.appendChild(el('div', 'scs-note',
      '各段互不重叠：同时命中多个词的算「同时命中」那一类，不重复计入单词。' +
      '所以每根柱子的高度 = 那一格真实的命中条数。'));
  }

  /** 单色柱状图（现在只有需要时才用）。 */
  function bars(box, entries, opt) {
    clear(box);
    if (!entries.length) { box.appendChild(el('div', 'scs-empty', '没有数据')); return; }
    var max = 0;
    entries.forEach(function (e) { if (e[1] > max) max = e[1]; });
    if (!max) max = 1;

    var wrap = el('div', 'scs-bars');
    entries.forEach(function (e) {
      var col = el('div', 'scs-bar');
      col.title = e[0] + '：' + e[1] + ' 条';
      var fill = el('div', 'scs-bar-fill');
      fill.style.height = Math.max(2, Math.round(e[1] / max * 100)) + '%';
      if (e[1] === max) fill.classList.add('scs-peak');
      col.appendChild(el('div', 'scs-bar-n', e[1] || ''));
      col.appendChild(fill);
      col.appendChild(el('div', 'scs-bar-x', opt && opt.shortLabel
        ? String(e[0]).slice(opt.shortLabel) : e[0]));
      wrap.appendChild(col);
    });
    box.appendChild(wrap);
  }

  /** 可点的公司名 —— 点一下就只看这个人发的，和网页版的行为一致。 */
  function who(name, sid, terms) {
    var a = el('span', 'scs-who', name);
    a.title = '只看 ' + name + ' 发的（ID ' + sid + '）';
    a.onclick = function () {
      VIEW_SID = (VIEW_SID === sid) ? null : sid;   // 再点一次取消
      show(terms);
      var box = $('#scs');
      if (box) box.scrollTop = 0;
    };
    return a;
  }

  function statRow(box, label, value) {
    var r = el('div', 'scs-stat');
    r.appendChild(el('span', null, label));
    r.appendChild(el('b', null, value));
    box.appendChild(r);
  }

  // ------------------------------------------------------------------ CSV
  function toCSV(res) {
    var lines = ['时间(' + tzLabel() + '),房间,公司,发送者ID,领域,命中词,内容'];
    res.hits.forEach(function (h) {
      var m = h.m;
      lines.push([
        fmtTime(m.t), m.room, csvCell(m.name), m.sid, 'R' + m.realm,
        csvCell(h.terms.join(' + ')), csvCell(m.body),
      ].join(','));
    });
    return '﻿' + lines.join('\r\n');    // BOM，Excel 打开中文不乱码
  }
  function csvCell(s) {
    s = String(s == null ? '' : s);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function download(name, text) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  // ------------------------------------------------------------------ 界面
  var CSS = [
    '#scs-fab{position:fixed;right:18px;bottom:18px;z-index:99998;width:44px;height:44px;',
    'border-radius:12px;background:#1b1f2a;color:#7dd3fc;border:1px solid rgba(255,255,255,.14);',
    'cursor:pointer;font-size:18px;line-height:44px;text-align:center;font-family:inherit;',
    'box-shadow:0 6px 20px rgba(0,0,0,.45)}',
    '#scs-fab:hover{border-color:#7dd3fc}',
    '#scs{position:fixed;inset:auto 18px 74px auto;z-index:99999;width:min(860px,calc(100vw - 36px));',
    'max-height:calc(100vh - 110px);overflow:auto;background:#12151d;color:#e6e9ef;',
    'border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:16px;display:none;',
    'font:13px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;',
    'box-shadow:0 18px 50px rgba(0,0,0,.55)}',
    '#scs.on{display:block}',
    '#scs h3{margin:0 0 4px;font-size:14px}',
    '#scs .scs-sub{color:#8b93a3;font-size:11.5px;margin-bottom:12px}',
    '#scs label{display:block;color:#8b93a3;font-size:11.5px;margin:10px 0 4px}',
    '#scs input[type=text],#scs select{width:100%;padding:7px 9px;background:#1b1f2a;color:#e6e9ef;',
    'border:1px solid rgba(255,255,255,.1);border-radius:7px;font-size:13px;font-family:inherit}',
    '#scs input:focus,#scs select:focus{outline:none;border-color:#7dd3fc}',
    '.scs-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}',
    '.scs-row>div{flex:1;min-width:130px}',
    '.scs-btn{padding:7px 14px;background:#1b1f2a;color:#e6e9ef;border:1px solid rgba(255,255,255,.12);',
    'border-radius:7px;cursor:pointer;font-size:12.5px;font-family:inherit}',
    '.scs-btn:hover:not(:disabled){border-color:rgba(255,255,255,.3)}',
    '.scs-btn:disabled{opacity:.45;cursor:default}',
    '.scs-btn.pri{background:rgba(125,211,252,.16);border-color:rgba(125,211,252,.45);color:#7dd3fc}',
    '.scs-chips{display:flex;gap:5px;flex-wrap:wrap}',
    '.scs-chip{padding:3px 10px;border-radius:999px;background:#1b1f2a;color:#8b93a3;',
    'border:1px solid rgba(255,255,255,.1);font-size:12px;cursor:pointer;user-select:none}',
    '.scs-chip.on{background:rgba(125,211,252,.16);border-color:#7dd3fc;color:#7dd3fc}',
    '.scs-opts{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;color:#8b93a3;font-size:12px}',
    '.scs-opts label{display:flex;align-items:center;gap:5px;margin:0;cursor:pointer}',
    '.scs-opts input{accent-color:#7dd3fc;margin:0}',
    '#scs-msg{margin:10px 0;color:#8b93a3;font-size:12px;min-height:18px}',
    '#scs-msg.err{color:#f87171}',
    '.scs-card{background:#161a23;border:1px solid rgba(255,255,255,.07);border-radius:10px;',
    'padding:12px;margin-top:12px}',
    '.scs-card h4{margin:0 0 10px;font-size:12px;color:#8b93a3;font-weight:600;letter-spacing:.5px}',
    '.scs-stat{display:flex;justify-content:space-between;padding:2px 0;color:#8b93a3}',
    '.scs-stat b{color:#e6e9ef;font-variant-numeric:tabular-nums}',
    '.scs-bars{display:flex;align-items:flex-end;gap:3px;height:120px;overflow-x:auto;padding-top:14px}',
    '.scs-bar{flex:1;min-width:15px;display:flex;flex-direction:column;justify-content:flex-end;',
    'align-items:center;height:100%;position:relative}',
    '.scs-bar-fill{width:100%;background:rgba(125,211,252,.35);border-radius:3px 3px 0 0;min-height:2px}',
    '.scs-stack{width:100%;display:flex;flex-direction:column-reverse;',
    'border-radius:3px 3px 0 0;overflow:hidden;min-height:2px}',
    '.scs-seg{width:100%;min-height:1px}',
    '.scs-legend{display:flex;gap:12px;flex-wrap:wrap;margin-top:10px;font-size:11.5px;color:#8b93a3}',
    '.scs-lg{display:flex;align-items:center;gap:5px}',
    '.scs-lg i{width:9px;height:9px;border-radius:2px;display:inline-block;flex:0 0 auto}',

    /* ---------------- 手机 ---------------- */
    /* 700px 以下铺满全屏。手机上"悬浮小窗"是最难用的形态：
       内容挤成一条，还老是误触到底下的页面。 */
    '@media (max-width:700px){',
    '  #scs{inset:0;width:100vw;max-height:none;height:100dvh;border-radius:0;',
    '       border:0;padding:14px 12px calc(14px + env(safe-area-inset-bottom));',
    '       -webkit-overflow-scrolling:touch}',
    '  #scs-fab{right:12px;bottom:calc(12px + env(safe-area-inset-bottom));',
    '           width:48px;height:48px;line-height:48px}',
    /* 输入框字号 <16px 时某些浏览器会自动放大页面，一放大就再也缩不回去 */
    '  #scs input[type=text],#scs select{font-size:16px;padding:9px 10px}',
    '  .scs-row>div{flex:1 1 100%;min-width:0}',
    '  .scs-btn{padding:9px 14px;font-size:13px}',      /* 手指够得着 */
    '  .scs-chip{padding:5px 12px;font-size:13px}',
    '  .scs-opts{gap:10px}',
    '  .scs-opts label{flex:1 1 100%}',
    '  .scs-bars{height:100px;gap:2px}',
    '  .scs-bar{min-width:11px}',                        /* 24 根柱子要能塞进一屏 */
    '  .scs-bar-n{font-size:9px}',
    '  .scs-bar-x{font-size:9px}',
    '  .scs-tw{max-height:none}',                        /* 别做表内滚动，整页滚更好用 */
    '  #scs table{font-size:12.5px}',
    '  #scs th,#scs td{padding:6px 4px}',
    '  #scs td.scs-body{max-width:none}',
    '  #scs td.scs-t{font-size:11px;white-space:normal}',
    '}',
    '.scs-bar-fill.scs-peak{background:rgba(125,211,252,.75)}',
    '.scs-bar-n{font-size:9.5px;color:#666e7e;font-variant-numeric:tabular-nums;height:12px}',
    '.scs-bar-x{font-size:9.5px;color:#666e7e;margin-top:3px;white-space:nowrap}',
    '.scs-empty{color:#666e7e;font-size:12px;padding:8px 0}',
    '#scs table{width:100%;border-collapse:collapse;font-size:12px;margin-top:4px}',
    '#scs th{text-align:left;color:#8b93a3;font-weight:600;padding:5px 6px;',
    'border-bottom:1px solid rgba(255,255,255,.1);position:sticky;top:0;background:#161a23}',
    '#scs td{padding:5px 6px;border-bottom:1px solid rgba(255,255,255,.05);vertical-align:top}',
    '#scs td.scs-body{word-break:break-word;white-space:pre-wrap;max-width:380px}',
    '.scs-tw{max-height:340px;overflow:auto;margin-top:8px}',
    '.scs-tag{display:inline-block;font-size:10px;padding:0 5px;border-radius:4px;',
    'background:rgba(125,211,252,.14);color:#7dd3fc;margin-right:3px}',
    '.scs-term{font-variant-numeric:tabular-nums}',
    '.scs-term.weak{opacity:.55;text-decoration:line-through;',
    'text-decoration-color:rgba(255,255,255,.4)}',
    '.scs-warn{color:#fbbf24;font-size:11.5px;margin-top:8px}',
    '#scs td.scs-t{white-space:nowrap;color:#8b93a3;font-variant-numeric:tabular-nums}',
    '.scs-meta{margin-bottom:3px}',
    '.scs-tag.room{background:rgba(167,139,250,.16);color:#c4b5fd}',
    '.scs-who{cursor:pointer;border-bottom:1px dashed rgba(255,255,255,.25)}',
    '.scs-who:hover{color:#7dd3fc;border-bottom-color:#7dd3fc}',
    '.scs-note{color:#666e7e;font-size:11.5px;margin-top:8px;line-height:1.5}',
    '.scs-filter{display:flex;align-items:center;gap:6px;margin-top:12px;padding:8px 12px;',
    'background:rgba(125,211,252,.1);border:1px solid rgba(125,211,252,.3);border-radius:10px}',
    '.scs-dim{color:#666e7e;font-size:11.5px}',
  ].join('');

  function buildUI() {
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var fab = el('button', null, '📊');
    fab.id = 'scs-fab';
    fab.title = '词频统计';
    document.body.appendChild(fab);

    var box = el('div');
    box.id = 'scs';
    box.appendChild(el('h3', null, '词频统计'));
    box.appendChild(el('div', 'scs-sub',
      '直接读存档的 JSON，不改页面任何东西。多个词用空格或逗号分开。'));

    var row = el('div', 'scs-row');

    var c1 = el('div');
    c1.appendChild(el('label', null, '关键词（空格或逗号分隔）'));
    var q = el('input');
    q.type = 'text'; q.id = 'scs-q'; q.placeholder = '例如：buy bfr';
    c1.appendChild(q);
    row.appendChild(c1);

    var c2 = el('div');
    c2.appendChild(el('label', null, '范围'));
    var days = el('select');
    days.id = 'scs-days';
    [[7, '最近 7 天'], [30, '最近 30 天'], [90, '最近 90 天'], [0, '全部（慢）']]
      .forEach(function (o) {
        var op = el('option', null, o[1]);
        op.value = o[0];
        if (o[0] === DEFAULT_DAYS()) op.selected = true;
        days.appendChild(op);
      });
    c2.appendChild(days);
    row.appendChild(c2);

    var c3 = el('div');
    c3.appendChild(el('label', null, '时区（影响按小时/按天和表里的时间）'));
    var tz = el('select');
    tz.id = 'scs-tz';
    // 只列偏移量，不列地名 —— 不需要时区数据库，也没有夏令时规则要维护
    var TZS = [['local', '本地时区']];
    [-720, -660, -600, -570, -540, -480, -420, -360, -300, -270, -240, -210, -180,
     -120, -60, 0, 60, 120, 180, 210, 240, 270, 300, 330, 345, 360, 390, 420, 480,
     525, 540, 570, 600, 630, 660, 720, 765, 780, 840].forEach(function (m) {
      TZS.push([String(m), offLabel(m)]);
    });
    TZS.forEach(function (o) {
      var op = el('option', null, o[1]);
      op.value = o[0];
      if ((TZ_MIN == null && o[0] === 'local') || String(TZ_MIN) === o[0]) op.selected = true;
      tz.appendChild(op);
    });
    tz.onchange = function () {
      TZ_MIN = (tz.value === 'local') ? null : Number(tz.value);
      saveTZ();
      // 已经有结果就地重算 —— 换时区不用重新拉数据
      if (LAST) show(LAST.termList || []);
    };
    c3.appendChild(tz);
    row.appendChild(c3);

    box.appendChild(row);

    box.appendChild(el('label', null, '排除词（含这些词的消息整条不算，空格或逗号分隔）'));
    var xq = el('input');
    xq.type = 'text'; xq.id = 'scs-x';
    xq.placeholder = '例如：wtb 求购 —— 留空则不排除';
    box.appendChild(xq);

    box.appendChild(el('label', null, '房间（不选=全部）'));
    var chips = el('div', 'scs-chips');
    chips.id = 'scs-rooms';
    box.appendChild(chips);

    var opts = el('div', 'scs-opts');
    [['scs-case', '区分大小写', false],
     ['scs-name', '也搜公司名', false],
     ['scs-rm', '排除已撤回/已删除', true]].forEach(function (o) {
      var l = el('label');
      var cb = el('input');
      cb.type = 'checkbox'; cb.id = o[0]; cb.checked = o[2];
      l.appendChild(cb);
      l.appendChild(el('span', null, o[1]));
      opts.appendChild(l);
    });
    box.appendChild(opts);

    var btns = el('div', 'scs-row');
    btns.style.marginTop = '12px';
    var go = el('button', 'scs-btn pri', '开始统计');
    go.id = 'scs-go'; go.style.flex = '0 0 auto';
    var stop = el('button', 'scs-btn', '中断');
    stop.id = 'scs-stop'; stop.style.flex = '0 0 auto'; stop.disabled = true;
    var csv = el('button', 'scs-btn', '导出 CSV');
    csv.id = 'scs-csv'; csv.style.flex = '0 0 auto'; csv.disabled = true;
    var close = el('button', 'scs-btn', '关闭');
    close.style.flex = '0 0 auto'; close.style.marginLeft = 'auto';
    btns.appendChild(go); btns.appendChild(stop); btns.appendChild(csv); btns.appendChild(close);
    box.appendChild(btns);

    box.appendChild(el('div', null, '')).id = 'scs-msg';
    var out = el('div');
    out.id = 'scs-out';
    box.appendChild(out);

    document.body.appendChild(box);

    fab.onclick = function () {
      box.classList.toggle('on');
      if (box.classList.contains('on')) { ensureIndex(); q.focus(); }
    };
    close.onclick = function () { box.classList.remove('on'); };
    go.onclick = run;
    stop.onclick = function () { ABORT = true; setMsg('正在中断…'); };
    csv.onclick = function () {
      if (!SHOWN) return;
      download('simco-词频-' + Date.now() + '.csv', toCSV(SHOWN));
    };
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
    xq.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
  }

  function setMsg(t, isErr) {
    var m = $('#scs-msg');
    if (!m) return;
    m.textContent = t || '';
    m.className = isErr ? 'err' : '';
  }

  // ------------------------------------------------------------------ 索引
  var picked = new Set();

  function ensureIndex() {
    if (INDEX) return Promise.resolve(INDEX);
    setMsg('读取索引…');
    return getJSON(dataURL('index.json', true), true).then(function (ix) {
      INDEX = ix;
      INDEX.days = (ix.days || []).filter(function (d) { return (d.n || 0) > 0; });
      renderRooms();
      setMsg('索引就绪：' + INDEX.days.length + ' 个日文件，共 ' +
             (ix.total || 0).toLocaleString() + ' 条');
      return INDEX;
    }).catch(function (e) {
      setMsg('读不到索引：' + e.message + '（确认这个页面是存档站）', true);
      throw e;
    });
  }

  function renderRooms() {
    var box = $('#scs-rooms');
    if (!box) return;
    clear(box);
    var counts = {};
    INDEX.days.forEach(function (d) { counts[d.room] = (counts[d.room] || 0) + (d.n || 0); });
    Object.keys(counts).sort().forEach(function (r) {
      var c = el('div', 'scs-chip' + (picked.has(r) ? ' on' : ''),
                 roomLabel(r) + ' ' + counts[r].toLocaleString());
      c.title = r;                    // 悬停看得到原始标识
      c.onclick = function () {
        if (picked.has(r)) picked.delete(r); else picked.add(r);
        renderRooms();
      };
      box.appendChild(c);
    });
  }

  // ------------------------------------------------------------------ 主流程
  function splitTerms(v) {
    return String(v || '').split(/[\s,，]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  function run() {
    var terms = splitTerms($('#scs-q').value);
    var exclude = splitTerms($('#scs-x').value);
    if (!terms.length) { setMsg('先填至少一个关键词', true); return; }
    if (terms.length > 12) { setMsg('一次最多 12 个关键词', true); return; }
    if (exclude.length > 30) { setMsg('排除词最多 30 个', true); return; }

    ensureIndex().then(function () {
      var nDays = Number($('#scs-days').value) || 0;
      var wantRooms = picked.size ? picked : null;

      // 索引是按「房间|日期」倒序排的，所以这里按日期自己算界线，
      // 不能直接 slice —— 那样会只拿到排在最前面那个房间的天。
      var allDays = INDEX.days.filter(function (d) {
        return !wantRooms || wantRooms.has(d.room);
      });
      if (nDays > 0) {
        var cutoff = new Date(Date.now() - nDays * 86400000).toISOString().slice(0, 10);
        allDays = allDays.filter(function (d) { return d.day >= cutoff; });
      }
      if (!allDays.length) { setMsg('这个范围里没有数据', true); return; }

      var total = allDays.reduce(function (a, d) { return a + (d.n || 0); }, 0);
      if (total > WARN_MSGS() &&
          !confirm('将读取 ' + total.toLocaleString() + ' 条消息（' +
                   allDays.length + ' 个文件）。\n数据量较大，可能会卡一会儿。\n\n继续吗？')) {
        return;
      }

      var dayList = allDays.map(function (d) { return d.day; }).sort();
      var roomList = [];
      allDays.forEach(function (d) {
        if (roomList.indexOf(d.room) < 0) roomList.push(d.room);
      });
      WEAK = new Set();          // 换了词就重新来过
      SCOPE = {
        rooms: roomList.sort(),
        from: dayList[0], to: dayList[dayList.length - 1],
        files: allDays.length, indexTotal: total,
        picked: picked.size > 0, nDays: nDays, exclude: exclude,
      };
      VIEW_SID = null;

      ABORT = false;
      $('#scs-go').disabled = true;
      $('#scs-stop').disabled = false;
      $('#scs-csv').disabled = true;
      clear($('#scs-out'));

      var t0 = Date.now();
      loadDays(allDays, function (done, all) {
        setMsg('读取中 ' + done + '/' + all + ' 个文件…');
      }).then(function (msgs) {
        if (ABORT) { setMsg('已中断（已读到的会留在缓存里，下次更快）'); return; }
        setMsg('统计中…');
        var res = analyze(msgs, terms, {
          caseSensitive: $('#scs-case').checked,
          alsoName: $('#scs-name').checked,
          skipRemoved: $('#scs-rm').checked,
          exclude: exclude,
        });
        LAST = res;
        LAST.termList = terms;        // 换时区时要用它重新渲染
        VIEW_SID = null;
        show(terms);
        $('#scs-csv').disabled = res.hits.length === 0;
        setMsg('扫了 ' + res.scanned.toLocaleString() + ' 条，命中 ' +
               res.hit.toLocaleString() + ' 条' +
               (res.excluded ? '（排除词又滤掉 ' + res.excluded.toLocaleString() + ' 条）' : '') +
               '，耗时 ' +
               ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');
      }).catch(function (e) {
        setMsg('出错了：' + e.message, true);
      }).then(function () {
        $('#scs-go').disabled = false;
        $('#scs-stop').disabled = true;
      });
    }).catch(function () { /* 索引那步已经报过了 */ });
  }

  // ------------------------------------------------------------------ 渲染
  /** 按当前的发送者筛选决定要展示哪一份，然后画出来。 */
  function show(terms) {
    if (!LAST) return;

    // 弱词和发送者两道筛选都只是【过滤已有的命中再重新聚合】——
    // 不重新拉数据、不重新扫正文，所以点一下是瞬时的。
    var kept = LAST.hits;
    var weakDropped = 0;
    if (WEAK.size) {
      var before = kept.length;
      kept = kept.filter(function (h) {
        for (var i = 0; i < h.terms.length; i++) {
          if (!WEAK.has(h.terms[i])) return true;      // 有一个硬词就留下
        }
        return false;                                   // 全靠弱词命中的，丢
      });
      weakDropped = before - kept.length;
    }
    if (VIEW_SID != null) {
      kept = kept.filter(function (h) { return h.m.sid === VIEW_SID; });
    }

    // 每次都重新聚合，不走"没筛就直接用 LAST"的捷径 ——
    // 换时区时命中集合没变，但小时/按天要重新分桶，走捷径就不会更新。
    SHOWN = aggregate(kept, terms, LAST.scanned, LAST.excluded);
    SHOWN.weakDropped = weakDropped;

    render(SHOWN, terms);
    $('#scs-csv').disabled = SHOWN.hits.length === 0;
  }

  function render(res, terms) {
    NARROW_AT_RENDER = isNarrow();
    var out = $('#scs-out');
    clear(out);

    // ---- 统计范围：明确说清楚这些数字是【哪一批数据】算出来的 ----
    if (SCOPE) {
      var sc = el('div', 'scs-card');
      sc.appendChild(el('h4', null, '统计范围'));
      statRow(sc, '房间',
        (SCOPE.picked ? '' : '全部｜') +
        SCOPE.rooms.map(roomLabel).join('、'));
      statRow(sc, '日期', SCOPE.from + ' ～ ' + SCOPE.to +
        '（' + SCOPE.files + ' 个日文件）');
      if (SCOPE.exclude && SCOPE.exclude.length) {
        statRow(sc, '排除词', SCOPE.exclude.join('、'));
      }
      statRow(sc, '时区', tzLabel());
      if (SCOPE.nDays > 0) {
        sc.appendChild(el('div', 'scs-note',
          '⚠️ 只统计了最近 ' + SCOPE.nDays + ' 天。想看全部历史，把「范围」改成「全部」再跑一次。'));
      } else {
        sc.appendChild(el('div', 'scs-note',
          '这是存档里这些房间的【全部】历史。'));
      }
      out.appendChild(sc);
    }

    // ---- 关键词开关：哪些词「单独出现时不算」 ----
    if (terms.length > 1) {
      var wc = el('div', 'scs-card');
      wc.appendChild(el('h4', null, '关键词（点一下切换「弱词」）'));

      var wrow = el('div', 'scs-chips');
      terms.forEach(function (t) {
        var weak = WEAK.has(t);
        // 这个词【单独】能撑起多少条 —— 就是把它设成弱词会掉多少
        var soloN = 0;
        LAST.hits.forEach(function (h) {
          var onlyWeakElse = true, hasT = false;
          for (var i = 0; i < h.terms.length; i++) {
            if (h.terms[i] === t) { hasT = true; continue; }
            if (!WEAK.has(h.terms[i])) onlyWeakElse = false;
          }
          if (hasT && onlyWeakElse) soloN++;
        });

        var chip = el('div', 'scs-chip scs-term' + (weak ? ' weak' : ' on'),
                      (weak ? '弱 ' : '') + t + '  ' + (LAST.perTerm[t] || 0));
        chip.title = weak
          ? '现在是弱词：只靠它命中的不算。点一下改回硬词。'
          : '点一下设为弱词 —— 只靠它命中的 ' + soloN + ' 条会被去掉';
        chip.onclick = function () {
          if (WEAK.has(t)) WEAK.delete(t); else WEAK.add(t);
          show(terms);
          var b = $('#scs');
          if (b) b.scrollTop = 0;
        };
        wrow.appendChild(chip);
      });
      wc.appendChild(wrow);

      wc.appendChild(el('div', 'scs-note',
        '弱词 = 这个词还搜，但【只靠它命中的不算】。' +
        '一条消息至少要命中一个非弱词才留下。\n' +
        '比如搜 Creator / of / the / Creation，把 of 和 the 点成弱词：' +
        '只有 of、只有 the、只有 of+the 的全丢掉，Creator+of 的留下。'));

      if (WEAK.size === terms.length) {
        wc.appendChild(el('div', 'scs-warn',
          '⚠️ 所有词都是弱词了 —— 那就没有任何消息能满足条件。至少留一个硬词。'));
      }
      out.appendChild(wc);
    }

    // ---- 发送者筛选条 ----
    if (VIEW_SID != null) {
      var f = el('div', 'scs-filter');
      // ⚠️ 别叫 who —— 那是下面要用的函数名，var 会把整个 render 里的它遮掉
      var whoName = (res.senders[0] && res.senders[0].name) || ('ID ' + VIEW_SID);
      f.appendChild(el('span', null, '只看：'));
      f.appendChild(el('b', null, whoName));
      f.appendChild(el('span', 'scs-dim', '（ID ' + VIEW_SID + '）'));
      var x = el('button', 'scs-btn', '✕ 取消筛选');
      x.style.marginLeft = 'auto';
      x.onclick = function () { VIEW_SID = null; show(terms); };
      f.appendChild(x);
      out.appendChild(f);
    }

    // ---- 总览 ----
    var c0 = el('div', 'scs-card');
    c0.appendChild(el('h4', null, '总览'));
    statRow(c0, '扫描消息', res.scanned.toLocaleString() + ' 条');
    if (res.excluded) {
      statRow(c0, '排除词滤掉', res.excluded.toLocaleString() + ' 条');
    }
    if (res.weakDropped) {
      statRow(c0, '弱词滤掉（只靠弱词命中的）',
        res.weakDropped.toLocaleString() + ' 条');
    }
    statRow(c0, '命中消息', res.hit.toLocaleString() + ' 条' +
      (res.scanned ? '（' + (res.hit / res.scanned * 100).toFixed(2) + '%）' : ''));
    terms.forEach(function (t) {
      var all = res.perTerm[t] || 0, only = res.onlyTerm[t] || 0;
      statRow(c0, '　含「' + t + '」',
        all.toLocaleString() + ' 条' +
        (terms.length > 1 ? '（其中只含它 ' + only.toLocaleString() + ' 条）' : ''));
    });
    if (terms.length > 1) {
      statRow(c0, '　同时命中 ≥2 个词', res.combo.toLocaleString() + ' 条');
      c0.appendChild(el('div', 'scs-note',
        '「含」这一列是重叠的（同时含两个词的两边都算），加起来会大于命中条数；' +
        '下面的图用的是互不重叠的分法。'));
    }
    statRow(c0, '涉及发送者', res.senders.length.toLocaleString() + ' 人');
    out.appendChild(c0);

    if (!res.hit) {
      out.appendChild(el('div', 'scs-empty', '没有命中任何消息。'));
      return;
    }

    // ---- 按小时（分词堆叠）----
    var hoursX = [];
    for (var hh = 0; hh < 24; hh++) hoursX.push(hh);
    var hoursBy = {};
    res.cats.forEach(function (c) {
      hoursBy[c] = {};
      (res.hoursBy[c] || []).forEach(function (n, i) { if (n) hoursBy[c][i] = n; });
    });

    var c1 = el('div', 'scs-card');
    c1.appendChild(el('h4', null, '按小时分布（' + tzLabel() + '）'));
    var hb = el('div');
    c1.appendChild(hb);
    stacked(hb, hoursX, res.cats, hoursBy, terms);
    legend(c1, res.cats, terms, res.onlyTerm);
    out.appendChild(c1);

    // ---- 按天（分词堆叠）----
    var dayKeys = Object.keys(res.days).sort();
    var c2 = el('div', 'scs-card');
    c2.appendChild(el('h4', null, '按天分布（' + dayKeys.length + ' 天，' + tzLabel() + '）'));
    var db = el('div');
    c2.appendChild(db);
    stacked(db, dayKeys, res.cats, res.daysBy, terms, { shortLabel: 5 });
    legend(c2, res.cats, terms, res.onlyTerm);
    out.appendChild(c2);

    // ---- 房间 / 领域 ----
    var c3 = el('div', 'scs-card');
    c3.appendChild(el('h4', null, '房间与领域'));
    Object.keys(res.rooms).sort().forEach(function (r) {
      statRow(c3, roomLabel(r), res.rooms[r].toLocaleString() + ' 条');
    });
    Object.keys(res.realms).sort().forEach(function (r) {
      statRow(c3, 'R' + r, res.realms[r].toLocaleString() + ' 条');
    });
    out.appendChild(c3);

    // ---- 发送者 ----
    var c4 = el('div', 'scs-card');
    c4.appendChild(el('h4', null, '发送者排行（前 30）'));
    var tw = el('div', 'scs-tw');
    var t4 = el('table');
    var narrowS = isNarrow();
    var hr = el('tr');
    (narrowS ? ['#', '公司', '条数'] : ['#', '公司', '发送者 ID', '条数', '占比'])
      .forEach(function (h) { hr.appendChild(el('th', null, h)); });
    t4.appendChild(hr);
    res.senders.slice(0, 30).forEach(function (s, i) {
      var tr = el('tr');
      tr.appendChild(el('td', null, i + 1));
      var tdN = el('td');
      tdN.appendChild(who(s.name, s.sid, terms));
      tr.appendChild(tdN);
      if (!narrowS) tr.appendChild(el('td', null, s.sid));
      tr.appendChild(el('td', null, s.n +
        (narrowS ? '（' + (s.n / res.hit * 100).toFixed(0) + '%）' : '')));
      if (!narrowS) tr.appendChild(el('td', null, (s.n / res.hit * 100).toFixed(1) + '%'));
      t4.appendChild(tr);
    });
    tw.appendChild(t4);
    c4.appendChild(tw);
    out.appendChild(c4);

    // ---- 明细 ----
    var c5 = el('div', 'scs-card');
    var limit = TABLE_LIMIT();
    var shown = Math.min(res.hits.length, limit);
    c5.appendChild(el('h4', null, '明细（显示最新 ' + shown +
      ' 条，共 ' + res.hits.length + ' 条；导出 CSV 是全量）'));
    var narrow = isNarrow();
    var tw2 = el('div', 'scs-tw');
    var t5 = el('table');
    var hr2 = el('tr');
    // 窄屏只留三列：房间和命中词折进「内容」格里，用小标签显示。
    // 靠 CSS 隐藏列的话，那两项信息就彻底看不到了 —— 折进去才是真适配。
    (narrow ? ['时间', '公司', '内容'] : ['时间', '房间', '公司', '命中', '内容'])
      .forEach(function (h) { hr2.appendChild(el('th', null, h)); });
    t5.appendChild(hr2);

    res.hits.slice(0, limit).forEach(function (h) {
      var tr = el('tr');
      tr.appendChild(el('td', 'scs-t', fmtTime(h.m.t)));
      if (!narrow) {
        var tdR = el('td', null, roomLabel(h.m.room));
        tdR.title = h.m.room;
        tr.appendChild(tdR);
      }
      var tdC = el('td');
      tdC.appendChild(who(h.m.name, h.m.sid, terms));
      tr.appendChild(tdC);
      if (!narrow) {
        var tdT = el('td');
        h.terms.forEach(function (t) { tdT.appendChild(el('span', 'scs-tag', t)); });
        tr.appendChild(tdT);
      }
      var tdB = el('td', 'scs-body');
      if (narrow) {
        var meta = el('div', 'scs-meta');
        meta.appendChild(el('span', 'scs-tag room', roomLabel(h.m.room)));
        h.terms.forEach(function (t) { meta.appendChild(el('span', 'scs-tag', t)); });
        tdB.appendChild(meta);
      }
      // 正文一律 textContent / createTextNode —— 绝不 innerHTML
      tdB.appendChild(document.createTextNode(h.m.body));
      tr.appendChild(tdB);
      t5.appendChild(tr);
    });
    tw2.appendChild(t5);
    c5.appendChild(tw2);
    out.appendChild(c5);
  }

  // ------------------------------------------------------------------ 启动
  function boot() {
    if (document.getElementById('scs-fab')) return;   // 别装两次
    loadTZ();
    buildUI();

    // 转屏或改窗口宽度时，如果跨过了那条 700px 的界线就重画一次 ——
    // 表格是按宽度决定列数的（不是靠 CSS 藏列），不重画就还是旧的列。
    var t = null;
    try {
      window.addEventListener('resize', function () {
        if (t) clearTimeout(t);
        t = setTimeout(function () {
          if (!SHOWN || NARROW_AT_RENDER === isNarrow()) return;
          render(SHOWN, (LAST && LAST.termList) || []);
        }, 200);
      });
    } catch (e) { /* 没有 window 就算了（测试环境） */ }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();


