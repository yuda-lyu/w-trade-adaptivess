import fs from 'fs'
import path from 'path'
import { loadPick } from '../eval/pickLoader.mjs'
import { isIntegrityError, integrityError, assertIntrinsics, pushOwn } from '../eval/intrinsics.mjs'
import { postfitInfoOf, FILL_DIR } from './fillPlan.mjs'
import { pickHashOf, evaluatorFpOf, readFill } from './fillKeys.mjs'
import { recentDiagOf } from './diagRead.mjs'

//共同儲存「自適應挑選策略」區(規則 R-REC-25): <狀態根>/picks/
//  目的: 各節點(探索與驗證皆含)交付之挑選模組統一歸檔 —— 程式碼之逐位複本 + 由迴圈以同一評估器重跑所得之回測期績效與必要之欄位,
//        供節點與做夢 agent 直接查閱全部已找到之自適應挑選策略, 不必逐一翻各節點之文件與工作夾; 保留期之檢定由主控另算, 此處只列正負號
//  佈局:
//    README.md            說明與欄位定義(由本模組產生)
//    INDEX.md             總表(每個策略一列; 依回測期 S 由高至低)
//    index.json           全部欄位(機器可讀; { schema, updatedAt, fields, items })
//    <節點 id>/pick.mjs    交付版之逐位複本
//    <節點 id>/info.json   該策略之全部欄位
//    _holdout.json        保留期之正負號(只有正負號; 由主控之檢定工具寫入; 本模組只讀、不產生、不刪; 只收 "+" / "-" / "0" 之字串, 其他值一律忽略〔視為未算〕)
//    _cross.json          其他標的之正負號(選配; 同一挑選模組原樣不改、於另一標的之策略庫上評估; 回測期與保留期各給績效與挑選內容之號;
//                         由使用端之上層以其工具寫入; 本模組只讀、不產生、不刪; 只收 "+" / "-" / "0" 之字串, 其他值一律忽略〔視為未算〕; 規則 R-REC-30)
//                         無此檔(或檔之形狀不合)者, 共同儲存區之各檔與未支援此檔之版本逐位相同(欄、說明、info.json 之 cross 鍵皆不出現)
//  擴充: 欄位於 infoOf 內分組(identity / status / design / backtest / ext / postfit / holdout / [cross] / files; ext = 各擴充診斷自帶之看板值, 見 extRowOf; 規則 R-REC-31;
//        postfit = 求解窗後段之佐證〔狀態根之補算檔 fill/<節點 id>.json(agent 不可寫之處; 檔內之 nodeId 須相符); 成品之雜湊相符者; 不入總表〕, 見 fillPlan.mjs 之 postfitInfoOf; 規則 R-REC-34);
//        新增欄位 = 在該組加一鍵並於 FIELD_DEFS 補一列說明;
//        INDEX.md 之欄由 COLUMNS 決定。讀取端應以鍵取值、容許未知之鍵與 null(舊節點文件可能無某欄)
//  本區由迴圈產生(輪末與主控審定後), agent 唯讀; 來源 = 節點文件(迴圈重跑之數字, 不是 agent 自報)與各節點工作夾之 pick.mjs

let SCHEMA = 1

//中止本次更新之說明(完整性錯誤之訊息前綴)
const ABORT_NOTE = '共同儲存區之更新已中止(未寫入任何檔)'

//欄位定義(寫入 README.md 與 index.json.fields)
/**
 * 欄位定義表,每列為 [欄位名, 說明],寫入 README.md 與 index.json 之 fields
 *
 * @type {Array<Array<String>>}
 */
let FIELD_DEFS = [
    ['id / short', '節點 id(16 字)與其前 8 字'],
    ['round', '執行之輪次'],
    ['type', '任務類型: explore(探索)/ verify(驗證)'],
    ['arms / base', '指派之臂與起點節點(無 = 從零)'],
    ['claimKey / claim', '驗證類之主張鍵與主張(開頭 200 字); 探索類之 claim 為 null, claimKey 僅在該方向與既有節點同臂同起點時為區分用之鍵、否則 null'],
    ['family', '做夢最近一次整體研判所歸之機制家族(未歸類為 null)'],
    ['status.trust / action', '做夢審計之可信度(trusted / partial / untrusted)與處置; 尚未審計為 null'],
    ['status.vetoed / ladder', '是否被否決、回測期階梯'],
    ['status.inactiveArms', '指派而交付版未作用之臂(審計所定; 無審計者取節點自報)'],
    ['status.claimVerdict', '節點依方向所寫之判定方式自判之主張判定(confirmed / refuted); 無則 null'],
    ['status.issues', '迴圈檢查所列之問題(各取前 120 字)'],
    ['design.desc / params', '成品 meta 之說明與參數(成品自述)'],
    ['design.summary', '節點結論之摘要(開頭 400 字; agent 所寫)'],
    ['backtest.S', '回測期之分數 S(迴圈以現行評估器重跑)'],
    ['backtest.eqYrMean / eqYrMin / eqYrByPhase / nPosPhases', '七相位等效年化(%)之平均、最差、各相位、為正之相位數'],
    ['backtest.content', '挑選內容 = 對組成對照之超額: builtin(內建; 同側同活躍度)、recent(近 90 日活躍度版)、mean(兩者之均)、p / pRecent(單側 p)'],
    ['backtest.replays', '換亂數種子與同分次序之重放: 各次之 S、內建與近 90 日組成對照之超額'],
    ['backtest.monthlyOrders / peakHold / winRate', '月均單、最大同時持倉、勝率'],
    ['backtest.sigPerPick / longRatio', '每隻入選策略之訊號數、選集之做多比例'],
    ['backtest.selHash / pickSec / ledgerKey', '選集與下單序列之指紋、挑選耗時(秒)、評估帳本之鍵'],
    ['ext.<診斷名>.board / flag / notContent / subset', '共用工具區之擴充診斷(metrics/)各自帶之看板值、迴圈檢查之提示、「組成對照不是挑選內容」之自述、子集名(原值,不改寫、不截斷;判定有無之規則同看板與迴圈檢查;未帶者 null;診斷出錯者只有 error);取自節點文件(迴圈重跑之正本與其後之補算〔--mode extfill〕),與節點文件之 harness.raw.metrics.ext 同一份值'],
    ['holdout.perf / content', '保留期(回測期之後、未用於搜尋之期間)之正負號: perf = 七相位等效年化之平均、content = 挑選內容(內建與近 90 日組成對照之超額之均); "+" / "-" / "0"; 未算為 null。只提供正負號, 不提供數字'],
    ['holdout.asOf', '保留期檢定所用資料之終點'],
    ['files.pick / doc', '本區內之程式碼複本、節點文件(Markdown)之相對路徑'],
]

