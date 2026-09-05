// ==UserScript==
// @name         Sim Companies 聊天存档 · 词频统计
// @namespace    https://github.com/Hoshino-Saisho/simco-public
// @version      1.16.0
// @description  聊天存档增强：① 词频统计（按小时/天/发送者/房间，支持排除词、强弱词三档、自定时区、图标码转名字、导出 CSV）② 销售办公室合同对比 —— 把多张单子并排摆开，比时利和利润率 ③ 餐馆优化器 —— 扫价格/服务/评分，画曲线和热力图，直接指出利润最高那一档
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
  /*
   * ⚠️ 左边的 key 是数据的一部分（日文件路径 d/<key>/日期.json），改不得；
   * 这张表只管【显示】。房间叫 ZH、页面上写「游戏」，是两件事。
   */
  var ROOM_LABEL = { ZH: '游戏', SALES: '交易', SOCIAL: '社交',
                     X: '航天交易', ENSALES: '英文交易' };
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

    /* ---------------- 合同对比 ---------------- */
    /* 第二个悬浮键，叠在词频那个上面。只在计算器模式下显示。 */
    '#scs-rest{position:fixed;right:18px;bottom:122px;z-index:99998;width:44px;height:44px;',
    '  border-radius:50%;border:1px solid var(--line,#243244);cursor:pointer;',
    '  background:var(--panel,#111823);color:var(--tx,#e8eef7);font-size:18px;',
    /*
     * ⚠️ 这里【不能】写 display:none。
     *
     *   显隐是用 style.display 控的，而"显示"那一步如果写成
     *   `style.display = ''`，清掉的只是**行内**样式 —— 它会落回 CSS，
     *   也就是落回这句 display:none，于是**永远不亮**。
     *   旁边那个 #scs-cmp 之所以一直好用，正是因为它的 CSS 里没有这句。
     *
     *   现在两头都改硬了：CSS 里不写，显示时也明确写 'block' 而不是 ''。
     */
    '  box-shadow:0 6px 20px rgba(0,0,0,.4)}',
    '#scs-restwin{position:fixed;right:18px;bottom:172px;z-index:99997;',
    '  width:min(660px,calc(100vw - 36px));max-height:min(76vh,760px);overflow:auto;',
    '  background:var(--panel,#111823);color:var(--tx,#e8eef7);border-radius:12px;',
    '  border:1px solid var(--line,#243244);box-shadow:0 18px 50px rgba(0,0,0,.55);',
    '  padding:14px 16px;font-size:13px;display:none}',
    '#scs-restwin h3{margin:0 0 4px;font-size:15px}',
    '#scs-restwin .sub{color:var(--mut,#93a4bd);font-size:11.5px;line-height:1.6;',
    '  white-space:pre-wrap;margin-bottom:8px}',
    '#scs-restwin .got{display:flex;flex-wrap:wrap;gap:6px 14px;margin:8px 0;',
    '  padding:8px 10px;border:1px solid var(--line,#243244);border-radius:9px}',
    '#scs-restwin .got span b{color:var(--acc,#7dd3fc);font-weight:700}',
    '#scs-restwin .free{display:flex;flex-wrap:wrap;gap:8px;align-items:center;',
    '  margin:8px 0;padding:8px 10px;border:1px solid var(--acc,#7dd3fc);border-radius:9px}',
    '#scs-restwin input[type=number]{width:82px;padding:4px 6px;border-radius:6px;',
    '  border:1px solid var(--line,#243244);background:var(--panel2,#0d141d);',
    '  color:var(--tx,#e8eef7);font-family:inherit}',
    '#scs-restwin canvas{display:block;width:100%;margin:8px 0;border-radius:9px;',
    '  border:1px solid var(--line,#243244);background:var(--panel2,#0d141d);',
    '  touch-action:none;cursor:grab}',
    '#scs-restwin .best{padding:8px 11px;border-radius:9px;margin:8px 0;',
    '  border:1px solid var(--ok,#86efac);background:rgba(134,239,172,.08)}',
    '#scs-restwin .best b{color:var(--ok,#86efac)}',
    '#scs-restwin .warn{color:var(--warn,#facc15);font-size:11.5px;line-height:1.6;',
    '  white-space:pre-wrap}',
    '#scs-restwin .tabs{display:flex;gap:6px;margin:6px 0}',
    '#scs-restwin .tabs button{padding:4px 10px;border-radius:7px;cursor:pointer;',
    '  border:1px solid var(--line,#243244);background:var(--panel2,#0d141d);',
    '  color:var(--mut,#93a4bd);font-family:inherit;font-size:12px}',
    '#scs-restwin .tabs button.on{border-color:var(--acc,#7dd3fc);color:var(--acc,#7dd3fc)}',
    '#scs-restwin .chk{display:inline-flex;align-items:center;gap:4px;cursor:pointer;',
    '  font-size:12px;color:var(--tx,#e8eef7)}',
    '#scs-restwin .mrw{color:var(--warn,#facc15)}',
    /* 分档表：数字列右对齐，不然一眼看不出哪个大 */
    '#scs-restwin table.qt{border-collapse:collapse;width:100%;font-size:11.5px;',
    '  margin:6px 0}',
    '#scs-restwin table.qt th,#scs-restwin table.qt td{padding:3px 6px;text-align:right;',
    '  border-bottom:1px solid var(--line,#243244);white-space:nowrap}',
    '#scs-restwin table.qt th:first-child,#scs-restwin table.qt td:first-child,',
    '#scs-restwin table.qt th:last-child,#scs-restwin table.qt td:last-child{text-align:left}',
    '#scs-restwin table.qt th{color:var(--mut,#93a4bd);font-weight:600}',
    /* 「这一轮拿到的品质」和「整仓平均」不一样的那几行标出来 —— 这块面板的全部意义 */
    '#scs-restwin table.qt tr.hit td{color:var(--acc,#7dd3fc)}',
    '#scs-restwin table.qt tr.mrw td{color:var(--warn,#facc15)}',
    '#scs-cmp{position:fixed;right:18px;bottom:70px;z-index:99998;width:44px;height:44px;',
    'border-radius:12px;background:#1b1f2a;color:#fbbf24;border:1px solid rgba(251,191,36,.4);',
    'cursor:pointer;font-size:17px;line-height:44px;text-align:center;font-family:inherit;',
    'box-shadow:0 6px 20px rgba(0,0,0,.45)}',
    '#scs-cmp:hover{border-color:#fbbf24}',
    /* 开了几个窗就在角上标几 —— 窗口拖到屏幕外面时这是唯一的线索 */
    '#scs-cmp[data-n]:not([data-n=""])::after{content:attr(data-n);position:absolute;',
    'top:-6px;right:-6px;min-width:17px;height:17px;line-height:17px;font-size:10.5px;',
    'border-radius:9px;background:#fbbf24;color:#12151d;font-weight:700}',
    '#scs-wins{position:fixed;inset:0;z-index:99990;pointer-events:none}',
    '.scs-win,#scs-cmpbar{position:absolute;pointer-events:auto;width:356px;',
    'background:#12151d;border:1px solid rgba(251,191,36,.35);border-radius:11px;',
    'box-shadow:0 16px 42px rgba(0,0,0,.6);',
    'font:12px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;',
    'color:#e6e9ef}',
    '#scs-cmpbar{display:none;position:fixed;z-index:99991;width:290px;',
    'border-color:rgba(125,211,252,.45)}',
    '#scs-cmpbar.on{display:block}',
    '.scs-wh{display:flex;align-items:center;gap:6px;padding:5px 6px 5px 9px;',
    'border-bottom:1px solid rgba(255,255,255,.08);cursor:move;user-select:none;',
    'background:rgba(251,191,36,.10);border-radius:11px 11px 0 0;touch-action:none}',
    '#scs-cmpbar .scs-wh{background:rgba(125,211,252,.12)}',
    /* 名字可以改：「航天那张 / 便宜那张」比「单子 1 / 单子 2」好认得多 */
    'input.scs-wname{flex:1;min-width:0;background:transparent;border:0;padding:2px 3px;',
    'color:#fbbf24;font-size:12px;font-weight:700;font-family:inherit;border-radius:5px}',
    'input.scs-wname:hover{background:rgba(255,255,255,.06)}',
    'input.scs-wname:focus{outline:none;background:rgba(255,255,255,.09)}',
    'span.scs-wname{flex:1;font-size:12px;font-weight:700;color:#7dd3fc}',
    '.scs-wx{width:22px;height:22px;line-height:1;padding:0;border-radius:6px;',
    'background:transparent;color:#666e7e;border:1px solid rgba(255,255,255,.12);',
    'cursor:pointer;font-size:13px;font-family:inherit;flex:0 0 auto}',
    '.scs-wx:hover:not(:disabled){border-color:#f87171;color:#f87171}',
    '.scs-wx:disabled{opacity:.3;cursor:default}',
    '.scs-wb{padding:8px 9px 10px}',
    '.scs-wg{display:grid;gap:6px;grid-template-columns:repeat(2,minmax(0,1fr))}',
    '.scs-cf label{display:block;color:#8b93a3;font-size:10px;margin:0 0 2px}',
    '.scs-win input,#scs-cmpbar input{width:100%;padding:4px 6px;background:#1b1f2a;',
    'color:#e6e9ef;border:1px solid rgba(255,255,255,.1);border-radius:6px;',
    'font-size:12px;font-family:inherit;font-variant-numeric:tabular-nums}',
    '.scs-win input:focus{outline:none;border-color:#fbbf24}',
    '.scs-wtw{overflow-x:auto;margin-top:8px}',
    '.scs-win table,#scs-cmpbar table{border-collapse:collapse;width:100%;font-size:11.5px}',
    '.scs-win th,#scs-cmpbar th{font-size:9.5px;color:#666e7e;font-weight:600;',
    'text-align:left;padding:0 3px 4px;white-space:nowrap;border:0;background:none;position:static}',
    '.scs-win td,#scs-cmpbar td{padding:2px 3px;border:0;color:#8b93a3;white-space:nowrap}',
    '.scs-win td input{width:58px}',
    '#scs-cmpbar td{color:#e6e9ef;padding:3px 4px}',
    '#scs-cmpbar td.scs-n{text-align:right;font-variant-numeric:tabular-nums}',
    '#scs-cmpbar td.scs-n.win{color:#86efac;font-weight:700}',
    '.scs-wadd{margin-top:7px;padding:3px 9px;font-size:11.5px}',
    '.scs-wk{display:grid;gap:6px;margin-top:9px;grid-template-columns:repeat(2,minmax(0,1fr))}',
    '.scs-wkpi{background:#1b1f2a;border:1px solid rgba(255,255,255,.08);border-radius:8px;',
    'padding:6px 8px;min-width:0}',
    '.scs-wkpi.big{grid-column:1 / -1}',
    '.scs-wkk{font-size:10px;color:#666e7e}',
    '.scs-wkv{font-size:13px;margin-top:1px;font-variant-numeric:tabular-nums;',
    'word-break:break-all}',
    '.scs-wkpi.big .scs-wkv{font-size:19px;font-weight:700}',
    '.scs-wkpi.good .scs-wkv{color:#86efac}',
    '.scs-wkpi.bad .scs-wkv{color:#f87171}',
    /* 两个第一名各标一个边 —— 不合成一个总分，见 cmpRenderBar 的注释 */
    '.scs-wkpi.win{border-color:rgba(134,239,172,.55);background:rgba(134,239,172,.08)}',
    '.scs-wnote{color:#666e7e;font-size:10.5px;margin-top:8px;line-height:1.5}',
    '@media (max-width:700px){',
    /* 手机上两个悬浮键都往上抬，避开底部安全区和浏览器自己的工具条 */
    '  #scs-cmp{right:12px;bottom:calc(70px + env(safe-area-inset-bottom));',
    '           width:48px;height:48px;line-height:48px}',
    /* 小窗铺到接近整宽：356 在窄屏上会有一半露在外面，拖都拖不回来 */
    '  .scs-win{width:calc(100vw - 24px)}',
    '  #scs-cmpbar{width:calc(100vw - 24px)}',
    '  .scs-win input,#scs-cmpbar input{font-size:16px}',
    '  .scs-win td input{width:64px}',
    '}',
  ].join('');


  /*
   * ==========================================================================
   *                      合同对比（销售办公室）
   * ==========================================================================
   *
   * 存档站上的计算器只算【一张单子】。这一块是把几张单子同时摆出来比 ——
   * 每张一个可拖动的小窗，另有一个「对比」窗把它们按时利和利润率排好。
   *
   * 为什么放在插件里而不是页面里：**这是进阶功能，不该是打开网页就有的。**
   * 页面那边负责"这张单子能不能做"，插件负责"这几张里挑哪张"。
   *
   * ---- 数据从哪来 ----
   *
   * 读 localStorage 的 `simco.calc` —— 那是页面计算器自己存的那份，
   * 同源，插件直接就能读。字段是页面那边定的契约（两边都写了注释）：
   *
   *     { hours, wage, bonus, target, items: [{ q, p, quality, cost }] }
   *     值全是【字符串】（输入框原文，'1.' 这种中间状态也原样存着）
   *
   * 分裂出来之后这份数据就【复制成插件自己的】了，存在 `scs.cmp`，
   * 页面再怎么改都不会动到它 —— 那正是对比要的：定住几个快照。
   *
   * ---- 公式和页面必须一致 ----
   *
   * 这里重写了一遍 calcContract。重复是有代价的（两边会飘），
   * 但插件够不着页面的函数（页面整段包在 IIFE 里，一个全局都没露）。
   * 所以两边的测试**用同一组数字**钉着：
   *     1 个、单价 84470、奖励 1.85%、q4、成本 77000、工资 31620、47 小时
   *     → 时利 −380.8345，收入 90720.78
   * 哪边改坏了，那边的测试就红。
   */

  var CMP_KEY = 'scs.cmp';

  /** 输入框原文 → 数字。取不出来当 0，别让一个半截数字把整块算炸。 */
  function cnum(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  /**
   * 中文输入法友好的数字清洗。和页面那边同一套规则。
   * （页面上不做这个的话，中文键盘打小数点会被直接过滤，看着像键盘坏了。）
   */
  function normNum(s) {
    s = String(s == null ? '' : s);
    s = s.replace(/[。．｡､、,，]/g, '.');
    s = s.replace(/[０-９]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    });
    s = s.replace(/[－ー—–]/g, '-');
    s = s.replace(/[^0-9.\-]/g, '');
    var neg = s.charAt(0) === '-';
    s = s.replace(/-/g, '');
    var parts = s.split('.');
    if (parts.length > 2) s = parts.shift() + '.' + parts.join('');
    return (neg ? '-' : '') + s;
  }

  /**
   * 一张单子的账。
   *
   *   收入 R = Σ 单价×数量×(1 + 奖励% × 品质)
   *   货款 G = Σ 进价×数量
   *   利润   = R − G − 工资
   *   时利   = 利润 ÷ 小时数
   *   利润率 = 利润 ÷ 收入        ← 对比用的第二个指标
   *
   * ⚠️ 利润率的分母是【收入】，不是成本。
   * 用成本当分母算出来的是"加价率"，两张单子成本结构不同时没法比；
   * 而收入是合同白纸黑字给的那个数，除出来就是"这单子里有多少是你的"。
   */
  function cmpCalc(c) {
    var b = cnum(c.bonus) / 100;
    var H = cnum(c.hours) || 1;
    var W = cnum(c.wage);
    var rev = 0, goods = 0;
    (c.items || []).forEach(function (it) {
      var q = cnum(it.q), p = cnum(it.p), Q = cnum(it.quality), cost = cnum(it.cost);
      rev += p * q * (1 + b * Q);
      goods += cost * q;
    });
    var profit = rev - goods - W;
    return {
      rev: rev, goods: goods, wage: W, hours: H, profit: profit,
      hourly: profit / H,
      // 收入是 0 的时候（还没填单价）利润率没有意义 —— 给 null，界面上显示 —
      margin: rev > 0 ? profit / rev : null,
      budget: rev - W - cnum(c.target) * H,
    };
  }

  /* ---------------------------- 状态 ---------------------------- */

  var CMP = (function () {
    try {
      var raw = JSON.parse(localStorage.getItem(CMP_KEY) || 'null');
      if (raw && raw.wins) return raw;
    } catch (e) { /* 坏了就从空的开始 */ }
    return { wins: [], seq: 1 };
  })();

  function cmpSave() {
    try { localStorage.setItem(CMP_KEY, JSON.stringify(CMP)); }
    catch (e) { /* 存不了不影响用 */ }
  }

  /** 页面计算器现在填的那张单子。读不到就给一张空的。 */
  function cmpReadPage() {
    var blank = { hours: '47', wage: '', bonus: '', target: '500',
                  items: [{ q: '', p: '', quality: '', cost: '' }] };
    try {
      var raw = JSON.parse(localStorage.getItem('simco.calc') || 'null');
      if (!raw || !raw.items || !raw.items.length) return blank;
      return {
        hours: raw.hours, wage: raw.wage, bonus: raw.bonus, target: raw.target,
        items: raw.items.map(function (it) {
          return { q: it.q, p: it.p, quality: it.quality, cost: it.cost };
        }),
      };
    } catch (e) { return blank; }
  }

  function cmpMoney(x) {
    if (!isFinite(x)) return '—';
    return Math.round(x).toLocaleString();
  }
  function cmpMoney2(x) {
    if (!isFinite(x)) return '—';
    return x.toLocaleString(undefined,
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function cmpPct(x) {
    return (x == null || !isFinite(x)) ? '—' : (x * 100).toFixed(2) + '%';
  }

  /**
   * 分裂：把页面上现在填的那张单子复制成一个小窗。
   *
   * 复制的是【快照】—— 之后你在页面上接着改，这个窗口不跟着变。
   * 不这样的话就没有"对比"可言了：几个窗口会一起跟着页面走。
   */
  function cmpSplit() {
    var w = cmpReadPage();
    w.id = 'c' + (CMP.seq++);
    w.name = '单子 ' + (CMP.wins.length + 1);
    var n = CMP.wins.length;
    // 从右上往左下错开。摆左上会正好压住页面上你刚才填数的那几个格子。
    var W = (window.innerWidth || 1200);
    w.x = Math.max(8, W - 372 - (n % 5) * 26);
    w.y = 68 + (n % 5) * 26;
    CMP.wins.push(w);
    cmpSave();
    cmpRender();
  }

  /** 标题栏拖动。指针捕获，拖出窗口外也不会掉。 */
  function cmpDrag(handle, box, w) {
    handle.onpointerdown = function (e) {
      if (e.target && e.target.tagName === 'BUTTON') return;   // 别把关闭键当把手
      var sx = e.clientX, sy = e.clientY, ox = cnum(w.x), oy = cnum(w.y);
      var move = function (ev) {
        w.x = ox + (ev.clientX - sx);
        w.y = oy + (ev.clientY - sy);
        box.style.left = w.x + 'px';
        box.style.top = w.y + 'px';
      };
      var up = function () {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        try { handle.releasePointerCapture(e.pointerId); } catch (x) {}
        cmpSave();          // 松手才存，别把每一帧都写进 localStorage
      };
      try { handle.setPointerCapture(e.pointerId); } catch (x) {}
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      if (e.preventDefault) e.preventDefault();
    };
  }

  /**
   * 一个输入框。改了就重画。
   *
   * ⚠️ type=text，不是 number。number 会把打到一半的 '1.' 当成 1，
   * 重画时写回去那个点就没了 —— 小数永远输不完整。页面那边栽过一次。
   */
  function cmpInput(val, onset, key) {
    var i = document.createElement('input');
    i.type = 'text';
    i.setAttribute('inputmode', 'decimal');
    i.setAttribute('autocomplete', 'off');
    i.setAttribute('data-ck', key);
    i.value = (val == null) ? '' : String(val);
    i.oninput = function () {
      var raw = i.value, fixed = normNum(raw), caret = null;
      try { caret = i.selectionStart; } catch (e) { caret = null; }
      if (fixed !== raw && caret != null) caret -= (raw.length - fixed.length);
      onset(fixed);
      cmpSave();
      cmpRender();
      var back = document.querySelector('[data-ck="' + key + '"]');
      if (!back || !back.focus) return;
      back.focus();
      try {
        var at = caret == null ? back.value.length : Math.max(0, caret);
        back.setSelectionRange(at, at);
      } catch (e) { /* 个别浏览器不支持 */ }
    };
    return i;
  }

  function cmpField(lab, val, onset, key) {
    var d = el('div', 'scs-cf');
    d.appendChild(el('label', null, lab));
    d.appendChild(cmpInput(val, onset, key));
    return d;
  }

  /* ---------------------------- 画 ---------------------------- */

  function cmpRenderWin(host, w, wi, rank) {
    var R = cmpCalc(w);
    var box = el('div', 'scs-win');
    box.style.left = cnum(w.x) + 'px';
    box.style.top = cnum(w.y) + 'px';

    var head = el('div', 'scs-wh');
    // 名字可以改 —— 「单子 1 / 单子 2」比不过「航天那张 / 便宜那张」
    var nm = document.createElement('input');
    nm.className = 'scs-wname';
    nm.type = 'text';
    nm.value = w.name || ('单子 ' + (wi + 1));
    nm.setAttribute('data-ck', w.id + 'n');
    nm.oninput = function () { w.name = nm.value; cmpSave(); cmpRenderBar(); };
    head.appendChild(nm);
    var x = el('button', 'scs-wx', '×');
    x.title = '关掉这个窗口';
    x.onclick = function () {
      CMP.wins.splice(wi, 1); cmpSave(); cmpRender();
    };
    head.appendChild(x);
    cmpDrag(head, box, w);
    box.appendChild(head);

    var body = el('div', 'scs-wb');
    var g = el('div', 'scs-wg');
    g.appendChild(cmpField('小时', w.hours, function (v) { w.hours = v; }, w.id + 'h'));
    g.appendChild(cmpField('工资', w.wage, function (v) { w.wage = v; }, w.id + 'w'));
    g.appendChild(cmpField('奖励%', w.bonus, function (v) { w.bonus = v; }, w.id + 'b'));
    g.appendChild(cmpField('目标时利', w.target, function (v) { w.target = v; }, w.id + 't'));
    body.appendChild(g);

    var tw = el('div', 'scs-wtw');
    var t = document.createElement('table');
    var hr = document.createElement('tr');
    ['', '数量', '单价', '品质', '进价', ''].forEach(function (h) {
      hr.appendChild(el('th', null, h));
    });
    t.appendChild(hr);
    w.items.forEach(function (it, i) {
      var tr = document.createElement('tr');
      var c0 = el('td', null, '产品 ' + (i + 1));
      tr.appendChild(c0);
      [['q', 'q'], ['p', 'p'], ['quality', 'Q'], ['cost', 'c']].forEach(function (f) {
        var td = el('td');
        td.appendChild(cmpInput(it[f[0]], function (v) { it[f[0]] = v; },
                                w.id + 'i' + i + f[1]));
        tr.appendChild(td);
      });
      var td2 = el('td');
      var del = el('button', 'scs-wx', '×');
      del.title = '删掉这一行';
      if (w.items.length <= 1) del.disabled = true;
      else del.onclick = function () { w.items.splice(i, 1); cmpSave(); cmpRender(); };
      td2.appendChild(del);
      tr.appendChild(td2);
      t.appendChild(tr);
    });
    tw.appendChild(t);
    body.appendChild(tw);

    var add = el('button', 'scs-btn scs-wadd', '+ 产品');
    add.onclick = function () {
      w.items.push({ q: '', p: '', quality: '', cost: '' }); cmpSave(); cmpRender();
    };
    body.appendChild(add);

    var k = el('div', 'scs-wk');
    var mk = function (lab, val, cls) {
      var d = el('div', 'scs-wkpi' + (cls ? ' ' + cls : ''));
      d.appendChild(el('div', 'scs-wkk', lab));
      d.appendChild(el('div', 'scs-wkv', val));
      return d;
    };
    k.appendChild(mk('时利', cmpMoney2(R.hourly),
      'big ' + (R.hourly >= cnum(w.target) ? 'good' : 'bad') +
      (rank.bestHourly === w.id ? ' win' : '')));
    k.appendChild(mk('利润率', cmpPct(R.margin),
      (R.margin != null && R.margin >= 0 ? 'good' : 'bad') +
      (rank.bestMargin === w.id ? ' win' : '')));
    k.appendChild(mk('货款预算', cmpMoney(R.budget)));
    body.appendChild(k);

    box.appendChild(body);
    host.appendChild(box);
  }

  /**
   * 「对比」条：把所有窗口按时利排好，两个指标各标一个第一。
   *
   * ⚠️ 时利最高的和利润率最高的**经常不是同一张单子** ——
   * 一张 47 小时赚 3 万的和一张 5 小时赚 5 千的，时利差不多，
   * 但后者占用少、利润率可能高得多。所以两个都标，不合成一个分数：
   * 合成分数要设权重，而权重取决于你当下缺时间还是缺钱，那是你的判断。
   */
  function cmpRank() {
    var best = { bestHourly: null, bestMargin: null };
    var bh = -Infinity, bm = -Infinity;
    CMP.wins.forEach(function (w) {
      var R = cmpCalc(w);
      if (isFinite(R.hourly) && R.hourly > bh) { bh = R.hourly; best.bestHourly = w.id; }
      if (R.margin != null && R.margin > bm) { bm = R.margin; best.bestMargin = w.id; }
    });
    return best;
  }

  function cmpRenderBar() {
    var bar = document.getElementById('scs-cmpbar');
    if (!bar) return;
    clear(bar);
    if (CMP.wins.length < 2) { bar.className = ''; return; }
    bar.className = 'on';

    var rank = cmpRank();
    var head = el('div', 'scs-wh');
    head.appendChild(el('span', 'scs-wname', '对比（' + CMP.wins.length + ' 张）'));
    var x = el('button', 'scs-wx', '×');
    x.title = '关掉全部对比窗';
    x.onclick = function () { CMP.wins = []; cmpSave(); cmpRender(); };
    head.appendChild(x);
    /*
     * 默认摆左下角。
     * 摆左上会正好盖住页面上那几个输入框 —— 你一分裂完，
     * 第一件事就得先把它拖开，那这个默认位置等于没选。
     */
    if (!CMP.bar) {
      var vh = (window.innerHeight || 800);
      // 窄屏上再往上抬一截：右下角那两个悬浮键会压在对比表的数字上
      CMP.bar = { x: 12, y: Math.max(60, vh - 250 - (isNarrow() ? 74 : 0)) };
    }
    bar.style.left = cnum(CMP.bar.x) + 'px';
    bar.style.top = cnum(CMP.bar.y) + 'px';
    cmpDrag(head, bar, CMP.bar);
    bar.appendChild(head);

    var body = el('div', 'scs-wb');
    var t = document.createElement('table');
    var hr = document.createElement('tr');
    ['单子', '时利', '利润率'].forEach(function (h) { hr.appendChild(el('th', null, h)); });
    t.appendChild(hr);

    // 按时利从高到低排 —— 那是最常问的那个问题
    CMP.wins.slice().map(function (w, i) {
      return { w: w, i: i, R: cmpCalc(w) };
    }).sort(function (a, b) {
      return (isFinite(b.R.hourly) ? b.R.hourly : -Infinity) -
             (isFinite(a.R.hourly) ? a.R.hourly : -Infinity);
    }).forEach(function (o) {
      var tr = document.createElement('tr');
      tr.appendChild(el('td', null, o.w.name || ('单子 ' + (o.i + 1))));
      tr.appendChild(el('td', 'scs-n' + (rank.bestHourly === o.w.id ? ' win' : ''),
                        cmpMoney2(o.R.hourly)));
      tr.appendChild(el('td', 'scs-n' + (rank.bestMargin === o.w.id ? ' win' : ''),
                        cmpPct(o.R.margin)));
      t.appendChild(tr);
    });
    body.appendChild(t);
    body.appendChild(el('div', 'scs-wnote',
      '时利最高的和利润率最高的经常不是同一张 —— 缺时间就看左边，缺本金就看右边。'));
    bar.appendChild(body);
  }

  function cmpRender() {
    var host = document.getElementById('scs-wins');
    if (!host) return;
    clear(host);
    var rank = cmpRank();
    CMP.wins.forEach(function (w, i) { cmpRenderWin(host, w, i, rank); });
    cmpRenderBar();
    var fab = document.getElementById('scs-cmp');
    if (fab) fab.setAttribute('data-n', CMP.wins.length || '');
  }

  /**
   * 那个分裂按钮只在【页面切到计算器模式】时出现。
   *
   * 聊天记录模式下它没有任何意义（没有单子可分裂），常驻只会挡着看消息。
   * 页面切模式是给 body 加 / 去一个 class，所以盯 body 的 class 就够了 ——
   * 不用去猜页面内部的状态，也不依赖页面暴露任何东西。
   */
  function cmpWatchMode() {
    var sync = function () {
      var on = false;
      try { on = document.body.classList.contains('mode-calc'); } catch (e) {}
      var fab = document.getElementById('scs-cmp');
      var host = document.getElementById('scs-wins');
      if (fab) fab.style.display = on ? '' : 'none';
      if (host) host.style.display = on ? '' : 'none';
      var bar = document.getElementById('scs-cmpbar');
      if (bar) bar.style.display = on ? '' : 'none';
    };
    sync();
    try {
      new MutationObserver(sync).observe(document.body,
        { attributes: true, attributeFilter: ['class'] });
    } catch (e) { /* 没有 MutationObserver 就只在启动时判一次 */ }
  }


  /* ======================= 餐馆优化器 =======================
   *
   * ⚠️⚠️ 这一块**一个公式都不自己写**。
   *
   *   评分、上座率、食材、工资全部直接调页面上的
   *   mapRestRating / mapRestOcc / mapRestNeed / mapRestWage。
   *   插件是 `@grant none` 跑的，和页面同一个 window，够得着。
   *
   *   抄一份进来的话，页面那边一改公式（这一节已经改过两次了：
   *   品质那一项、销售加成那一项），插件就开始给出**看着很像对的错答案** ——
   *   而两边各自看都对。这是这个仓库最贵的一类 bug。
   *
   *   代价是：页面版本太老（没有那几个函数）时，这个功能**直接不开**，
   *   并且说清楚为什么。宁可不给，也不给一份自己算的。
   */
  /*
   * ⚠️ 页面整个包在一个 IIFE 里 —— 它内部的函数【一个都不在 window 上】。
   *
   *   第一版我直接写 RW('mapRestRating')(...)：语法没问题、测试全绿
   *   （测试里是自己塞的假函数），但在真页面上那个悬浮键**永远不亮**，
   *   而且不报任何错。"能跑的测试 + 不动的功能"是最难查的一种。
   *
   *   现在页面在收尾处明确导出一张表 window.SIMCO_MAP。
   *   下面这个 RW() 就从那张表里取；顺带也认裸的 window.xxx，
   *   万一以后页面换了暴露方式，插件不用跟着改。
   */
  /*
   * 插件自己的版本号，写在状态行里。
   * ⚠️ 查"到底该更新哪一边"的时候，两边的版本必须【同时】看得见 ——
   *    只报页面指纹的话，会漏掉"插件没更新"这一半。
   */
  var SCS_VER = '1.16.0';

  var REST_FN = ['MAP', 'mapCur', 'mapListAt', 'mapLvNow', 'mapStock', 'mapStockQ',
                 'mapStockQFor', 'mapQBlend', 'MAP_Q_MAX',
                 'mapRestRating', 'mapRestOcc', 'mapRestNeed', 'mapRestWage',
                 'mapRestSeats', 'mapRestMenuOk', 'mapRestOtherSeats',
                 'mapRestAt', 'mapRestCfgAt', 'mapRestStyle',
                 'mapRestStops', 'mapRestDecay',
                 'MAP_REST_MENU', 'MAP_REST_GROUPS', 'MAP_REST_GNAME', 'mapRestDish',
                 'mapName',
                 'MAP_REST_PRICE_MIN', 'MAP_REST_PRICE_MAX', 'MAP_REST_RATING_MAX',
                 'MAP_REST_BLD'];
  function RW(n) {
    var box = window.SIMCO_MAP;
    if (box && typeof box[n] !== 'undefined') return box[n];
    return window[n];
  }
  function restReady() {
    for (var i = 0; i < REST_FN.length; i++) {
      if (typeof RW(REST_FN[i]) === 'undefined') return REST_FN[i];
    }
    return null;
  }
  /**
   * 没准备好的时候，说清楚是【哪一种】没准备好。
   *
   * ⚠️ 两种情况的下一步完全不同，混成一句"版本太老"最坑：
   *     整张表都没有 → 页面是旧的，**要重新发一次页面**
   *     表在但缺一项 → 页面比插件旧一点，补那一项就行
   *    第一版就是混着说的，于是"到底该更新哪一边"完全靠猜。
   */
  function restWhy() {
    var miss = restReady();
    if (!miss) return null;
    var box = window.SIMCO_MAP;
    if (!box) {
      return '这个页面还没有 SIMCO_MAP 那张导出表 —— **页面是旧的**。\n' +
             '插件靠它去调页面自己的餐馆算法（不自己抄一份公式），所以缺了就不开。\n' +
             '要做的是：把新版页面发上去（Cloudflare 的 worker.js 和 GitHub 的 index.html），' +
             '然后强刷一次。光更新插件没用。';
    }
    // box 一定在（上面已经挡了），但还是别用裸的 box.build —— 这一屏是报错用的，
    // 报错的路上再抛一次，人就只剩一片空白了
    return '页面的导出表里缺 ' + miss + '（页面指纹 ' + ((box && box.build) || '未知') + '）——\n' +
           '页面比插件旧一点。把页面重新发一次就好。';
  }

  /*
   * showQ / optMenu 这两个是**默认关着**的（`false`）——
   * 勾上才出现。它们各自会多出一整块界面和一次穷举，
   * 平时进来只想看"这个价该定多少"的人不该被它们挡着。
   */
  var REST = { price: '', rating: '', occ: '', staff: null,
               view: 'heat', yaw: -0.6, pitch: 0.9, grid: null,
               showQ: false, optMenu: false, menuRun: null };

  /*
   * ---- 自设定的那几项，打包成一个 ov 传下去 ----
   *
   * ⚠️ 原来是一个一个当位置参数传（`ratingOv`）。加第二个（上座率）的时候
   *    每个函数都要多一个参数、每个调用点都要多一个 `null` ——
   *    而漏掉一个调用点【不会报错】，只会让那一处悄悄用回默认值，
   *    屏幕上看着完全正常。所以改成一个对象，加第三个时不用再动签名。
   *
   *   ov.r    评分覆盖值（0~10），null = 按菜单算
   *   ov.occ  上座率覆盖值（0~1 的小数，界面上按 % 填），null = 按评分算
   */
  function restOv(r, occ) { return { r: r == null ? null : Number(r),
                                     occ: occ == null ? null : Number(occ) }; }
  function OVR(ov) { return (ov && ov.r != null) ? ov.r : null; }
  function OVO(ov) { return (ov && ov.occ != null) ? ov.occ : null; }

  /** 从页面上把这一栋餐馆的现状抓出来。抓不到的留空。 */
  function restRead() {
    var why = restWhy();
    if (why) return { err: why };
    var MAP = RW('MAP');
    if (!MAP) return { err: '页面上没有 MAP —— 先进「游戏模拟」那个模式。' };
    var x = null;
    try {
      RW('mapListAt')(RW('mapCur')()).forEach(function (b) {
        if (b.k === MAP.sel) x = b;
      });
    } catch (e) {}
    if (!x || x.b !== RW('MAP_REST_BLD')) {
      return { err: '先在「游戏模拟」里点开一栋餐馆。' };
    }

    var live = RW('mapRestAt')(x.k, RW('mapCur')());
    var eff = live ? RW('mapRestCfgAt')(live, RW('mapCur')()) : null;
    /*
     * ---- 读的必须是【页面面板上摆着的那一份】，也就是草稿 ----
     *
     * ⚠️ 原来这里优先读 `eff`（这一轮实际在跑的那份），
     *    而页面面板显示的是草稿 `dr`。营业中一改草稿（这正是打开面板的目的），
     *    两边立刻分家：面板按新菜单给评分，插件按旧菜单给评分，
     *    **而两边各自看都对**。
     *
     *    页面在你打开面板时会把草稿从当前生效那份同步过来，
     *    所以"优先草稿"在没改的时候和 eff 是同一份，改了之后跟着面板走 —— 两种情况都对得上。
     */
    var dr = (MAP.rdraft || {})[x.k] || {};
    var hasDraft = !!(dr.menu && dr.menu.length);
    var base = hasDraft ? dr : (eff || {});
    var menu = base.menu || [];
    var style = live ? live.style : RW('mapRestStyle')(x.k, RW('mapCur')());
    var lv = RW('mapLvNow')(x);
    var staff = (REST.staff == null) ? !!base.staff : REST.staff;
    /*
     * 草稿和这一轮实际在跑的那份不一样时，要说一声 ——
     * 不然"这一屏算的到底是哪一份"没法知道。
     */
    var draftDiff = !!(live && eff && hasDraft && (
      dr.menu.slice().sort().join(',') !== eff.menu.slice().sort().join(',') ||
      Number(dr.price) !== Number(eff.price) ||
      !!dr.staff !== !!eff.staff));

    /*
     * ---- 仓库【快照】：每道菜的品质分档，只取一次 ----
     *
     * ⚠️ mapStock 每问一次都要重走一遍事件流。菜单优化器要试几万种配法，
     *    照着一次次问能跑到分钟级。所以在这儿把 16 道菜的 lots 一次性抓下来，
     *    后面全部在快照上算。
     *
     * ⚠️ 但**混合的规则不抄** —— 走的是页面导出的 mapQBlend，
     *    页面和插件是同一个函数。抄一份出去的话，"从高往低取"这条规则
     *    就写了两遍，两边迟早不一样，而且各自看都对。
     */
    var lots = {}, unitQ = {};
    RW('MAP_REST_MENU').forEach(function (dish) {
      var g = null;
      try { g = RW('mapStock')(dish.id); } catch (e) {}
      lots[dish.id] = g ? g.lots : null;
      unitQ[dish.id] = g ? g.q : 0;
    });

    var d0 = { lv: lv, style: style, lots: lots };
    var cur = restMenuCalc(d0, menu);

    /*
     * ---- 歇业衰减：评分要乘 0.875^（这一笔开张前歇过几次业） ----
     *
     * ⚠️ 这一条原来【整条漏了】，是这个面板报过的最坏的一种错：
     *    它不会算崩，只会把评分报成一个**这家店永远达不到的数** ——
     *    歇过一次业就差 12.5%，插件说 8.96、页面说 7.84，
     *    而两边各自看都对，谁也不说另一个错。
     *
     * ⚠️ 数的是【这一笔开张之前】的次数，不是数到现在 ——
     *    走页面的 mapRestDecay，不自己数一遍。
     */
    var decayFrom = live ? live.h : RW('mapCur')();
    var stops = RW('mapRestStops')(x.k, decayFrom);
    var decay = RW('mapRestDecay')(x.k, decayFrom);   // 只用来提示，不参与计算

    return {
      x: x, lv: lv, style: style, menu: menu, staff: staff,
      seats: RW('mapRestSeats')(lv, style),
      lots: lots, unitQ: unitQ, stops: stops, decay: decay,
      cur: cur, cost: cur.cost, qsum: cur.qsum, missMat: cur.miss,
      wage: RW('mapRestWage')(lv, style, staff),
      wageAlt: RW('mapRestWage')(lv, style, !staff),
      other: RW('mapRestOtherSeats')(x.k, RW('mapCur')()),
      ok: RW('mapRestMenuOk')(menu),
      livePrice: base.price != null ? base.price : null,
      draftDiff: draftDiff, eff: eff,
      running: !!live,
    };
  }

  /**
   * 一份菜单在这个规模 / 这个装修下：吃多少料、花多少钱、总品质是多少。
   *
   * ⚠️ 成本和品质走的是**同一批 lots**（从高品质往低取）。
   *    第一版成本用的是整仓均价 `mapStock(id).c` —— 那就成了
   *    "按最高品质给评分、按整仓均价算成本"的四不像：
   *    仓里 100 个贵的 Q12 + 10 万个便宜的 Q0，
   *    评分按 Q12 给，成本却按几乎全是 Q0 的均价算，**利润凭空多出来一大截**。
   *    而两边各自看都对。
   */
  function restMenuCalc(d, menu) {
    var need = {}, cost = 0, qsum = 0, miss = [], short = [];
    RW('mapRestNeed')(menu, d.lv, d.style).forEach(function (u) {
      need[u.id] = u.n;
      var lots = d.lots[u.id];
      if (!lots || !lots.length) {
        // 仓里一个都没有：成本算不出来（记一笔），品质走页面的回落口径
        miss.push(u.id);
        try { qsum += RW('mapStockQFor')(u.id, u.n); } catch (e) {}
        return;
      }
      var b = RW('mapQBlend')(lots, u.n);
      cost += (b.c || 0) * b.got;
      qsum += (b.ql || 0);
      if (b.short) short.push(u.id);
    });
    return { menu: menu, need: need, cost: cost, qsum: qsum,
             miss: miss, short: short };
  }

  /**
   * 一个价格 / 一个服务档下的整轮账。全部走页面自己的函数。
   *
   * `m` 是 restMenuCalc 的结果（哪份菜单、吃多少料、总品质多少）。
   * 不传就用当前这一份 —— 菜单优化器会拿别的配法进来。
   *
   * ⚠️ 总品质【按这一轮真的要用掉那么多】算，不是整仓平均。
   *    仓里 100 个 Q8 + 1 万个 Q0、这一轮只吃 60 个的话，拿到的是**纯 Q8**。
   *    用整仓平均的话，"专门备一批高品质料"这件事在评分里完全消失，
   *    而页面自己的账是按前者记的 —— 两边会对不上，各自看都对。
   */
  function restOne(d, price, staff, ov, m) {
    var mm = m || d.cur;
    var seats = d.seats;
    var wage = RW('mapRestWage')(d.lv, d.style, staff);
    var oFix = OVO(ov);
    var rating, occ, comp = null, traffic = null;
    if (oFix != null) {
      /*
       * ⚠️ 上座率被钉死之后，**评分整条链就断了**：
       *    评分只通过 mapRestOcc 影响结果，那一步被绕过，
       *    菜单、品质、豪华、沟通就全都不影响这一轮的账了。
       *
       *    所以这里【干脆不算评分】—— 算了再摆出来最坑：
       *    屏幕上会有一个跟着菜单变的评分，而它一分钱都不影响，
       *    人会一直调菜单等着利润动。
       *    界面那边改成报「你填的上座率反推出来的评分」，那个才有意义。
       *
       *    顺带：不算评分，五万多种配法的穷举从三四秒降到零点几秒。
       */
      occ = Math.max(0, Math.min(1, oFix));
      rating = OVR(ov);                    // 评分也填了就照抄，但它不参与计算
    } else {
      /*
       * ⚠️ **这里【不】乘歇业衰减。**
       *
       *    我上一版乘了，是因为我把「歇业」当成了常态。实际不是：
       *    餐馆一旦开起来就一直转，不主动排「下次关闭」它不会停 ——
       *    真正会歇业的只有切装修风格那一次。
       *
       *    所以常态下衰减恒等于 1，乘它只会凭空把评分压低。
       *    页面那边算历史账时仍然要乘（那是页面的机制），
       *    两边要是对不上，差的就是这一项 —— 所以下面把次数摆在屏幕上，
       *    **不藏着**：藏起来的话，两个都对的数会莫名其妙对不上。
       */
      rating = (OVR(ov) == null)
        ? RW('mapRestRating')({ menu: mm.menu, price: price, staff: staff,
                                style: d.style, qsum: mm.qsum }).r
        : OVR(ov);
      var oc = RW('mapRestOcc')(rating, price, d.other);
      occ = oc.occ; comp = oc.comp; traffic = oc.traffic;
    }
    var served = Math.min(seats, Math.floor(seats * occ));
    return { price: price, staff: staff, rating: rating, occ: occ,
             occFixed: oFix != null, comp: comp, traffic: traffic, m: mm,
             served: served, spoiled: seats - served,
             revenue: served * price,
             profit: served * price - mm.cost - wage, wage: wage };
  }

  /**
   * 反推：你量到的上座率是 occ，在这个价位上对应的评分该是多少。
   *
   * ⚠️ **不自己解方程** —— 那要把 0.08 / 0.82 / 0.25 那几个系数抄进来。
   *    改成拿页面的 mapRestOcc 二分：上座率对评分是单调递增的，一定收敛。
   *    页面改公式，这里自动跟着对。
   *
   * 够不到就返回 { err }，**不给一个看着正常的数** ——
   * 价格罚和同行挤占会把可达区间整段压下去，光靠评分是补不回来的。
   */
  function restImpliedRating(d, price, occ) {
    var max = RW('MAP_REST_RATING_MAX');
    var lo = 0, hi = max;
    var oLo = RW('mapRestOcc')(lo, price, d.other).occ;
    var oHi = RW('mapRestOcc')(hi, price, d.other).occ;
    if (occ < oLo - 1e-9 || occ > oHi + 1e-9) {
      return { err: '在 $' + price + ' 上，评分从 0 到 ' + max +
                    ' 只能让上座率落在 ' + (oLo * 100).toFixed(1) + '% ~ ' +
                    (oHi * 100).toFixed(1) + '% 之间 —— 你填的 ' +
                    (occ * 100).toFixed(1) + '% 光靠评分够不到。' };
    }
    for (var i = 0; i < 60; i++) {
      var mid = (lo + hi) / 2;
      if (RW('mapRestOcc')(mid, price, d.other).occ < occ) lo = mid; else hi = mid;
    }
    return { rating: (lo + hi) / 2 };
  }

  /** 价格从头扫到尾。步长取整块的 1 元，350−60 就 291 个点，够密也够快。 */
  function restSweep(d, staff, ov, m) {
    var lo = RW('MAP_REST_PRICE_MIN'), hi = RW('MAP_REST_PRICE_MAX');
    var out = [];
    for (var p = lo; p <= hi; p++) out.push(restOne(d, p, staff, ov, m));
    return out;
  }

  /* ==================== 菜单优化（默认关着，勾了才跑） ====================
   *
   * 「在我**有料**的那些菜里，哪一种配法最赚」。
   *
   * ⚠️ 只把**仓库里真有货、而且够这一轮吃**的菜算进候选。
   *    把没料的菜排进"最优菜单"是没意义的 —— 那份菜单根本开不起来，
   *    而屏幕上会显示成一个看着挺像样的答案。
   *
   * ⚠️ 组合数是**乘起来**的：沙拉吧 6 道、主菜 6 道、饮品 4 道，
   *    每组至少一道 → (2⁶−1) × (2⁶−1) × (2⁴−1) = 63 × 63 × 15 = 59,535 种。
   *    全扫得动，所以这里**是穷举，不是启发式** —— 报出来的"最赚"
   *    在给定价格下是真的最赚，不是"搜到的最好的"。
   */
  function restSubsets(ids) {
    var out = [];
    var n = ids.length;
    for (var mask = 1; mask < (1 << n); mask++) {
      var one = [];
      for (var i = 0; i < n; i++) if (mask & (1 << i)) one.push(ids[i]);
      out.push(one);
    }
    return out;
  }
  /** 按组分开列出「有货」的菜。三组里但凡有一组一个都没有，就没得挑。 */
  function restAvail(d) {
    var by = {};
    RW('MAP_REST_GROUPS').forEach(function (g) { by[g] = []; });
    RW('MAP_REST_MENU').forEach(function (dish) {
      if ((d.unitQ[dish.id] || 0) > 0) by[dish.g].push(dish.id);
    });
    return by;
  }
  /**
   * 穷举。两段：
   *   ① 在**一个价位、一档服务**上把全部配法扫一遍，留下最赚的那几份
   *   ② 对留下的那几份，两档服务各做一次完整的 291 档价格扫描，选总冠军
   *
   * ⚠️ 第一段固定价格和服务档，所以严格说"最赚"是**在那一格上**最赚。
   *    第二段是用来兜住"换了价格 / 换了服务档，排名会变"的 —— 但它只复查前几名。
   *    这条限制**写在屏幕上**，不藏起来：藏起来的话，
   *    一个两段搜索会伪装成一次全局穷举。
   *
   * ⚠️ 第一段为什么不把两档服务一起扫：五万多种配法各算一次评分已经三四秒，
   *    两档就是七八秒 —— 一个整整卡住七八秒的标签页，
   *    屏幕上不会有任何一处说它在忙。服务档挪到第二段（只有几十份）里比。
   */
  function restMenuOpt(d, staff, ov, p0, keep) {
    var by = restAvail(d);
    var groups = RW('MAP_REST_GROUPS');
    var emptyG = groups.filter(function (g) { return !by[g].length; });
    if (emptyG.length) {
      return { err: '这几组一道菜的料都没有：' +
                    emptyG.map(function (g) { return RW('MAP_REST_GNAME')[g]; }).join('、') +
                    ' —— 三组齐了才开得了轮，没得挑。' };
    }
    var subs = groups.map(function (g) { return restSubsets(by[g]); });
    var total = subs.reduce(function (a, s) { return a * s.length; }, 1);
    var archs = (staff == null) ? [false, true] : [staff];
    var st0 = archs[0];
    var rows = [], skipped = 0;
    subs[0].forEach(function (a) {
      subs[1].forEach(function (b) {
        subs[2].forEach(function (c) {
          var menu = a.concat(b, c);
          var m = restMenuCalc(d, menu);
          // 料不够这一轮吃的配法直接扔掉 —— 它开不起来
          if (m.short.length || m.miss.length) { skipped++; return; }
          rows.push(restOne(d, p0, st0, ov, m));
        });
      });
    });
    /*
     * ⚠️ 排序的依据要跟着【问的是什么】变：
     *
     *   没钉上座率 → 问的是"怎么最赚"      → 按利润排
     *   钉了上座率 → 问的是"菜该怎么配"     → 按【能定到的最高价】排
     *
     *   钉了还按利润排的话，排出来的其实是"最省料的那一套"——
     *   上菜数不随菜单变，利润只剩料钱在动。那答的不是你问的问题。
     */
    if (OVO(ov) != null) {
      rows.forEach(function (r) {
        var h = restMaxPriceAt(restTargetScan(d, OVO(ov), r.m, r.staff));
        r.maxPrice = h ? h.price : null;
        r.reqAt = h ? h.req : null;
      });
      rows = rows.filter(function (r) { return r.maxPrice != null; });
      rows.sort(function (x, y) { return y.maxPrice - x.maxPrice; });
    } else {
      rows.sort(function (x, y) { return y.profit - x.profit; });
    }
    var K = keep || 40;
    var fin = null, n2 = 0;
    if (OVO(ov) != null) {
      // 钉了上座率：第一段已经按"能定到的最高价"排好了，冠军就是第一名
      fin = rows[0] || null;
    } else {
      rows.slice(0, K).forEach(function (r) {
        archs.forEach(function (st) {
          n2++;
          var b = restBest(restSweep(d, st, ov, r.m));
          if (!fin || b.profit > fin.profit) fin = b;
        });
      });
    }
    return { best: fin, tried: rows.length, tried2: n2, total: total,
             skipped: skipped, p0: p0, st0: st0, keep: K, avail: by,
             archs: archs, stage1: rows.slice(0, K) };
  }

  /**
   * ---- 上座率是【目标】，不是假设 ----
   *
   * ⚠️ 我上一版把它做成了"假设上座率是 T，然后求利润最大" ——
   *    那必然顶到最高价（上菜数不动，每涨 1 块就多赚一份），
   *    于是屏幕上永远写着"最优价 $350"。
   *    **那是个废答案**：上座率是上座率，跟"该定多高"是两回事，
   *    而你问的本来就是反过来的那个方向。
   *
   *    现在做成反解：给定要保持的上座率，
   *      · 每个价位上【需要】多少评分   ← 拿页面的 mapRestOcc 二分
   *      · 你这份菜单在那个价位上【有】多少评分
   *    两条线一交，交点就是"最高能定到多少钱还保持得住"。
   *
   * ⚠️ 两条线的方向是相反的，这也是为什么一定有交点：
   *      需要的评分：价格越高，价格罚越重 → 需要越高
   *      你有的评分：价格越高，价格分越低 → 越低
   */
  function restTargetScan(d, T, m, staff) {
    var lo = RW('MAP_REST_PRICE_MIN'), hi = RW('MAP_REST_PRICE_MAX');
    var mm = m || d.cur;
    var out = [];
    for (var p = lo; p <= hi; p++) {
      var req = restImpliedRating(d, p, T);
      var have = RW('mapRestRating')({ menu: mm.menu, price: p, staff: staff,
                                       style: d.style, qsum: mm.qsum }).r;
      out.push({ price: p, req: req.err ? null : req.rating, reqErr: req.err || null,
                 have: have, ok: !req.err && have >= req.rating - 1e-9 });
    }
    return out;
  }
  /**
   * 保持这个上座率的前提下，最高能定到多少钱。
   *
   * ⚠️ 返回 null 表示【一个价位都达不到】—— 不返回一个凑合的数。
   *    凑合一个的话，屏幕上会出现一个你照着定、结果达不到目标的价格。
   */
  function restMaxPriceAt(rows) {
    var best = null;
    rows.forEach(function (r) { if (r.ok) best = r; });
    return best;
  }
  /* ==================== 挑品质（勾选才开） ====================
   *
   * 「我这几档货成本差得很远，这一轮到底该用哪一档？」
   *
   * ⚠️ 高品质**不一定划算**：品质进的是评分，评分进的是上座率；
   *    而料钱是直接扣的。一档贵十倍的货换来半分评分，多半是亏的。
   *    这正是"挑"这个字的意思 —— 摊开一张表给你看不算挑。
   *
   * ⚠️⚠️ **但页面扣料是【从最高品质往下扣】的，改不了。**
   *    所以这里挑出来的不是"这一轮该点哪个按钮"，而是
   *    「**手里该留着哪一档**」—— 买/造的时候按它来，
   *    别把用不上的高档货囤在这道菜上。
   *    不说清楚的话，会照着它去页面上找一个根本不存在的选项。
   */

  /**
   * 一道菜的候选配法：从第 j 档开始往下取 need 个。
   *
   * ⚠️ 候选不是"每一档单独用"，而是"从第 j 档起往下取" ——
   *    最高那一档不够 need 个时，本来就得往下凑。
   *    只列单档的话，那些"档不够量"的菜会一个候选都没有，
   *    而它们恰恰是最需要挑的。
   */
  function restQOpts(d, id, n) {
    var lots = d.lots[id];
    if (!lots || !lots.length) return [];
    var out = [], seen = {};
    for (var j = 0; j < lots.length; j++) {
      var b = RW('mapQBlend')(lots.slice(j), n);
      if (b.got < n - 1e-9) break;             // 从这一档起往下都不够了
      var key = Math.round(b.ql * 100);
      if (seen[key]) continue;
      seen[key] = 1;
      out.push({ ql: b.ql, unit: b.c, cost: b.c * n, from: lots[j].ql });
    }
    return out;
  }

  /**
   * 挑：总品质每多一点值不值那点料钱。
   *
   * 做法是一个背包 DP —— 评分只看【总品质】（各道菜的品质相加），
   * 料钱也是相加，所以"给定总品质，最少要花多少料钱"可以逐道菜推。
   *
   * ⚠️ 不能对每道菜单独挑。单独挑的话每道都会选"性价比最高"的那一档，
   *    而真正的取舍是**整张菜单一起**跨过评分那几个坎 ——
   *    差半分评分可能一分钱都不值，也可能值好几万。
   *
   * 总品质按 0.1 一档离散化：16 道 × 12 分 = 192，最多 1921 个状态，
   * 逐道菜推一遍就完事，比穷举菜单便宜得多。
   */
  var RESTQ_STEP = 10;                    // 总品质 ×10 取整
  function restQPlan(d, m, price, staff) {
    var ids = m.menu, i;
    var opts = [];
    for (i = 0; i < ids.length; i++) {
      var o = restQOpts(d, ids[i], m.need[ids[i]]);
      if (!o.length) {
        return { err: '「' + RW('mapName')(ids[i]) + '」仓里的量不够这一轮吃，挑不了。' };
      }
      opts.push(o);
    }
    /*
     * chain[i] = 前 i 道菜推完之后，「总品质 → 最省的那条路」。
     * ⚠️ 路径要边推边记（prev + pick），不能只留最后一层再倒推 ——
     *    只留最后一层的话，回溯时得把 DP 再推一遍，
     *    两遍之间但凡有一点不一致（比如同价位取谁），
     *    报出来的配法就和报出来的钱对不上，而两边各自看都对。
     */
    var chain = [{ 0: { cost: 0, prev: null, pick: null } }];
    for (i = 0; i < ids.length; i++) {
      var nx = {};
      Object.keys(chain[i]).forEach(function (k) {
        var cur = chain[i][k];
        opts[i].forEach(function (op) {
          var nk = Number(k) + Math.round(op.ql * RESTQ_STEP);
          var c = cur.cost + op.cost;
          if (!nx[nk] || c < nx[nk].cost) {
            nx[nk] = { cost: c, prev: Number(k), pick: op };
          }
        });
      });
      chain.push(nx);
    }
    var last = chain[ids.length];
    var wage = RW('mapRestWage')(d.lv, d.style, staff);
    var best = null, all = [];
    Object.keys(last).forEach(function (k) {
      var qsum = Number(k) / RESTQ_STEP;
      var rt = RW('mapRestRating')({ menu: ids, price: price, staff: staff,
                                     style: d.style, qsum: qsum });
      var oc = RW('mapRestOcc')(rt.r, price, d.other);
      var served = Math.min(d.seats, Math.floor(d.seats * oc.occ));
      var row = { qsum: qsum, cost: last[k].cost, rating: rt.r, occ: oc.occ,
                  served: served, key: Number(k),
                  profit: served * price - last[k].cost - wage };
      all.push(row);
      if (!best || row.profit > best.profit) best = row;
    });
    if (!best) return { err: '一种配得起来的品质组合都没有。' };
    var picks = [], k2 = best.key;
    for (i = ids.length; i > 0; i--) {
      var node = chain[i][k2];
      picks.unshift({ id: ids[i - 1], opt: node.pick });
      k2 = node.prev;
    }
    all.sort(function (a, b) { return a.qsum - b.qsum; });
    return { best: best, picks: picks, all: all, opts: opts };
  }
  /** 把一份挑好的品质配法，装回 restOne 认的那种 m。 */
  function restQAsM(m, plan) {
    return { menu: m.menu, need: m.need, cost: plan.best.cost,
             qsum: plan.best.qsum, miss: [], short: [] };
  }
  /** 找利润最高的那一个。 */
  function restBest(rows) {
    var b = null;
    rows.forEach(function (r) { if (!b || r.profit > b.profit) b = r; });
    return b;
  }
  /**
   * 评分 → 上座率那条曲线。
   * 评分本身不扫价格 —— 它是"假设评分是 N，上座率会是多少"。
   */
  function restRatingCurve(d, price) {
    var out = [], max = RW('MAP_REST_RATING_MAX');
    for (var i = 0; i <= 100; i++) {
      var r = max * i / 100;
      var oc = RW('mapRestOcc')(r, price, d.other);
      var served = Math.min(d.seats, Math.floor(d.seats * oc.occ));
      out.push({ rating: r, occ: oc.occ, served: served,
                 profit: served * price - d.cost - d.wage });
    }
    return out;
  }
  /** 价格 × 评分 的网格（两个都没填时用）。 */
  function restGrid(d, nP, nR) {
    var lo = RW('MAP_REST_PRICE_MIN'), hi = RW('MAP_REST_PRICE_MAX');
    var max = RW('MAP_REST_RATING_MAX');
    /*
     * px / py 存的是【真的被扫到的那些坐标】。
     * 只存 lo / hi 的话，格子切错一格（j/nP 而不是 j/(nP−1)）
     * 最右一列永远扫不到，而 lo/hi 照样是对的 —— 测试也就照样绿。
     */
    var g = { nP: nP, nR: nR, lo: lo, hi: hi, max: max, z: [], px: [], py: [],
              min: 0, top: null };
    var mn = Infinity, mx = -Infinity;
    for (var jj = 0; jj < nP; jj++) g.px.push(lo + (hi - lo) * jj / (nP - 1));
    for (var ii = 0; ii < nR; ii++) g.py.push(max * ii / (nR - 1));
    for (var i = 0; i < nR; i++) {
      var row = [];
      var rating = g.py[i];
      for (var j = 0; j < nP; j++) {
        var price = g.px[j];
        var oc = RW('mapRestOcc')(rating, price, d.other);
        var served = Math.min(d.seats, Math.floor(d.seats * oc.occ));
        var pr = served * price - d.cost - d.wage;
        row.push(pr);
        if (pr < mn) mn = pr;
        if (pr > mx) { mx = pr; g.top = { price: price, rating: rating, profit: pr }; }
      }
      g.z.push(row);
    }
    g.min = mn; g.maxv = mx;
    return g;
  }


  /* ---- 画图。三种，都用 canvas，不引任何库 ---- */
  function restCv(w, h) {
    var c = document.createElement('canvas');
    var dp = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(w * dp); c.height = Math.round(h * dp);
    c.style.height = h + 'px';
    var g = c.getContext('2d');
    g.scale(dp, dp);
    return { c: c, g: g, w: w, h: h };
  }
  function restCss(n, dflt) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(n);
      return (v && v.trim()) || dflt;
    } catch (e) { return dflt; }
  }

  /**
   * 折线图。多条曲线共用一个 x 轴，各自归一化到自己的量程 ——
   * ⚠️ 利润是几万、上座率是 0~1，塞进同一个纵轴的话上座率会压成一条直线。
   *    所以每条线单独缩放，纵轴不标数，改成在图例里写各自的范围。
   */
  function restLines(box, series, markX, xlab) {
    var W = 620, H = 220, PAD = 28;
    var cv = restCv(W, H), g = cv.g;
    var line = restCss('--line', '#243244'), mut = restCss('--mut', '#93a4bd');
    g.fillStyle = restCss('--panel2', '#0d141d');
    g.fillRect(0, 0, W, H);
    /*
     * ⚠️ 每条线【自带自己的点】（se.pts = [{x, y}]）。
     *    第一版是所有线共用一个 rows 数组、靠一个闭包计数器轮着取值 ——
     *    只要有一条线的点数不一样，取到的就全串位了，而画出来的图
     *    **看着仍然像条正常的曲线**。这种错没法在图上看出来。
     */
    var x0 = Infinity, x1 = -Infinity;
    series.forEach(function (se) {
      se.pts.forEach(function (p) {
        if (p.x < x0) x0 = p.x;
        if (p.x > x1) x1 = p.x;
      });
    });
    var px = function (v) { return PAD + (W - PAD * 2) * (v - x0) / ((x1 - x0) || 1); };
    g.strokeStyle = line; g.lineWidth = 1;
    g.beginPath(); g.moveTo(PAD, H - 20); g.lineTo(W - PAD, H - 20); g.stroke();
    /*
     * ⚠️ 同一组里的线【共用一个纵轴量程】，不同组各用各的。
     *    普通服务和优质服务的利润必须共用，不然两条线会各自撑满整张图，
     *    "哪一档更赚"这件事在图上直接消失了 —— 而两条线各自看都对。
     */
    var groups = {};
    series.forEach(function (se) {
      var k = se.grp || se.n;
      if (!groups[k]) groups[k] = { lo: Infinity, hi: -Infinity };
      se.pts.forEach(function (p) {
        if (p.y < groups[k].lo) groups[k].lo = p.y;
        if (p.y > groups[k].hi) groups[k].hi = p.y;
      });
    });
    series.forEach(function (se) {
      var gr = groups[se.grp || se.n];
      se.lo = gr.lo; se.hi = gr.hi;
      var py = function (v) {
        return (H - 24) - (H - 44) * (v - gr.lo) / ((gr.hi - gr.lo) || 1);
      };
      g.strokeStyle = se.c; g.lineWidth = 1.8;
      g.beginPath();
      se.pts.forEach(function (p, i) {
        var X = px(p.x), Y = py(p.y);
        if (i) g.lineTo(X, Y); else g.moveTo(X, Y);
      });
      g.stroke();
    });
    if (markX != null) {
      g.strokeStyle = restCss('--ok', '#86efac');
      g.setLineDash([4, 3]); g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(px(markX), 8); g.lineTo(px(markX), H - 20); g.stroke();
      g.setLineDash([]);
    }
    g.fillStyle = mut; g.font = '10px system-ui,sans-serif';
    g.fillText(String(Math.round(x0)), PAD, H - 7);
    g.fillText(String(Math.round(x1)), W - PAD - 22, H - 7);
    g.fillText(xlab, W / 2 - 18, H - 7);
    box.appendChild(cv.c);
    var lg = el('div', 'sub');
    series.forEach(function (se) {
      var one = el('span');
      one.style.color = se.c;
      one.textContent = '■ ' + se.n + ' ' + se.fmt(se.lo) + ' ~ ' + se.fmt(se.hi) + '　';
      lg.appendChild(one);
    });
    box.appendChild(lg);
  }

  /** 热力图：价格 × 评分 → 利润。精确、能悬停，找最优比 3D 快。 */
  function restHeat(box, gd, curve) {
    var W = 620, H = 260, PAD = 34;
    var cv = restCv(W, H), g = cv.g;
    g.fillStyle = restCss('--panel2', '#0d141d'); g.fillRect(0, 0, W, H);
    var cw = (W - PAD - 12) / gd.nP, ch = (H - PAD - 18) / gd.nR;
    for (var i = 0; i < gd.nR; i++) {
      for (var j = 0; j < gd.nP; j++) {
        var t = (gd.z[i][j] - gd.min) / ((gd.maxv - gd.min) || 1);
        // 亏钱的一律画成暗红 —— 不然一片渐变里看不出哪边是负的
        if (gd.z[i][j] < 0) g.fillStyle = 'rgba(180,60,60,' + (0.25 + 0.4 * (1 - t)) + ')';
        else g.fillStyle = 'rgba(125,211,252,' + (0.08 + 0.9 * t) + ')';
        g.fillRect(PAD + j * cw, H - 18 - (i + 1) * ch, cw + 0.6, ch + 0.6);
      }
    }
    /*
     * ⚠️ 先画"够得到的那条线"，再画面上最高点的圈 ——
     *    顺序反了的话，圈会被线盖住，而那个圈是唯一区分
     *    "能拿到的"和"假设的"的记号。
     */
    var XY = function (price, rating) {
      return { x: PAD + (price - gd.lo) / (gd.hi - gd.lo) * (W - PAD - 12),
               y: H - 18 - rating / gd.max * (H - PAD - 18) };
    };
    if (curve && curve.length) {
      g.strokeStyle = restCss('--ok', '#86efac'); g.lineWidth = 2;
      g.beginPath();
      curve.forEach(function (r, i) {
        var p = XY(r.price, r.rating);
        if (i) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y);
      });
      g.stroke();
      var bb = null;
      curve.forEach(function (r) { if (!bb || r.profit > bb.profit) bb = r; });
      if (bb) {
        var bp = XY(bb.price, bb.rating);
        g.fillStyle = restCss('--ok', '#86efac');
        g.beginPath(); g.arc(bp.x, bp.y, 4, 0, Math.PI * 2); g.fill();
      }
    }
    if (gd.top) {
      var tp = XY(gd.top.price, gd.top.rating);
      // 空心白圈 = 面上最高点，可能【够不到】；实心绿点 = 你真能拿到的最优
      g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 1.6;
      g.beginPath(); g.arc(tp.x, tp.y, 5, 0, Math.PI * 2); g.stroke();
    }
    g.fillStyle = restCss('--mut', '#93a4bd'); g.font = '10px system-ui,sans-serif';
    g.fillText('$' + gd.lo, PAD, H - 5);
    g.fillText('$' + gd.hi, W - 40, H - 5);
    g.fillText('价格 →', W / 2 - 16, H - 5);
    g.save(); g.translate(10, H / 2 + 16); g.rotate(-Math.PI / 2);
    g.fillText('评分 0 → ' + gd.max, 0, 0); g.restore();
    box.appendChild(cv.c);
  }

  /**
   * 3D 曲面，鼠标/手指拖着转。
   *
   * ⚠️ 用画家算法（远的先画）。不排序的话近处的面会被远处的盖住，
   *    转到某个角度整块曲面会像"翻过来"了一样 —— 而它其实一直是对的。
   */
  function restSurf(box, gd) {
    var W = 620, H = 300;
    var cv = restCv(W, H), g = cv.g;
    function draw() {
      g.fillStyle = restCss('--panel2', '#0d141d'); g.fillRect(0, 0, W, H);
      var cy = Math.cos(REST.yaw), sy = Math.sin(REST.yaw);
      var cp = Math.cos(REST.pitch), sp = Math.sin(REST.pitch);
      var span = (gd.maxv - gd.min) || 1;
      function pt(j, i, z) {
        var X = (j / (gd.nP - 1) - 0.5) * 2;
        var Y = (i / (gd.nR - 1) - 0.5) * 2;
        var Z = ((z - gd.min) / span - 0.5) * 1.4;
        var rx = X * cy - Y * sy, ry = X * sy + Y * cy;
        var ry2 = ry * cp - Z * sp, rz = ry * sp + Z * cp;
        var s = 110 / (3.2 - rz * 0.35);
        return { x: W / 2 + rx * s * 1.6, y: H / 2 + ry2 * s * 0.95 - 10, d: rz };
      }
      var quads = [];
      for (var i = 0; i < gd.nR - 1; i++) {
        for (var j = 0; j < gd.nP - 1; j++) {
          var a = pt(j, i, gd.z[i][j]), b = pt(j + 1, i, gd.z[i][j + 1]);
          var c = pt(j + 1, i + 1, gd.z[i + 1][j + 1]), dd = pt(j, i + 1, gd.z[i + 1][j]);
          var zavg = (gd.z[i][j] + gd.z[i][j + 1] + gd.z[i + 1][j + 1] + gd.z[i + 1][j]) / 4;
          quads.push({ p: [a, b, c, dd], t: (zavg - gd.min) / span,
                       neg: zavg < 0, d: (a.d + b.d + c.d + dd.d) / 4 });
        }
      }
      quads.sort(function (m, n) { return m.d - n.d; });   // 远的先画
      quads.forEach(function (q) {
        g.beginPath();
        g.moveTo(q.p[0].x, q.p[0].y);
        for (var k = 1; k < 4; k++) g.lineTo(q.p[k].x, q.p[k].y);
        g.closePath();
        g.fillStyle = q.neg ? 'rgba(180,60,60,.6)'
                            : 'rgba(125,211,252,' + (0.14 + 0.8 * q.t) + ')';
        g.fill();
        g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = 0.4; g.stroke();
      });
      g.fillStyle = restCss('--mut', '#93a4bd'); g.font = '10px system-ui,sans-serif';
      g.fillText('拖动旋转　X = 价格　Y = 评分　高度 = 利润', 12, H - 10);
    }
    draw();
    var drag = null;
    cv.c.onpointerdown = function (e) {
      drag = { x: e.clientX, y: e.clientY, yaw: REST.yaw, pitch: REST.pitch };
      try { cv.c.setPointerCapture(e.pointerId); } catch (e2) {}
    };
    cv.c.onpointermove = function (e) {
      if (!drag) return;
      REST.yaw = drag.yaw + (e.clientX - drag.x) * 0.01;
      REST.pitch = Math.max(0.15, Math.min(1.45,
        drag.pitch + (e.clientY - drag.y) * 0.008));
      draw();
    };
    cv.c.onpointerup = function () { drag = null; };
    box.appendChild(cv.c);
  }

  /* ---- 面板 ---- */
  function restNum(val, ph, on) {
    var i = document.createElement('input');
    i.type = 'number'; i.step = 'any';
    i.value = (val === '' || val == null) ? '' : String(val);
    i.placeholder = ph;
    i.onchange = function () { on(i.value); };
    return i;
  }

  /** 一个勾选框。默认全是关着的 —— 见 REST 那段注释。 */
  function restChk(label, on, cb) {
    var w = el('label', 'chk');
    var i = document.createElement('input');
    i.type = 'checkbox';
    i.checked = !!on;
    i.onchange = function () { cb(i.checked); };
    w.appendChild(i);
    w.appendChild(document.createTextNode(' ' + label));
    return w;
  }

  /**
   * ---- 勾选①：挑品质（按不同品质的成本算） ----
   *
   * ⚠️ 上一版这里只是**摊开一张表**给你看。那不是挑。
   *    高品质不一定划算：品质进的是评分、评分进的是上座率，
   *    而料钱是当场扣的 —— 一档贵十倍的货换来半分评分多半是亏的。
   *    现在真的挑：每道菜该用哪一档，整张菜单一起算。
   */
  function restQPanel(box, d, ov, hasP) {
    var price = hasP ? Number(REST.price) : 96;
    var staff = !!d.staff;

    /*
     * ⚠️⚠️ 这句必须在最前面，而且不能省。
     *    页面（和游戏）扣料是**从最高品质往下扣**的，改不了 ——
     *    所以下面挑出来的不是"这一轮该点哪个按钮"，
     *    而是「**手里该留着哪一档**」：买 / 造的时候按它来。
     *    不说的话，会照着它去页面上找一个根本不存在的选项。
     */
    box.appendChild(el('div', 'warn',
      '⚠️ 用料是【从最高品质往下扣】的，这条改不了。\n' +
      '所以下面挑出来的是「**手里该留着哪一档**」（买 / 造的时候照它来），' +
      '不是"这一轮点哪个按钮"。\n' +
      '把用不上的高档货囤在某道菜上，等于白花那份料钱。'));

    var plan = restQPlan(d, d.cur, price, staff);
    if (plan.err) { box.appendChild(el('div', 'warn', plan.err)); return; }

    var b = plan.best;
    var bt = el('div', 'best');
    bt.appendChild(el('b', null, '最划算的品质配法：'));
    bt.appendChild(document.createTextNode(
      '　总品质 ' + (Math.round(b.qsum * 10) / 10) +
      '　评分 ' + (Math.round(b.rating * 100) / 100) +
      '　上座率 ' + (b.occ * 100).toFixed(1) + '%' +
      '　料 $' + cmpMoney(b.cost) +
      '　这一轮 $' + cmpMoney(b.profit) +
      '（按 $' + price + ' 算）'));
    box.appendChild(bt);

    /*
     * ⚠️ 一定要和【两个极端】比。
     *    只报一个"最划算"的话，没法知道它到底省下了什么 ——
     *    而这一整块功能的价值全在那个差额上。
     */
    var ends = [
      { n: '全用最高品质', row: plan.all[plan.all.length - 1] },
      { n: '全用最便宜的', row: plan.all[0] },
    ];
    ends.forEach(function (e) {
      if (!e.row || e.row.key === b.key) return;
      var one = el('div', 'sub');
      one.appendChild(el('b', null, '对比 · ' + e.n + '：'));
      one.appendChild(document.createTextNode(
        '　总品质 ' + (Math.round(e.row.qsum * 10) / 10) +
        '　评分 ' + (Math.round(e.row.rating * 100) / 100) +
        '　料 $' + cmpMoney(e.row.cost) +
        '　这一轮 $' + cmpMoney(e.row.profit) +
        '　→ 比最划算那份少赚 $' + cmpMoney(b.profit - e.row.profit)));
      box.appendChild(one);
    });

    // ---- 每道菜挑了哪一档，以及它有哪些档可挑 ----
    var t = el('table', 'qt');
    var hr = el('tr');
    ['菜', '这一轮吃', '挑中的档', '单价', '这道菜的料钱', '仓里有的档（品质 → 单价）']
      .forEach(function (h) { hr.appendChild(el('th', null, h)); });
    t.appendChild(hr);
    plan.picks.forEach(function (pk, i) {
      var n = d.cur.need[pk.id] || 0;
      var r = el('tr');
      r.appendChild(el('td', null, RW('mapName')(pk.id)));
      r.appendChild(el('td', null, n.toLocaleString()));
      r.appendChild(el('td', null, 'Q' + (Math.round(pk.opt.ql * 100) / 100)));
      r.appendChild(el('td', null, '$' + cmpMoney(pk.opt.unit)));
      r.appendChild(el('td', null, '$' + cmpMoney(pk.opt.cost)));
      r.appendChild(el('td', null, plan.opts[i].map(function (o) {
        return 'Q' + (Math.round(o.ql * 100) / 100) + '→$' + cmpMoney(o.unit);
      }).join('　')));
      // 没挑最高的那一档 —— 这一行就是"高品质不划算"的实例，标出来
      if (plan.opts[i].length > 1 && pk.opt.ql < plan.opts[i][0].ql - 1e-9) {
        r.className = 'hit';
      }
      t.appendChild(r);
    });
    box.appendChild(t);

    var down = plan.picks.filter(function (pk, i) {
      return plan.opts[i].length > 1 && pk.opt.ql < plan.opts[i][0].ql - 1e-9;
    }).length;
    box.appendChild(el('div', 'sub', down
      ? ('标出来那 ' + down + ' 道菜【最高的那一档不划算】—— ' +
         '多出来的品质换来的评分，不够抵那一档多花的料钱。')
      : '每道菜都是最高那一档最划算 —— 这一局里高品质确实值那个价。'));
    box.appendChild(el('div', 'sub',
      '⚠️ 这一屏按 $' + price + ' 算的。价格换了，"多一分评分值多少钱"就变了，' +
      '挑法也会跟着变 —— 把价格那一格填上可以定死它。'));
  }

  /**
   * ---- 勾选②：连菜单一起挑 ----
   *
   * ⚠️ 摆一个按钮而不是一进来就算：这一次要试五万多种配法。
   *    自动跑的话，每改一次价格都会卡住几秒，而卡住的原因屏幕上没有任何线索。
   */
  function restMenuPanel(box, d, ov, hasP) {
    var p0 = hasP ? Number(REST.price) : 96;
    var byOcc = OVO(ov) != null;
    if (byOcc) {
      box.appendChild(el('div', 'sub',
        '你填了上座率，所以这里挑的是【哪一套菜能让你在保住 ' +
        (OVO(ov) * 100) + '% 的前提下定得最高】—— 不是"哪套最赚"。\n' +
        '⚠️ 按利润排的话，上菜数不随菜单变，利润只剩料钱在动，' +
        '排出来的会是"最省料的那一套"—— 那答的不是你问的问题。'));
    }
    box.appendChild(el('div', 'sub',
      '在【仓里有料、而且够这一轮吃】的菜里穷举全部配法。\n' +
      (byOcc ? '每一套都反解一次"最高能定到多少还保住这个上座率"，按那个价排。'
             : ('⚠️ 分两段：先在 $' + p0 + ' 这一个价位、')) +
      (byOcc ? '' : (REST.staff === true ? '优质服务' : '普通服务')) +
      (byOcc ? '' :
        ('上把全部配法扫一遍，再把最赚的前几份各做一次完整的价格扫描（两档服务都比）。\n' +
         '所以第一段是真的穷举，第二段只复查前几名 —— ' +
         '换价格会让排名小幅变动，极端情况下冠军可能落在复查名单之外。'))));
    var bar = el('div', 'free');
    var go = el('button', null, REST.menuRun ? '重新算一次' : '开始穷举（要几秒）');
    go.onclick = function () {
      REST.menuRun = restMenuOpt(d, REST.staff, ov, p0);
      restRender();
    };
    bar.appendChild(go);
    if (REST.menuRun) {
      var cl = el('button', null, '清掉');
      cl.onclick = function () { REST.menuRun = null; restRender(); };
      bar.appendChild(cl);
    }
    box.appendChild(bar);

    var run = REST.menuRun;
    if (!run) return;
    if (run.err) { box.appendChild(el('div', 'warn', run.err)); return; }
    if (!run.best) {
      box.appendChild(el('div', 'warn',
        '一种配得起来的配法都没有：' + run.total.toLocaleString() +
        ' 种里 ' + run.skipped.toLocaleString() + ' 种料不够。\n' +
        '先把料备上 —— 用量是按【满座】算的，不是按上座率。'));
      return;
    }
    var b = run.best;
    var bt = el('div', 'best');
    if (b.maxPrice != null) {
      bt.appendChild(el('b', null, '保住 ' + (OVO(ov) * 100) + '% 还能定得最高的配法：'));
      bt.appendChild(document.createTextNode(
        '　' + b.m.menu.length + ' 道　最高定到 $' + b.maxPrice +
        '　' + (b.staff ? '优质服务' : '普通服务') +
        '　（那个价上需要评分 ' + (Math.round(b.reqAt * 100) / 100) +
        '，这套菜有 ' + (Math.round(
          RW('mapRestRating')({ menu: b.m.menu, price: b.maxPrice, staff: b.staff,
                                style: d.style, qsum: b.m.qsum }).r * 100) / 100) +
        '）　料 $' + cmpMoney(b.m.cost)));
    } else {
      bt.appendChild(el('b', null, '最赚的配法：'));
      bt.appendChild(document.createTextNode(
        '　' + b.m.menu.length + ' 道　价格 $' + b.price +
        '　' + (b.staff ? '优质服务' : '普通服务') +
        '　评分 ' + (Math.round(b.rating * 100) / 100) +
        '　上座率 ' + (b.occ * 100).toFixed(1) + '%' +
        '　这一轮 $' + cmpMoney(b.profit)));
    }
    box.appendChild(bt);

    // 摊开这份菜单，按组分行 —— 多样性系数是按组算的，混在一行里看不出来
    RW('MAP_REST_GROUPS').forEach(function (g) {
      var ids = b.m.menu.filter(function (id) { return RW('mapRestDish')(id).g === g; });
      var line = el('div', 'sub');
      line.appendChild(el('b', null, RW('MAP_REST_GNAME')[g] + '　' + ids.length + ' 道　'));
      line.appendChild(document.createTextNode(
        ids.map(function (id) { return RW('mapName')(id); }).join('、')));
      box.appendChild(line);
    });

    /*
     * ⚠️ 一定要和【你现在这份】比一比。
     *    只报一个"最优"的话，人没法知道值不值得动 ——
     *    差 200 块和差 20 万，决定完全不一样。
     */
    var cmp = el('div', 'sub');
    cmp.appendChild(el('b', null, '和你现在这份比：'));
    if (b.maxPrice != null) {
      var mineHit = restMaxPriceAt(restTargetScan(d, OVO(ov), d.cur, b.staff));
      cmp.appendChild(document.createTextNode(mineHit
        ? ('　你的 ' + d.menu.length + ' 道最高定到 $' + mineHit.price +
           '　→ 换成上面那份能多定 $' + (b.maxPrice - mineHit.price))
        : ('　你现在这份一个价位都保不住 ' + (OVO(ov) * 100) + '%，上面那份可以。')));
    } else {
      var mine = restBest(restSweep(d, b.staff, ov, d.cur));
      cmp.appendChild(document.createTextNode(
        '　你的 ' + d.menu.length + ' 道在最优价 $' + mine.price + ' 是 $' +
        cmpMoney(mine.profit) + '　→ 换成上面那份多赚 $' +
        cmpMoney(b.profit - mine.profit)));
    }
    box.appendChild(cmp);
    box.appendChild(el('div', 'sub',
      '第一段扫了 ' + run.tried.toLocaleString() + ' 种（' + run.total.toLocaleString() +
      ' 种里有 ' + run.skipped.toLocaleString() + ' 种料不够，直接扔了）；' +
      '第二段把前 ' + run.keep + ' 名做了 ' + run.tried2 + ' 次完整价格扫描。'));
  }

  function restRender() {
    var box = document.getElementById('scs-restwin');
    if (!box) return;
    clear(box);
    box.appendChild(el('h3', null, '🍽 餐馆优化器'));

    var d = restRead();
    if (d.err) {
      box.appendChild(el('div', 'warn', d.err));
      /*
       * ⚠️ 报错之后还要给一条【下一步怎么办】。
       *    只说"先点开一栋餐馆"是够的；但"页面版本太老"那种，
       *    人不知道自己该干嘛，所以顺带把当前的判断结果摊出来。
       */
      var why2 = el('div', 'sub');
      var missFn = restReady();
      var bx = window.SIMCO_MAP;
      why2.textContent =
        '现在的状态：' +
        (document.body.classList.contains('mode-map') ? '在游戏模拟里' : '不在游戏模拟里') +
        '　导出表：' + (bx ? ('有（页面 ' + (bx.build || '未知') + '）') : '没有') +
        '　' + (missFn ? ('缺 ' + missFn) : '算法齐了') +
        '　' + (!missFn && RW('MAP') && RW('MAP').sel ? '已选中一栋楼' : '还没点开任何楼') +
        '\n插件 ' + SCS_VER;
      box.appendChild(why2);
      return;
    }
    box.appendChild(el('div', 'sub',
      '算法【全部直接调页面自己的那几个函数】—— 不抄一份进来。\n' +
      '⚠️ 评分和上座率这两块本来就是私服自定的（页面上那块黄框写着），' +
      '所以下面这些「最优」是在那套公式里的最优，不是官方的。'));

    // ---- 抓到的 ----
    var got = el('div', 'got');
    [['菜单', d.menu.length + ' 道' + (d.ok ? '' : '（三组没齐）')],
     ['座位', d.seats.toLocaleString() + '（' + d.lv + ' 级 · ' +
       (d.style === 'lux' ? '豪华' : '经济型') + '）'],
     ['总品质', (Math.round(d.qsum * 10) / 10)],
     ['食材成本', '$' + cmpMoney(d.cost)],
     ['工资（含管理费）', '$' + cmpMoney(d.wage)],
     ['同行座位', d.other.toLocaleString()]].concat(d.stops > 0
       ? [['⚠️ 页面记了歇业', '这栋楼在页面上记了 ' + d.stops + ' 次歇业，' +
            '页面算历史账时评分会 ×' + (Math.round(d.decay * 1000) / 1000) +
            '。餐馆常态是一直转、不主动排「下次关闭」不会停，' +
            '所以**这一屏不算它**。两边评分对不上的话，差的就是这一项。']]
       : []).forEach(function (o) {
      var one = el('span');
      one.appendChild(el('b', null, o[0] + ' '));
      one.appendChild(document.createTextNode(String(o[1])));
      got.appendChild(one);
    });
    box.appendChild(got);
    if (d.draftDiff) {
      box.appendChild(el('div', 'warn',
        '⚠️ 这一屏算的是【你正在编辑的那一份】（和页面面板上摆着的一致），' +
        '不是这一轮实际在跑的那一份。\n' +
        '这一轮实际在跑：' + d.eff.menu.length + ' 道菜 · $' + d.eff.price + ' · ' +
        (d.eff.staff ? '优质服务' : '普通服务') + '。'));
    }
    if (d.missMat.length) {
      box.appendChild(el('div', 'warn',
        '⚠️ 有 ' + d.missMat.length + ' 样食材仓库里没有 —— 食材成本按【已有的那些】算，' +
        '所以下面的利润偏高。'));
    }
    if (!d.ok) {
      box.appendChild(el('div', 'warn',
        '⚠️ 菜单三组没齐（沙拉吧 / 主菜 / 饮品各要至少一道），评分是 0，' +
        '这一屏算出来的东西没有意义。先把菜单配齐。'));
      return;
    }

    // ---- 没填的 ----
    var free = el('div', 'free');
    free.appendChild(el('span', null, '空着的就拿来扫：'));
    free.appendChild(el('span', null, '价格 '));
    free.appendChild(restNum(REST.price, '不填=扫全程', function (v) {
      REST.price = v; restRender();
    }));
    free.appendChild(el('span', null, '　评分 '));
    free.appendChild(restNum(REST.rating, '不填=按菜单算', function (v) {
      REST.rating = v; restRender();
    }));
    /*
     * 上座率：按 % 填，小数点随便（62.5 就是 62.5%）。
     *
     * ⚠️ 单位写在标签上，而且占位符里再写一遍 ——
     *    这一格填 0.625 还是 62.5 是个真会犯的错，
     *    而填错了不会报错，只会把上菜数算成千分之一，
     *    然后整屏利润变成一大片亏损，**看着像是菜单太贵**。
     */
    free.appendChild(el('span', null, '　上座率 % '));
    free.appendChild(restNum(REST.occ, '如 62.5，不填=按评分算', function (v) {
      REST.occ = v; restRender();
    }));
    var sb = el('button', null, REST.staff == null
      ? '服务：两档都扫' : (REST.staff ? '服务：优质' : '服务：普通'));
    sb.onclick = function () {
      REST.staff = (REST.staff == null) ? true : (REST.staff ? false : null);
      restRender();
    };
    free.appendChild(sb);
    box.appendChild(free);

    var hasP = REST.price !== '' && isFinite(Number(REST.price));
    var hasR = REST.rating !== '' && isFinite(Number(REST.rating));

    /*
     * ⚠️ 填了范围外的数要【说出来】，不能悄悄夹住。
     *    夹住的话，填 625（少打一个小数点）会被当成 100%，
     *    整屏都按满座算 —— 而屏幕上没有任何一处说它替你改了数。
     */
    var occRaw = REST.occ !== '' && isFinite(Number(REST.occ)) ? Number(REST.occ) : null;
    var occBad = occRaw != null && (occRaw < 0 || occRaw > 100);
    var hasO = occRaw != null && !occBad;
    var ov = restOv(hasR ? Number(REST.rating) : null, hasO ? occRaw / 100 : null);
    var ratingOv = ov;
    if (occBad) {
      box.appendChild(el('div', 'warn',
        '⚠️ 上座率填的是 ' + occRaw + ' —— 这一格的单位是【百分数】，' +
        '要填 0~100（62.5 就是 62.5%）。\n' +
        '这一次先当没填，按评分算。'));
    }

    /*
     * ---- 上座率一钉死，好几条链就断了 ----
     *
     * ⚠️ 这一块必须摆出来，而且必须摆在图【前面】。
     *    评分只通过 mapRestOcc 影响结果，那一步被绕过之后，
     *    菜单、品质、豪华、沟通、销售加成**一分钱都不影响这一轮**——
     *    不说的话，人会一路调菜单，等着利润动，而它永远不动。
     */
    /*
     * ⚠️ 上菜数**只算一处**：拿 restOne 探一笔，屏幕上到处都用它的结果。
     *
     *    第一版屏幕上那行是自己乘一遍 `座位 × occRaw / 100` 算出来的 ——
     *    于是"% 有没有换算对"这条规则同时活在两个地方。
     *    结果是：把传下去那一路的 /100 拆掉，**测试照样绿**
     *    （屏幕上那行自己除过了），而真正参与算钱的那一路已经错成 100 倍。
     *    两边各自看都对。
     *
     *    上座率钉死时上菜数和价格无关，所以探哪个价位都一样。
     */
    var oProbe = hasO ? restOne(d, hasP ? Number(REST.price) : 96, d.staff, ov) : null;
    if (hasO) {
      var ob = el('div', 'got');
      var o1 = el('span');
      o1.appendChild(el('b', null, '上座率 ' + occRaw + '%（你钉死的）'));
      o1.appendChild(document.createTextNode(
        '　上菜 ' + oProbe.served.toLocaleString() +
        ' / ' + d.seats.toLocaleString() + ' 座'));
      ob.appendChild(o1);
      var o2 = el('span');
      o2.appendChild(el('b', null, '⚠️ 评分这条链断了：'));
      o2.appendChild(document.createTextNode(
        '菜单 / 品质 / 豪华 / 沟通 / 销售加成都只通过评分影响上座率，' +
        '钉死之后它们对这一轮的账【一分钱都不影响】。优质服务只剩工资那一头。'));
      ob.appendChild(o2);
      box.appendChild(ob);

      /*
       * 反推：你量到这个上座率，对应的评分是多少 —— 这个数才是有意义的那个。
       * ⚠️ 拿页面的 mapRestOcc 二分出来的，不是我这边解的方程。
       */
      var ip = restImpliedRating(d, hasP ? Number(REST.price) : 96, occRaw / 100);
      var ir = el('div', 'sub');
      if (ip.err) {
        ir.textContent = '⚠️ ' + ip.err;
      } else {
        var mine0 = RW('mapRestRating')({ menu: d.menu, price: hasP ? Number(REST.price) : 96,
                                          staff: d.staff, style: d.style,
                                          qsum: d.cur.qsum });
        ir.textContent =
          '反推：在 $' + (hasP ? Number(REST.price) : 96) + ' 上，' + occRaw +
          '% 对应评分 ' + (Math.round(ip.rating * 100) / 100) +
          '　（你这份菜单算出来是 ' + (Math.round(mine0.r * 100) / 100) + '）\n' +
          '这是拿页面自己的上座率公式二分出来的，不是我这边解的方程。';
      }
      box.appendChild(ir);
    }

    /*
     * ---- 两个【默认关着】的开关 ----
     *
     * ⚠️ 这两块都会多摊出一整屏东西（一张分档表 / 一次五万多种配法的穷举）。
     *    平时进来只想问"这个价该定多少"的人不该被它们挡着，所以默认不出现。
     *
     * ⚠️ 但**底下的算法不归它们管**：这一屏的总品质一直是按
     *    「这一轮真的要吃掉那么多」算的（和页面自己的账一个口径）。
     *    勾选只决定**摊不摊开给你看**，不决定算得对不对 ——
     *    做成开关的话，关着的时候这一屏会和页面对不上，而两边各自看都对。
     */
    var opt = el('div', 'free');
    opt.appendChild(restChk('挑品质（按各档的成本算）', REST.showQ, function (v) {
      REST.showQ = v; restRender();
    }));
    opt.appendChild(restChk('连菜单一起挑（只在有料的菜里）', REST.optMenu, function (v) {
      REST.optMenu = v; REST.menuRun = null; restRender();
    }));
    box.appendChild(opt);

    if (REST.showQ) restQPanel(box, d, ov, hasP);
    if (REST.optMenu) restMenuPanel(box, d, ratingOv, hasP);

    /*
     * ---- 上座率钉死时，图全都不画 ----
     *
     * ⚠️ 三张图的纵轴都是评分（或者由评分驱动），而评分这条链已经断了 ——
     *    画出来是一张【每一行都一模一样】的面，和一条水平的曲线。
     *    那种图最坑：它看着完全正常，只是不带任何信息，
     *    而人会对着它得出"评分怎么调都没用"这种关于游戏的错误结论，
     *    ——问题其实出在他自己钉死了上座率。
     *
     *    所以这里改成把结论直接说出来。
     */
    if (hasO) {
      /*
       * ---- 反解：要保持这个上座率，该怎么定价 / 需要多少评分 / 菜怎么配 ----
       *
       * ⚠️ 这一屏【不求利润最大】。钉死上座率再求利润最大必然顶到最高价，
       *    那是个废答案 —— 上座率是上座率，跟"该定多高"是两回事。
       *    利润在下面只作为一列信息列出来，不当目标。
       */
      var rowsT = restTargetScan(d, occRaw / 100, d.cur, !!d.staff);
      var hit = restMaxPriceAt(rowsT);

      if (!hit) {
        /*
         * ⚠️ 一个价位都够不到时，**不给一个凑合的价格**，
         *    而是说清楚差在哪：是评分不够，还是这个上座率本来就到不了顶。
         */
        var first = rowsT[0];
        box.appendChild(el('div', 'warn', first.reqErr
          ? ('⚠️ ' + first.reqErr + '\n' +
             '就算定到最低价 $' + first.price + '、评分拉满也到不了 ' + occRaw + '%。')
          : ('⚠️ 你这份菜单一个价位都保不住 ' + occRaw + '%。\n' +
             '最便宜的 $' + first.price + ' 那里：需要评分 ' +
             (Math.round(first.req * 100) / 100) + '，你只有 ' +
             (Math.round(first.have * 100) / 100) + '（差 ' +
             (Math.round((first.req - first.have) * 100) / 100) + ' 分）。\n' +
             '要么提品质 / 加菜品数 / 开优质服务，要么把目标降一点。')));
      } else {
        var one = restOne(d, hit.price, d.staff, restOv(null, occRaw / 100));
        var bt1 = el('div', 'best');
        bt1.appendChild(el('b', null, '要保持 ' + occRaw + '%，最高能定到：'));
        bt1.appendChild(document.createTextNode(
          '　$' + hit.price +
          '　（这个价上需要评分 ' + (Math.round(hit.req * 100) / 100) +
          '，你这份菜单有 ' + (Math.round(hit.have * 100) / 100) + '）'));
        box.appendChild(bt1);
        box.appendChild(el('div', 'sub',
          '再往上定一块钱就保不住了：$' + (hit.price + 1) + ' 需要评分 ' +
          (rowsT[hit.price + 1 - rowsT[0].price] &&
           rowsT[hit.price + 1 - rowsT[0].price].req != null
             ? (Math.round(rowsT[hit.price + 1 - rowsT[0].price].req * 100) / 100)
             : '够不到') + '。\n' +
          '顺带（不是这一屏的目标）：这个价上上菜 ' + one.served.toLocaleString() +
          '，料 $' + cmpMoney(d.cur.cost) + '，工资 $' + cmpMoney(one.wage) +
          '，这一轮 $' + cmpMoney(one.profit) + '。'));
      }

      /*
       * 两条线：需要的评分 / 你有的评分。交点就是上面那个价。
       * ⚠️ 两条【共用一个纵轴】（grp 一样）—— 各自缩放的话，
       *    "在哪儿交叉"这件事会从图上直接消失，而两条线各自看都对。
       */
      var pts = function (k) {
        return rowsT.filter(function (r) { return r[k] != null; })
                    .map(function (r) { return { x: r.price, y: r[k] }; });
      };
      restLines(box, [
        { n: '这个价位【需要】的评分', grp: 'r', c: '#facc15', pts: pts('req'),
          fmt: function (v) { return String(Math.round(v * 100) / 100); } },
        { n: '你这份菜单【有】的评分', grp: 'r', c: '#7dd3fc', pts: pts('have'),
          fmt: function (v) { return String(Math.round(v * 100) / 100); } },
      ], hit ? hit.price : null, '价格 →');
      box.appendChild(el('div', 'sub',
        '⚠️ 这一屏回答的是"怎么达到这个上座率"，**不是**"怎么最赚"。\n' +
        '两条线方向相反：价格越高，需要的评分越高（价格罚），而你有的评分越低（价格分）。\n' +
        '想问"怎么最赚"，把上座率那一格清空。'));
      return;
    }

    /*
     * 三种情况，对应三张图。
     * ⚠️ 顺序是【空着几个】决定的，不是让人去挑图表类型 ——
     *    挑图表是让人替算法做决定，而他要的是"帮我算哪个最优"。
     */
    if (!hasP && !hasR) {
      // 两个都空：价格 × 评分 的面
      var gd = restGrid(d, 40, 30);
      /*
       * ---- 你【够得到】的其实只有一条线，不是一整张面 ----
       *
       * ⚠️ 这一段是被问出来的："最赚的一格 评分 10 → $569,622"，
       *    可他这份菜单根本到不了 10 —— 那个数是**永远拿不到的**。
       *
       *    评分那一轴从头到尾是【假设】（原来只在图底下用一行小字说了），
       *    而顶上那句"这张面上最赚的一格"是**加粗的绿框**。
       *    一个够不到的数摆在最显眼的位置、旁边一行小字说它是假设 ——
       *    等于没说。而且现在旁边就是菜单穷举报出来的【真能拿到】的数，
       *    两个一对，只会得出"这插件算错了"。
       *
       *    实际上给定菜单之后，每个价位上评分**只有一个值**（价格那一项在动）。
       *    所以能拿到的是面上的一条曲线。把它画上去，
       *    并且把绿框让给曲线上的最优点 —— 面上的最高点降级成"如果能到 N"。
       */
      var reach = restSweep(d, d.staff, ov);
      var rBest = restBest(reach);
      var rMax = 0;
      reach.forEach(function (r) { if (r.rating > rMax) rMax = r.rating; });

      var tabs = el('div', 'tabs');
      [['heat', '热力图'], ['3d', '3D（可拖动）']].forEach(function (o) {
        var b = el('button', REST.view === o[0] ? 'on' : null, o[1]);
        b.onclick = function () { REST.view = o[0]; restRender(); };
        tabs.appendChild(b);
      });
      box.appendChild(tabs);
      if (REST.view === '3d') restSurf(box, gd); else restHeat(box, gd, reach);

      if (rBest) {
        var bt = el('div', 'best');
        bt.appendChild(el('b', null, '你现在够得到的最优：'));
        bt.appendChild(document.createTextNode(
          '　价格 $' + rBest.price +
          '　评分 ' + (Math.round(rBest.rating * 100) / 100) +
          '（你这份菜单在这个价上就是这个评分）' +
          '　上座率 ' + (rBest.occ * 100).toFixed(1) + '%' +
          '　这一轮 $' + cmpMoney(rBest.profit)));
        box.appendChild(bt);
      }
      /*
       * ⚠️ 面上那个最高点仍然报，但**必须写明它够不够得到**。
       *    删掉它不对（"评分再高能多赚多少"是个真问题），
       *    藏起来也不对 —— 图上那块最亮的地方就在那儿摆着。
       */
      if (gd.top) {
        var hy = el('div', 'sub');
        var gap = gd.top.rating - rMax;
        hy.textContent = gap > 0.01
          ? ('整张面上最高的一格是：价格 $' + Math.round(gd.top.price) +
             '　评分 ' + (Math.round(gd.top.rating * 100) / 100) +
             '　$' + cmpMoney(gd.top.profit) + '\n' +
             '⚠️ 但那个评分你【现在到不了】—— 这份菜单最高只有 ' +
             (Math.round(rMax * 100) / 100) + '（还差 ' +
             (Math.round(gap * 100) / 100) + ' 分）。那一格问的是' +
             '"如果评分能到那么高，该定多少钱"，不是一个你能去执行的方案。')
          : ('整张面上最高的一格就在你够得到的范围里 —— 上面那个绿框就是它。');
        box.appendChild(hy);
      }
      box.appendChild(el('div', 'sub',
        '图上那条亮线 = 你这份菜单**实际**会走的路（每个价位上评分只有一个值）。\n' +
        '线以外的地方全是假设：它问的是"如果评分是 N，该定多少钱"。'));
      return;
    }

    if (hasR && !hasP) {
      // 评分定死，只扫价格
      restLinesWrap(box, d, ratingOv);
      return;
    }

    if (!hasR && hasP) {
      // 价格定死，扫评分 → 上座率
      var rc = restRatingCurve(d, Number(REST.price));
      restLines(box, [
        { n: '上座率', c: '#7dd3fc',
          pts: rc.map(function (r) { return { x: r.rating, y: r.occ }; }),
          fmt: function (v) { return (v * 100).toFixed(1) + '%'; } },
        { n: '这一轮利润', c: '#86efac',
          pts: rc.map(function (r) { return { x: r.rating, y: r.profit }; }),
          fmt: function (v) { return '$' + cmpMoney(v); } },
      ], null, '评分 →');
      var now = RW('mapRestRating')({ menu: d.menu, price: Number(REST.price),
                                       staff: d.staff, style: d.style,
                                       qsum: d.cur.qsum });
      box.appendChild(el('div', 'best',
        '你现在这份菜单算出来的评分是 ' + (Math.round(now.r * 100) / 100) +
        '，对应上座率 ' +
        (RW('mapRestOcc')(now.r, Number(REST.price), d.other).occ * 100).toFixed(1) + '%'));
      return;
    }

    // 两个都填了：只报一个数
    var one = restOne(d, Number(REST.price), d.staff, ratingOv);
    box.appendChild(el('div', 'best',
      '价格 $' + REST.price + '：评分 ' + (Math.round(one.rating * 100) / 100) +
      '　上座率 ' + (one.occ * 100).toFixed(1) + '%　上菜 ' +
      one.served.toLocaleString() + '　这一轮 $' + cmpMoney(one.profit)));
    box.appendChild(el('div', 'sub', '把价格那一格清空，就会扫全程画曲线。'));
  }

  /** 只扫价格那一张：一档服务 or 两档一起比。 */
  function restLinesWrap(box, d, ov) {
    var archs = (REST.staff == null) ? [false, true] : [REST.staff];
    var all = archs.map(function (st) {
      return { st: st, rows: restSweep(d, st, ov) };
    });
    var COL = { p: '#7dd3fc', s: '#f0abfc' };

    var winner = null;
    all.forEach(function (a) {
      var b = restBest(a.rows);
      if (!winner || b.profit > winner.profit) winner = b;
    });

    // 利润：两档共用一个纵轴（grp 一样），不然比不出高低
    restLines(box, all.map(function (a) {
      return { n: (a.st ? '优质服务' : '普通服务') + ' · 利润', grp: 'profit',
               c: a.st ? COL.s : COL.p,
               pts: a.rows.map(function (r) { return { x: r.price, y: r.profit }; }),
               fmt: function (v) { return '$' + cmpMoney(v); } };
    }), winner ? winner.price : null, '价格 →');

    // 评分和上座率单独一张 —— 和利润不是一个量级，塞一起会压成直线
    restLines(box, [
      { n: '评分', c: '#facc15',
        pts: all[0].rows.map(function (r) { return { x: r.price, y: r.rating }; }),
        fmt: function (v) { return String(Math.round(v * 100) / 100); } },
      { n: '上座率', c: '#86efac',
        pts: all[0].rows.map(function (r) { return { x: r.price, y: r.occ }; }),
        fmt: function (v) { return (v * 100).toFixed(1) + '%'; } },
    ], winner ? winner.price : null, '价格 →');

    if (winner) {
      var bt = el('div', 'best');
      bt.appendChild(el('b', null, '利润最高：'));
      bt.appendChild(document.createTextNode(
        '　价格 $' + winner.price + '　' + (winner.staff ? '优质服务' : '普通服务') +
        '　评分 ' + (Math.round(winner.rating * 100) / 100) +
        '　上座率 ' + (winner.occ * 100).toFixed(1) + '%' +
        '　上菜 ' + winner.served.toLocaleString() +
        '（浪费 ' + winner.spoiled.toLocaleString() + '）' +
        '　这一轮 $' + cmpMoney(winner.profit)));
      box.appendChild(bt);
      if (winner.profit < 0) {
        bt = el('div', 'warn');
        bt.textContent = '⚠️ 最赚的那一档也是亏的 —— 这份菜单在当前规模下没有赚钱的价位。\n' +
          '往上抬品质、往上加道数（多样性系数会降用料），或者关掉优质服务。';
        box.appendChild(bt);
      }
      if (archs.length === 2) {
        var lo = restBest(all[0].rows), hi = restBest(all[1].rows);
        var tip = el('div', 'sub');
        /*
         * ⚠️ 这句话里【不写死任何系数】。
         *    "优质服务换 N 分评分"那个 N 是页面上的常数，抄进来就会跟着漂 ——
         *    所以直接量：拿两档在同一个价位上的评分差报出来。
         *    量出来的数永远和页面一致，页面改了它自己就跟着改。
         */
        var dR = hi.rating - restOne(d, hi.price, false, ov).rating;
        tip.textContent = '两档各自的最优：普通 $' + lo.price + ' → ' + cmpMoney(lo.profit) +
          '　优质 $' + hi.price + ' → ' + cmpMoney(hi.profit) +
          '　差 ' + cmpMoney(Math.abs(hi.profit - lo.profit)) +
          '（优质服务多花 ' + cmpMoney(hi.wage - lo.wage) + ' 工资，换 ' +
          (Math.round(dR * 100) / 100) + ' 分评分）';
        box.appendChild(tip);
      }
    }
  }

  /** 什么时候把那个按钮亮出来。 */
  /*
   * 便宜的那道门：**只看在不在游戏模拟里**。
   *
   * ⚠️ 第一版还要求"而且已经点进了一栋餐馆"。想法是对的（别在没用的地方挡着），
   *    但后果很差：那个键什么时候会出现【全靠猜】——
   *    没出现的时候，你没法区分"条件没满足"和"这功能根本坏了"。
   *    实际上就是这么坏了一次，而屏幕上没有任何线索。
   *
   *    现在改成：进游戏模拟就亮，点开之后由面板自己说缺什么。
   *    **能说话的面板 > 会消失的按钮。**
   *
   * ⚠️ 这里【不能】调 restRead() —— 它会去算食材、工资、评分，
   *    而这个 sync 挂在 MutationObserver 上，页面每重画一次就跑一遍。
   */
  function restOn() {
    try {
      return document.body.classList.contains('mode-map');
    } catch (e) { return false; }
  }

  function restWatch() {
    var sync = function () {
      var on = restOn();
      var fab = document.getElementById('scs-rest');
      // ⚠️ 明确写 'block'，不写 '' —— 见上面 CSS 那段注释
      if (fab) fab.style.display = on ? 'block' : 'none';
      if (!on) {
        var w = document.getElementById('scs-restwin');
        if (w) w.style.display = 'none';
      }
    };
    sync();
    try {
      new MutationObserver(sync).observe(document.body,
        { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
    } catch (e) {}
    try { setInterval(sync, 1500); } catch (e) {}
  }

  function buildUI() {
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var fab = el('button', null, '📊');
    fab.id = 'scs-fab';
    fab.title = '词频统计';
    document.body.appendChild(fab);

    /*
     * 合同对比：一个悬浮键 + 一层放小窗的画布。
     * 两个都常驻在 body 上（不是塞进页面某个容器里）——
     * 页面自己重画侧栏/消息流的时候不会把它们连带删掉。
     */
    var cfab = el('button', null, '⚖');
    cfab.id = 'scs-cmp';
    cfab.title = '合同对比：把这张单子分裂成一个可拖动的小窗';
    cfab.onclick = cmpSplit;
    document.body.appendChild(cfab);

    /*
     * 餐馆优化器：一个悬浮键 + 一块面板，都常驻在 body 上。
     * 只有在【游戏模拟里点开了一栋餐馆】的时候才亮出来 ——
     * 别的模式下它没有任何意义，摆着只会挡东西。
     */
    var rfab = el('button', null, '🍽');
    rfab.id = 'scs-rest';
    rfab.title = '餐馆优化器：扫价格 / 服务 / 评分，找利润最高那一档';
    rfab.onclick = function () {
      var w = document.getElementById('scs-restwin');
      if (!w) return;
      var show = w.style.display === 'none' || !w.style.display;
      w.style.display = show ? 'block' : 'none';
      if (show) restRender();
    };
    document.body.appendChild(rfab);
    var rwin = el('div');
    rwin.id = 'scs-restwin';
    document.body.appendChild(rwin);

    var wins = el('div');
    wins.id = 'scs-wins';
    document.body.appendChild(wins);

    var cbar = el('div');
    cbar.id = 'scs-cmpbar';
    document.body.appendChild(cbar);

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
    cmpWatchMode();
    restWatch();
    cmpRender();

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
