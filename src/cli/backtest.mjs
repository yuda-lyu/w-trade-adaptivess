import fs from 'fs'
import path from 'path'
import { getSettings, argOf, writeJson } from '../cfg.mjs'
import { loadLedger } from '../eval/ledger.mjs'
import { makeEvaluator, lowerBound, mulberry32 } from '../eval/evalCore.mjs'
import { loadPick } from '../eval/pickLoader.mjs'
import { backtestCfg } from '../domain/backtestCfg.mjs'
import { gradeOf } from '../domain/backtestGrade.mjs'


//回測期旗標(只供迴圈與主代理使用; 節點 agent 與做夢 agent 不得執行, 其輸出之數字不得揭露給 agent)
//  node g_backtest.mjs --pick <挑選模組.mjs> --name <結果檔名(無副檔名)> [--dir <結果夾>] [--show]
//    須設環境變數 ARSI_HARNESS=1(迴圈於起子行程時設定); 未設即拒絕執行
//    --show: 另把數字印到標準輸出(主代理校準用; 迴圈不帶)
//  作法: 以全期帳本(訓練期 + 回測期; 私有根)自訓練期之暖機後逐決策執行挑選函數(使其狀態 ctx.state / ctx.prev 連續),
//        只取決策棒落在回測期者計操作績效(持倉簿自回測期起點重新開始); 挑選函數於回測期內之每個決策仍只看得到該決策棒以前之資訊
//        ctx.meta.ntAll 固定為訓練期之進場數(不含回測期)
//  旗標: 七相位等效年化之平均 > rule.meanMin 且最差相位 > rule.worstPhaseMin, 且換亂數種子之複製版(共 backtest.replicas 次重放)皆然 ⇒ pass;
//        未達 pass 者: 分級啟用(backtest.grade.enabled; 預設)時依「對訊號量相當之隨機挑」分為 above / mixed / level / below(src/domain/backtestGrade.mjs), 否則 fail
//  輸出: 私有根 backtest/<name>.json(完整數字 + 參照 + 分段); 標準輸出末行「BACKTEST_FLAG <旗標>」
//  離開碼: 0 完成 / 2 挑選模組問題 / 3 挑選函數執行錯誤 / 4 未授權 / 5 帳本不一致
if (process.env.ARSI_HARNESS !== '1') {
    console.log('g_backtest.mjs 只供迴圈使用(回測期數字不對 agent 揭露); 節點與做夢任務請用 g_eval.mjs')
    process.exit(4)
}
let st = getSettings()
let bt = backtestCfg(st)
let fpPick = argOf('pick', '')
let name = String(argOf('name', ''))
let show = argOf('show', false) === true
let dirArg = argOf('dir', '')
if (dirArg && dirArg !== true) {
    bt.resultDir = path.resolve(String(dirArg)) //結果夾可由呼叫端指定(測試用之狀態根不與正式者混放)
}
if (!fpPick || fpPick === true || !name || name === 'true') {
    console.log('用法: node g_backtest.mjs --pick <挑選模組.mjs> --name <結果檔名> [--dir <結果夾>] [--show]')
    process.exit(2)
}
let pk
try {
    pk = await loadPick(fpPick)
}
catch (err) {
    console.log(`ERROR ${err.code || ''} ${err.message}`)
    process.exit(2)
}
let L = loadLedger(bt.ledgerDir)
let barMs = L.meta.barHours * 3600000
let time0Ms = Date.parse(`${L.meta.time0}Z`)
let barOf = (iso) => Math.round((Date.parse(`${iso}Z`) - time0Ms) / barMs)
let trainEndBar = barOf(st.periods.train.end)
let btStartBar = barOf(st.periods.backtest.start)
//訓練期之進場數(靜態欄; 不含回測期)並與訓練期帳本核對
let ntStatic = new Int32Array(L.n)
for (let s = 0; s < L.n; s++) {
    ntStatic[s] = lowerBound(L.ent, L.off[s], L.off[s + 1], trainEndBar) - L.off[s]
}
{
    let b = fs.readFileSync(path.join(st.eval.ledgerDir, 'off.u32'))
    let offT = new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
    let bad = offT.length !== L.n + 1 ? -2 : -1
    for (let s = 0; s < L.n && bad === -1; s++) {
        if (offT[s + 1] - offT[s] !== ntStatic[s]) {
            bad = s
        }
    }
    if (bad !== -1) {
        console.log(`ERROR 全期帳本與訓練期帳本不一致(策略數或訓練期進場數不同; 位置 ${bad}); 請以同一策略庫重建兩者`)
        process.exit(5)
    }
}
L.ntStatic = ntStatic
let ev = makeEvaluator(L, st.eval)
let accept = typeof pk.accept === 'function' ? pk.accept : null
//亂數種子: 預設 settings.eval.seed; --seed N 可覆寫(主代理校準參照用: 同一模組換種子看等級之分佈)
let seedArg = argOf('seed', null)
let seed = typeof seedArg === 'number' && Number.isFinite(seedArg) ? seedArg : (st.eval.seed === undefined ? 1 : st.eval.seed)
let r2 = (x) => Math.round(x * 100) / 100
//replay, 以某亂數種子重放一次(七相位); 回各相位之切片與操作績效
//  切片帶 k0(其第一個決策於整段重放之決策序): 執行規則收到之 sig.k 與挑選函數之 ctx.k 一致(皆自帳本起點之第一個決策起算)
let replay = (sd) => {
    let rs = []
    let os = []
    for (let ph of st.eval.phases) {
        let r = ev.runPick(pk.pick, ph, sd)
        let i0 = r.bars.findIndex((b) => b >= btStartBar)
        let run = i0 < 0 ? { phase: ph, bars: [], sels: [], tags: [], k0: 0 } : { phase: ph, bars: r.bars.slice(i0), sels: r.sels.slice(i0), tags: r.tags.slice(i0), k0: i0 }
        rs.push(run)
        os.push(ev.opOf(run.sels, run.bars, run.tags, accept, { k0: run.k0 }))
    }
    let e = os.map((o) => o.eqYr)
    let mn = e.reduce((s, v) => s + v, 0) / e.length
    let lo = Math.min(...e)
    let nOrd = os.reduce((s, o) => s + o.nOrders, 0)
    return { seed: sd, runs: rs, ops: os, eq: e, mean: mn, min: lo, nOrders: nOrd, ok: nOrd > 0 && mn > bt.rule.meanMin && lo > bt.rule.worstPhaseMin }
}
//主重放(設定之種子)+ 複製版(種子 + 1、+ 2 …): 全部達判準才 pass
let reps = []
try {
    for (let i = 0; i < bt.replicas; i++) {
        reps.push(replay(seed + i))
    }
}
catch (err) {
    console.log(`ERROR PICK_RUN ${String((err && err.stack) || err).split('\n').slice(0, 6).join('\n')}`)
    process.exit(3)
}
let { runs, ops, eq, mean, min } = reps[0]
let avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0)
let sdOf = (a) => {
    let m = avg(a); return Math.sqrt(avg(a.map((v) => (v - m) * (v - m))))
}
//做多 / 做空之策略序號池與側別配比之隨機挑(grade.matchSides 用)
let longIds = []
let shortIds = []
for (let s = 0; s < L.n; s++) {
    (L.mode[s] > 0 ? longIds : shortIds).push(s)
}
let stamp = new Int32Array(L.n)
let tick = 0
let drawFrom = (pool, k, rng, out, m0) => {
    let m = 0
    while (m < k) {
        let v = pool[Math.floor(rng() * pool.length)]
        if (stamp[v] !== tick) {
            stamp[v] = tick
            out[m0 + m] = v
            m++
        }
    }
}
//nullSides, 同決策時點、同執行規則之隨機挑, 每次決策之隻數 = 成品該次之隻數 × scale, 其中做多之比例固定為 lr(成品於回測期全段之平均做多比例)
//  —— 只匹配**靜態**之多空組成: 偏多 / 偏空之選集不因該期間之多空行情而得分或失分; 成品逐次改變兩側配比(依市況切換)之效果仍留在成品與參照之差內
let nullSides = (rs, draws, sd0, scale, lr) => {
    let vals = []
    let nSig = 0
    let nSlot = 0
    for (let d = 0; d < draws; d++) {
        let rng = mulberry32(sd0 + (d + 1) * 7919)
        let acc = 0
        for (let r of rs) {
            let sels = r.sels.map((sel) => {
                let k = Math.min(L.n, Math.max(sel.length > 0 ? 1 : 0, Math.round(sel.length * scale)))
                let kL = Math.min(longIds.length, Math.round(k * lr))
                let kS = Math.min(shortIds.length, k - kL)
                let out = new Int32Array(kL + kS)
                tick++
                drawFrom(longIds, kL, rng, out, 0)
                drawFrom(shortIds, kS, rng, out, kL)
                nSlot += kL + kS
                return out.sort()
            })
            let o = ev.opOf(sels, r.bars, r.tags, accept, { k0: r.k0 || 0 })
            acc += o.eqYr
            nSig += o.nSignals
        }
        vals.push(acc / rs.length)
    }
    vals.comp = { sigPerPick: nSlot > 0 ? nSig / nSlot : 0 }
    return vals
}
//longRatioOf, 一組重放之選集之做多比例(各決策之選集合計)
let longRatioOf = (rs) => {
    let nL = 0
    let nA = 0
    for (let r of rs) {
        for (let sel of r.sels) {
            nA += sel.length
            for (let i = 0; i < sel.length; i++) {
                if (L.mode[sel[i]] > 0) {
                    nL++
                }
            }
        }
    }
    return nA > 0 ? nL / nA : null
}
//refNull, 一組重放(各相位之切片)之參照: 同劑量之隨機挑(同決策時點、同選集大小、同執行規則);
//  選集之每隻訊號數偏離參照逾 10% 時, 改用訊號量相當之隨機挑(選集大小依比例縮放; 與訓練期評估器之「同訊號量虛無」同一作法);
//  lr 非 null(grade.matchSides)時, 參照另固定做多比例為 lr(見 nullSides)
let refNull = (rs, os, draws, sd0, lr = null) => {
    let obs = avg(os.map((o) => o.eqYr))
    let v1 = ev.nullOf(rs, accept, draws, sd0)
    let nSlot = rs.reduce((s, r) => s + r.sels.reduce((t, x) => t + x.length, 0), 0)
    let selSig = nSlot > 0 ? os.reduce((s, o) => s + o.nSignals, 0) / nSlot : 0
    let kind = 'dose'
    let vals = v1
    let ratio = 1
    if (lr !== null) {
        let vs = nullSides(rs, draws, sd0 + 15485863, 1, lr)
        ratio = vs.comp.sigPerPick > 0 ? selSig / vs.comp.sigPerPick : 1
        kind = 'side'
        vals = vs
        if (Math.abs(ratio - 1) > 0.1) {
            vals = nullSides(rs, draws, sd0 + 104729, ratio, lr)
            kind = 'side+vol'
        }
    }
    else {
        ratio = v1.comp && v1.comp.sigPerPick > 0 ? selSig / v1.comp.sigPerPick : 1
        if (Math.abs(ratio - 1) > 0.1) {
            let rs2 = rs.map((r) => ({ ...r, sels: r.sels.map((sel) => ({ length: Math.min(L.n, Math.max(sel.length > 0 ? 1 : 0, Math.round(sel.length * ratio))) })) }))
            vals = ev.nullOf(rs2, accept, draws, sd0 + 104729)
            kind = 'vol'
        }
    }
    let m = avg(vals)
    let s = sdOf(vals)
    let pOf = (vs) => (1 + vs.filter((v) => v >= obs).length) / (1 + vs.length)
    return { kind, ratio, obs, mean: m, sd: s, z: s > 0 ? (obs - m) / s : 0, p: pOf(vals), dose: { mean: avg(v1), sd: sdOf(v1), p: pOf(v1), z: sdOf(v1) > 0 ? (obs - avg(v1)) / sdOf(v1) : 0, posRate: v1.filter((v) => v > 0).length / v1.length } }
}
//參照之做多比例: 成品於回測期全段之平均(靜態組成); 全段與各分段之參照皆用此值
let matchSides = argOf('match-sides', null) === null ? bt.grade.matchSides === true : Number(argOf('match-sides', 0)) === 1
let lrAll = matchSides ? longRatioOf(runs) : null
let ref = bt.nullDraws > 0 ? refNull(runs, ops, bt.nullDraws, seed, lrAll) : null
let nul = ref ? { draws: bt.nullDraws, mean: r2(ref.dose.mean), sd: r2(ref.dose.sd), p: r2(ref.dose.p), z: r2(ref.dose.z), posRate: r2(ref.dose.posRate) } : null
//分段: 回測期等分為 grade.splits 段(依決策棒), 各段之超額 = 本成品 − 該段參照之平均(各段各自之參照)
let segs = []
if (ref && bt.grade.enabled) {
    let endBar = barOf(st.periods.backtest.end)
    let k = Math.max(1, Math.round(bt.grade.splits))
    for (let i = 0; i < k; i++) {
        let b0 = btStartBar + Math.round((endBar - btStartBar) * i / k)
        let b1 = i === k - 1 ? Infinity : btStartBar + Math.round((endBar - btStartBar) * (i + 1) / k)
        let rs = runs.map((r) => {
            let a = r.bars.findIndex((b) => b >= b0)
            if (a < 0) {
                return { phase: r.phase, bars: [], sels: [], tags: [], k0: 0 }
            }
            let z = r.bars.findIndex((b) => b >= b1)
            if (z < 0) {
                z = r.bars.length
            }
            return { phase: r.phase, bars: r.bars.slice(a, z), sels: r.sels.slice(a, z), tags: r.tags.slice(a, z), k0: (r.k0 || 0) + a }
        })
        let os = rs.map((r) => ev.opOf(r.sels, r.bars, r.tags, accept, { k0: r.k0 }))
        let rf = refNull(rs, os, bt.nullDraws, seed + 7 * (i + 1), lrAll)
        segs.push({ from: ev.timeOf(b0), eq: rf.obs, refKind: rf.kind, refMean: rf.mean, excess: rf.obs - rf.mean, z: rf.z })
    }
}
//旗標: 分級(grade.enabled)= pass / above / mixed / level / below(定義見 src/domain/backtestGrade.mjs); 否則二元 pass / fail
let flag = bt.grade.enabled && ref
    ? gradeOf({ repsOk: reps.map((r) => r.ok), nOrders: reps[0].nOrders, p: ref.p, segZ: segs.map((h) => h.z), halves: segs.map((h) => h.excess), repsAbove: reps.map((r) => r.mean > ref.mean) }, bt.grade)
    : (reps.every((r) => r.ok) ? 'pass' : 'fail')