//其他標的之正負號(規則 R-REC-30): 有 _cross.json 時才附於欄位定義之後(無此檔者欄位定義與 FIELD_DEFS 相同)
/**
 * 其他標的之正負號之欄位定義,每列為 [欄位名, 說明];共同儲存區有 _cross.json 時才附於 FIELD_DEFS 之後
 *
 * @type {Array<Array<String>>}
 */
let CROSS_FIELD_DEFS = [
    ['cross.backtest.perf / content', '其他標的(同一挑選模組原樣不改、於另一標的之策略庫上評估)於回測期之正負號: perf = 七相位等效年化之平均、content = 挑選內容(內建與近 90 日組成對照之超額之均); "+" / "-" / "0"; 未算為 null。只提供正負號, 不提供數字'],
    ['cross.holdout.perf / content', '其他標的於保留期之正負號(定義同上)'],
]
//signOf, 只收正負號: 字串 "+" / "-" / "0"(逐字相符)照回, 其他值(數字、數字字串、前後有空白者、全形號、其他字串、布林、物件、陣列、未給)一律為 null
//  保留期之 _holdout.json 與其他標的之 _cross.json 之資訊界線相同: 數字不入專案、只有號(以全等比較, 不經字串之方法)
let signOf = (v) => (v === '+' || v === '-' || v === '0' ? v : null)
let isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
let CROSS_PERIODS = ['backtest', 'holdout']
let CROSS_KEYS = ['perf', 'content']

//crossOf, _cross.json 之內容 → 讀取器; 只收正負號(規則 R-REC-30)
//  回 null(讀不到或形狀不合〔頂層非物件、items 非物件或為陣列〕; 呼叫端視同無此檔)或 { signsOf(id), ignored(), signed() }:
//  signsOf(id) 回 { backtest: { perf, content }, holdout: { perf, content } }(各值為 "+" / "-" / "0" 或 null; 只含這四個鍵, 檔內之其他鍵與值一概不帶出; 只認 items 之自有屬性);
//  檔內有值而不是可收之號者(數字、其他字串、物件、陣列、布林; 含整段 backtest / holdout 或整個策略之形狀不合)計入 ignored、該處為 null; null / undefined 為未算(不計入);
//  ignored() = 所讀之各策略之檔內不是號之值數、signed() = 所讀之各策略之中至少有一個號者之數; 同一個 id 只讀一次(重複呼叫回同值之複本、不重複計數)
/**
 * 由 _cross.json 之內容建立其他標的之正負號之讀取器(只收 "+" / "-" / "0" 之字串;其他值忽略並計數)
 *
 * @param {*} file 輸入 _cross.json 解析後之內容(讀不到者為 null)
 * @returns {Object|null} 回傳 null(形狀不合或無檔)或 { signsOf, ignored, signed }:signsOf(id) 回 { backtest: { perf, content }, holdout: { perf, content } }(同一個 id 只讀一次),ignored() 為所讀之各策略被忽略之值數,signed() 為所讀之各策略之中至少有一個號者之數
 * @example
 * let cr = crossOf({ items: { a1: { backtest: { perf: '+', content: '-' } } } })
 * cr.signsOf('a1') // => { backtest: { perf: '+', content: '-' }, holdout: { perf: null, content: null } }
 */
