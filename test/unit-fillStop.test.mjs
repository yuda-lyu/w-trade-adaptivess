import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { getSettings, FD_ROOT } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { specHash } from '../src/engineApi.mjs'
import * as RUN from '../src/arsi/runner.mjs'
import { makeTmp } from './tools/synthLedger.mjs'
//新增之具名匯出以命名空間取得(修前之複本無此匯出時, 本檔仍可載入, 各案以斷言失敗呈現而非整檔載入失敗)
let { STOP_FILE, stopFileOf, stopFileExists } = RUN


//補算(domain.mjs 之 fill; g_rsi.mjs --mode fill)之停止檔(排程第 545 項; Gitea #184 §7; R-RUN-12)
//  規格之句 ⇒ 案: 「補算之工作者於取下一個成品前檢查狀態根之停止檔 STOP」= 於第一個成品評估中建立停止檔 ⇒ 第二個起不取(已取者做完);「與 g_rsi 輪次之停止檔同一檔、同一檢查函數」= runner.mjs 之 stopFileOf、stopFileExists(原始碼之盤點);
//    「存在即不取新成品、已取者做完、正常結束」= 回傳(不拋)、各成品之結果與補算檔只有已取者、已取者之各項(求解窗後段與擴充診斷)皆完成;「摘要寫明『因停止檔提前結束』與已完成 / 未完成數」= out.lines 與 out.stopped;
//    「輪末之附算屬該輪」= source 'round' 不檢(停止檔之語意是跑完本輪後停下); 命令列之補算(source 'cli')檢
//  修前(1.0.47): 補算無停止機制(停止檔存在亦照算全樹)
describe('補算之停止檔(R-RUN-12)', function () {
    this.timeout(120000)
    let t
    beforeEach(() => {
        t = makeTmp('fillStop')
    })
    afterEach(() => {
        t.cleanup()
    })
    let ARMS = [['A01_nt'], ['A01_nt', 'B14_pitKey'], ['B14_pitKey']]
    let argOfA = (args, k) => {
        let i = args.indexOf(k); return i >= 0 ? args[i + 1] : null
    }
    let pfOf = (k) => ({
        ok: true,
        period: { name: 'postfit', start: '2025-04-08T04:00:00', end: '2025-10-06T00:00:00' },
        score: null,
        metrics: {
            selHash: `pf-sel-${k}`,
            nullSideAct: { p: 0.01 + k / 100, z: 2 + k, excess: 10 + k },
            afterFit: { seatsKept: 20 + k, seatsDropped: 5 + k, orders: 100, halves: [{ from: 'a', to: 'b', sideAct: { p: 0.02 + k / 100, z: 1 + k, excess: 30 + k } }, { from: 'c', to: 'd', sideAct: { p: 0.5, z: -1 - k, excess: -15 - k } }] },
        },
    })
    //mk, 暫存夾之專案: 3 個已執行之節點(同 unit-fillRun)、共用工具區 metrics/ 之兩個診斷; 假之評估(runEval)記錄每次之呼叫、可於呼叫時執行 hook
    let mk = ({ resources = {} } = {}) => {
        let st = getSettings()
        let d = path.join(t.dir, 'proj')
        st.resources = resources
        st.rsi = { ...st.rsi, fillParallel: 1, memberCheck: false }
        st.rsi.root = path.join(d, 'rsi')
        st.rsi.docLimits = false
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthStop' }), 'utf8')
        fs.mkdirSync(path.join(st.records.toolboxDir, 'metrics'), { recursive: true })
        fs.writeFileSync(path.join(st.records.toolboxDir, 'metrics', 'dA.mjs'), 'export default { v: 1 }\n', 'utf8')
        fs.writeFileSync(path.join(st.records.toolboxDir, 'metrics', 'dB.mjs'), 'export default { v: 2 }\n', 'utf8')
        let P = makeProject(st, { dispatch: async () => ({ ok: false, error: 'fake' }), gate: null, catalogFile: path.join(d, 'catalog.json') })
        P.rsi.init()
        let ids = ARMS.map((arms, k) => {
            let spec = { arms, base: null }
            let id = P.idOf(spec)
            let wd = path.join(st.records.workDir, id)
            fs.mkdirSync(wd, { recursive: true })
            fs.writeFileSync(path.join(wd, 'pick.mjs'), `export const meta = { arms: ${JSON.stringify(arms)}, desc: '成品 ${k}' }\nexport default function pick(ctx) {\n    return [${k}]\n}\n`, 'utf8')
            fs.writeFileSync(path.join(wd, 'harness_full.json'), JSON.stringify({ ok: true, at: `2026-01-0${k + 1}T00:00:00.000Z`, metrics: { selHash: `sel-${k}` } }), 'utf8')
            let ext = k === 0 ? { dA: { board: 100 + k } } : (k === 1 ? { dA: { board: 100 + k }, dB: { board: 200 + k } } : {})
            let metrics = { selHash: `sel-${k}`, ext, op: { eqYr: { mean: 12.5 + k, min: -1.5 - k, byPhase: [1, 2, 3, 4, 5, 6, 7].map((v) => v + k) }, monthlyOrders: { mean: 90 + k }, peakHold: { max: 30 - k }, winRate: 0.4 + k / 100 } }
            P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round: 1, raw: { metrics, issues: [] }, score: { S: 10 + k, ladder: 3, flags: { vetoed: false, why: [] } } })
            P.records.putNodeDoc({ nodeId: id, round: 1, attempt: 1, status: 'verified', spec, task: { goal: 'g', type: 'explore' }, plan: {}, code: {}, results: { claimed: {} }, conclusion: { outcome: 'improved', summary: `摘要 ${k}` }, harness: { ok: true, summary: [`既有之列 ${k}`], notes: [], checks: { issues: [] }, score: { S: 10 + k, ladder: 3, flags: { vetoed: false, why: [] } }, raw: { metrics } } })
            return id
        })
        let calls = []
        let hook = null
        let runEval = async ({ nodeId, kind, args }) => {
            calls.push({ nodeId, kind })
            let k = ids.indexOf(nodeId)
            if (hook) {
                await hook({ nodeId, kind, k })
            }
            let out = argOfA(args, '--out')
            if (kind === 'postfit') {
                fs.writeFileSync(out, JSON.stringify(pfOf(k)), 'utf8')
                return { code: 0, timeout: false }
            }
            let names = argOfA(args, '--ext-only').split(',')
            fs.writeFileSync(out, JSON.stringify({ ok: true, metrics: { selHash: `sel-${k}`, ext: Object.fromEntries(names.map((nm) => [nm, { board: `${nm}-${k}-new` }])) } }), 'utf8')
            return { code: 0, timeout: false }
        }
        return {
            P,
            st,
            ids,
            calls,
            runEval,
            setHook: (h) => {
                hook = h
            }
        }
    }
    let fillFilesOf = (st) => {
        let fd = path.join(st.rsi.root, 'fill')
        return fs.existsSync(fd) ? fs.readdirSync(fd).filter((f) => f.endsWith('.json') && !f.endsWith('.postfit.json')).sort() : []
    }
    let relStop = (st) => path.relative(FD_ROOT, stopFileOf(st.rsi.root)).replace(/\\/g, '/')

    it('停止檔不存在 ⇒ 補算全樹, 回傳不帶 stopped、摘要無「因停止檔提前結束」(對照: 行為同修前)', async () => {
        let { P, st, ids, runEval } = mk()
        let r = await P.fill({ runEval })
        assert.equal(r.results.length, 3)
        assert.strictEqual(r.stopped, undefined)
        assert(!r.lines.some((l) => l.includes('因停止檔提前結束')), r.lines.join('|'))
        assert.equal(fillFilesOf(st).length, 3)
        assert.deepEqual(r.plan, { nTasks: 3, nCurrent: 0 })
        assert.equal(ids.length, 3)
    })

    it('補算進行中建立停止檔(par 1): 已取之成品做完(求解窗後段與診斷皆完成)、不再取新成品、正常結束(回傳不拋); out.stopped 與摘要寫明已完成 / 未完成數; 其餘成品無補算檔、不入待重試; 刪除停止檔後再補算即續(只算未做者)', async () => {
        let { P, st, ids, calls, runEval, setHook } = mk()
        let stopAt = null
        setHook(async ({ nodeId }) => {
            //第一個成品之第一次評估時建立停止檔(其後之評估與其餘成品之取用皆在停止檔存在之下)
            if (stopAt === null) {
                stopAt = nodeId
                fs.writeFileSync(stopFileOf(st.rsi.root), '', 'utf8')
            }
        })
        let r = await P.fill({ runEval })
        //已取者做完: 第一個成品之各項皆評估(其待算之 postfit 與所缺之診斷), 其餘成品一次也未評估
        assert.equal(r.results.length, 1, JSON.stringify(r.results.map((x) => x.nodeId)))
        assert.equal(r.results[0].nodeId, stopAt)
        assert(calls.length >= 1 && calls.every((c) => c.nodeId === stopAt), `評估只及於已取之成品: ${JSON.stringify(calls)}`)
        assert.equal(r.results[0].postfit, 'ok')
        assert.deepEqual(r.results[0].ext.failed, [])
        assert.strictEqual(r.results[0].error, null)
        assert.deepEqual(r.stopped, { file: relStop(st), done: 1, rest: 2 })
        assert.equal(r.plan.nTasks, 3)
        let line = r.lines.find((l) => l.includes('因停止檔提前結束'))
        assert.equal(line, `因停止檔提前結束(停止檔 ${relStop(st)} 存在): 本次待算 3 個成品, 已完成 1 個(已取者皆做完, 含失敗者)、未完成 2 個(未完成者留為待補算; 刪除停止檔後重跑即續)`)
        //補算檔只有已取者; 待重試為空(未取者不是失敗)
        assert.deepEqual(fillFilesOf(st), [`${stopAt}.json`])
        let fst = JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'fill_state.json'), 'utf8'))
        assert.deepEqual(fst.retry, [])
        assert.deepEqual(r.retry, [])
        //續跑: 刪除停止檔後, 計畫只剩未做之 2 個、現行 1 個; 完成後全樹皆有補算檔; 無 stopped
        let before = calls.length
        fs.rmSync(stopFileOf(st.rsi.root))
        setHook(null)
        let r2 = await P.fill({ runEval })
        assert.deepEqual(r2.plan, { nTasks: 2, nCurrent: 1 })
        assert.equal(r2.results.length, 2)
        assert.strictEqual(r2.stopped, undefined)
        assert(calls.slice(before).every((c) => c.nodeId !== stopAt), '已做者不重算')
        assert.equal(fillFilesOf(st).length, 3)
        assert.equal(ids.length, 3)
    })

    it('開始前已有停止檔: 不取任何成品(results 空、無評估、無補算檔)、stopped = { done: 0, rest: 全部 }、摘要寫明; 不拋', async () => {
        let { P, st, calls, runEval } = mk()
        fs.mkdirSync(st.rsi.root, { recursive: true })
        fs.writeFileSync(stopFileOf(st.rsi.root), '', 'utf8')
        let r = await P.fill({ runEval })
        assert.equal(r.results.length, 0)
        assert.equal(calls.length, 0)
        assert.deepEqual(r.stopped, { file: relStop(st), done: 0, rest: 3 })
        assert(r.lines.some((l) => l.includes('因停止檔提前結束') && l.includes('已完成 0 個(已取者皆做完, 含失敗者)、未完成 3 個')), r.lines.join('|'))
        assert.deepEqual(fillFilesOf(st), [])
    })

    it('併行 2: 兩個工作者各取一個成品後, 停止檔建立於兩者皆進行中 ⇒ 兩者做完、第三個不取(已完成 2、未完成 1); 工作者於資源閘之等待之後、取用之前檢查', async () => {
        let { P, st, ids, calls, runEval, setHook } = mk()
        let seen = new Set()
        let open = null
        let gate = new Promise((resolve) => {
            open = resolve
        })
        setHook(async ({ nodeId }) => {
            seen.add(nodeId)
            if (seen.size === 2) {
                //兩個工作者皆已取成品而進行中(各卡在第一次評估): 建立停止檔後放行
                fs.writeFileSync(stopFileOf(st.rsi.root), '', 'utf8')
                open()
            }
            await gate
        })
        let r = await P.fill({ runEval, par: 2 })
        assert.equal(r.par, 2)
        assert.equal(r.results.length, 2)
        assert.deepEqual(new Set(calls.map((c) => c.nodeId)), seen)
        assert.equal(seen.size, 2)
        assert.deepEqual(r.stopped, { file: relStop(st), done: 2, rest: 1 })
        assert(r.results.every((x) => x.postfit === 'ok' && x.ext.failed.length === 0), '已取者皆做完')
        assert.equal(fillFilesOf(st).length, 2)
        assert.equal(ids.length, 3)
    })

    it('資源閘之等待期間建立之停止檔: 第二個工作者等資源閘(已用記憶體恆高於起新工作之門檻 ⇒ 等到最長等待後放行)時, 第一個成品之評估中建立停止檔 ⇒ 等待結束後不取第二個成品(檢查在等待之後)', async () => {
        //門檻 ramStartGB 0.001 GB(恆不達成)、最長等待 0.02 分 = 1.2 秒 ⇒ 工作者 #2 於 1.2 秒後逾時放行(forced)
        let { P, st, calls, runEval, setHook } = mk({ resources: { ramUsedMaxGB: 100000, ramStartGB: 0.001, maxWaitMin: 0.02, pollSec: 0.4, sampleSec: 0.2 } })
        let first = true
        setHook(async () => {
            if (first) {
                first = false
                //第二個工作者已通過「等待之前」之檢查(此時尚無停止檔)而在等閘之後才有停止檔: 延 0.3 秒再建立(等閘 1.2 秒)
                await new Promise((resolve) => setTimeout(resolve, 300))
                fs.writeFileSync(stopFileOf(st.rsi.root), '', 'utf8')
            }
        })
        let t0 = Date.now()
        let r = await P.fill({ runEval, par: 2 })
        let sec = (Date.now() - t0) / 1000
        assert(sec >= 1, `工作者 #2 確等了資源閘(鑑別前提): ${sec} 秒`)
        assert.equal(r.results.length, 1, `等待之後不再取: ${JSON.stringify(r.results.map((x) => x.nodeId))}`)
        assert.deepEqual(r.stopped, { file: relStop(st), done: 1, rest: 2 })
        assert(calls.every((c) => c.nodeId === r.results[0].nodeId), JSON.stringify(calls))
    })

    it('停止檔已存在而資源閘不放行(併行 2): 第二個工作者於等待之前即檢查, 不為已無工作可取之閘等到最長等待(等待之前之檢查)', async () => {
        //門檻不可能達成 + 最長等待 30 秒: 若第二個工作者先等閘再檢查, 本案耗時 ≥ 30 秒
        let { P, st, calls, runEval } = mk({ resources: { ramUsedMaxGB: 100000, ramStartGB: 0.001, maxWaitMin: 0.5, pollSec: 0.4, sampleSec: 0.2 } })
        fs.mkdirSync(st.rsi.root, { recursive: true })
        fs.writeFileSync(stopFileOf(st.rsi.root), '', 'utf8')
        let t0 = Date.now()
        let r = await P.fill({ runEval, par: 2 })
        let sec = (Date.now() - t0) / 1000
        assert(sec < 10, `不等閘: ${sec} 秒`)
        assert.equal(r.results.length, 0)
        assert.equal(calls.length, 0)
        assert.deepEqual(r.stopped, { file: relStop(st), done: 0, rest: 3 })
    })

    it('extFill(經 fill 執行)同承停止檔: 進行中建立 ⇒ 已取之節點做完、其餘不取、回傳帶 stopped 與摘要句(lines)、results 只有已取者; 開始前已有 ⇒ results 空、stopped 0 / 全部; 無停止檔者不帶此二鍵', async () => {
        let { P, st, ids, calls, runEval, setHook } = mk()
        //對照: 無停止檔 ⇒ 不帶 stopped、lines
        let r0 = await P.extFill({ names: ['dA', 'dB'], runEval })
        assert.strictEqual(r0.stopped, undefined)
        assert.strictEqual(r0.lines, undefined)
        assert.equal(r0.nNodes, 3)
        //重置(強制重算)後, 進行中建立停止檔
        let first = null
        setHook(async ({ nodeId }) => {
            if (first === null) {
                first = nodeId
                fs.writeFileSync(stopFileOf(st.rsi.root), '', 'utf8')
            }
        })
        let before = calls.length
        let r = await P.extFill({ names: ['dA', 'dB'], force: true, runEval })
        assert.equal(r.results.length, 1, JSON.stringify(r.results))
        assert.equal(r.results[0].nodeId, first)
        assert.deepEqual(r.stopped, { file: relStop(st), done: 1, rest: 2 })
        assert.deepEqual(r.lines, [`因停止檔提前結束(停止檔 ${relStop(st)} 存在): 本次待算 3 個成品, 已完成 1 個(已取者皆做完, 含失敗者)、未完成 2 個(未完成者留為待補算; 刪除停止檔後重跑即續)`])
        assert(calls.slice(before).every((c) => c.nodeId === first))
        //開始前已有
        setHook(null)
        before = calls.length
        let r2 = await P.extFill({ names: ['dA', 'dB'], force: true, runEval })
        assert.equal(r2.results.length, 0)
        assert.deepEqual(r2.stopped, { file: relStop(st), done: 0, rest: 3 })
        assert.equal(calls.length, before, '一個也不評估')
        fs.rmSync(stopFileOf(st.rsi.root))
        assert.equal(ids.length, 3)
    })

    it('命令列(g_rsi.mjs --mode extfill)之原始碼: 開始前以 stopAtStart(與 --mode fill 同一函數)、輸出之末印 r.lines(因停止檔提前結束之摘要句)', () => {
        let src = fs.readFileSync(path.join(FD_ROOT, 'src', 'cli', 'rsi.mjs'), 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
        let block = src.slice(src.indexOf('else if (mode === \'extfill\') {'), src.indexOf('else if (mode === \'fill\') {'))
        assert(block.length > 500)
        assert(/\bstopAtStart\(\)/.test(block), 'extfill: 開始前之檢查')
        assert(/for \(let l of \(r\.lines \|\| \[\]\)\) \{\s*console\.log\(l\)/.test(block), 'extfill: 印摘要句')
        let fillBlock = src.slice(src.indexOf('else if (mode === \'fill\') {'), src.indexOf('else if (mode === \'frontier\') {'))
        assert(/\bstopAtStart\(\)/.test(fillBlock), 'fill: 開始前之檢查')
        //stopAtStart 本身: 離開碼 3 與固定訊息、先於 acquireRunLock
        assert(/let stopAtStart = \(\) => \{\s*if \(stopFileExists\(st\.rsi\.root\)\) \{\s*console\.log\(`未執行: 停止檔 [^`]*存在;刪除後再補算`\)\s*process\.exit\(3\)/.test(src))
        assert(block.indexOf('stopAtStart()') < block.indexOf('acquireRunLock('), 'extfill: 檢查在取鎖之前')
        assert(fillBlock.indexOf('stopAtStart()') < fillBlock.indexOf('acquireRunLock('), 'fill: 檢查在取鎖之前')
    })

    it('輪末之附算(source "round")不檢停止檔(停止檔之語意是跑完本輪後停下, 輪末之附算屬該輪): 停止檔存在亦全數補算、不帶 stopped', async () => {
        let { P, st, runEval } = mk()
        fs.mkdirSync(st.rsi.root, { recursive: true })
        fs.writeFileSync(stopFileOf(st.rsi.root), '', 'utf8')
        let r = await P.fill({ runEval, source: 'round' })
        assert.equal(r.results.length, 3)
        assert.strictEqual(r.stopped, undefined)
        assert(!r.lines.some((l) => l.includes('因停止檔提前結束')))
        assert.equal(fillFilesOf(st).length, 3)
    })

    it('同一檔、同一檢查函數: stopFileOf = 狀態根之直下之 STOP; stopFileExists 隨檔之有無; g_rsi.mjs 與 domain.mjs 皆經 runner.mjs 之函數(原始碼之盤點: 無各自之 "STOP" 字面與 existsSync 之檢查)', () => {
        let root = path.join(t.dir, 'sr')
        fs.mkdirSync(root, { recursive: true })
        assert.equal(STOP_FILE, 'STOP')
        assert.equal(stopFileOf(root), path.join(root, 'STOP'))
        assert.equal(stopFileExists(root), false)
        fs.writeFileSync(stopFileOf(root), '', 'utf8')
        assert.equal(stopFileExists(root), true)
        fs.rmSync(stopFileOf(root))
        assert.equal(stopFileExists(root), false)
        let code = (rel) => fs.readFileSync(path.join(FD_ROOT, rel), 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/.*$/, '')).join('\n')
        for (let rel of ['src/cli/rsi.mjs', 'src/domain/domain.mjs']) {
            let c = code(rel)
            assert(!/'STOP'/.test(c) && !/"STOP"/.test(c), `${rel}: 無各自之 STOP 字面`)
            assert(!/existsSync\(\s*fpStop\s*\)/.test(c), `${rel}: 無各自之 existsSync(fpStop)`)
            assert(/\bstopFileExists\(/.test(c), `${rel}: 經 stopFileExists`)
        }
        //鑑別前提: 同樣之樣式抓得到修前之寫法
        assert(/existsSync\(\s*fpStop\s*\)/.test('if (fs.existsSync(fpStop)) {') && /'STOP'/.test('path.join(st.rsi.root, \'STOP\')'))
    })
})
