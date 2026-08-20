// ==UserScript==
// @name         Sim Companies 聊天存档 · 词频统计
// @namespace    https://github.com/Hoshino-Saisho/simco-public
// @version      1.7.1
// @description  在聊天存档页面上统计多个关键词的出现分布：按小时、按天、按发送者、按房间；支持排除词、强词/弱词三档、自定时区、产品图标码转名字，可导出明细表格
// @author       —
// @match        https://simco-chat.cc.cd/*
// @match        https://simco-chat.garden-of-eden.workers.dev/*
// @match        https://hoshino-saisho.github.io/simco-public/*
// @grant        none
// @run-at       document-idle
// @noframes
// @homepageURL  https://hoshino-saisho.github.io/simco-public/
// @supportURL   https://github.com/Hoshino-Saisho/simco-public/issues
// @downloadURL  https://hoshino-saisho.github.io/simco-public/simco-chat-stats.user.js
// @updateURL    https://hoshino-saisho.github.io/simco-public/simco-chat-stats.user.js
// ==/UserScript==

/*
 * ⚠️ 上面那段 ==UserScript== 头里【只能有 `// @键 值` 这种行】。
 * 别在里面写普通注释 —— 油猴还能忍，但别的脚本管理器
 * （Violentmonkey / Greasemonkey）可能直接把整段元数据解析坏，
 * 表现是"装上了但一点反应都没有"，最难查。解释一律写在外面，就像这里。
 *
 * ------------------------- 自动更新是怎么工作的 -------------------------
 *
 * @updateURL   油猴定期去下这个文件，【只读上面那段头】，比对 @version
 * @downloadURL 发现有新版时，从这个地址下完整脚本
 *
 * 所以规矩只有一条：**每次改动都必须把 @version 往上加**。
 * 不加的话，代码发上去了也没有任何人会收到更新提示。
 *
 * 为什么地址用 github.io 而不是 raw.githubusercontent.com：
 * raw 那个域名在国内长期被 DNS 污染，而玩家基本都在国内 ——
 * github.io 是他们本来就打得开的（存档站就挂在上面）。
 *
 * 这两个地址指向的必须是【仓库里那一份】。改完本地文件记得推上去，
 * 否则版本号涨了、线上还是旧的，别人点更新会拿到和现在一样的东西。
 */

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
  /*
   * 「量太大了，确定继续吗」的阈值。
   *
   * ⚠️ 这两个数原来是 20,000 / 120,000 —— 那是【只有一两个房间】时定的。
   * 现在五个房间合计约 6,900 条/天，手机默认 7 天就是 48,300 条、
   * 电脑默认 30 天就是 207,000 条 —— 两边都超，于是每次统计都弹框。
   * 一个每次都弹的确认框等于没有确认框：人会闭着眼睛点「确定」，
   * 真正危险的那次也就跟着被点过去了。
   *
   * 重新按实测定：一条消息在堆里约 0.43 KB。
   *   手机  50,000 条 ≈ 22 MB，安全；真正有风险的量级在 30 万条以上
   *   电脑 250,000 条 ≈ 108 MB，桌面 Chrome 单标签页有 2~4 GB 可用
   * 这样框只在真的该拦的时候才出现。
   */
  function WARN_MSGS() { return isNarrow() ? 50000 : 250000; } // 超过就先问一句
  var FETCH_PARALLEL = 4;         // 同时拉几个日文件（和查看器保持一致）
  var NARROW_AT_RENDER = null;    // 上次渲染时是不是窄屏，用来判断要不要重画

  /* 房间的中文名。左边的 key 是数据里的房间标识（日文件路径就是 d/<key>/…），
     这张表只管显示。没配的显示 key 本身，将来加新房间也不会开天窗。 */
  var ROOM_LABEL = { SALES: '交易', SOCIAL: '社交', X: '航天交易', ENSALES: '英文交易' };
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

  /*
   * ============================ 产品图标码 ============================
   *
   * 聊天里的 :re-30: 是游戏内产品图标的 id。这里只把 id 翻成名字，
   * 不去还原图标：:re-30: → 能源研究
   *
   * 这张表和存档站查看器里的是【同一份】，逗号串、下标即 id、0 号占位。
   * 改一处两处都要改 —— 但这个代价换来的是 1.5 KB 而不是 3 KB 的 JSON。
   *
   * 为什么这个功能在统计插件里特别值：
   *   交易区的报价几乎全是图标码堆出来的（":re-97: 5000 @ 12.3"），
   *   不翻译的话你只能搜 "re-97"，得先去查 97 是什么。
   *   翻译之后搜「BFR」和搜「re-97」命中的是同一批消息。
   *
   * 空字符串 = 不知道这个 id 的名字（36~39 在原始表里就是 undefined）。
   * 查不到时【原样显示 :re-36:】，绝不显示空白或 "undefined"。
   */
  var PRODUCTS = (',电力,水,苹果,橘子,葡萄,谷物,牛排,香肠,鸡蛋,原油,汽油,柴油,运输单位,矿物,铝土矿,硅材,化合物,铝材,塑料,处理器,电子元件,电池,显示屏,智能手机,平板电脑,笔记本电脑,显示器,电视机,作物研究,能源研究,采矿研究,电器研究,畜牧研究,化学研究,软件,,,,,棉花,棉布,铁矿石,钢材,沙子,玻璃,皮革,车载电脑,电动马达,豪华车内饰,基本内饰,车身,内燃机,经济电动车,豪华电动车,经济燃油车,豪华燃油车,卡车,汽车研究,时装研究,内衣,手套,裙子,高跟鞋,手袋,运动鞋,种子,圣诞爆竹,金矿石,金条,名牌手表,项链,甘蔗,乙醇,甲烷,碳纤维,碳纤复合材,机身,机翼,精密电子元件,飞行计算机,座舱,姿态控制器,火箭燃料,燃料储罐,固体燃料助推器,火箭发动机,隔热板,离子推进器,喷气发动机,亚轨道二级火箭,亚轨道火箭,轨道助推器,星际飞船,BFR,喷气客机,豪华飞机,单引擎飞机,无人机,人造卫星,航空航天研究,钢筋混凝土,砖块,水泥,黏土,石灰石,木材,钢筋,木板,窗户,工具,建筑预构件,推土机,材料研究,机器人,牛,猪,牛奶,咖啡豆,咖啡粉,蔬菜,面包,芝士,苹果派,橙汁,苹果汁,姜汁汽水,披萨,面条,汉堡包,千层面,肉丸,混合果汁,面粉,黄油,糖,可可,面团,酱汁,动物饲料,巧克力,植物油,沙拉,咖喱角,圣诞装饰品,食谱,南瓜,杰克灯笼,女巫服,南瓜汤,树,复活节兔兔,斋月糖果,巧克力冰淇淋,苹果冰淇淋').split(',');

  // 带 /g 的正则；用之前一律先归零 lastIndex，所以可以安全共用一份
  var RE_ICON = /:[a-z0-9]+(?:-[a-z0-9]+)+:/gi;
  var RE_URL  = /https?:\/\/[^\s<>"']+/gi;

  /** :re-30: → '能源研究'；认不出来返回空串（调用方负责原样显示）。 */
  function productName(code) {
    var m = /^:re-(\d+):$/i.exec(code);
    if (!m) return '';                       // 别的前缀不翻译，原样留着
    return PRODUCTS[Number(m[1])] || '';
  }

  /**
   * 把正文里所有图标码对应的产品名拼成一串，供检索用。
   *
   * 在【读入那一刻】算一次，之后统计还是纯 indexOf ——
   * 不会因为多了这个功能就让每次搜索都变慢。
   */
  function iconNames(body) {
    if (body.indexOf(':') < 0) return '';    // 绝大多数消息在这里就返回了
    var out = '';
    body.replace(RE_ICON, function (m) {
      var n = productName(m);
      if (n) out += ' ' + n;
      return m;
    });
    return out;
  }

  /**
   * 把正文画进一个格子里：图标码显示成产品名，其余原样。
   *
   * ⚠️ 全程 createTextNode / textContent，一个 innerHTML 都没有 ——
   * 正文是玩家写的，里面可能有 <script>，那只能是普通文字。
   * 测试里的 DOM 桩会在任何人写 innerHTML 时直接抛异常，这条纪律是被钉死的。
   */
  function renderBody(parent, text) {
    var body = String(text || '');
    if (body.indexOf(':') < 0) {              // 绝大多数消息走这条捷径
      parent.appendChild(document.createTextNode(body));
      return;
    }
    // 先把网址整段切出来。https://x.com/a:re-30:b 里那段【不是】图标码，
    // 不先切就会把网址显示成 "https://x.com/a能源研究b"。查看器也是这个顺序。
    var segs = [];
    RE_URL.lastIndex = 0;
    var at = 0, u;
    while ((u = RE_URL.exec(body)) !== null) {
      if (u.index > at) segs.push({ url: false, s: body.slice(at, u.index) });
      segs.push({ url: true, s: u[0] });
      at = u.index + u[0].length;
    }
    if (at < body.length) segs.push({ url: false, s: body.slice(at) });

    segs.forEach(function (seg) {
      if (seg.url) { parent.appendChild(document.createTextNode(seg.s)); return; }
      RE_ICON.lastIndex = 0;
      var last = 0, m;
      while ((m = RE_ICON.exec(seg.s)) !== null) {
        if (m.index > last) {
          parent.appendChild(document.createTextNode(seg.s.slice(last, m.index)));
        }
        var pn = productName(m[0]);
        if (pn) {
          var chip = el('span', 'scs-emo', pn);
          chip.title = m[0];                  // 悬停看得到原始的 :re-30:
          parent.appendChild(chip);
        } else {
          // 认不出来就原样显示原始码 —— 绝不留空、更不能是 undefined
          parent.appendChild(document.createTextNode(m[0]));
        }
        last = m.index + m[0].length;
      }
      if (last < seg.s.length) {
        parent.appendChild(document.createTextNode(seg.s.slice(last)));
      }
    });
  }

  /** 把正文里的图标码换成 [产品名]，给 CSV 用（表格里走 renderBody）。 */
  function bodyForCSV(body) {
    if (body.indexOf(':') < 0) return body;
    RE_URL.lastIndex = 0;
    var out = '', at = 0, u;
    var conv = function (t) {
      RE_ICON.lastIndex = 0;
      return t.replace(RE_ICON, function (m) {
        var n = productName(m);
        return n ? '[' + n + ']' : m;        // 认不出来的原样留着
      });
    };
    while ((u = RE_URL.exec(body)) !== null) {
      out += conv(body.slice(at, u.index)) + u[0];   // 网址整段原样
      at = u.index + u[0].length;
    }
    return out + conv(body.slice(at));
  }

  /*
   * '房间|日期' -> 【原始 JSON 文本】，避免反复拉同一天。
   *
   * ⚠️ 这里存的是文本，不是 expand 之后的消息对象。差别很大：
   *   五个房间 × 30 天 ≈ 207,000 条
   *     存文本   约   4.9 MB
   *     存对象   约 150   MB   ← 差 30 倍
   * 换句话说，缓存对象的话，光是"为了第二次统计快一点"就要一直占着 150 MB。
   * 存文本再现场 JSON.parse + expand：parse 一整批只要 126 毫秒，
   * 而省下来的是 145 MB —— 这笔账怎么算都划算。
   *
   * 统计做完之后那批对象就没人引用了，会被回收；缓存里留下的只有文本。
   */
  var CACHE = new Map();          // '房间|日期' -> 日文件的原始 JSON 文本
  var INDEX = null;
  /*
   * 快通道（data/recent.json）里的消息，按房间分好。
   *
   * 为什么非要它不可：房间列表原本只从索引（日文件）里推，
   * 而【刚加的聊天室在整点那次完整发布之前根本没有日文件】——
   * 于是它压根不出现在房间选择里，你想选都选不到。
   * ENSALES 刚加上去时就是这个情况，看起来像"插件设置不了这个房间"。
   *
   * 存档站的查看器早就靠 recent 解决了同一个问题（indexRooms 会合并它），
   * 插件这边一直没跟上 —— 这就是那个缺口。
   *
   * 只对【索引里一天都没有的房间】用它，所以不会和日文件重复计数。
   * GitHub Pages 那条线路不生成这个文件，拿不到就当没有，行为退回原样。
   */
  var RECENT = {};                // 房间 -> 消息数组（只在没有日文件时才用）
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
  /*
   * 强词：这个词【必须】命中，否则整条不算。多个强词是【而且】的关系。
   *
   * 三档合起来是一句话：
   *     必须命中【全部】强词，并且至少命中一个非弱词。
   *
   * 场景（就是弱词那个例子再进一步）：搜 1 2 3 4 5，3/4/5 标成弱词之后，
   * 留下的消息"有 1 或有 2 或都有"。可你要的其实是"必须有 1"——
   * 把 1 标成强词：每条都必须有 1，可以顺带有 2，而 3/4/5 永远不会单独出现。
   *
   * 为什么多个强词是【而且】而不是【或者】：
   *   如果是"或者"，那把所有非弱词都标成强词，效果和"什么都不标"一模一样——
   *   这个档位就白加了。「而且」才是弱词做不到的那件事：
   *   搜 Creator / of / the / Creation，把 of、the 标弱，Creator、Creation 标强，
   *   得到的就是"两个都出现"的那一批，接近搜一个词组。
   *
   * 一个词不能同时是强词和弱词（那是自相矛盾的），切换时会自动互斥。
   */
  var STRONG = new Set();

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

  /** 同上，但拿原文 —— 日文件走这条，好把【文本】而不是对象放进缓存。 */
  function getText(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    });
  }

  /*
   * ================== 日文件可能是 gzip 存的（GitHub 那边） ==================
   *
   * GitHub Pages 的发布站点有 1 GB 硬上限，数的是文件本体：
   * 明文 345 MB/年（约 3 年满），gzip 54 MB/年（约 19 年）。
   * 所以 GitHub 上的日文件是 `.json.gz`。
   *
   * Cloudflare 那边不用管：Worker 带 Content-Encoding 返回，浏览器自己解。
   * GitHub Pages 不认预压缩文件，只能我们自己解。
   *
   * 判断依据是索引里的 enc 字段（GitHub 那份写 'gz'）——
   * ⚠️ 别靠域名猜，换个域名或套个 CDN 就错，而且错法是"静默读不到"。
   */
  function encSuffix() {
    return (INDEX && INDEX.enc === 'gz') ? '.gz' : '';
  }
  function canGunzip() {
    return typeof DecompressionStream !== 'undefined';
  }

  /*
   * 换格式之前发上去的天还是明文 `.json`，而且不会被自动重发
   * （发布端只重发"条数变了"的天）。索引一标 enc:'gz'，这些老天就全 404。
   * 所以 404 就回退到明文，并记住这一天，之后不再多敲一次 404。
   * ⚠️ 只有 404 回退 —— 断网不能把这一天永久标成明文。
   */
  var ENC_PLAIN = {};

  /** 取一个包的【原文】。压缩的就先解开 —— 返回的永远是 JSON 文本。 */
  function getPackText(url) {
    var suf = encSuffix();
    if (!suf || ENC_PLAIN[url]) return getText(url);
    if (!canGunzip()) {
      return Promise.reject(new Error(
        '这个浏览器不支持 gzip 解压（DecompressionStream），读不了压缩存档'));
    }
    return fetch(url + suf).then(function (r) {
      if (r.status === 404) { ENC_PLAIN[url] = true; return getText(url); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text();
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
        // 图标码对应的产品名，读入时算一次 —— 搜「BFR」和搜「re-97」都能命中
        icons: iconNames(String(r[ix.body] || '')),
        realm: (Number(r[ix.realm]) || 0) + 1,
        retracted: !!Number(r[ix.ret]),
        deleted: !!Number(r[ix.del]),
      };
    });
  }

  function loadDay(room, day, onDone) {
    var key = room + '|' + day;
    if (CACHE.has(key)) {
      var cached = CACHE.get(key);
      return Promise.resolve(cached ? expand(JSON.parse(cached)) : []);
    }
    return getPackText(dataURL('d/' + encodeURIComponent(room) + '/' +
                               encodeURIComponent(day) + '.json'))
      .then(function (txt) {
        CACHE.set(key, txt);
        return expand(JSON.parse(txt));
      })
      .catch(function () { CACHE.set(key, ''); return []; });
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

      // 正文 + 图标码翻出来的产品名。原始码也还在正文里，所以
      // 搜 ":re-97:"、搜 "re-97"、搜 "BFR" 命中的是同一批消息。
      var raw = m.body + (m.icons || '');
      var hay = opt.caseSensitive ? raw : raw.toLowerCase();
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
    // analyze 只管"扫正文"，弱词是【看结果时】才切换的，所以这里不传 ——
    // show() 每次都会带着当前的 WEAK 重新聚合一遍。
    return aggregate(hits, terms, msgs.length, excluded, null);
  }

  /**
   * 从命中列表算出全部统计。
   *
   * 单独拆出来是为了【点某个公司名只看他一个人】—— 那时候不用重新拉数据、
   * 也不用重新扫一遍正文，把已有的命中过滤一下再聚合就行，是瞬时的。
   */
  function aggregate(hits, terms, scanned, excluded, weak) {
    /*
     * 分布要【分词看】，而且各段必须互不重叠 —— 否则叠起来的总高度会超过
     * 实际命中条数，图就骗人了。
     *
     * 所以每条命中只归到【一个】类别：
     *   只命中 buy      → 归到 "buy"
     *   只命中 bfr      → 归到 "bfr"
     *   两个都命中      → 归到 "同时命中"（单独一类，不重复计入前两类）
     * 这样每根柱子的总高度 = 那个时段真实的命中条数，一分不多一分不少。
     *
     * ⚠️ 归类只看【硬词】，弱词完全不参与。这一条是补的，而且很关键：
     *
     * 以前归类看的是全部命中词，于是 "Creator of steel" 因为多命中了一个 of
     * 就被归进「同时命中 ≥2 个词」。可你把 of 点成弱词，说的就是
     * "它一个人说了不算" —— 那它当然也不该把一条本质上只命中 Creator 的消息
     * 抬进"同时命中"那一类。
     *
     * 更糟的是另一个后果：弱词自己那一类【必然恒等于 0】。
     * 因为"只命中这个弱词"的消息在上一步就被过滤掉了，
     * 剩下的每一条都至少还有一个硬词 —— 于是弱词永远归不到自己名下。
     * 图上看就是那根柱子一直是零，和"把这个词删掉"长得一模一样。
     * 这正是"弱词看起来还是排除词"的真正原因。
     *
     * 现在：弱词不进堆叠图的类别表（不再画一条恒零的线），
     * 但它在 perTerm 里【照常计数】—— 它还是搜到了，只是不单独成类。
     */
    weak = weak || new Set();
    var hard = terms.filter(function (t) { return !weak.has(t); });
    var cats = hard.slice();
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

      // 只用硬词决定归到哪一类；弱词上面已经计过数了，这里不参与
      var hh2 = [];
      for (var q = 0; q < h.terms.length; q++) {
        if (!weak.has(h.terms[q])) hh2.push(h.terms[q]);
      }
      var cat = hh2.length > 1 ? MULTI : (hh2.length === 1 ? hh2[0] : null);
      if (cat === null) return;            // 理论上到不了这里（过滤时已排除）
      onlyTerm[cat] = (onlyTerm[cat] || 0) + 1;
      if (hh2.length > 1) combo++;

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
      weakList: terms.filter(function (t) { return weak.has(t); }),
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
        csvCell(h.terms.join(' + ')), csvCell(bodyForCSV(m.body)),
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
    /*
     * 三档各有自己的颜色，光看颜色就能分开：
     *   强 = 金（实心感、加粗）      必须有
     *   普通 = 蓝（和面板主色一致）  可以有
     *   弱 = 紫（虚线下划线）        有也不单独算数
     *
     * ⚠️ 弱词原来是【灰 + 删除线】。那个样子的问题是：删除线在所有界面里
     * 都表示"已删除/已作废"，正好是弱词最容易被误解的那个意思。
     * 换成紫色 + 虚线下划线 —— 虚线读作"有条件"，不读作"被划掉了"。
     */
    '.scs-term.weak{background:rgba(196,181,253,.14);color:#c4b5fd;',
    'border-color:rgba(196,181,253,.45);',
    'text-decoration:underline dashed;text-underline-offset:3px;',
    'text-decoration-color:rgba(196,181,253,.7)}',
    '.scs-term.strong{background:rgba(251,191,36,.18);color:#fbbf24;',
    'border-color:rgba(251,191,36,.5);font-weight:600}',
    // 图例：一行一档，左边一个和真词条长得一样的小样，右边一句话
    '.scs-legend{margin-top:10px;display:flex;flex-direction:column;gap:6px}',
    '.scs-legend div{display:flex;align-items:center;gap:8px;',
    'color:#8b93a3;font-size:11.5px;line-height:1.4}',
    '.scs-legend .scs-chip{cursor:default;flex:0 0 auto;min-width:52px;text-align:center}',
    '.scs-warn{color:#fbbf24;font-size:11.5px;margin-top:8px}',
    '#scs td.scs-t{white-space:nowrap;color:#8b93a3;font-variant-numeric:tabular-nums}',
    '.scs-meta{margin-bottom:3px}',
    '.scs-tag.room{background:rgba(167,139,250,.16);color:#c4b5fd}',
    '.scs-emo{display:inline-block;padding:0 4px;border-radius:4px;',
    'background:rgba(134,239,172,.13);color:#86efac}',
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
      // 顺手拉一次快通道，好让还没进索引的新房间也能被选中。
      // 拉不到就当没有 —— 索引已经到手了，不能因为这一步失败就整个报错。
      return loadRecent().then(function () {
        // 数据是压缩存的、而这个浏览器解不了 —— 立刻说清楚。
        // 不然表现是"每天都读不到"，而提示写的是别的原因，会把人带偏。
        if (encSuffix() === '.gz' && !canGunzip()) {
          setMsg('这个浏览器不支持 gzip 解压（DecompressionStream），' +
                 '读不了压缩存档。请换 Chrome / Edge / Safari 16.4+ / ' +
                 'Firefox 113+ 或更新的版本。', true);
          return INDEX;
        }
        renderRooms();
        setMsg('索引就绪：' + INDEX.days.length + ' 个日文件，共 ' +
               (ix.total || 0).toLocaleString() + ' 条' +
               (recentOnlyRooms().length
                 ? '；另有 ' + recentOnlyRooms().map(roomLabel).join('、') +
                   ' 还没生成日文件，先用快通道里的最近一小包'
                 : ''));
        return INDEX;
      });
    }).catch(function (e) {
      setMsg('读不到索引：' + e.message + '（确认这个页面是存档站）', true);
      throw e;
    });
  }

  /**
   * 拉一次快通道。失败一律当作"没有"—— 它只是个补充来源，
   * 不能因为它挂了就把整个统计功能拖down（GitHub 那条线路本来就没有这个文件）。
   */
  // 同查看器：GitHub 上这个文件必然 404，问一次就够了，别每次开面板都问
  var HAS_RECENT = null;

  function loadRecent() {
    if (HAS_RECENT === false) { RECENT = {}; return Promise.resolve(RECENT); }
    return getPackText(dataURL('recent.json')).then(function (txt) {
      var rec = JSON.parse(txt);
      HAS_RECENT = true;
      var out = {};
      ((rec && rec.packs) || []).forEach(function (p) {
        var room = String(p.room || '');
        if (!room) return;
        out[room] = (out[room] || []).concat(expand(p));
      });
      RECENT = out;
      return RECENT;
    }).catch(function () {
      if (HAS_RECENT === null) HAS_RECENT = false;
      RECENT = {};
      return RECENT;
    });
  }

  /** 索引里一天都没有、只在快通道里出现过的房间 —— 刚加的聊天室就是这种。 */
  function recentOnlyRooms() {
    var has = {};
    ((INDEX && INDEX.days) || []).forEach(function (d) { has[d.room] = 1; });
    return Object.keys(RECENT).filter(function (r) {
      return !has[r] && RECENT[r] && RECENT[r].length;
    }).sort();
  }

  function renderRooms() {
    var box = $('#scs-rooms');
    if (!box) return;
    clear(box);
    var counts = {}, recentOnly = {};
    INDEX.days.forEach(function (d) { counts[d.room] = (counts[d.room] || 0) + (d.n || 0); });
    // 还没进索引的房间也要列出来，否则你根本无从选它。
    // 这是"插件设置不了新房间"那个 bug 的正解 —— 和查看器 indexRooms() 同一条规则。
    recentOnlyRooms().forEach(function (r) {
      counts[r] = RECENT[r].length;
      recentOnly[r] = 1;
    });
    Object.keys(counts).sort().forEach(function (r) {
      var c = el('div', 'scs-chip' + (picked.has(r) ? ' on' : ''),
                 roomLabel(r) + ' ' + counts[r].toLocaleString() +
                 (recentOnly[r] ? '（仅最近）' : ''));
      // 悬停看得到原始标识；新房间还要说清楚这个数字为什么这么小
      c.title = recentOnly[r]
        ? r + '：还没生成日文件（新房间要等下一次整点发布），\n' +
              '现在只有快通道里最近这一小包 —— 选它统计得到的就是这批'
        : r;
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

      // 还没有日文件的房间：它的消息只在快通道里。不特意带上的话，
      // 选中它就等于什么都没选 —— 那还是"设置不了这个房间"。
      // 天数上限不用另外卡：快通道本来就只覆盖最近一个多小时。
      var roRooms = recentOnlyRooms().filter(function (r) {
        return !wantRooms || wantRooms.has(r);
      });
      var recentMsgs = [];
      roRooms.forEach(function (r) {
        RECENT[r].forEach(function (m) { recentMsgs.push(m); });
      });

      if (!allDays.length && !recentMsgs.length) {
        setMsg('这个范围里没有数据', true); return;
      }

      var total = allDays.reduce(function (a, d) { return a + (d.n || 0); }, 0) +
                  recentMsgs.length;
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
      roRooms.forEach(function (r) {
        if (roomList.indexOf(r) < 0) roomList.push(r);
      });
      // 只选了新房间时一个日文件都没有，日期范围就从快通道的消息本身推
      if (!dayList.length && recentMsgs.length) {
        var ds = recentMsgs.map(function (m) { return dayOf(m.t); }).sort();
        dayList = [ds[0], ds[ds.length - 1]];
      }
      WEAK = new Set();          // 换了词就重新来过
      STRONG = new Set();
      SCOPE = {
        rooms: roomList.sort(),
        from: dayList[0], to: dayList[dayList.length - 1],
        files: allDays.length, indexTotal: total,
        picked: picked.size > 0, nDays: nDays, exclude: exclude,
        recentOnly: roRooms.slice(), recentN: recentMsgs.length,
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
        for (var k = 0; k < recentMsgs.length; k++) msgs.push(recentMsgs[k]);
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

    // 强词、弱词、发送者三道筛选都只是【过滤已有的命中再重新聚合】——
    // 不重新拉数据、不重新扫正文，所以点一下是瞬时的。
    var kept = LAST.hits;

    // ① 强词：必须【全部】命中。先做这一步，两个数才分得开 ——
    //    "强词滤掉多少"和"弱词滤掉多少"是调词时的两个独立反馈。
    var strongDropped = 0;
    if (STRONG.size) {
      var beforeS = kept.length;
      var need = [];
      STRONG.forEach(function (t) { need.push(t); });
      kept = kept.filter(function (h) {
        for (var k = 0; k < need.length; k++) {
          if (h.terms.indexOf(need[k]) < 0) return false;
        }
        return true;
      });
      strongDropped = beforeS - kept.length;
    }

    // ② 弱词：至少要命中一个非弱词。
    //    （有强词时这一步其实必然通过 —— 强词本身就是非弱词 —— 留着是为了
    //     只标弱词、不标强词的情形，也为了逻辑写全不留暗坑。）
    var weakDropped = 0;
    if (WEAK.size) {
      var before = kept.length;
      kept = kept.filter(function (h) {
        for (var i = 0; i < h.terms.length; i++) {
          if (!WEAK.has(h.terms[i])) return true;      // 有一个非弱词就留下
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
    SHOWN = aggregate(kept, terms, LAST.scanned, LAST.excluded, WEAK);
    SHOWN.weakDropped = weakDropped;
    SHOWN.strongDropped = strongDropped;

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
      // 新房间的数字小得吓人是正常的 —— 说清楚，别让人以为又坏了
      if (SCOPE.recentOnly && SCOPE.recentOnly.length) {
        sc.appendChild(el('div', 'scs-note',
          '⏱ ' + SCOPE.recentOnly.map(roomLabel).join('、') +
          ' 还没生成日文件（新房间要等下一次整点发布），' +
          '这里只统计了快通道里最近的 ' + SCOPE.recentN.toLocaleString() +
          ' 条 —— 不是全部历史。'));
      }
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
      wc.appendChild(el('h4', null, '关键词（点一下切换：普通 → 强 → 弱）'));

      var wrow = el('div', 'scs-chips');
      terms.forEach(function (t) {
        var weak = WEAK.has(t);
        var strong = STRONG.has(t);
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

        // ⚠️ 这里要用 res（= 筛完之后的 SHOWN），不是 LAST。
        // 用 LAST 的话，设成弱词之后数字纹丝不动，看起来像"设了没生效"；
        // 而它真正该显示的是"在留下来的消息里，这个词还命中了多少条" ——
        // 那个数【不是 0】，正是"弱词不等于排除词"的直接证据。
        var shownN = res.perTerm[t] || 0;
        var cls = strong ? ' strong' : (weak ? ' weak' : ' on');
        var mark = strong ? '强 ' : (weak ? '弱 ' : '');
        var chip = el('div', 'scs-chip scs-term' + cls, mark + t + '  ' + shownN);
        chip.title = strong
          ? '强词：每一条留下来的消息都【必须】含它。\n' +
            '多个强词是「而且」的关系 —— 全都要命中。\n' +
            '点一下变成弱词。'
          : weak
          ? '弱词：只靠它命中的那些消息已经去掉了。\n' +
            '留下来的消息里它仍然命中 ' + shownN + ' 条 —— 它还在搜，只是不单独算数。\n' +
            '点一下变回普通词。'
          : '普通词：能独立支撑一条消息算数。\n' +
            '点一下设为强词（每条都必须含它）；再点一下变成弱词' +
            '（只靠它命中的 ' + soloN + ' 条会被去掉）。';
        // 三档轮着切：普通 → 强 → 弱 → 普通。
        // 强和弱是互斥的 —— "必须有它"和"有它也不算数"不可能同时成立。
        chip.onclick = function () {
          if (STRONG.has(t)) { STRONG.delete(t); WEAK.add(t); }
          else if (WEAK.has(t)) { WEAK.delete(t); }
          else { STRONG.add(t); }
          show(terms);
          var b = $('#scs');
          if (b) b.scrollTop = 0;
        };
        wrow.appendChild(chip);
      });
      wc.appendChild(wrow);

      /*
       * 颜色图例。三个小样和真词条用的是【同一套 class】，
       * 所以以后改样式不会出现"图例和实际长得不一样"这种最气人的情况。
       */
      var lg = el('div', 'scs-legend');
      [['strong', '强', '每条都【必须】含它。多个强词是「而且」—— 全都要有。'],
       ['on',     '普通', '有它就算数。可有可无，但能独立支撑一条消息。'],
       ['weak',   '弱', '还在搜、还计数，但【只靠它命中的不算数】。≠ 排除词。']]
        .forEach(function (row) {
          var line = el('div');
          line.appendChild(el('span', 'scs-chip scs-term ' + row[0], row[1] + ' 词'));
          line.appendChild(el('span', null, row[2]));
          lg.appendChild(line);
        });
      wc.appendChild(lg);

      wc.appendChild(el('div', 'scs-note',
        '规则一句话：必须命中【全部强词】，并且至少命中一个【非弱词】。\n' +
        '例：搜 Creator / of / the / Creation，of 和 the 标弱、Creator 标强 —— ' +
        '每条都必须有 Creator，可以顺带有 Creation，' +
        '而只有 of / the 的永远进不来；留下的消息里 of 【照常计入上面的条数】。\n' +
        '「排除词」是另一回事：那是含了就整条不要，在上面的输入框里填。\n' +
        '恒为零的类别不画进下面的堆叠图（画出来只会是一条零线，看着像被删了），' +
        '但总览里的条数照常显示。'));

      if (WEAK.size === terms.length) {
        wc.appendChild(el('div', 'scs-warn',
          '⚠️ 所有词都是弱词了 —— 那就没有任何消息能满足条件。至少留一个非弱词。'));
      }
      if (STRONG.size > 1) {
        wc.appendChild(el('div', 'scs-note',
          '现在有 ' + STRONG.size + ' 个强词，是【而且】的关系：' +
          '一条消息要同时含全部 ' + STRONG.size + ' 个才留下。' +
          (res.hit === 0 ? ' 结果是 0 条，多半就是因为这几个词从来没同时出现过。' : '')));
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
    if (res.strongDropped) {
      statRow(c0, '强词滤掉（没有全部命中强词的）',
        res.strongDropped.toLocaleString() + ' 条');
    }
    if (res.weakDropped) {
      statRow(c0, '弱词滤掉（只靠弱词命中的）',
        res.weakDropped.toLocaleString() + ' 条');
    }
    statRow(c0, '命中消息', res.hit.toLocaleString() + ' 条' +
      (res.scanned ? '（' + (res.hit / res.scanned * 100).toFixed(2) + '%）' : ''));
    terms.forEach(function (t) {
      var all = res.perTerm[t] || 0, only = res.onlyTerm[t] || 0;
      var isWeak = WEAK.has(t);
      var isStrong = STRONG.has(t);
      statRow(c0, '　含「' + t + '」' + (isStrong ? ' 强' : (isWeak ? ' 弱' : '')),
        all.toLocaleString() + ' 条' +
        (isStrong
          // 强词必然出现在每一条里，所以"占比 100%"是废话，写它真正的含义
          ? '（强词：每条都必须含它，所以就是命中总数）'
          : isWeak
          // 弱词【没有】被排除掉，它只是不单独成一类。把这句写死在这里，
          // 因为"含 of：1 条"旁边如果还写"只含它 0 条"，看起来就像它被删了。
          ? '（弱词：不单独成类，但在留下的消息里照常计数）'
          : (terms.length > 1 ? '（其中只含它 ' + only.toLocaleString() + ' 条）' : '')));
    });
    if (terms.length > 1) {
      statRow(c0, '　同时命中 ≥2 个' + (WEAK.size ? '硬' : '') + '词',
        res.combo.toLocaleString() + ' 条');
      c0.appendChild(el('div', 'scs-note',
        '「含」这一列是重叠的（同时含两个词的两边都算），加起来会大于命中条数；' +
        '下面的图用的是互不重叠的分法。' +
        (WEAK.size
          ? '\n有弱词时，归类只看硬词 —— 一条只命中 Creator 的消息，' +
            '不会因为顺带含了个 of 就被算成「同时命中 ≥2 个词」。'
          : '')));
    }
    statRow(c0, '涉及发送者', res.senders.length.toLocaleString() + ' 人');
    out.appendChild(c0);

    if (!res.hit) {
      out.appendChild(el('div', 'scs-empty', '没有命中任何消息。'));
      return;
    }

    /*
     * 恒为零的类别不画。
     *
     * 这不是美化，是【防误读】：一根一直贴地的柱子和"这个词被删掉了"长得一样。
     * 什么时候会出现恒零的类别：
     *   · 标了强词之后 —— 每条都含强词，所以"只含某个普通词"这一类必然是 0
     *   · 某个词一条都没搜到
     * 两种情况下那一类都没有任何信息量，画出来只会误导。
     * 总览里那一行【照常显示】，所以数字不会凭空消失，只是不占图。
     */
    var drawCats = res.cats.filter(function (c) { return (res.onlyTerm[c] || 0) > 0; });
    var hiddenCats = res.cats.filter(function (c) { return !((res.onlyTerm[c] || 0) > 0); });
    if (!drawCats.length) drawCats = res.cats;      // 兜底：真一个都没有就照旧画

    // ---- 按小时（分词堆叠）----
    var hoursX = [];
    for (var hh = 0; hh < 24; hh++) hoursX.push(hh);
    var hoursBy = {};
    drawCats.forEach(function (c) {
      hoursBy[c] = {};
      (res.hoursBy[c] || []).forEach(function (n, i) { if (n) hoursBy[c][i] = n; });
    });

    var c1 = el('div', 'scs-card');
    c1.appendChild(el('h4', null, '按小时分布（' + tzLabel() + '）'));
    var hb = el('div');
    c1.appendChild(hb);
    stacked(hb, hoursX, drawCats, hoursBy, terms);
    legend(c1, drawCats, terms, res.onlyTerm);
    if (hiddenCats.length) {
      c1.appendChild(el('div', 'scs-note',
        '没画：' + hiddenCats.map(catLabel).join('、') +
        '（这些类别一条都没有 —— 有强词时，"只含某个普通词"必然是 0，' +
        '因为每条都还含着强词）。总览里的条数不受影响。'));
    }
    out.appendChild(c1);

    // ---- 按天（分词堆叠）----
    var dayKeys = Object.keys(res.days).sort();
    var c2 = el('div', 'scs-card');
    c2.appendChild(el('h4', null, '按天分布（' + dayKeys.length + ' 天，' + tzLabel() + '）'));
    var db = el('div');
    c2.appendChild(db);
    stacked(db, dayKeys, drawCats, res.daysBy, terms, { shortLabel: 5 });
    legend(c2, drawCats, terms, res.onlyTerm);
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
      renderBody(tdB, h.m.body);
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