let crossOf = (file) => {
    if (!isPlainObj(file) || !isPlainObj(file.items)) {
        return null
    }
    let items = file.items
    let nIgnored = 0
    let nSigned = 0
    //cellOf: 一格之值 → 號或 null(未算: undefined / null; 其他不是號者計入 ignored)
    let cellOf = (v) => {
        if (v === undefined || v === null) {
            return null
        }
        let s = signOf(v)
        if (s === null) {
            nIgnored++
        }
        return s
    }
    //partOf: 整段或整個策略之值 → 一般物件或 null(形狀不合者計入 ignored)
    let partOf = (v) => {
        if (v === undefined || v === null) {
            return null
        }
        if (!isPlainObj(v)) {
            nIgnored++
            return null
        }
        return v
    }
    //readOf: 讀一個策略之四個號(計數於此累計)
    let readOf = (id) => {
        let it = partOf(Object.prototype.hasOwnProperty.call(items, id) ? items[id] : undefined)
        let out = {}
        let any = false
        for (let k of CROSS_PERIODS) {
            let seg = it ? partOf(it[k]) : null
            out[k] = {}
            for (let q of CROSS_KEYS) {
                out[k][q] = seg ? cellOf(seg[q]) : null
                any = any || out[k][q] !== null
            }
        }
        if (any) {
            nSigned++
        }
        return out
    }
    //signsOf: 同一個 id 只讀一次(其後回同值): ignored、signed 為「所讀之各策略」之計數, 不因重複呼叫而虛增; 回傳為複本(呼叫端改動不影響其後之讀取)
    let seen = new Map()
    let signsOf = (id) => {
        if (!seen.has(id)) {
            seen.set(id, readOf(id))
        }
        let o = seen.get(id)
        return { backtest: { ...o.backtest }, holdout: { ...o.holdout } }
    }
    return { signsOf, ignored: () => nIgnored, signed: () => nSigned }
}

let num = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : null)
let clip = (s, n) => (typeof s === 'string' && s.trim() ? s.trim().replace(/\s+/g, ' ').slice(0, n) : null)
let readJson = (fp) => {
    try {
        return JSON.parse(fs.readFileSync(fp, 'utf8'))
    }
    catch (err) {
        return null
    }
}

//familyMap, 節點 id(前 8 字)→ 家族名: 取最近一份含 synthesis.overview.families 之做夢文件
let familyMap = (dreamDir) => {
    let out = new Map()
    let files = fs.existsSync(dreamDir) ? fs.readdirSync(dreamDir).filter((f) => /^r\d+\.json$/.test(f)).sort().reverse() : []
    for (let f of files) {
        let d = readJson(path.join(dreamDir, f))
        let fams = d && d.synthesis && d.synthesis.overview && d.synthesis.overview.families
        if (Array.isArray(fams) && fams.length) {
            for (let x of fams) {
                for (let id of Array.isArray(x.nodes) ? x.nodes : []) {
                    let k = String(id).slice(0, 8)
                    if (!out.has(k)) {
                        out.set(k, clip(x.name, 160))
                    }
                }
            }
            break
        }
    }
    return out
}

//crossInfoOf, 其他標的之正負號 → info 之 cross 欄(只取 backtest / holdout 之 perf / content; 不是可收之號者為 null —— infoOf 為匯出之函數, 呼叫端直接給物件者亦只帶出號)
let crossInfoOf = (c) => {
    let out = {}
    for (let k of CROSS_PERIODS) {
        let seg = isPlainObj(c) && isPlainObj(c[k]) ? c[k] : null
        out[k] = {}
        for (let q of CROSS_KEYS) {
            out[k][q] = signOf(seg ? seg[q] : null)
        }
    }
    return out
}

//extRowOf, 節點文件之 harness.raw.metrics → 各擴充診斷自帶之 board / flag / notContent / subset(規則 R-REC-31; R-REC-21、R-REC-22、R-REC-27 之延伸)
//  回 { <診斷名>: { board, flag, notContent, subset } }(依診斷名排序); 原值不改寫、不截斷 —— 與節點文件之 harness.raw.metrics.ext 同一份值(看板之表格另以 extSurfaceOf 清理);
//  有無之判定同 verify.mjs 之 extSurfaceOf: board = 非空白之字串或有限數字(含 0)、其餘三者 = 非空白之字串, 不合者為 null;
//  診斷出錯(error)者為 { error }(取前 120 字); 非物件(含陣列、null、數字)之診斷略過; 診斷之其他鍵(text、ms 等)不帶出; 無 ext 者回 {}
/**
 * 取出各擴充診斷自帶之看板值(來自 metrics.ext 各診斷之 board、flag、notContent、subset;原值)
 *
 * @param {Object} m 輸入節點文件之 harness.raw.metrics,讀取 m.ext
 * @returns {Object} 回傳 { <診斷名>: { board, flag, notContent, subset } },依診斷名排序;出錯之診斷為 { error };無 ext 者為 {}
 * @example
 * let r = extRowOf({ ext: { demo: { board: 3, flag: '提示' } } })
 * r.demo // => { board: 3, flag: '提示', notContent: null, subset: null }
 */
let extRowOf = (m) => {
    let ext = m && isPlainObj(m.ext) ? m.ext : {}
    let str = (v) => (typeof v === 'string' && v.trim() ? v : null)
    let out = {}
    for (let name of Object.keys(ext).sort()) {
        let o = ext[name]
        if (!isPlainObj(o)) {
            continue
        }
        if (o.error) {
            out[name] = { error: clip(String(o.error), 120) }
            continue
        }
        let board = (typeof o.board === 'string' && o.board.trim()) || (typeof o.board === 'number' && Number.isFinite(o.board)) ? o.board : null
        out[name] = { board, flag: str(o.flag), notContent: str(o.notContent), subset: str(o.subset) }
    }
    return out
}

