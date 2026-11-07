/* 精油芳疗求解引擎：按条件从名录求解配方，六道过滤、七步成方、六项硬标准。
 * 依赖 assets/aroma-data.js 先装载。
 * 对外：AROMA.solve(cond) 返回主方案与备选；AROMA.checkPlan(plan) 复核；
 *       AROMA.classicsOf(plan) 查最近经典方；AROMA.effectPool(effects) 取候选池。
 * 纯函数，无 DOM 依赖；结果只由条件决定，不含随机。 */
(function (global) {
  'use strict';
  var A = global.AROMA = global.AROMA || {};

  function find(arr, key, val) {
    for (var i = 0; i < arr.length; i++) if (arr[i][key] === val) return arr[i];
    return null;
  }
  function oilOf(name) { return find(A.OILS, 'name', name); }
  function groupOf(id) { return find(A.GROUPS, 'id', id); }
  function riskOf(id) { return find(A.RISKS, 'id', id); }
  function seasonOf(id) { return find(A.SEASONS, 'id', id); }
  function constitOf(id) { return find(A.CONSTITUTION, 'id', id); }
  function sceneOf(id) { return find(A.SCENES, 'id', id); }
  function effectOf(id) { return find(A.EFFECTS, 'id', id); }

  /* 效果解析：第一效果主用三分、辅用二分，其后主用二分、辅用一分。 */
  function effectPool(effects) {
    var score = {}, order = [];
    (effects || []).forEach(function (id, idx) {
      var e = effectOf(id);
      if (!e) return;
      var mainW = idx === 0 ? 3 : 2, subW = idx === 0 ? 2 : 1;
      (e.main || []).forEach(function (n) {
        if (!(n in score)) { score[n] = 0; order.push(n); }
        score[n] += mainW;
      });
      (e.sub || []).forEach(function (n) {
        if (!(n in score)) { score[n] = 0; order.push(n); }
        score[n] += subW;
      });
    });
    return order.map(function (n) { return { name: n, score: score[n] }; })
      .sort(function (a, b) { return b.score - a.score; });
  }

  /* 六道过滤：库存、季节、体质、人群、风险、场景。
     性味只作阻断与警示，不改效果分，免把效果核心油压掉。 */
  function hardFilter(cond) {
    var pool = effectPool(cond.effects);
    var group = groupOf(cond.people || 'adult');
    var risks = (cond.risks || []).map(riskOf).filter(Boolean);
    var season = seasonOf(cond.season || 'spring');
    var constit = constitOf(cond.thermal || 'unknown');
    var scene = sceneOf(cond.scene || 'general');
    var stock = cond.stock && cond.stock.oils && cond.stock.oils.length ? cond.stock.oils : null;
    var banned = {};
    function ban(name, reason) { if (!banned[name]) banned[name] = reason; }
    if (group) {
      (group.avoidOils || []).forEach(function (n) { ban(n, '人群：' + group.name); });
      if (group.avoidTags && group.avoidTags.indexOf('全部') >= 0) {
        A.OILS.forEach(function (o) { ban(o.name, '人群：' + group.name); });
      }
    }
    risks.forEach(function (r) {
      (r.avoidOils || []).forEach(function (n) { ban(n, '风险：' + r.name); });
    });
    if (season) (season.block || []).forEach(function (n) { ban(n, '季节：' + season.name); });
    if (constit) (constit.block || []).forEach(function (n) { ban(n, '体质：' + constit.name); });
    var usable = [], excluded = [];
    pool.forEach(function (p) {
      if (stock && stock.indexOf(p.name) < 0) { excluded.push({ name: p.name, reason: '不在库存' }); return; }
      if (banned[p.name]) { excluded.push({ name: p.name, reason: banned[p.name] }); return; }
      usable.push({ name: p.name, score: p.score });
    });
    return { usable: usable, excluded: excluded, group: group, risks: risks, season: season, constit: constit, scene: scene, stock: stock };
  }

  /* 角色：主调取最高分且非后调，辅调取次高异族，定香取后调最高，点缀取剩余。 */
  function pickRoles(usable, count) {
    var remain = usable.slice(), picked = [];
    function take(pred) {
      for (var i = 0; i < remain.length; i++) {
        var o = oilOf(remain[i].name);
        if (o && pred(o)) { picked.push(remain.splice(i, 1)[0]); return picked[picked.length - 1]; }
      }
      return null;
    }
    var main = take(function (o) { return o.layer !== '后'; }) || take(function () { return true; });
    if (main) main.role = '主调';
    if (count >= 2) {
      var mainOil = main ? oilOf(main.name) : null;
      var aux = take(function (o) { return !mainOil || o.scent !== mainOil.scent; }) || take(function () { return true; });
      if (aux) aux.role = '辅调';
    }
    if (count >= 3) {
      var fix = take(function (o) { return o.layer === '后'; }) || take(function () { return true; });
      if (fix) fix.role = '定香';
    }
    while (picked.length < Math.min(count, usable.length)) {
      var rest = take(function () { return true; });
      if (!rest) break;
      rest.role = '点缀';
    }
    return picked;
  }

  /* 比例：按味数骨架，单味上限压回，余量补定香。 */
  function brewPct(picks, count) {
    var brew = A.RULES.brew[Math.min(count, 10)];
    var cap = A.RULES.cap[Math.min(count, 10)] || 100;
    var pct = picks.map(function (p, i) { return Math.min(brew[i] || 0, cap); });
    var sum = pct.reduce(function (a, b) { return a + b; }, 0);
    if (sum < 100 && pct.length) {
      var fixIdx = -1;
      picks.forEach(function (p, i) { if (p.role === '定香') fixIdx = i; });
      if (fixIdx < 0) fixIdx = pct.length - 1;
      pct[fixIdx] += 100 - sum;
    }
    return pct;
  }

  /* 基础油：按用法取默认组合，按种数分配骨架，库存内取。 */
  function pickBases(cond) {
    var method = cond.method || 'roller';
    var want = cond.baseCount || 2;
    var stock = cond.stock && cond.stock.bases && cond.stock.bases.length ? cond.stock.bases : null;
    if (method === 'diffuse') return [];
    var pref;
    if (method === 'roller') pref = ['分馏椰子', '荷荷巴', '甜杏仁'];
    else if (method === 'face') pref = ['荷荷巴', '葡萄籽', '玫瑰果'];
    else if (method === 'massage') pref = ['甜杏仁', '荷荷巴', '小麦胚芽'];
    else pref = ['分馏椰子', '荷荷巴', '甜杏仁'];
    if (stock) pref = pref.filter(function (n) { return stock.indexOf(n) >= 0; });
    if (!pref.length) pref = stock ? stock.slice(0, want) : ['荷荷巴', '甜杏仁', '小麦胚芽'];
    var take = pref.slice(0, Math.max(1, Math.min(want, 3)));
    var pct = A.RULES.base[take.length] || [100];
    var vol = cond.volume || 30, left = vol, ml = [];
    take.forEach(function (n, i) {
      var v = i === take.length - 1 ? left : Math.round(vol * pct[i] / 100);
      left -= v;
      ml.push(v);
    });
    return take.map(function (n, i) { return { name: n, pct: pct[i], ml: ml[i] }; });
  }

  /* 浓度取人群、风险、用法档三者最小；滴数按容量与占比分配，差额补定香。 */
  function calcDrops(cond, picks, pct) {
    var group = groupOf(cond.people || 'adult');
    var risks = (cond.risks || []).map(riskOf).filter(Boolean);
    var method = cond.method || 'roller';
    var conc = method === 'diffuse' ? 0 : (cond.conc || 2);
    var cap = group ? group.cap : 3;
    risks.forEach(function (r) { if (r.cap && r.cap < cap) cap = r.cap; });
    var used = Math.min(conc, cap);
    var vol = cond.volume || 30;
    var total = Math.round(vol * A.RULES.dropsPerMl * used / 100);
    var drops = pct.map(function (p) { return Math.round(total * p / 100); });
    var sum = drops.reduce(function (a, b) { return a + b; }, 0);
    if (sum !== total && drops.length) {
      var fixIdx = -1;
      picks.forEach(function (p, i) { if (p.role === '定香') fixIdx = i; });
      if (fixIdx < 0) fixIdx = drops.length - 1;
      drops[fixIdx] += total - sum;
    }
    return { drops: drops, conc: used, total: total, cap: cap };
  }

  /* 六项硬标准。 */
  function checkPlan(plan) {
    var out = [];
    out.push({ name: '六道合规', pass: !plan.conflicts || plan.conflicts.length === 0, note: plan.conflicts && plan.conflicts.length ? plan.conflicts.join('；') : '通过' });
    out.push({ name: '浓度上限', pass: plan.total.conc <= plan.cap + 0.001, note: plan.total.conc + '%，上限 ' + plan.cap + '%' });
    var cap = A.RULES.cap[plan.parts.length] || 100;
    var over = plan.parts.filter(function (p) { return p.pct > cap; });
    out.push({ name: '单味上限', pass: over.length === 0, note: over.length ? over.map(function (p) { return p.oil + ' ' + p.pct + '%'; }).join('、') : '通过' });
    if (plan.parts.length >= 4) {
      var layers = {};
      plan.parts.forEach(function (p) { layers[p.layer] = true; });
      out.push({ name: '调位完整', pass: !!(layers['前'] && layers['中'] && layers['后']), note: ['前', '中', '后'].filter(function (k) { return layers[k]; }).join('、') || '无' });
    } else if (plan.parts.length === 3) {
      var hasBack = plan.parts.some(function (p) { return p.layer === '后'; });
      out.push({ name: '调位完整', pass: hasBack, note: hasBack ? '后调一门承托' : '缺后调，留香短' });
    } else {
      out.push({ name: '调位完整', pass: true, note: '两味方不判' });
    }
    var byScent = {};
    plan.parts.forEach(function (p) { byScent[p.scent] = (byScent[p.scent] || 0) + 1; });
    var dup = Object.keys(byScent).filter(function (k) { return byScent[k] > 2; });
    out.push({ name: '同族不超二', pass: dup.length === 0, note: dup.length ? dup.join('、') : '通过' });
    var noSrc = plan.parts.filter(function (p) { var o = oilOf(p.oil); return !o || o.status === '待核'; });
    out.push({ name: '出处齐备', pass: noSrc.length === 0, note: noSrc.length ? noSrc.map(function (p) { return p.oil; }).join('、') : '通过' });
    return out;
  }

  /* 经典对照：按共有油数算相似度。 */
  function classicsOf(plan) {
    var mine = plan.parts.map(function (p) { return p.oil; });
    var best = null, bestSim = 0;
    A.CLASSICS.forEach(function (c) {
      var theirs = c.modern.split('、');
      var common = mine.filter(function (n) { return theirs.indexOf(n) >= 0; }).length;
      var sim = mine.length && theirs.length ? common / Math.max(mine.length, theirs.length) : 0;
      if (sim > bestSim) { bestSim = sim; best = c; }
    });
    return best ? { name: best.name, kind: best.kind, author: best.author, sim: Math.round(bestSim * 100) } : null;
  }

  /* 警示：凉类超冬季两成、温类超夏季三成、调位不全。 */
  function noticesOf(plan) {
    var cond = plan.cond || {};
    var out = [];
    var byT = {};
    plan.parts.forEach(function (p) { byT[p.thermal] = (byT[p.thermal] || 0) + p.pct; });
    var cold = cond.thermal === 'cold' || cond.season === 'winter';
    var hot = cond.thermal === 'heat' || cond.season === 'summer';
    if (cold && (byT['凉'] || 0) > 20) out.push('凉类合计 ' + byT['凉'] + '%，超冬季两成，建议减凉类或换平温类');
    if (hot && (byT['温'] || 0) > 30) out.push('温类合计 ' + byT['温'] + '%，超夏季三成，建议减温类');
    if (plan.parts.length >= 3 && plan.checks && plan.checks[3] && !plan.checks[3].pass) {
      out.push('调位不全：' + plan.checks[3].note);
    }
    return out;
  }

  function partsOf(picks, pct, drops) {
    return picks.map(function (p, i) {
      var o = oilOf(p.name);
      return { oil: o.name, role: p.role, pct: pct[i], drops: drops[i], layer: o.layer, thermal: o.thermal, scent: o.scent, concMax: o.concMax, status: o.status };
    });
  }

  function solveCore(cond, usable, count) {
    var picks = pickRoles(usable, count);
    if (!picks.length) return null;
    var pct = brewPct(picks, count);
    var dr = calcDrops(cond, picks, pct);
    var plan = {
      cond: cond,
      parts: partsOf(picks, pct, dr.drops),
      bases: pickBases(cond),
      total: { drops: dr.total, conc: dr.conc, ml: cond.volume || 30 },
      cap: dr.cap,
      conflicts: []
    };
    plan.checks = checkPlan(plan);
    plan.notices = noticesOf(plan);
    plan.classics = classicsOf(plan);
    return plan;
  }

  function samePlan(a, b) {
    var x = a.parts.map(function (p) { return p.oil; }).sort().join('|');
    var y = b.parts.map(function (p) { return p.oil; }).sort().join('|');
    return x === y;
  }

  /* 求解：七步成方，出主方案与两个备选。 */
  function solve(cond) {
    var f = hardFilter(cond);
    var count = Math.max(2, Math.min(8, cond.count || 3));
    var pinned = (cond.pinned || []).map(oilOf).filter(Boolean);
    var usable = f.usable.slice();
    var conflicts = [];
    pinned.forEach(function (o) {
      var at = -1;
      usable.forEach(function (u, i) { if (u.name === o.name) at = i; });
      if (at >= 0) usable.unshift(usable.splice(at, 1)[0]);
      else {
        var reason = '不在库存';
        f.excluded.forEach(function (x) { if (x.name === o.name) reason = x.reason; });
        conflicts.push(o.name + '：' + reason);
      }
    });
    var picks = pickRoles(usable, count);
    if (picks.length < count) conflicts.push('可用不足：仅 ' + picks.length + ' 味');
    var pct = brewPct(picks, count);
    var dr = calcDrops(cond, picks, pct);
    var plan = {
      cond: cond,
      parts: partsOf(picks, pct, dr.drops),
      bases: pickBases(cond),
      total: { drops: dr.total, conc: dr.conc, ml: cond.volume || 30 },
      cap: dr.cap,
      conflicts: conflicts,
      excluded: f.excluded,
      scene: f.scene,
      group: f.group
    };
    plan.checks = checkPlan(plan);
    plan.notices = noticesOf(plan);
    plan.classics = classicsOf(plan);

    var alts = [];
    if (usable.length > count) {
      var alt = solveCore(cond, usable.slice(1), count);
      if (alt && !samePlan(alt, plan)) alts.push(alt);
    }
    if (count > 2) {
      var c2 = Object.assign({}, cond, { count: count - 1 });
      var alt2 = solveCore(c2, usable, count - 1);
      if (alt2 && !samePlan(alt2, plan)) alts.push(alt2);
    }
    plan.alts = alts.slice(0, 2);
    return plan;
  }

  A.solve = solve;
  A.checkPlan = checkPlan;
  A.classicsOf = classicsOf;
  A.effectPool = effectPool;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
