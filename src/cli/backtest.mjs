import fs from 'fs'
import path from 'path'
import { getSettings, argOf } from '../cfg.mjs'
import { loadLedger } from '../eval/ledger.mjs'
import { makeEvaluator, ntStaticOf, mulberry32 } from '../eval/evalCore.mjs'
import { loadPick } from '../eval/pickLoader.mjs'
import { P as PI, assertIntrinsics, isIntegrityError } from '../eval/intrinsics.mjs'
import { backtestCfg } from '../domain/backtestCfg.mjs'
import { gradeOf } from '../domain/backtestGrade.mjs'
import { trainFromBarOf, gridCheck, checkEvalSettings, periodAt, configMsgOf } from '../eval/barGrid.mjs'


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
//  離開碼: 0 完成 / 2 挑選模組問題或設定不合(期間之界線、eval.trainFromStart、eval.fitEnd; 規則 R-EV-44)/ 3 挑選函數執行錯誤 / 4 未授權 / 5 帳本不一致(全期帳本與評估帳本之訓練期進場數不同, 或評估帳本無法載入 / 不合核對之前提)
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
//內建物件之完整性(規則 R-EV-35 ②; 同 src/cli/eval.mjs): 載入挑選模組後、讀帳本前、輸出前比對; 被改 ⇒ ERROR EVAL_INTEGRITY、離開碼 3
let checkOrExit = (where) => {
    try {
        assertIntrinsics(where)
    }
    catch (err) {
        PI.ConsoleLog(`ERROR ${err.message}`)
        process.exit(3)
    }
}
let pk
try {
    pk = await loadPick(fpPick)
}
catch (err) {
    console.log(`ERROR ${err.code || ''} ${err.message}`)
    process.exit(isIntegrityError(err) ? 3 : 2)
}
checkOrExit('before-ledger')
let L = loadLedger(bt.ledgerDir)
let barMs = L.meta.barHours * 3600000
let time0Ms = Date.parse(`${L.meta.time0}Z`)
let barOf = (iso) => Math.round((Date.parse(`${iso}Z`) - time0Ms) / barMs)
//設定之預檢(規則 R-EV-44; 與 g_eval.mjs、迴圈組裝專案時同一組 checkEvalSettings): 期間之界線(缺 periods.train / periods.backtest 亦為 invalid periods.…, 不是 TypeError)、eval.fitEnd、eval.trainFromStart、
//  影響評估之數字(暖機日數、決策間隔、虛無抽數、活躍度分層數、名次寬度)不合 ⇒ 印 ERROR invalid …、離開碼 2(未寫任何檔)
try {
    checkEvalSettings(st, L.meta)
}
catch (err) {
    let msg = configMsgOf(err)
    if (msg === null) {
        throw err
    }
    console.log(`ERROR ${msg}`)
    process.exit(2)
}
let trainEndBar = barOf(periodAt(st, 'train', 'end'))
let btStartBar = barOf(periodAt(st, 'backtest', 'start'))
//訓練期之進場數(靜態欄; 不含回測期)並與評估帳本核對(排程第 496 項)
//  評估帳本(settings.eval.ledgerDir; g_build 之標準產物)涵蓋訓練期與回測期(終點為回測期終點), 其 off.u32 為全期計數 —— 不是訓練期之進場數, 不可拿來核對;
//  改以評估帳本自身於同一個訓練期終點之進場數(ntStaticOf; 棒序依其自身之 time0 與每棒小時數換算)與全期帳本逐策略比對: 兩者由同一策略庫建出時,
//  訓練期以前之進場相同(進場只依該棒以前之資訊; 終點不同只影響其後之訂單)⇒ 數量逐策略相等; 策略數或任一策略之計數不同即拒絕(請以同一策略庫重建兩者)
//  (g_build --train 之訓練期帳本為核對或診斷用之選配產物, 標準流程不保證存在, 故不以它為依據)
//  核對之前提(任一不成立即拒絕, 離開碼 5): 兩帳本皆載得入、time0 / barHours 有效且訓練期終點落在其棒序內、off 欄之長度 = 策略數 + 1(損毀者之 off 欄使計數為缺值)、
//    兩帳本皆涵蓋訓練期終點(nBars 為整數且 ≥ 界線: 短於界線之帳本其計數相同亦不代表期間完整; nBars 缺值者亦拒收)、全期帳本涵蓋回測期起點(nBars > 回測期起點之棒序; 否則重放無決策而旗標無意義)、策略數相同;
//    兩帳本由同一策略庫建出且起點(time0)相同或其前無進場(ntStaticOf 自帳本起點計數)
let ntStatic = null
{
    let Le = null
    try {
        Le = loadLedger(st.eval.ledgerDir)
    }
    catch (err) {
        if (isIntegrityError(err)) {
            PI.ConsoleLog(`ERROR ${err.message}`)
            process.exit(3)
        }
        console.log('ERROR 評估帳本無法載入(缺檔或損毀; 核對全期帳本與評估帳本之訓練期進場數需要它); 請先 node g_build.mjs 建評估帳本')
        process.exit(5)
    }
    let barMsE = Le.meta.barHours * 3600000
    let trainEndE = Math.round((Date.parse(`${periodAt(st, 'train', 'end')}Z`) - Date.parse(`${Le.meta.time0}Z`)) / barMsE)
    let reason = null
    if (!(barMs > 0 && Number.isFinite(barMs) && barMsE > 0 && Number.isFinite(barMsE) && Number.isFinite(time0Ms) && Number.isFinite(Date.parse(`${Le.meta.time0}Z`)))) {
        reason = 'time0 或 barHours 無效'
    }
    else if (!(Number.isInteger(trainEndBar) && trainEndBar >= 0 && Number.isInteger(trainEndE) && trainEndE >= 0)) {
        reason = '訓練期終點不在帳本之棒序範圍內'
    }
    else if (Le.off.length !== Le.n + 1 || L.off.length !== L.n + 1) {
        reason = 'off 欄之長度與策略數不符'
    }
    else if (!(Number.isInteger(Le.nBars) && Le.nBars >= trainEndE && Number.isInteger(L.nBars) && L.nBars >= trainEndBar)) {
        reason = '帳本未涵蓋訓練期終點' //nBars 缺值或非整數者(無 px.f64 之舊格式帳本不驗 meta.nBars)亦拒收
    }
    else if (!(L.nBars > btStartBar)) {
        reason = '全期帳本未涵蓋回測期起點' //重放只取決策棒落在回測期者; 全期帳本止於回測期起點或更早者無決策, 其旗標無意義
    }
    if (reason !== null) {
        console.log(`ERROR 全期帳本與評估帳本不合核對之前提(${reason}); 請以同一策略庫重建兩者`)
        process.exit(5)
    }
    //eval.trainFromStart(選配; 規則 R-EV-44): 兩帳本各以自身之 time0 與每棒小時數換算訓練期起點之棒序, 作為計數之下界; 未給 ⇒ 自帳本起點(行為不變); 設定不合 ⇒ 離開碼 2
    //  期間之界線(換算為棒序者: 訓練期終點於兩帳本、回測期起點、分級分段所用之回測期終點)須落在帳本之棒格線上(規則 R-EV-44; 同 g_eval.mjs)⇒ 不合者離開碼 2
    //  下界為第 0 根(帳本起點 = 訓練期起點)者與未給者相同(ntStaticOf 之 fromBar 為 0 時與未給同一路徑)
    let fromL = null
    let fromE = null
    try {
        //全期帳本(L)之訓練期終點、回測期起點已由上方之預檢核對; 此處核對評估帳本(Le)之訓練期終點與分級分段所用之回測期終點
        gridCheck(periodAt(st, 'train', 'end'), Le.meta, 'periods.train.end')
        if (bt.grade.enabled && bt.nullDraws > 0) {
            gridCheck(periodAt(st, 'backtest', 'end'), L.meta, 'periods.backtest.end')
        }
        fromL = trainFromBarOf(st, L.meta, trainEndBar)
        fromE = trainFromBarOf(st, Le.meta, trainEndE)
    }
    catch (err) {
        console.log(`ERROR ${err.message}`)
        process.exit(2)
    }
    ntStatic = fromL === null ? ntStaticOf(L, trainEndBar) : ntStaticOf(L, trainEndBar, fromL)
    let ntEval = fromE === null ? ntStaticOf(Le, trainEndE) : ntStaticOf(Le, trainEndE, fromE)
    let bad = Le.n !== L.n ? -2 : -1
    for (let s = 0; s < L.n && bad === -1; s++) {
        if (ntEval[s] !== ntStatic[s]) {
            bad = s
        }
    }
    if (bad !== -1) {
        console.log(`ERROR 全期帳本與評估帳本之訓練期進場數不一致(${bad === -2 ? '策略數不同' : `策略序號 ${bad} 之訓練期進場數不同`}); 請以同一策略庫重建兩者`)
        process.exit(5)
    }
}
L.ntStatic = ntStatic
//eval.fitEnd 不在帳本之棒格線上等設定不合(規則 R-EV-44)⇒ 離開碼 2(未寫任何檔)
let ev
try {
    ev = makeEvaluator(L, st.eval)
}
catch (err) {
    let msg = configMsgOf(err)
    if (msg !== null) {
        console.log(`ERROR ${msg}`)
        process.exit(2)
    }
    throw err
}
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
    checkOrExit('pick')
    console.log(`ERROR ${isIntegrityError(err) ? '' : 'PICK_RUN '}${String((err && err.stack) || err).split('\n').slice(0, 6).join('\n')}`)
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
    //基礎單位(規則 R-EV-43; 回測期旗標之重放現行關閉): 全期帳本帶者才記(無此鍵 = 每單 1 單位; 未開啟者輸出不變); 帳本與設定之比對、研究用本金之檢查未接(啟用此機制前須補)
    ...(L.unit === undefined || L.unit === null ? {} : { unit: { rule: { stepSize: L.unit.rule.stepSize, minQty: L.unit.rule.minQty, minNotional: L.unit.rule.minNotional }, buffer: L.unit.buffer, uIni: L.unit.uIni } }),
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
checkOrExit('output')
fs.mkdirSync(bt.resultDir, { recursive: true })
//結果檔: 格式同 cfg.mjs 之 writeJson(縮排 2、UTF-8), 以擷取之 JSON.stringify 序列化
fs.writeFileSync(path.join(bt.resultDir, `${name}.json`), PI.JSONStringify(out, null, 2), 'utf8')
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