//infoOf, 一個節點文件 → 該策略之全部欄位(純函數; meta = 成品之 meta 或 null; fam = 家族名或 null; ho = 保留期之正負號或 null)
/**
 * 由一個節點文件取得該策略之全部欄位(純函數)
 *
 * 欄位分 identity、status、design、backtest、ext、holdout、files 各組,缺值為 null;ext 為各擴充診斷自帶之 board、flag、notContent、subset(見 extRowOf);
 * 有給 cross 者於 holdout 之後另帶 cross。
 *
 * @param {Object} d 輸入節點文件,讀取 nodeId、round、task、spec、harness、conclusion、audit、code
 * @param {Object} [opt={}] 輸入設定物件,預設{}
 * @param {Object|null} [opt.meta=null] 輸入成品之 meta,預設null
 * @param {String|null} [opt.fam=null] 輸入家族名,預設null
 * @param {Object|null} [opt.ho=null] 輸入保留期之正負號(perf、content、asOf),預設null;perf、content 只收 "+" / "-" / "0",其他值為 null
 * @param {Object|null} [opt.postfit=null] 輸入求解窗後段之佐證(fillPlan.mjs 之 postfitInfoOf 之結果),預設null;非物件者為 null
 * @param {Object} [opt.cross] 輸入其他標的之正負號(crossOf 之 signsOf 之結果:backtest、holdout 各 { perf, content });未給(undefined)者回傳物件不含 cross 鍵,給 null 者四值皆 null;只帶出 "+" / "-" / "0"
 * @param {Function} [opt.rel] 輸入路徑轉相對路徑之函數,預設原樣回傳
 * @param {String} [opt.storeRel=''] 輸入儲存區之相對路徑,預設''
 * @returns {Object} 回傳該策略之欄位物件(id、short、round、type、arms、base、claimKey、claim、family、status、design、backtest、ext、postfit、holdout、[cross]、files)
 * @example
 * let info = infoOf(nodeDoc, { meta, fam: null, ho: null, storeRel: 'picks' })
 */
let infoOf = (d, { meta = null, fam = null, ho = null, cross = undefined, postfit = undefined, rel = (p) => p, storeRel = '' } = {}) => {
    let h = d.harness || {}
    let m = (h.raw && h.raw.metrics) || {}
    let op = m.op || {}
    let eq = op.eqYr || {}
    let ns = m.nullSideAct || {}
    let nr = recentDiagOf(m) || {} //近期活躍度版之 side(與領域、迴圈之驗證同一個「有值」之判準: 物件、不帶 error、超額為有限數值; 規則 R-REC-38 ⑦); 無值者皆 null
    let both = [ns.excess, nr.excess].filter((v) => typeof v === 'number')
    let sc = h.score || {}
    let c = d.conclusion || {}
    let a = d.audit || null
    let id = d.nodeId
    return {
        id,
        short: String(id).slice(0, 8),
        round: d.round,
        type: (d.task && d.task.type) || 'explore',
        arms: d.spec.arms,
        base: d.spec.base || null,
        claimKey: d.spec.claim || null,
        claim: clip(d.task && d.task.claim, 200),
        family: fam,
        status: {
            trust: a ? a.trust || null : null,
            action: a ? a.action || null : null,
            vetoed: !!(sc.flags && sc.flags.vetoed),
            ladder: typeof sc.ladder === 'number' ? sc.ladder : null,
            inactiveArms: (a && Array.isArray(a.inactiveArms) ? a.inactiveArms : (d.code && Array.isArray(d.code.inactiveArms) ? d.code.inactiveArms : [])),
            claimVerdict: c.claimVerdict || null,
            issues: ((h.checks && h.checks.issues) || []).map((s) => clip(String(s), 120)),
        },
        design: {
            desc: clip(meta && meta.desc, 300),
            params: meta && meta.params && typeof meta.params === 'object' ? meta.params : null,
            summary: clip(c.summary, 400),
        },
        backtest: {
            S: num(sc.S),
            eqYrMean: num(eq.mean),
            eqYrMin: num(eq.min),
            eqYrByPhase: Array.isArray(eq.byPhase) ? eq.byPhase.map((v) => num(v, 1)) : null,
            nPosPhases: Array.isArray(eq.byPhase) ? eq.byPhase.filter((v) => v > 0).length : null,
            content: { builtin: num(ns.excess, 1), p: num(ns.p, 4), recent: num(nr.excess, 1), pRecent: num(nr.p, 4), mean: both.length ? num(both.reduce((s, v) => s + v, 0) / both.length, 1) : null },
            replays: Array.isArray(h.raw && h.raw.replays) ? h.raw.replays.map((x) => ({ S: num(x.S), builtin: num(x.comp, 1), recent: num(x.recent, 1) })) : [],
            monthlyOrders: num(op.monthlyOrders && op.monthlyOrders.mean, 1),
            peakHold: num(op.peakHold && op.peakHold.max, 0),
            winRate: num(op.winRate, 4),
            sigPerPick: num(m.sel && m.sel.sigPerPick, 2),
            longRatio: num(m.sel && m.sel.longRatio, 3),
            selHash: m.selHash || (h.raw && h.raw.selHash) || null,
            pickSec: num(m.ms && typeof m.ms.pick === 'number' ? m.ms.pick / 1000 : null, 1),
            ledgerKey: m.ledgerKey || null,
        },
        ext: extRowOf(m),
        //求解窗後段之佐證(規則 R-REC-34): 補算檔之值(postfitInfoOf 之結果)或 null; 不入總表之欄
        //  未給 postfit(undefined; 狀態根無任何補算檔)⇒ 不帶此鍵(與未加入本功能時逐位相同; 同其他標的之號之作法)
        ...(postfit === undefined ? {} : { postfit: postfit && typeof postfit === 'object' && !Array.isArray(postfit) ? postfit : null }),
        //保留期: perf / content 只收正負號(signOf; 數字不入專案, 與其他標的之 _cross.json 之界線相同)
        holdout: ho ? { perf: signOf(ho.perf), content: signOf(ho.content), asOf: ho.asOf || null } : { perf: null, content: null, asOf: null },
        //其他標的之正負號(規則 R-REC-30): 只在給了 cross 時才有此鍵(無 _cross.json 者 info.json 與舊版逐位相同); 只取四個號, 不帶其他欄
        ...(cross === undefined ? {} : { cross: crossInfoOf(cross) }),
        files: { pick: `${storeRel}/${id}/pick.mjs`, doc: rel(d.__docMd || '') || null },
    }
}