let out = {
    name,
    at: new Date().toISOString(),
    pick: path.resolve(fpPick),
    ledgerKey: L.meta.key,
    period: { start: st.periods.backtest.start, end: st.periods.backtest.end, firstDecision: runs[0] && runs[0].bars.length ? ev.timeOf(runs[0].bars[0]) : null },
    rule: bt.rule,
    flag,
    op: { eqYr: { mean: r2(mean), min: r2(min), max: r2(Math.max(...eq)), byPhase: eq.map(r2) }, monthlyOrders: r2(ops.reduce((s, o) => s + o.monthlyOrders, 0) / ops.length), peakHold: Math.max(...ops.map((o) => o.peakHold)), nOrders: ops.map((o) => o.nOrders), nDecisions: ops.map((o) => o.nDecisions), winRate: r2(ops.reduce((s, o) => s + o.winRate, 0) / ops.length) },
    null: nul,
    ref: ref ? { kind: ref.kind, ratio: r2(ref.ratio), longRatio: lrAll === null ? null : r2(lrAll), mean: r2(ref.mean), sd: r2(ref.sd), z: r2(ref.z), p: Math.round(ref.p * 10000) / 10000 } : null,
    segments: segs.map((h) => ({ from: h.from, eq: r2(h.eq), refKind: h.refKind, refMean: r2(h.refMean), excess: r2(h.excess), z: r2(h.z) })),
    grade: bt.grade,
    replicas: reps.map((r) => ({ seed: r.seed, ok: r.ok, mean: r2(r.mean), min: r2(r.min), byPhase: r.eq.map(r2), nOrders: r.nOrders, aboveRef: ref ? r.mean > ref.mean : null })),
}
fs.mkdirSync(bt.resultDir, { recursive: true })
writeJson(path.join(bt.resultDir, `${name}.json`), out)
if (show) {
    console.log(`回測期 ${out.period.start} ~ ${out.period.end}(首次決策 ${out.period.firstDecision};各相位決策 ${out.op.nDecisions.join('/')} 次)`)
    console.log(`等效年化 均 ${out.op.eqYr.mean}% 最差相位 ${out.op.eqYr.min}% 最佳 ${out.op.eqYr.max}% | 各相位 ${out.op.eqYr.byPhase.join(' / ')} | 月均單 ${out.op.monthlyOrders} | 最大同時持倉 ${out.op.peakHold} | 勝率 ${(out.op.winRate * 100).toFixed(1)}%`)
    if (nul) {
        console.log(`回測期同劑量虛無(${nul.draws} 抽): 均 ${nul.mean}% sd ${nul.sd} 正值比例 ${nul.posRate} | z ${nul.z} p ${nul.p}`)
    }
    if (out.ref) {
        console.log(`參照(${out.ref.kind};每隻訊號數之比 ${out.ref.ratio}${out.ref.longRatio === null ? '' : `;做多比例固定 ${out.ref.longRatio}`}): 均 ${out.ref.mean}% sd ${out.ref.sd} | z ${out.ref.z} p ${out.ref.p}`)
    }
    for (let h of out.segments) {
        console.log(`  分段 ${h.from} 起: 等效年化 ${h.eq}% | 參照均 ${h.refMean}%(${h.refKind}) | 超額 ${h.excess} z ${h.z}`)
    }
    console.log(`複製版(換亂數種子;全部達判準才 pass): ${out.replicas.map((r) => `種子 ${r.seed} 均 ${r.mean} 最差 ${r.min} ${r.ok ? '達' : '未達'}${r.aboveRef === null ? '' : (r.aboveRef ? ' 高於參照' : ' 未高於參照')}`).join(' | ')}`)
}
console.log(`BACKTEST_FLAG ${flag}`)
