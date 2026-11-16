import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { getSettings, argOf } from '../cfg.mjs'
import { loadLedger, memberLedger } from '../eval/ledger.mjs'
import { makeEvaluator, ntStaticOf } from '../eval/evalCore.mjs'
import { loadPick, loadExt } from '../eval/pickLoader.mjs'
import { P as PI, pushOwn, safeJson, assertIntrinsics, isIntegrityError } from '../eval/intrinsics.mjs'
import { scoreOf } from '../eval/score.mjs'
import { createResourceMonitor } from '../arsi/resources.mjs'


//評估一個挑選模組(節點 agent、做夢 agent 與人共用之唯一驗證入口)
//  **預設評估回測期**(settings.periods.backtest): 目標 = 回測期之等效年化更佳
//    挑選函數自帳本起點(暖機後之第一個決策)連續執行到回測期終點, 每個決策只看得到決策棒以前之資訊;
//    只有決策棒落在回測期者計入績效、新鮮度、虛無與選集統計(持倉簿自回測期起點為空)。ctx.meta.ntAll 只計訓練期之進場數(策略庫之靜態屬性)
//  node g_eval.mjs --pick <挑選模組.mjs> [--mode quick|full] [--period backtest|train] [--out <結果.json>] [--null N] [--phases 0,3] [--ref <參考模組.mjs>[,<參考模組2.mjs>…]]
//    quick: 相位 0 與 3、地平線 7 日、不算虛無(數秒; 迭代用)
//    full : 七相位、全部地平線、同劑量虛無 64 抽(交付用; 結果之 selHash 為選集序列之指紋)
//    --period train: 改看訓練期內之決策(診斷用; 訓練期是策略庫之求解期 = 樣本內, 不計入判讀)
//    --seed N: 換亂數種子(**只在迴圈之重放(ARSI_HARNESS=1)時生效**; 其他呼叫者帶此旗標即忽略 —— 節點不得藉換種子挑結果)
//    --tie-salt N: 換同分次序(ctx.meta.tie 與同一進場棒之訊號先後; 同樣只在迴圈之重放時生效; 節點要自檢同分之影響用共用工具區之 snippets/tieAlt.mjs)
//    --member <鹽>:<0|1>: 成員重抽(規則 R-EV-40)—— 只把策略庫之一半交給挑選函數(0 = 甲半、1 = 乙半; 鹽為 0 ~ 4294967295 之整數, 十進位或 0x 開頭之十六進位; 換鹽 = 換一種切法),
//           模組不必改寫: ctx.n 為半庫之隻數, ctx.meta 之各陣列與 ctx.stat 等皆為半庫內之序號, 各策略之 ctx.meta.tie 與其於全庫時相同; 期間、相位、虛無、擴充診斷照舊
//           用途: 檢驗成品之內容是否依賴特定成員(「換一批策略」之重複; 兩半皆成立才算不依賴); **此結果不是正本**(結果檔與評估紀錄另記 member), 節點、做夢與迴圈皆可用; 格式不合者不評估(離開碼 2)
//    --ref: 另以參考模組之 pick 於同相位、同亂數種子逐決策執行(各有自己的 ctx.state / ctx.rand, 與本模組互不影響),
//           輸出兩者選集之重疊率(交集 ÷ 本模組之選集大小)依決策段(各相位最前 10% / 中段 / 最後 10% 之決策)之分佈;
//           只增輸出(結果檔之 refOverlap), 既有數字與 selHash 不變; 可給多個(逗號分隔): refOverlap = 第一個, 另有 refOverlaps = 全部依序
//  離開碼: 0 完成 / 2 挑選模組不存在或未過靜態檢查 / 3 挑選函數執行錯誤(含內建物件被改: ERROR EVAL_INTEGRITY)
//  內建物件之完整性(規則 R-EV-35 ②): 挑選模組、擴充診斷模組、參考模組各於載入後比對; 讀帳本前與輸出前(最後一個 await 之後)再比對 ——
//    模組可排入延後執行之程式(微任務), 於其後之 await 期間才改內建物件; 評估本身為同步, 執行中不會插入
//    被改 ⇒ 評估失敗(離開碼 3; 有 --out 者寫 { ok: false, code: 'EVAL_INTEGRITY', where, items }), 結果檔與評估紀錄以擷取之 JSON.stringify 寫出
let st = getSettings()
let fpPick = argOf('pick', '')
if (!fpPick || fpPick === true) {
    console.log('用法: node g_eval.mjs --pick <挑選模組.mjs> [--mode quick|full] [--period backtest|train] [--out <結果.json>] [--null N] [--phases 0,3] [--ref <參考模組.mjs>]')
    process.exit(2)
}
let mode = argOf('mode', 'quick')
let periodArg = String(argOf('period', 'backtest'))
if (!['backtest', 'train'].includes(periodArg)) {
    console.log('--period 須為 backtest(預設;評估期)或 train(診斷用;樣本內)')
    process.exit(2)
}
//成員重抽(規則 R-EV-40): --member <鹽>:<0|1> ⇒ 以半庫帳本(memberLedger: 只含該半之策略、重新編號、保留各策略於全庫之同分次鍵)評估; 未給 ⇒ 全庫(行為不變)
//  格式不合者不評估(離開碼 2; 不靜默改用全庫: 那會把全庫之結果當成半庫之結果); 於載入模組與等資源閘之前即檢查(不先耗時), 不寫結果檔、不記評估紀錄
//  鹽之 0x 十六進位寫法只於此處解析(memberLedger 收整數, 依 iseint); memberTag 為標記('0x<鹽之十六進位>:<0|1>'; 未給為 null): 結果檔之 member.tag 與評估紀錄之每一列(含失敗者)帶之 —— 帶此標記者不是正本之評估
let memberArg = argOf('member', null)
let member = null
let memberTag = null
if (memberArg !== null) {
    //格式 <鹽>:<0|1>: 鹽之位數不另限(前導零無妨), 以數值 ≤ 4294967295 為界(過大者轉為 Infinity 或大數而拒收); 旗標重複給者拒收(argOf 只取第一個, 其餘靜默忽略會誤跑)
    let mm = /^(0x[0-9a-fA-F]+|[0-9]+):([01])$/.exec(String(memberArg))
    let saltV = mm ? (mm[1].startsWith('0x') ? parseInt(mm[1].slice(2), 16) : Number(mm[1])) : NaN
    if (!mm || !(saltV <= 0xFFFFFFFF) || process.argv.filter((a) => a === '--member').length > 1) {
        console.log('invalid --member: must be <salt>:<half>, where salt is an integer from 0 to 4294967295 (decimal or 0x hexadecimal) and half is 0 or 1')
        process.exit(2)
    }
    member = { salt: saltV, half: Number(mm[2]) }
    memberTag = `0x${saltV.toString(16)}:${member.half}`
}
//memberInfo, 失敗之結果檔所帶之 member(帳本尚未載入, 無 n / nFull): 成功之結果檔之 member 另含 n 與 nFull
let memberInfo = () => (member ? { member: { tag: memberTag, salt: member.salt, half: member.half } } : {})
let fpOut = argOf('out', '')
let t0 = Date.now()
//評估紀錄: 挑選模組位於節點 / 做夢之工作夾內時, 每次執行於其所在資料夾之 .evals.log 附加一列(時間、檔名、模式、結果), 供迴圈計數「交付前評估了幾次」
//  (不靠解析 agent 之指令字串: shell 迴圈與 && 串接會漏數); --no-log 不記, **只在迴圈之重跑(環境變數 ARSI_HARNESS=1)時生效**;
//  其他呼叫者帶 --no-log 照樣記錄並標記 noLogIgnored(節點不得以此繞過評估次數之記錄)
//  每列另記 h(模組內容之雜湊; 迴圈據以查「已評估之版本是否仍有檔可重現」)與 waitedSec(資源閘之等待秒數; 有等才記)
let pickHash = null
try {
    pickHash = crypto.createHash('sha1').update(fs.readFileSync(path.resolve(String(fpPick)))).digest('hex').slice(0, 12)
}
catch (err) {}
let waitedSec = 0
let logEval = (o) => {
    try {
        let noLog = argOf('no-log', false) === true
        if (noLog && process.env.ARSI_HARNESS === '1') {
            return
        }
        if (noLog) {
            o = { ...o, noLogIgnored: true }
        }
        let dir = path.dirname(path.resolve(String(fpPick)))
        let relToWork = path.relative(st.records.workDir, dir)
        if (relToWork.startsWith('..') || path.isAbsolute(relToWork)) {
            return
        }
        fs.appendFileSync(path.join(dir, '.evals.log'), safeJson({ at: new Date().toISOString(), pick: path.basename(String(fpPick)), mode, ...(periodArg !== 'backtest' ? { period: periodArg } : {}), h: pickHash, ...(memberTag ? { member: memberTag } : {}), ...(waitedSec > 0 ? { waitedSec } : {}), ...o }) + '\n')
    }
    catch (err) {}
}
//writeJson, 寫結果檔(格式同 cfg.mjs 之 writeJson: 縮排 2、UTF-8); 以載入時擷取之 JSON.stringify 序列化(規則 R-EV-35 ②)
let writeJson = (fp, obj) => {
    fs.mkdirSync(path.dirname(fp), { recursive: true })
    fs.writeFileSync(fp, PI.JSONStringify(obj, null, 2), 'utf8')
}
//failIntegrity, 內建物件被改(err 為 intrinsics 之完整性錯誤): 評估失敗, 離開碼 3(--ext-test 時印 EXT_FAIL、離開碼 4)
//  結果檔以擷取之 JSON.stringify 寫出(此時內建物件已被改; 見上方之 writeJson)
//  此時內建物件已被改: 輸出用擷取之 console.log, 結果檔與評估紀錄以 safeJson 序列化(不經原型上之 toJSON)
let failIntegrity = (err, extTestName = null) => {
    if (extTestName) {
        PI.ConsoleLog(`EXT_FAIL ${extTestName}: ${err.message}`)
        process.exit(4)
    }
    PI.ConsoleLog(`ERROR ${err.message}`)
    if (fpOut && fpOut !== true) {
        try {
            fs.mkdirSync(path.dirname(path.resolve(fpOut)), { recursive: true })
            fs.writeFileSync(path.resolve(fpOut), safeJson({ ok: false, ...memberInfo(), error: err.message, code: 'EVAL_INTEGRITY', where: err.where, items: err.items }, true), 'utf8')
        }
        catch (e) {}
    }
    logEval({ ok: false, code: 'EVAL_INTEGRITY' })
    process.exit(3)
}
//checkOrFail, 比對內建物件; 被改即 failIntegrity
let checkOrFail = (where, extTestName = null) => {
    try {
        assertIntrinsics(where)
    }
    catch (err) {
        failIntegrity(err, extTestName)
    }
}
let pk
try {
    pk = await loadPick(fpPick)
}
catch (err) {
    if (isIntegrityError(err)) {
        failIntegrity(err)
    }
    console.log(`ERROR ${err.code || ''} ${err.message}`)
    if (fpOut && fpOut !== true) {
        writeJson(path.resolve(fpOut), { ok: false, ...memberInfo(), error: err.message, code: err.code || null, issues: err.issues || [] })
    }
    logEval({ ok: false, code: err.code || 'PICK_LOAD' })
    process.exit(2)
}
//資源閘(評估層): 全機 CPU 或已用記憶體逼近上限(settings.resources)時, 先等一下再開始 —— 多個節點同時評估、或機器上另有他人之負載時, 讓評估錯開
//  門檻: CPU ≤ evalCpuStart(預設 cpuMax − 5)、已用記憶體 ≤ ramStartGB; 最長等 evalMaxWaitSec(預設 90)秒, 逾時照常開始; 不影響任何數字
//  迴圈之重跑(ARSI_HARNESS=1)已於迴圈內經資源閘, 此處不再等
if (st.resources && process.env.ARSI_HARNESS !== '1') {
    try {
        let rs = st.resources
        let num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
        if (num(rs.cpuMax) !== null || num(rs.ramUsedMaxGB) !== null) {
            let gate = createResourceMonitor({
                cpuMax: rs.cpuMax,
                ramUsedMaxGB: rs.ramUsedMaxGB,
                cpuStart: num(rs.evalCpuStart) !== null ? rs.evalCpuStart : (num(rs.cpuMax) !== null ? Math.max(1, rs.cpuMax - 5) : null),
                ramStartGB: rs.ramStartGB,
                pollSec: 5,
                jitter: 0.6,
                maxWaitSec: num(rs.evalMaxWaitSec) !== null ? rs.evalMaxWaitSec : 90,
            })
            let w = await gate.wait('eval')
            if (w.waitedSec >= 3) {
                waitedSec = w.waitedSec
                console.log(`資源閘: 全機負載偏高, 等待 ${w.waitedSec} 秒後開始評估${w.forced ? '(已達最長等待, 照常開始)' : ''};不影響結果`)
            }
        }
    }
    catch (err) {}
}
//保留期之檢定(主控專用; 規則 R-BT-4): 只在迴圈專用之環境(ARSI_HARNESS=1)下, 環境變數 ARSI_LEDGER_DIR 改用另一份帳本(私有根; 終點在回測期之後)、
//  ARSI_EVAL_FROM 改評估起點(保留期之起點); 節點與做夢之任務不使用(其操作紀錄含 ARSI_HARNESS 即被稽核列出), 其數字不對 agent 揭露
let harnessEnv = process.env.ARSI_HARNESS === '1'
let ledgerDir = harnessEnv && process.env.ARSI_LEDGER_DIR ? path.resolve(process.env.ARSI_LEDGER_DIR) : st.eval.ledgerDir
let evalFrom = harnessEnv && process.env.ARSI_EVAL_FROM ? process.env.ARSI_EVAL_FROM : st.periods.backtest.start
//讀帳本前比對內建物件(挑選模組已載入; 其延後執行之程式可能於上方之 await 期間才執行): 讀帳本與建評估器為同步, 其間不會再執行模組之程式
checkOrFail('before-ledger')
let Lfull = loadLedger(ledgerDir)
//成員重抽: 半庫帳本(memberLedger 之入口另比對內建物件; 與讀帳本同為同步, 其間不會再執行模組之程式); 之後之評估期間、訓練期之進場數、評估器皆以半庫帳本為準
let L = member ? memberLedger(Lfull, member.salt, member.half) : Lfull
if (member) {
    member = { ...member, n: L.n, nFull: Lfull.n }
}
//評估期間: 帳本涵蓋訓練期 + 回測期; 預設只計回測期內之決策, --period train 只計訓練期內之決策(診斷)
let barMs = L.meta.barHours * 3600000
let time0Ms = Date.parse(`${L.meta.time0}Z`)
let barOf = (iso) => Math.round((Date.parse(`${iso}Z`) - time0Ms) / barMs)
let trainEndBar = barOf(st.periods.train.end)
let btStartBar = barOf(evalFrom)
if (periodArg === 'backtest' && btStartBar >= L.nBars) {
    console.log(`ERROR 評估帳本(${st.eval.ledgerDir};終點 ${L.meta.endTime})未涵蓋回測期(${st.periods.backtest.start} 起);請先建帳本: node g_build.mjs`)
    process.exit(2)
}
//靜態欄 ctx.meta.ntAll: 只計訓練期之進場數(策略庫之屬性; 不含訓練期以後之資訊); makeEvaluator 要求明給訓練期之界線
//  帳本只涵蓋訓練期者(終點 ≤ 訓練期之終點)其值 = 帳本全期之進場數(進場棒皆小於帳本之 K 棒數)
L.ntStatic = ntStaticOf(L, trainEndBar)
let win = periodArg === 'train' ? { toBar: trainEndBar } : { fromBar: btStartBar }
//亂數種子: 預設 settings.eval.seed; --seed 只在迴圈之重放(ARSI_HARNESS=1)時生效
let seedArg = argOf('seed', null)
let seed = st.eval.seed === undefined ? 1 : st.eval.seed
if (seedArg !== null) {
    if (process.env.ARSI_HARNESS === '1' && typeof seedArg === 'number' && Number.isFinite(seedArg)) {
        seed = seedArg
    }
    else {
        console.log('--seed 只供迴圈之重放使用,已忽略(沿用設定之亂數種子)')
    }
}
//同分次序: 預設為正本; --tie-salt N(非 0 之整數)以另一組固定之同分次序重放(ctx.meta.tie 與同一進場棒之訊號先後), 同樣只在迴圈之重放(ARSI_HARNESS=1)時生效
let tieArg = argOf('tie-salt', null)
let tieSalt = 0
if (tieArg !== null) {
    if (process.env.ARSI_HARNESS === '1' && Number.isInteger(tieArg)) {
        tieSalt = tieArg
    }
    else {
        console.log('--tie-salt 只供迴圈之重放使用,已忽略(沿用正本之同分次序)')
    }
}
let ev = makeEvaluator(L, tieSalt !== 0 ? { ...st.eval, tieSalt } : st.eval)
let phasesArg = argOf('phases', null)
let opt = mode === 'full'
    ? { phases: st.eval.phases, horizons: st.eval.horizons, nullDraws: st.eval.nullDraws }
    : { phases: [0, 3], horizons: [st.eval.cadenceDays], nullDraws: 0 }