//INDEX.md 之欄: [標題, 取值]
let f1 = (v) => (typeof v === 'number' ? v.toFixed(1) : '—')
/**
 * INDEX.md 之欄定義,每列為 [標題, 取值函數(以 infoOf 之結果為輸入)]
 *
 * @type {Array<Array>}
 */
let COLUMNS = [
    ['節點', (x) => `\`${x.short}\``],
    ['輪', (x) => `r${String(x.round).padStart(3, '0')}`],
    ['類型', (x) => (x.type === 'verify' ? '驗證' : '探索')],
    ['臂(←起點)', (x) => `${x.arms.join(' + ')}${x.base ? ` ←${x.base.slice(0, 8)}` : ''}`],
    ['審計', (x) => `${x.status.trust || '未審'}${x.status.vetoed ? '(否決)' : ''}`],
    ['回測期 S / 階梯', (x) => `**${x.backtest.S === null ? '—' : x.backtest.S}** / ${x.status.ladder === null ? '—' : x.status.ladder}`],
    ['七相位 平均 / 最差 / 為正', (x) => `${f1(x.backtest.eqYrMean)} / ${f1(x.backtest.eqYrMin)} / ${x.backtest.nPosPhases === null ? '—' : x.backtest.nPosPhases}`],
    ['挑選內容 內建 / 近 90 日(p)', (x) => `${f1(x.backtest.content.builtin)} / ${f1(x.backtest.content.recent)}(${x.backtest.content.p === null ? '—' : x.backtest.content.p})`],
    ['月均單 / 做多比例', (x) => `${f1(x.backtest.monthlyOrders)} / ${x.backtest.longRatio === null ? '—' : x.backtest.longRatio}`],
    ['保留期 績效 / 內容', (x) => `${x.holdout.perf || '·'} / ${x.holdout.content || '·'}`],
    ['機制(成品自述或結論摘要)', (x) => String(x.design.desc || x.design.summary || '—').replace(/\|/g, '/').slice(0, 110)],
]
//其他標的之正負號之兩欄(規則 R-REC-30): 有 _cross.json 時才插在「保留期」一欄之後(無此檔者總表之欄與 COLUMNS 相同)
/**
 * 其他標的之正負號之兩欄定義(INDEX.md;有 _cross.json 時才插在 COLUMNS 之「保留期」一欄之後),每列為 [標題, 取值函數(以含 cross 之 infoOf 結果為輸入)]
 *
 * @type {Array<Array>}
 */
let CROSS_COLUMNS = [
    ['其他標的 回測期 績效 / 內容', (x) => `${x.cross.backtest.perf || '·'} / ${x.cross.backtest.content || '·'}`],
    ['其他標的 保留期 績效 / 內容', (x) => `${x.cross.holdout.perf || '·'} / ${x.cross.holdout.content || '·'}`],
]
//columnsOf, 本次總表之欄(crossOn: 有可用之 _cross.json)
let columnsOf = (crossOn) => {
    if (!crossOn) {
        return COLUMNS
    }
    let i = COLUMNS.findIndex(([t]) => t.startsWith('保留期'))
    return [...COLUMNS.slice(0, i + 1), ...CROSS_COLUMNS, ...COLUMNS.slice(i + 1)]
}
//POSTFIT_FIELD_DEFS, 求解窗後段之佐證之欄位定義(規則 R-REC-34): 狀態根有補算檔時才插於擴充診斷之欄之後(無者欄位定義 = FIELD_DEFS, 與未加入本功能時相同)
let POSTFIT_FIELD_DEFS = [
    ['postfit.from / to / seatsKept / seatsDropped / comp / halves / selHash / recent / at / current', '求解窗後段(回測期以前、各策略之求解窗終點之後;評估器之 --period postfit)之佐證,**不是成績:不入 S、階梯、總表與看板之排序**:所留 / 所捨之席(每次決策之平均)、所留之席之組成對照(同側同活躍度)之超額 / z / p(comp)、前段 / 後段之同一組量(halves)、評估器有近期活躍度版之組成對照者另有 recent(comp、halves);at = 算出之時刻、current = 與現行之評估器相符、且附算時所記之正本之選集指紋與現況之正本相同(false = 評估器改版或正本重算後尚未重算);迴圈附算(輪末:本輪之新成品)與補算(--mode fill)所得,存於狀態根之 fill/<節點 id>.json(迴圈所寫;agent 不可寫之處);尚無者為 null'],
]
//fieldDefsOf, 本次之欄位定義(crossOn: 有可用之 _cross.json; fillOn: 狀態根有補算檔)
let fieldDefsOf = (crossOn, fillOn = false) => {
    let i = FIELD_DEFS.findIndex(([k]) => k.startsWith('ext.'))
    let base = fillOn ? [...FIELD_DEFS.slice(0, i + 1), ...POSTFIT_FIELD_DEFS, ...FIELD_DEFS.slice(i + 1)] : FIELD_DEFS
    return crossOn ? [...base, ...CROSS_FIELD_DEFS] : base
}
//hasFillFiles, 狀態根之補算夾(fill/)是否有補算檔(暫存檔不算)
let hasFillFiles = (stateRoot) => {
    try {
        return fs.readdirSync(path.join(stateRoot, FILL_DIR)).some((f) => /\.json$/.test(f) && !f.includes('.tmp-'))
    }
    catch (err) {
        return false
    }
}
//其他標的之正負號之說明(README.md; 有 _cross.json 時才插在「保留期之正負號」一節之後; 不寫其他標的之名稱、數字與期間)
let crossReadme = () => [
    '## 其他標的之正負號',
    '',
    '- 其他標的 = 另一個標的之策略庫:同一挑選模組**原樣不改**,於其上評估(期間同本標的之回測期與保留期)。檢定由主控執行,**數字不提供,只提供正負號**:',
    '  - `cross.backtest.perf` / `cross.holdout.perf`:該策略於其他標的之回測期 / 保留期之績效(七相位等效年化之平均)為正 `+`、為負 `-`、無單或為零 `0`。',
    '  - `cross.backtest.content` / `cross.holdout.content`:同期間之挑選內容(內建與近 90 日組成對照之超額之均)為正 `+`、為負 `-`、恰為零 `0`。',
    '  - 未算者為 null(總表顯示「·」)。',
    '- 用途:大致判斷一條線換一個標的是否仍成立(機制是否只屬本標的)。讀法同保留期 —— 看**同一家族多個成品是否同號**,不以單一成品之正負號下結論;不得為了湊出正號而反覆換設計(那等於把其他標的變成訓練資料)。',
    '',
]

//  hoFrom, 保留期之起點(settings.periods.holdoutFrom 之日期部分; 規則 R-REC-36: 不寫死期間); 未給者略去括號
let readmeText = (storeRel, n, asOf, crossOn = false, fillOn = false, hoFrom = null) => [
    '# 共同儲存「自適應挑選策略」區',
    '',
    `> 由迴圈產生(每輪結束與主控審定後重產),**agent 唯讀**。目前 ${n} 個策略。來源 = 各節點之交付版 \`pick.mjs\`(逐位複本)與節點文件內**迴圈以同一評估器重跑**之回測期數字(不是 agent 自報)。`,
    '',
    '## 怎麼用',
    '',
    `- **總表** \`${storeRel}/INDEX.md\`:每個策略一列,依回測期 S 由高至低;先看這份。`,
    `- **全部欄位** \`${storeRel}/index.json\`:\`items\` 為陣列,可自行排序、篩選(例:只看審計為 trusted 者、某一臂、某一家族、保留期為正者)。`,
    `- **程式碼** \`${storeRel}/<節點 id>/pick.mjs\`:該策略之交付版;要以它為底者照任務書之規定複製到自己之工作夾。`,
    `- **單一策略之欄位** \`${storeRel}/<節點 id>/info.json\`;完整之紀錄(規劃、實驗、審計)在其節點文件(\`files.doc\`)。`,
    '- 本區只收**已執行並經迴圈重跑**之節點成品;做夢之預先核對檔與共用工具區之樣板不在此列(見共用工具區之索引)。',
    '',
    '## 保留期之正負號',
    '',
    `- 保留期 = 回測期之後、未用於搜尋之期間${hoFrom ? `(${hoFrom} 起)` : ''}。檢定由主控執行,**數字不提供,只提供正負號**:`,
    '  - `holdout.perf`:該策略於保留期之績效(七相位等效年化之平均)為正 `+`、為負 `-`、無單或為零 `0`。',
    '  - `holdout.content`:該策略於保留期之挑選內容(內建與近 90 日組成對照之超額之均)為正 `+`、為負 `-`。',
    `  - 未算者為 null(總表顯示「·」)。${asOf ? `目前之檢定所用資料至 ${asOf}。` : '目前尚無任何檢定結果。'}`,
    '- 用途:大致判斷一條線於回測期之外是否仍成立(方向與可用性)。保留期遠短於回測期,單一正負號之雜訊大 —— 看**同一家族多個成品是否同號**,不以單一成品之正負號下結論;不得為了湊出正號而反覆換設計(那等於把保留期變成訓練資料)。',
    '',
    ...(crossOn ? crossReadme() : []),
    '## 欄位',
    '',
    '| 欄位 | 說明 |',
    '|---|---|',
    ...fieldDefsOf(crossOn, fillOn).map(([k, v]) => `| \`${k}\` | ${v} |`),
    '',
    '讀取端請以鍵取值、容許未知之鍵與 null(欄位會擴充;舊節點可能無某欄)。',
    '',
].join('\n')