if (phasesArg !== null && phasesArg !== true) {
    opt.phases = String(phasesArg).split(',').map((x) => Number(x))
}
let nullArg = argOf('null', null)
if (typeof nullArg === 'number') {
    opt.nullDraws = nullArg
}
//擴充診斷(共用工具區之 metrics/*.mjs; 由做夢擴建; 規則 R-EV-21): 完整評估且有算虛無時逐一載入, 結果附於 metrics.ext.<檔名>
//  每個檔 `export default function (api) { … return { text, … } }`; 與挑選模組同一組字樣限制(不得匯入、不得碰檔案 / 行程 / 時鐘); api 見 src/eval/evalCore.mjs
//  --ext-test <檔>: 只載入該檔、以小規模(相位 0,3、8 抽)試跑一次, 印 EXT_OK / EXT_FAIL(迴圈之機械檢查與自檢入口用; 不記評估紀錄、不寫結果檔)
let extTest = argOf('ext-test', null)
let extList = []
let extLoadErrors = []
//  載入器 loadExt 在 src/eval/pickLoader.mjs(與挑選模組之 loadPick 同處、同一種匯入快取鍵)
if (typeof extTest === 'string' && extTest) {
    opt = { phases: [0, 3], horizons: [st.eval.cadenceDays], nullDraws: 8 }
    try {
        //await 恢復後先比對(其間模組之延後程式可能已改), 再以 pushOwn 收集
        let ex = await loadExt(extTest)
        assertIntrinsics('ext-load')
        pushOwn(extList, ex)
    }
    catch (err) {
        if (isIntegrityError(err)) {
            failIntegrity(err, path.basename(extTest))
        }
        console.log(`EXT_FAIL ${path.basename(extTest)}: ${String((err && err.message) || err).split('\n')[0]}`)
        process.exit(4)
    }
}
else if (mode === 'full' && opt.nullDraws > 0 && periodArg === 'backtest') {
    let fdExt = path.join(st.records.toolboxDir || path.join(st.rsi.root, 'toolbox'), 'metrics')
    let fs2 = []
    try {
        fs2 = fs.readdirSync(fdExt).filter((f) => /\.mjs$/i.test(f)).sort()
    }
    catch (err) {}
    //--ext-only a,b: 只載入指名之擴充診斷(迴圈之重放用: 只需其中一兩項, 省時間); 同樣只在迴圈之重放(ARSI_HARNESS=1)時生效
    let extOnly = argOf('ext-only', null)
    if (typeof extOnly === 'string' && extOnly && process.env.ARSI_HARNESS === '1') {
        let want = new Set(extOnly.split(',').map((x) => x.trim()).filter((x) => x.length > 0))
        fs2 = fs2.filter((f) => want.has(f.replace(/\.mjs$/i, '')))
    }
    for (let f of fs2) {
        try {
            let ex = await loadExt(path.join(fdExt, f))
            assertIntrinsics('ext-load')
            pushOwn(extList, ex)
        }
        catch (err) {
            //內建物件被改: 不是單一診斷之載入失敗, 整次評估失敗
            if (isIntegrityError(err)) {
                failIntegrity(err)
            }
            extLoadErrors.push({ name: f.replace(/\.mjs$/i, ''), error: String((err && err.message) || err).split('\n')[0].slice(0, 300) })
        }
    }
}
//--ref 可給多個參考模組(逗號分隔): 一次評估即得對各參考之重疊率(不必為每個參考各跑一次)
let refArg = argOf('ref', null)
let refList = typeof refArg === 'string' && refArg.length > 0 ? refArg.split(',').map((x) => x.trim()).filter((x) => x.length > 0) : []
let hasRef = refList.length > 0
let runsMain = null
let m
try {
    m = ev.evalPolicy(pk.pick, {
        ...opt,
        ...win,
        seed,
        accept: pk.accept,
        ...(extList.length ? { ext: extList } : {}),
        ...(hasRef
            ? {
                onRuns: (rs) => {
                    runsMain = rs
                }
            }
            : {})
    })
    if (extLoadErrors.length) {
        m.ext = { ...(m.ext || {}), ...Object.fromEntries(extLoadErrors.map((x) => [x.name, { error: `載入失敗: ${x.error}` }])) }
    }
    if (typeof extTest === 'string' && extTest) {
        let nm = extList[0].name
        let r = (m.ext && m.ext[nm]) || { error: '無輸出' }
        console.log(r.error ? `EXT_FAIL ${nm}: ${r.error}` : `EXT_OK ${nm}(${r.ms} ms): ${typeof r.text === 'string' ? r.text.slice(0, 300) : JSON.stringify(r).slice(0, 300)}`)
        process.exit(r.error ? 4 : 0)
    }
}
catch (err) {
    if (isIntegrityError(err)) {
        failIntegrity(err, typeof extTest === 'string' && extTest && String(err.where).startsWith('ext') ? extList[0].name : null)
    }
    //寫錯誤結果前再比對一次(驗證拋錯之訊息組字可能執行模組之 toString)
    checkOrFail('pick')
    console.log(`ERROR PICK_RUN ${String((err && err.stack) || err).split('\n').slice(0, 6).join('\n')}`)
    if (fpOut && fpOut !== true) {
        writeJson(path.resolve(fpOut), { ok: false, ...memberInfo(), error: String((err && err.message) || err), code: 'PICK_RUN' })
    }
    logEval({ ok: false, code: 'PICK_RUN' })
    process.exit(3)
}
let sc = scoreOf(m, { limits: st.eval.limits, score: st.score })
//與參考模組之選集重疊率(--ref): 診斷用; 參考模組執行失敗只記錯誤, 不影響本模組之評估結果
//  結果檔: refOverlap = 第一個參考(物件; 單一參考時與舊版逐欄相同); 給多個參考時另有 refOverlaps = 全部參考依序之陣列(各自之 ctx.state / ctx.rand)
let overlapOf = async (refPath) => {
    let r4 = (x) => Math.round(x * 10000) / 10000
    try {
        let rk = await loadPick(refPath)
        //await 恢復後先比對, 才走訪本模組之選集(runsMain)
        assertIntrinsics('ref-load')
        //兩個已排序之序號陣列之交集大小
        let inter = (A, B) => {
            let i = 0
            let j = 0
            let c = 0
            while (i < A.length && j < B.length) {
                if (A[i] === B[j]) {
                    c++
                    i++
                    j++
                }
                else if (A[i] < B[j]) {
                    i++
                }
                else {
                    j++
                }
            }
            return c
        }
        let seg = { head: [], mid: [], tail: [] }
        let ofRef = []
        let refSizes = []
        for (let r of runsMain) {
            //參考模組同樣自帳本起點連續執行; 本模組之切片(評估期間內之決策)自其第 k0 個決策起, 逐決策對齊
            let b = ev.runPick(rk.pick, r.phase, seed)
            let k0 = r.k0 || 0
            let nD = r.sels.length
            let nEdge = Math.max(1, Math.round(nD * 0.1))
            for (let k = 0; k < nD; k++) {
                let A = r.sels[k]
                let B = b.sels[k + k0]
                refSizes.push(B.length)
                if (A.length === 0) {
                    continue
                }
                let c = inter(A, B)
                let to = k < nEdge ? seg.head : (k >= nD - nEdge ? seg.tail : seg.mid)
                to.push(c / A.length)
                if (B.length > 0) {
                    ofRef.push(c / B.length)
                }
            }
        }
        let dist = (a) => {
            if (a.length === 0) {
                return { n: 0, mean: null, p10: null, p50: null, p90: null }
            }
            let s = a.slice().sort((x, y) => x - y)
            let q = (p) => r4(s[Math.min(s.length - 1, Math.floor(p * s.length))])
            return { n: a.length, mean: r4(a.reduce((t, v) => t + v, 0) / a.length), p10: q(0.1), p50: q(0.5), p90: q(0.9) }
        }
        let all = [...seg.head, ...seg.mid, ...seg.tail]
        return { ref: path.resolve(refPath), refBytes: rk.bytes, refDesc: rk.meta && rk.meta.desc ? String(rk.meta.desc).slice(0, 160) : null, refSizeMean: r4(refSizes.reduce((t, v) => t + v, 0) / Math.max(1, refSizes.length)), all: dist(all), head: dist(seg.head), mid: dist(seg.mid), tail: dist(seg.tail), ofRefMean: ofRef.length ? r4(ofRef.reduce((t, v) => t + v, 0) / ofRef.length) : null }
    }
    catch (err) {
        //內建物件被改(參考模組違約): 不只是參考模組無法執行 —— 其後之輸出段已不可信, 整次評估失敗
        if (isIntegrityError(err)) {
            failIntegrity(err)
        }
        return { ref: path.resolve(refPath), error: String((err && err.message) || err).split('\n')[0].slice(0, 300) }
    }
}
let refOverlaps = []
if (hasRef && runsMain) {
    for (let rp of refList) {
        let ro = await overlapOf(rp)
        checkOrFail('ref')
        pushOwn(refOverlaps, ro)
    }
}
//輸出前(最後一個 await 之後)比對內建物件: 其後之輸出段為同步, 不會再執行模組之程式
checkOrFail('output')
let refOverlap = refOverlaps.length ? refOverlaps[0] : null
let periodInfo = periodArg === 'train'
    ? { name: 'train', label: '訓練期(診斷;樣本內,不計入判讀)', start: st.periods.train.start, end: st.periods.train.end }
    : { name: 'backtest', label: '回測期', start: st.periods.backtest.start, end: st.periods.backtest.end }