//buildPickStore, 產生(或更新)共同儲存區; 回 { dir, n, copied, skipped[], holdoutSigned, cross }(cross: 無 _cross.json 為 null; 規則 R-REC-30)
//  st: getSettings() 之結果(records.nodeDir / workDir / dreamDir、rsi.root、FD_ROOT)
/**
 * 產生或更新共同儲存「自適應挑選策略」區(<rsi.root>/picks/;會寫入 pick.mjs 複本、info.json、index.json、INDEX.md、README.md)
 * 先載入各節點之挑選模組取 meta(模組之頂層程式於本行程執行),全部載入後才寫檔;挑選模組改了內建物件(完整性錯誤)者中止本次更新: 不寫任何檔、拋出 code 為 EVAL_INTEGRITY 之錯誤(訊息指明節點與被改之項目)
 * 入口與每個節點載入後亦比對受保護之內建物件(成品之延後執行之程式、前次更新留下之改動皆於寫檔前偵測); 其他載入錯誤(靜態檢查未過、匯入失敗)不中止: 該策略之 meta 為 null、仍收錄
 *
 * @param {Object} st 輸入設定物件(getSettings 之結果),讀取 st.records.nodeDir、st.records.workDir、st.records.dreamDir、st.rsi.root、st.FD_ROOT
 * @returns {Promise<Object>} 回傳 { dir, n, copied, skipped, holdoutSigned, cross }:儲存區路徑、策略數、新複製之程式碼數、略過清單、已有保留期正負號之數量、其他標的之正負號之統計(無 _cross.json 為 null;有而形狀不合為 { invalid: true, signed: 0, ignored: 0 };可用為 { invalid: false, signed, ignored }:至少有一個號之策略數、區內策略之檔內不是號而被忽略之值之數)
 * @example
 * let r = await buildPickStore(st)
 */
let buildPickStore = async (st) => {
    //入口比對(規則 R-EV-35 ②): 本行程之內建物件已被改者(前次更新載入之成品所改, 迴圈行程不因此終止)不再更新 —— 無候選、各候選皆於載入前被拒者亦然
    assertIntrinsics('pick-store', ABORT_NOTE)
    let dir = path.join(st.rsi.root, 'picks')
    let rel = (p) => (p ? path.relative(st.FD_ROOT, p).replace(/\\/g, '/') : '')
    let storeRel = rel(dir)
    let fams = familyMap(st.records.dreamDir)
    let hoFile = readJson(path.join(dir, '_holdout.json'))
    let hoItems = (hoFile && hoFile.items) || {}
    //其他標的之正負號(規則 R-REC-30; 選配): 只讀、不產生、不刪; 無此檔或形狀不合 ⇒ cr 為 null, 各檔與舊版逐位相同
    let crFp = path.join(dir, '_cross.json')
    let crExists = fs.existsSync(crFp)
    let cr = crExists ? crossOf(readJson(crFp)) : null
    let items = []
    let skipped = []
    let copied = 0
    let docs = fs.existsSync(st.records.nodeDir) ? fs.readdirSync(st.records.nodeDir).filter((f) => /^[0-9a-f]{16}\.json$/.test(f)).sort() : []
    //第一段: 讀節點文件並載入各節點之成品取 meta(只讀; 不寫任何檔)
    //  loadPick 於本行程執行成品之頂層程式: 成品改了內建物件者(完整性錯誤, code 為 EVAL_INTEGRITY; 規則 R-EV-35 ②)⇒ 本行程之內建物件可能已被改, 即中止本次更新:
    //  不寫任何檔(區內維持上次之內容; 其後之寫檔亦不再依賴被改之內建物件)、拋完整性錯誤(訊息指明節點; 呼叫端記錄: 迴圈於輪末之記錄、命令列工具之 ERROR 行與離開碼 3)。
    //  其他錯誤(靜態檢查未過、匯入失敗等)維持原處置: meta 為 null、該策略仍收錄
    //  每個 await 恢復後、處理資料前再比對一次: 成品之延後執行之程式(微任務)可在 loadPick 內之比對之後、本函數恢復之前改內建物件;
    //  錯誤一律以 intrinsics.mjs 之 integrityError 建立(只用擷取之參照; 內建物件已被改時不經全域之 Error / String)
    let cands = []
    for (let f of docs) {
        let d = readJson(path.join(st.records.nodeDir, f))
        if (!d || !d.nodeId || !d.spec || !Array.isArray(d.spec.arms) || !d.harness || d.harness.ok !== true || !d.harness.score) {
            if (d && d.nodeId) {
                skipped.push(`${String(d.nodeId).slice(0, 8)}(無迴圈重跑之結果)`)
            }
            continue
        }
        let src = path.join(st.records.workDir, d.nodeId, 'pick.mjs')
        if (!fs.existsSync(src)) {
            skipped.push(`${String(d.nodeId).slice(0, 8)}(工作夾無 pick.mjs)`)
            continue
        }
        //交付版之位元組於載入前讀入、第二段複製此份(meta 與複本取自同一份; 第二段不再讀來源檔)
        let code = fs.readFileSync(src)
        let short = String(d.nodeId).slice(0, 8)
        let meta = null
        try {
            meta = (await loadPick(src)).meta
        }
        catch (err) {
            if (isIntegrityError(err)) {
                throw integrityError(err.where, err.items, `${ABORT_NOTE}: 節點 ${short}`)
            }
        }
        assertIntrinsics('pick-store', `${ABORT_NOTE}: 節點 ${short}`)
        pushOwn(cands, { d, code, meta })
    }
    //第二段: 寫入(複製交付版、info.json、index.json、INDEX.md、README.md)
    //  求解窗後段之佐證(規則 R-REC-34): 狀態根之補算檔(fill/<節點 id>.json; 檔內之 nodeId 須相符; 節點工作夾內之同名檔不讀), 成品之雜湊(本次複製之同一份位元組)相符者才帶; current = 評估器之指紋相符
    //評估器之指紋讀不到 ⇒ 求解窗後段之欄一律標為非現行(current: false); 共同儲存區之其餘照常產生
    let evaluator = null
    try {
        evaluator = evaluatorFpOf(st)
    }
    catch (err) {
        evaluator = null
    }
    //fillOn, 狀態根有補算檔才帶 postfit 之鍵與欄位定義(無者與未加入本功能時逐位相同)
    let fillOn = hasFillFiles(st.rsi.root)
    fs.mkdirSync(dir, { recursive: true })
    for (let { d, code, meta } of cands) {
        //正本之選集指紋: 補算檔所記者與之不同 ⇒ 此段之值與正本出自不同代之評估, 標為非現行
        let hr = d.harness && d.harness.raw ? d.harness.raw : null
        let canonSel = hr && hr.metrics && typeof hr.metrics.selHash === 'string' ? hr.metrics.selHash : (hr && typeof hr.selHash === 'string' ? hr.selHash : null)
        let postfit = postfitInfoOf(readFill(st.rsi.root, d.nodeId), { pick: pickHashOf(code), evaluator }, canonSel)
        let dst = path.join(dir, d.nodeId, 'pick.mjs')
        if (!fs.existsSync(dst) || !fs.readFileSync(dst).equals(code)) {
            fs.mkdirSync(path.dirname(dst), { recursive: true })
            fs.writeFileSync(dst, code)
            copied++
        }
        d.__docMd = path.join(st.records.nodeDir, `${d.nodeId}.md`)
        let ho = hoItems[d.nodeId] ? { ...hoItems[d.nodeId], asOf: hoFile.asOf || null } : null
        let info = infoOf(d, { meta, fam: fams.get(String(d.nodeId).slice(0, 8)) || null, ho, ...(cr ? { cross: cr.signsOf(d.nodeId) } : {}), ...(fillOn ? { postfit } : {}), rel, storeRel })
        fs.writeFileSync(path.join(dir, d.nodeId, 'info.json'), JSON.stringify(info, null, 1), 'utf8')
        items.push(info)
    }
    items.sort((p, q) => (q.backtest.S === null ? -Infinity : q.backtest.S) - (p.backtest.S === null ? -Infinity : p.backtest.S) || (p.id < q.id ? -1 : 1))
    let updatedAt = new Date().toISOString()
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ schema: SCHEMA, updatedAt, holdoutAsOf: (hoFile && hoFile.asOf) || null, fields: fieldDefsOf(!!cr, fillOn).map(([key, note]) => ({ key, note })), items }, null, 1), 'utf8')
    let cols = columnsOf(!!cr)
    let L = []
    L.push('# 自適應挑選策略總表')
    L.push('')
    L.push(`> 由迴圈產生(${updatedAt});${items.length} 個策略,依回測期 S 由高至低。欄位說明與用法見 \`${storeRel}/README.md\`;全部欄位見 \`${storeRel}/index.json\`;程式碼在 \`${storeRel}/<節點 id>/pick.mjs\`。`)
    L.push(cr
        ? '> 「保留期」與「其他標的」各欄只有正負號(「·」= 未算);S 高不等於有挑選內容 —— 先看「挑選內容」與審計。'
        : '> 「保留期」一欄只有正負號(「·」= 未算);S 高不等於有挑選內容 —— 先看「挑選內容」與審計。')
    L.push('')
    L.push(`| ${cols.map(([t]) => t).join(' | ')} |`)
    L.push(`|${cols.map(() => '---').join('|')}|`)
    for (let x of items) {
        L.push(`| ${cols.map(([, fn]) => fn(x)).join(' | ')} |`)
    }
    L.push('')
    fs.writeFileSync(path.join(dir, 'INDEX.md'), L.join('\n'), 'utf8')
    fs.writeFileSync(path.join(dir, 'README.md'), readmeText(storeRel, items.length, (hoFile && hoFile.asOf) || null, !!cr, fillOn, st.periods && typeof st.periods.holdoutFrom === 'string' && st.periods.holdoutFrom ? st.periods.holdoutFrom.slice(0, 10) : null), 'utf8')
    //cross: 無 _cross.json ⇒ null; 有而形狀不合 ⇒ { invalid: true, signed: 0, ignored: 0 }(總表不列其欄); 可用 ⇒ { invalid: false, signed〔至少有一個號之策略數〕, ignored〔區內策略之檔內不是號而被忽略之值之數〕}
    let cross = !crExists ? null : (cr ? { invalid: false, signed: cr.signed(), ignored: cr.ignored() } : { invalid: true, signed: 0, ignored: 0 })
    return { dir, n: items.length, copied, skipped, holdoutSigned: items.filter((x) => x.holdout.perf !== null).length, cross }
}

export { buildPickStore, infoOf, familyMap, crossOf, extRowOf, FIELD_DEFS, COLUMNS, CROSS_FIELD_DEFS, CROSS_COLUMNS, SCHEMA }