let out = { ok: true, mode, period: periodInfo, seed, ...(tieSalt !== 0 ? { tieSalt } : {}), ...(member ? { member: { tag: memberTag, ...member } } : {}), pick: path.resolve(fpPick), pickBytes: pk.bytes, pickMeta: pk.meta, at: new Date().toISOString(), metrics: m, score: sc, limits: st.eval.limits, loadMs: Date.now() - t0 - m.ms.total, ...(refOverlap ? { refOverlap } : {}), ...(refOverlaps.length > 1 ? { refOverlaps } : {}) }
let f1 = (x) => (typeof x === 'number' ? x.toFixed(1) : String(x))
if (member) {
    console.log(`成員重抽 ${memberTag}: 只用策略庫之${member.half === 0 ? '甲' : '乙'}半(${member.n} 隻 / 全庫 ${member.nFull} 隻;各策略之同分次鍵同全庫)—— 此結果不是正本`)
}
console.log(`[${mode}|${periodInfo.label} ${periodInfo.start.slice(0, 10)} ~ ${periodInfo.end.slice(0, 10)}] 相位 ${m.phases.join(',')} | 決策 ${m.op.nDecisions.join('/')} 次 | 選集大小 均 ${f1(m.sel.sizeMean)}(${m.sel.sizeMin} ~ ${m.sel.sizeMax}), 空 ${m.sel.nEmpty}, 換手 Jaccard ${m.sel.turnoverJaccard}`)
console.log(`操作績效(${m.period.cadenceDays} 日一換): 等效年化 均 ${f1(m.op.eqYr.mean)}% 最差相位 ${f1(m.op.eqYr.min)}% 最佳 ${f1(m.op.eqYr.max)}% | 月均單 ${f1(m.op.monthlyOrders.mean)} | 最大同時持倉 ${m.op.peakHold.max} | 勝率 ${(m.op.winRate * 100).toFixed(1)}% | 執行規則 ${m.hasAccept ? `有(下單率 ${(m.op.acceptRate * 100).toFixed(1)}%)` : '無(全收)'}`)
console.log(`新鮮度(七相位均 %): ${m.horizons.map((H) => `${H}d ${f1(m.fresh[H].eqYr.mean)}`).join(' | ')}`)
if (m.null) {
    console.log(`同劑量虛無(${m.null.draws} 抽): 均 ${f1(m.null.mean)}% sd ${f1(m.null.sd)} p95 ${f1(m.null.p95)} | 超額 ${f1(m.null.excess)} z ${m.null.z} p ${m.null.p}`)
}
if (m.nullVol) {
    console.log(`同訊號量虛無(選集之每隻訊號數為全體隨機之 ${m.nullVol.ratio} 倍 ⇒ 改以隨機 ${f1(m.nullVol.sizeMean)} 隻、訊號量相當者比較): 均 ${f1(m.nullVol.mean)}% sd ${f1(m.nullVol.sd)} | 超額 ${f1(m.nullVol.excess)} z ${m.nullVol.z} p ${m.nullVol.p}`)
}
if (m.nullAct) {
    console.log(`同活躍度虛無(隨機選集之活躍度分層與成品相同: 各決策依決策日以前之累計進場數分 ${m.nullAct.bins} 層、各層抽同樣隻數): 均 ${f1(m.nullAct.mean)}% sd ${f1(m.nullAct.sd)} | 超額 ${f1(m.nullAct.excess)} z ${m.nullAct.z} p ${m.nullAct.p}(選集比隨機安靜或活躍時, 同訊號量之超額含活躍度層本身之樣本內差異; 扣掉後剩多少看此列)`)
}
//組成對照與幾何對照: 各三等分段之均(thirdsMean)與成品之三等分並列, 一眼可見成品之超額是否只集中於某一段
let th3 = (x) => (Array.isArray(x.thirdsMean) && m.op.thirds && m.op.thirds.length === 3 ? ` | 三等分之均 ${x.thirdsMean.map((v) => f1(v)).join(' / ')}(成品 ${m.op.thirds.map((g) => f1(g.eqYr.mean)).join(' / ')})` : '')
if (m.nullSideAct) {
    console.log(`同側同活躍度虛無(組成對照: 把選集之每一隻換成同方向、決策日以前累計進場數之名次 ±${m.nullSideAct.half} 名內之隨機一隻): 均 ${f1(m.nullSideAct.mean)}% sd ${f1(m.nullSideAct.sd)} | 超額 ${f1(m.nullSideAct.excess)} z ${m.nullSideAct.z} p ${m.nullSideAct.p}${m.nullSideAct.share === null ? '' : ` | 組成可重現之比例 ${(m.nullSideAct.share * 100).toFixed(0)}%`}${th3(m.nullSideAct)}(${m.nullSideAct.triggered === false ? '選集之每隻訊號數與做多比例皆與全體隨機相近, 此列不入階梯; ' : ''}「方向 × 活躍度」之組成本身就有績效; 同組成內是否挑得比隨機好看此列)`)
}
if (m.nullSideGeo) {
    console.log(`同側同幾何同活躍度虛無(幾何對照: 再匹配該側內止盈 ${m.nullSideGeo.nTp} 等分 × 止損 ${m.nullSideGeo.nSl} 等分; 只供判讀、不入階梯): 均 ${f1(m.nullSideGeo.mean)}% sd ${f1(m.nullSideGeo.sd)} | 超額 ${f1(m.nullSideGeo.excess)} z ${m.nullSideGeo.z} p ${m.nullSideGeo.p}${m.nullSideGeo.share === null ? '' : ` | 可重現之比例 ${(m.nullSideGeo.share * 100).toFixed(0)}%`}${th3(m.nullSideGeo)}`)
}
console.log(`選集組成: 每隻每個決策視窗之訊號數 ${m.sel.sigPerPick}${m.null ? `(虛無 ${m.null.sigPerPick})` : ''} | 做多比例 ${m.sel.longRatio}${m.null ? `(虛無 ${m.null.longRatio})` : ''} | 平均因子數 ${m.sel.nKeysMean} | 平均止盈 / 止損 ${m.sel.tpMean} / ${m.sel.slMean}`)
if (m.op.bySide) {
    let sd = (x) => `${f1(x.orders)} 單、損益 ${x.pnl}、勝率 ${(x.winRate * 100).toFixed(1)}%`
    console.log(`損益歸因(各相位平均;損益 = 每單 1 單位之損益和, 合計 ${m.op.pnl}): 做多 ${sd(m.op.bySide.long)} | 做空 ${sd(m.op.bySide.short)}${Array.isArray(m.op.byGroup) && m.op.byGroup.length > 1 ? ` | 依子帳: ${m.op.byGroup.map((g) => `子帳 ${g.group}(每次決策 ${f1(g.seats)} 席)${sd(g)}`).join('、')}` : ''}${m.sel.tagPerf ? ` | 依 tag(共 ${m.sel.tagPerf.length} 種${m.sel.tagPerf.length > 8 ? ';列前 8 種, 全部見 metrics.sel.tagPerf' : ''}): ${m.sel.tagPerf.slice(0, 8).map((t) => `${t.tag} ${t.decisions} 次決策 ${f1(t.orders)} 單 損益 ${t.pnl}`).join('、')}` : ''}`)
}
for (let [nm, r] of Object.entries(m.ext || {})) {
    console.log(`擴充診斷 ${nm}(共用工具區 metrics/${nm}.mjs): ${r.error ? `未算(${r.error})` : (typeof r.text === 'string' ? r.text : JSON.stringify(r).slice(0, 400))}`)
}
if (m.op.thirds && m.op.thirds.length) {
    console.log(`評估期間三等分(各段自空倉起算;看績效是否集中於某一段): ${m.op.thirds.map((g) => `${g.from.slice(0, 10)} ~ ${g.to.slice(0, 10)} 均 ${f1(g.eqYr.mean)}%(最差相位 ${f1(g.eqYr.min)}${g.nullMean === undefined ? '' : `;隨機挑 ${f1(g.nullMean)}`})`).join(' | ')}`)
}
if (m.sel.orders) {
    console.log(`下單集中度(各相位平均): 實際下單之不同策略 ${f1(m.sel.orders.strats)} 隻、不同因子組合 ${f1(m.sel.orders.combos)} 種 | 下單最多之前 1% 進場棒占全部下單 ${(m.sel.orders.barTop1Share * 100).toFixed(1)}% | 單一進場棒最多 ${m.sel.orders.perBarMax} 單`)
}
if (m.sel.sizeDist) {
    console.log(`選集大小之分佈(各決策): p10 ${m.sel.sizeDist.p10} / 中位 ${m.sel.sizeDist.p50} / p90 ${m.sel.sizeDist.p90} | 空選集之決策比例 ${m.sel.emptyRate}${m.sel.tags && m.sel.tags.length ? ` | tag 之決策比例(共 ${m.sel.tagKinds} 種${m.sel.tags.length > 8 ? ';此處列前 8 種, 全部見結果檔之 metrics.sel.tags' : ''}): ${m.sel.tags.slice(0, 8).map((t) => `${t.tag} ${t.share}`).join('、')}${m.sel.tagStats ? ` | 數值 tag 之統計(${m.sel.tagStats.n} 次決策): 均 ${m.sel.tagStats.mean} / p10 ${m.sel.tagStats.p10} / 中位 ${m.sel.tagStats.p50} / p90 ${m.sel.tagStats.p90}` : ''}` : ''}`)
}
for (let ro of refOverlaps) {
    if (ro.error) {
        console.log(`與參考模組之重疊率: 參考模組 ${path.basename(ro.ref)} 無法執行(${ro.error});本模組之評估結果不受影響`)
    }
    else {
        let d = (x) => (x.n ? `均 ${x.mean}(p10 ${x.p10} / 中位 ${x.p50} / p90 ${x.p90};${x.n} 次決策)` : '—')
        console.log(`與參考模組 ${path.basename(ro.ref)} 之選集重疊率(交集 ÷ 本模組之選集大小;參考選集平均 ${ro.refSizeMean} 隻;交集 ÷ 參考選集 均 ${ro.ofRefMean}): 全部 ${d(ro.all)} | 各相位最前 10% 之決策 ${d(ro.head)} | 中段 ${d(ro.mid)} | 最後 10% ${d(ro.tail)}`)
    }
}
console.log(`判讀${periodArg === 'train' ? '(訓練期之診斷;不是成績)' : '(回測期)'}: S ${sc.S} 階梯 ${sc.ladder}${sc.flags.vetoed ? ' 否決' : ''} | 各相位之等效年化 ${m.op.eqYr.byPhase.map((v) => f1(v)).join(' / ')}${sc.flags.why.length ? ` | ${sc.flags.why.join('; ')}` : ''}`)
logEval({ ok: true, S: sc.S, selHash: m.selHash, ...(hasRef ? { ref: refList.map((x) => path.basename(x)).join(',') } : {}) })
console.log(`selHash ${m.selHash} | 耗時 挑選 ${m.ms.pick}ms 指標 ${m.ms.metrics}ms 虛無 ${m.ms.null}ms(載入 ${out.loadMs}ms)`)
if (fpOut && fpOut !== true) {
    writeJson(path.resolve(fpOut), out)
    console.log(`→ ${path.resolve(fpOut)}`)
}
if (!fs.existsSync(path.resolve(fpPick))) {
    process.exit(2)
}
