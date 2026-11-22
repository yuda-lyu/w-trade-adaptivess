import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { specHash } from '../src/engineApi.mjs'
import * as FP from '../src/domain/fillPlan.mjs'
import * as FK from '../src/domain/fillKeys.mjs'
import { makeTmp } from './tools/synthLedger.mjs'
import { runNodeProc } from '../src/domain/proc.mjs'
import { pathToFileURL, fileURLToPath } from 'url'
import { spawnSync } from 'child_process'


//附算與補算之強健性: 接縫不用替身 —— 真之樹、節點文件、補算檔、共同儲存區與輪末鉤子; 只有評估之執行本身(runEval)為替身
//  位置: 補算檔與完整結果檔在狀態根之 fill/(agent 不可寫之處), 讀取另核 nodeId; 節點工作夾內之同名檔一律不讀
//  攔截: 一個成品之執行整段攔截(轉為該成品之失敗); 全部工作者結束才返回
//  待重試: 帶次數與最後錯誤、逾上限只列不跑; 參數 / 設定(離開碼 2)與須重驗(選集指紋不同)不入待重試
//  重算計畫: 執行後以完整選項對「待重試 ∪ 本次失敗者」重算計畫, 仍有待算者才留
//  心跳: 每完成一個成品呼叫 onEach(命令列以之更新鎖之心跳)
//  狀態檔: 原子寫入; 損毀或遺失(補算夾已有補算檔)時不當作第一次建立(保守: 全部診斷之正本值視為過時), 摘要列出
describe('附算與補算之強健性(位置、攔截、待重試、心跳、狀態檔)', function () {
    this.timeout(60000)
    let t
    beforeEach(() => {
        t = makeTmp('fillRev')
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
        metrics: { selHash: `pf-sel-${k}`, nullSideAct: { p: 0.01 + k / 100, z: 2 + k, excess: 10 + k }, afterFit: { seatsKept: 20 + k, seatsDropped: 5 + k, orders: 100, halves: null } },
    })
    //mk, 暫存夾之專案(同 unit-fillRun): 3 個已執行之節點; 節點 0 之正本缺 dB、節點 1 兩者皆有、節點 2 皆缺
    //  beh(k, kind) → 'ok' | 'fail1'(離開碼 1)| 'fail2'(離開碼 2)| 'badsel' | 'slow'(延遲後成功)
    let mk = (beh = () => 'ok') => {
        let st = getSettings()
        let d = path.join(t.dir, 'proj')
        //資源閘關閉、併行 1(參考設定之資源閘會使工作者等待全機之負載降下, 測試之耗時與成敗隨機器之負載而變)
        //成員穩健性(規則 R-REC-51; 預設開啟)關閉: 本檔之範圍為求解窗後段與擴充診斷(成員穩健性見 unit-memberCheck)
        st.resources = {}
        st.rsi = { ...st.rsi, fillParallel: 1, memberCheck: false }
        st.rsi.root = path.join(d, 'rsi')
        st.rsi.docLimits = false //輪末鉤子之專案文件自動整理(R-REC-17)取本庫自身之 sgud; 測試不得改寫入版控之文件(R-PKG-10)
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthA' }), 'utf8')
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
            fs.writeFileSync(path.join(wd, 'pick.mjs'), `export default function pick(ctx) {\n    return [${k}]\n}\n`, 'utf8')
            fs.writeFileSync(path.join(wd, 'harness_full.json'), JSON.stringify({ ok: true, at: `2026-01-0${k + 1}T00:00:00.000Z`, metrics: { selHash: `sel-${k}` } }), 'utf8')
            let ext = k === 0 ? { dA: { board: 100 } } : (k === 1 ? { dA: { board: 101 }, dB: { board: 201 } } : {})
            let metrics = { selHash: `sel-${k}`, ext, op: { eqYr: { mean: 12.5 + k, min: -1.5 - k, byPhase: [1, 2, 3].map((v) => v + k) }, monthlyOrders: { mean: 90 + k }, peakHold: { max: 30 - k }, winRate: 0.4 } }
            P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round: 1, raw: { metrics, issues: [] }, score: { S: 10 + k, ladder: 3, flags: { vetoed: false, why: [] } } })
            P.records.putNodeDoc({ nodeId: id, round: 1, attempt: 1, status: 'verified', spec, task: { goal: 'g', type: 'explore' }, plan: {}, code: {}, results: { claimed: {} }, conclusion: { outcome: 'improved', summary: `摘要 ${k}` }, harness: { ok: true, summary: [`既有之列 ${k}`], notes: [], checks: { issues: [] }, score: { S: 10 + k, ladder: 3, flags: { vetoed: false, why: [] } }, raw: { metrics } } })
            return id
        })
        let calls = []
        let runEval = async ({ nodeId, kind, args }) => {
            calls.push({ nodeId, kind, args })
            let k = ids.indexOf(nodeId)
            let b = beh(k, kind)
            if (b === 'fail1') {
                return { code: 1, timeout: false }
            }
            if (b === 'fail2') {
                return { code: 2, timeout: false }
            }
            if (b === 'slow') {
                await new Promise((resolve) => setTimeout(resolve, 400))
            }
            if (b === 'timeout') {
                return { code: null, timeout: true }
            }
            let out = argOfA(args, '--out')
            if (b === 'nofile') {
                return { code: 0, timeout: false }
            }
            let code = b === 'code1valid' ? 1 : 0
            //stale: 結果檔之修改時刻設為 1 小時之前(早於本次之起算)
            let age = (fp) => {
                if (b === 'stale') {
                    let past = new Date(Date.now() - 3600000)
                    fs.utimesSync(fp, past, past)
                }
            }
            if (kind === 'postfit') {
                fs.writeFileSync(out, JSON.stringify(pfOf(k)), 'utf8')
                age(out)
                return { code, timeout: false }
            }
            let names = argOfA(args, '--ext-only').split(',')
            fs.writeFileSync(out, JSON.stringify({ ok: true, metrics: { selHash: b === 'badsel' ? 'other' : `sel-${k}`, ext: Object.fromEntries(names.map((nm) => [nm, b === 'extErr' && nm === 'dA' ? { error: 'boom: diag failed' } : { board: `${nm}-${k}-new` }])) } }), 'utf8')
            age(out)
            return { code, timeout: false }
        }
        return { P, st, ids, calls, runEval }
    }
    let fstOf = (st) => JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'fill_state.json'), 'utf8'))
    let tmpLeft = (st) => [st.rsi.root, path.join(st.rsi.root, FP.FILL_DIR)].some((dir) => fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.includes('.tmp-')))
    //validDocOf, 形狀與鍵皆合之補算檔(求解窗後段; 以現況之成品雜湊與評估器之指紋)
    let validDocOf = (st, id, k) => FP.fillDocOf(null, { nodeId: id, at: '2026-02-01T00:00:00.000Z', postfit: { key: { pick: FK.pickHashOf(fs.readFileSync(path.join(st.records.workDir, id, 'pick.mjs'))), evaluator: FK.evaluatorFpOf(st) }, row: FP.postfitRowOf(pfOf(k)) } })

    it('節點工作夾內形狀與鍵皆合之補算檔不讀(計畫照算、共同儲存區不列);狀態根之補算檔之 nodeId 不符者亦不讀;寫入只在狀態根之 fill/', async () => {
        let { P, st, ids, runEval } = mk()
        //工作夾內預先放一份「合格」之補算檔(節點 agent 可寫之處)
        for (let [k, id] of ids.entries()) {
            fs.writeFileSync(path.join(st.records.workDir, id, 'harness_fill.json'), JSON.stringify(validDocOf(st, id, k)), 'utf8')
        }
        assert.deepEqual(P.fillPlanOf({ ext: false }).tasks.map((x) => x.nodeId).sort(), [...ids].sort(), '工作夾內之檔不使其成為現行')
        await P.pickStore()
        let idx0 = JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'picks', 'index.json'), 'utf8'))
        assert(idx0.items.length === 3 && idx0.items.every((x) => !('postfit' in x)), '共同儲存區不讀工作夾內之檔(狀態根無補算檔 ⇒ 無此鍵)')
        //狀態根之補算檔: nodeId 不符者(把節點 0 之檔放到節點 1 之名下)不讀
        fs.mkdirSync(path.join(st.rsi.root, FP.FILL_DIR), { recursive: true })
        fs.writeFileSync(FK.fillFileOf(st.rsi.root, ids[1]), JSON.stringify(validDocOf(st, ids[0], 0)), 'utf8')
        assert.strictEqual(FK.readFill(st.rsi.root, ids[1]), null)
        assert(P.fillPlanOf({ ext: false }).tasks.some((x) => x.nodeId === ids[1]))
        //合格且 nodeId 相符者讀(對照: 讀取之路徑本身可用)
        fs.writeFileSync(FK.fillFileOf(st.rsi.root, ids[1]), JSON.stringify(validDocOf(st, ids[1], 1)), 'utf8')
        assert(!P.fillPlanOf({ ext: false }).tasks.some((x) => x.nodeId === ids[1]))
        //不合之 id(路徑穿越)⇒ null —— 鑑別前提: 穿越所指之處確有一份 nodeId 相符之檔
        fs.writeFileSync(path.join(st.rsi.root, 'x.json'), JSON.stringify({ schema: FP.FILL_SCHEMA, nodeId: '../x', postfit: null, ext: {} }), 'utf8')
        assert.strictEqual(FK.readFill(st.rsi.root, '../x'), null)
        assert.strictEqual(FK.readFill(st.rsi.root, ''), null)
        //實跑: 寫入只在狀態根之 fill/; 工作夾內之檔不動、不覆寫
        let before = ids.map((id) => fs.readFileSync(path.join(st.records.workDir, id, 'harness_fill.json'), 'utf8'))
        await P.fill({ runEval, storeAfter: false })
        ids.forEach((id, k) => {
            assert.equal(fs.readFileSync(path.join(st.records.workDir, id, 'harness_fill.json'), 'utf8'), before[k])
            assert(!fs.existsSync(path.join(st.records.workDir, id, 'harness_postfit.json')))
            assert.equal(JSON.parse(fs.readFileSync(FK.fillFileOf(st.rsi.root, id), 'utf8')).nodeId, id)
            assert(fs.existsSync(FK.postfitFileOf(st.rsi.root, id)) || k === 1)
        })
    })

    it('某成品之寫入失敗 ⇒ 轉為該成品之失敗(入待重試;不拋出);其餘成品照常寫入,慢者亦於返回之前寫完', async () => {
        let { P, st, ids, runEval } = mk((k) => (k === 2 ? 'slow' : 'ok'))
        //節點 1 之補算檔之位置先放一個資料夾 ⇒ 改名失敗
        fs.mkdirSync(FK.fillFileOf(st.rsi.root, ids[1]), { recursive: true })
        let r = await P.fill({ runEval, storeAfter: false, par: 3 })
        assert.equal(r.results.length, 3)
        let by = Object.fromEntries(r.results.map((x) => [x.nodeId, x]))
        assert.equal(by[ids[1]].postfit, 'failed')
        assert(by[ids[1]].error.includes('執行中斷'), by[ids[1]].error)
        assert.equal(by[ids[1]].kind, 'transient')
        assert.deepEqual(r.retry, [ids[1]])
        //慢者(節點 2)於返回之前已寫完
        assert.equal(JSON.parse(fs.readFileSync(FK.fillFileOf(st.rsi.root, ids[2]), 'utf8')).postfit.row.seatsKept, 22)
        assert.equal(JSON.parse(fs.readFileSync(FK.fillFileOf(st.rsi.root, ids[0]), 'utf8')).postfit.row.seatsKept, 20)
        assert.deepEqual(fstOf(st).retry.map((x) => x.id), [ids[1]])
        assert(!tmpLeft(st), '無殘留之暫存檔')
    })

    it('參數 / 設定之失敗(離開碼 2)與須重驗(選集指紋不同)不入待重試而另列;暫時性之失敗累計次數,達上限只列;輪末鉤子不再自動重試達上限者', async () => {
        let { P, st, ids, runEval } = mk((k, kind) => (k === 0 && kind === 'postfit' ? 'fail2' : (k === 2 && kind === 'ext' ? 'badsel' : (k === 1 ? 'fail1' : 'ok'))))
        //節點 0 原在待重試(舊格式)而本次之失敗屬參數 / 設定 ⇒ 移出待重試(鑑別前提: 候選須排除不重試者)
        fs.writeFileSync(path.join(st.rsi.root, 'fill_state.json'), JSON.stringify({ schema: 'arsi.fillState/1', registry: null, retry: [ids[0]] }), 'utf8')
        let r1 = await P.fill({ runEval, storeAfter: false })
        assert.deepEqual(r1.blocked.map((x) => [x.id, x.kind]).sort(), [[ids[0], 'config'], [ids[2], 'reverify']].sort())
        assert.deepEqual(r1.retry, [ids[1]])
        assert(r1.lines.some((l) => l.startsWith('附算之失敗而不重試:') && l.includes(`${ids[0].slice(0, 8)}(參數或設定不合)`) && l.includes(`${ids[2].slice(0, 8)}(須重驗:選集指紋與正本不同)`)), JSON.stringify(r1.lines))
        assert.deepEqual(r1.capped, [])
        //連續失敗: 次數累計, 達上限(3)者列出
        let r2 = await P.fill({ targets: [ids[1]], runEval, storeAfter: false })
        assert.deepEqual(r2.retryInfo.map((x) => [x.id, x.n]), [[ids[1], 2]])
        assert.deepEqual(r2.capped, [])
        let r3 = await P.fill({ targets: [ids[1]], runEval, storeAfter: false })
        assert.deepEqual(r3.retryInfo.map((x) => [x.id, x.n]), [[ids[1], 3]])
        assert.deepEqual(r3.capped, [ids[1]])
        assert(r3.lines.some((l) => l.startsWith('附算之待重試已達上限') && l.includes(ids[1].slice(0, 8))), JSON.stringify(r3.lines))
        assert(fstOf(st).retry[0].last.startsWith('求解窗後段:離開碼 1'))
        //輪末鉤子: 達上限者不入本次之範圍(另一個未達上限之待重試者照入)
        let fst = fstOf(st)
        fs.writeFileSync(path.join(st.rsi.root, 'fill_state.json'), JSON.stringify({ ...fst, retry: [...fst.retry, { id: ids[2], n: 1, last: 'x', source: 'round' }] }), 'utf8')
        let calls = []
        let dispatch = async (role, { prompt }) => {
            let m = /請閱讀 (\S+)\/brief\.md/.exec(prompt)
            let wd = path.resolve(st.FD_ROOT, m[1])
            let tpl = JSON.parse(fs.readFileSync(path.join(wd, 'dream.template.json'), 'utf8'))
            fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify({ audits: tpl.audits.map((a) => ({ nodeId: a.nodeId, trust: 'trusted', action: 'accept', evidence: ['假'], issues: [] })), synthesis: { summary: '假', worked: [], failed: [], patterns: [], prevDirections: [] }, guidance: { directions: [], avoid: [], openQuestions: [], improvements: [], armProposals: [] }, expansion: [], docsUpdated: [] }), 'utf8')
            return { ok: true, agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
        }
        let P2 = makeProject(st, {
            dispatch,
            gate: null,
            catalogFile: path.join(t.dir, 'proj', 'catalog2.json'),
            runEval: async (a) => {
                calls.push(a.nodeId)
                return runEval(a)
            }
        })
        await P2.domain.hooks.afterRound({ round: 1, nodes: [{ id: ids[0], status: 'executed', spec: { arms: ARMS[0], base: null } }] })
        let touched = [...new Set(calls)].sort()
        assert(!touched.includes(ids[1]), '達上限者不自動重試')
        assert(touched.includes(ids[2]) && touched.includes(ids[0]), JSON.stringify(touched))
    })

    it('只做部分項目之執行成功而另一項仍待算者照留;已不需計算之待重試者移除(未在本次之範圍亦然)', async () => {
        let fail = new Set(['0:postfit'])
        let { P, st, ids, runEval } = mk((k, kind) => (fail.has(`${k}:${kind}`) ? 'fail1' : 'ok'))
        let r1 = await P.fill({ targets: [ids[0]], runEval, storeAfter: false })
        assert.deepEqual(r1.retry, [ids[0]])
        assert.deepEqual(r1.results[0].ext.ok, ['dB'], '同一次之擴充診斷照補')
        //只補擴充診斷(postfit: false)而成功(本例無待補之診斷 ⇒ 不執行)⇒ 求解窗後段仍待算 ⇒ 照留
        let r2 = await P.fill({ targets: [ids[0]], postfit: false, runEval, storeAfter: false })
        assert.deepEqual(r2.retry, [ids[0]])
        //求解窗後段修好、另把一個已不需計算之節點(節點 2: 全部補齊)寫入待重試 ⇒ 節點 2 於下一次執行(只跑節點 1)時移除
        fail.clear()
        await P.fill({ targets: [ids[2]], runEval, storeAfter: false })
        let fst = fstOf(st)
        fs.writeFileSync(path.join(st.rsi.root, 'fill_state.json'), JSON.stringify({ ...fst, retry: [...fst.retry, { id: ids[2], n: 2, last: 'x' }] }), 'utf8')
        let r3 = await P.fill({ targets: [ids[1]], runEval, storeAfter: false })
        assert.deepEqual(r3.retry, [ids[0]], '節點 0 仍待算(未在本次之範圍)、節點 2 已不需計算而移除')
        assert.equal(r3.retryInfo[0].n, 1, '未在本次之範圍者沿用其次數')
        let r4 = await P.fill({ targets: [ids[0]], runEval, storeAfter: false })
        assert.deepEqual(r4.retry, [])
    })

    it('每完成一個成品呼叫 onEach 一次(成功與失敗皆然);onEach 拋錯不影響附算', async () => {
        let { P, ids, runEval } = mk((k) => (k === 1 ? 'fail1' : 'ok'))
        let n = 0
        let r = await P.fill({
            runEval,
            storeAfter: false,
            onEach: () => {
                n++
                throw new Error('心跳失敗')
            }
        })
        assert.equal(n, 3)
        assert.equal(r.results.length, 3)
        assert.deepEqual(r.retry, [ids[1]])
    })

    it('狀態檔損毀 ⇒ 不當作第一次建立:全部診斷之正本值視為過時而重補、摘要列出、狀態檔重寫為可讀;遺失(補算夾已有補算檔)亦然;第一次建立照舊;無殘留之暫存檔', async () => {
        let { P, st, ids, runEval } = mk()
        await P.fill({ runEval, storeAfter: false })
        assert.deepEqual(P.fillPlanOf().tasks, [], '補齊之後皆現行')
        assert.equal(fstOf(st).registry.dA.since, null, '第一次建立: since 為 null')
        //損毀
        fs.writeFileSync(path.join(st.rsi.root, 'fill_state.json'), '{"schema": "arsi.fillState/1", "registry": ', 'utf8')
        let p = P.fillPlanOf()
        //節點 0: dA 來自正本(其 dB 有補算檔)⇒ dA 重補; 節點 1: 兩者皆來自正本 ⇒ 皆重補; 節點 2: 兩者皆有補算檔 ⇒ 現行
        assert.deepEqual(p.tasks.map((x) => [ids.indexOf(x.nodeId), x.ext]).sort(), [[0, ['dA']], [1, ['dA', 'dB']]])
        let r = await P.fill({ runEval, storeAfter: false })
        assert(r.lines.includes('附算之狀態檔損毀(無法解析):已以保守方式重建 —— 全部擴充診斷之正本值視為過時而重補;待重試之紀錄遺失'), JSON.stringify(r.lines))
        let f2 = fstOf(st)
        assert(typeof f2.registry.dA.since === 'string' && typeof f2.registry.dB.since === 'string')
        assert.deepEqual(P.fillPlanOf().tasks, [])
        //遺失(補算夾已有補算檔)
        fs.rmSync(path.join(st.rsi.root, 'fill_state.json'))
        let r2 = await P.fill({ targets: [], runEval, storeAfter: false })
        assert(r2.lines.some((l) => l.startsWith('附算之狀態檔遺失(補算夾已有補算檔)')), JSON.stringify(r2.lines))
        assert(typeof fstOf(st).registry.dA.since === 'string' && typeof fstOf(st).registry.dB.since === 'string', '不當作第一次建立(since 非 null)')
        assert(!tmpLeft(st), '無殘留之暫存檔')
        //形狀不合(retry 非陣列)亦視為損毀
        fs.writeFileSync(path.join(st.rsi.root, 'fill_state.json'), JSON.stringify({ schema: 'arsi.fillState/1', registry: {}, retry: 'x' }), 'utf8')
        assert((await P.fill({ targets: [], runEval, storeAfter: false })).lines.some((l) => l.startsWith('附算之狀態檔損毀')))
    })
})


//附算與補算之採信條件與邊界(結果檔須為本次之輸出、診斷之輸出為錯誤、補算註記、子行程起不來、逾時、原子寫入): 接縫同上(只有 runEval 為替身)
describe('附算與補算之採信條件與邊界', function () {
    this.timeout(60000)
    let t
    beforeEach(() => {
        t = makeTmp('fillRev2')
    })
    afterEach(() => {
        t.cleanup()
    })
    //mk2, 與上一組同之夾具(以相同之寫法另組; 只差 beh 之種類與 io)
    let ARMS = [['A01_nt'], ['A01_nt', 'B14_pitKey'], ['B14_pitKey']]
    let argOfA = (args, k) => {
        let i = args.indexOf(k); return i >= 0 ? args[i + 1] : null
    }
    let pfOf = (k) => ({ ok: true, period: { name: 'postfit', start: '2025-04-08T04:00:00', end: '2025-10-06T00:00:00' }, score: null, metrics: { selHash: `pf-sel-${k}`, nullSideAct: { p: 0.01 + k / 100, z: 2 + k, excess: 10 + k }, afterFit: { seatsKept: 20 + k, seatsDropped: 5 + k, orders: 100, halves: null } } })
    let mk2 = (beh = () => 'ok', io = null) => {
        let st = getSettings()
        let d = path.join(t.dir, 'proj')
        st.resources = {}
        st.rsi = { ...st.rsi, fillParallel: 1, memberCheck: false }
        st.rsi.root = path.join(d, 'rsi')
        st.rsi.docLimits = false //輪末鉤子之專案文件自動整理(R-REC-17)取本庫自身之 sgud; 測試不得改寫入版控之文件(R-PKG-10)
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthA' }), 'utf8')
        fs.mkdirSync(path.join(st.records.toolboxDir, 'metrics'), { recursive: true })
        fs.writeFileSync(path.join(st.records.toolboxDir, 'metrics', 'dA.mjs'), 'export default { v: 1 }\n', 'utf8')
        fs.writeFileSync(path.join(st.records.toolboxDir, 'metrics', 'dB.mjs'), 'export default { v: 2 }\n', 'utf8')
        let P = makeProject(st, { dispatch: async () => ({ ok: false, error: 'fake' }), gate: null, catalogFile: path.join(d, 'catalog.json'), ...(io ? { io } : {}) })
        P.rsi.init()
        let ids = ARMS.map((arms, k) => {
            let spec = { arms, base: null }
            let id = P.idOf(spec)
            let wd = path.join(st.records.workDir, id)
            fs.mkdirSync(wd, { recursive: true })
            fs.writeFileSync(path.join(wd, 'pick.mjs'), `export default function pick(ctx) {\n    return [${k}]\n}\n`, 'utf8')
            fs.writeFileSync(path.join(wd, 'harness_full.json'), JSON.stringify({ ok: true, at: `2026-01-0${k + 1}T00:00:00.000Z`, metrics: { selHash: `sel-${k}` } }), 'utf8')
            let ext = k === 0 ? { dA: { board: 100 } } : (k === 1 ? { dA: { board: 101 }, dB: { board: 201 } } : {})
            let metrics = { selHash: `sel-${k}`, ext, op: { eqYr: { mean: 12.5 + k, min: -1.5 - k, byPhase: [1, 2, 3].map((v) => v + k) }, monthlyOrders: { mean: 90 + k }, peakHold: { max: 30 - k }, winRate: 0.4 } }
            P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round: 1, raw: { metrics, issues: [] }, score: { S: 10 + k, ladder: 3, flags: { vetoed: false, why: [] } } })
            P.records.putNodeDoc({ nodeId: id, round: 1, attempt: 1, status: 'verified', spec, task: { goal: 'g', type: 'explore' }, plan: {}, code: {}, results: { claimed: {} }, conclusion: { outcome: 'improved', summary: `摘要 ${k}` }, harness: { ok: true, summary: [`S ${10 + k}`], notes: [], checks: { issues: [] }, score: { S: 10 + k, ladder: 3, flags: { vetoed: false, why: [] } }, raw: { metrics } } })
            return id
        })
        let runEval = async ({ nodeId, kind, args }) => {
            let k = ids.indexOf(nodeId)
            let b = beh(k, kind)
            if (b === 'timeout') {
                return { code: null, timeout: true }
            }
            let out = argOfA(args, '--out')
            if (b === 'nofile') {
                return { code: 0, timeout: false }
            }
            //capital / integrity / pickrun: 評估入口之離開碼 3(持倉超過研究用本金 / 內建物件被改 / 挑選模組執行失敗), 結果檔帶 code
            if (b === 'capital' || b === 'integrity' || b === 'pickrun') {
                fs.writeFileSync(out, JSON.stringify({ ok: false, error: `boom-${b}-${k}`, code: { capital: 'EVAL_UNIT_CAPITAL', integrity: 'EVAL_INTEGRITY', pickrun: 'PICK_RUN' }[b] }), 'utf8')
                return { code: 3, timeout: false }
            }
            let code = b === 'code1valid' ? 1 : 0
            let age = (fp) => {
                if (b === 'stale') {
                    let past = new Date(Date.now() - 3600000)
                    fs.utimesSync(fp, past, past)
                }
            }
            if (kind === 'postfit') {
                fs.writeFileSync(out, JSON.stringify(pfOf(k)), 'utf8')
                age(out)
                return { code, timeout: false }
            }
            let names = argOfA(args, '--ext-only').split(',')
            //extPart: 輸出只含第一個診斷(其餘缺值: 既非物件亦非 { error })
            fs.writeFileSync(out, JSON.stringify({ ok: true, metrics: { selHash: `sel-${k}`, ext: Object.fromEntries(names.filter((nm, i) => !(b === 'extPart' && i > 0)).map((nm) => [nm, b === 'extErr' && nm === 'dA' ? { error: 'boom: diag failed' } : { board: `${nm}-${k}-new` }])) } }), 'utf8')
            age(out)
            return { code, timeout: false }
        }
        return { P, st, ids, runEval }
    }
    let fstOf = (st) => JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'fill_state.json'), 'utf8'))
    let resOf = (r, id) => r.results.find((x) => x.nodeId === id)
    //dreamDispatchOf, 假做夢(依任務書之範本交付; 無方向)
    let dreamDispatchOf = (st) => async (role, { prompt }) => {
        let m = /請閱讀 (\S+)\/brief\.md/.exec(prompt)
        let wd = path.resolve(st.FD_ROOT, m[1])
        let tpl = JSON.parse(fs.readFileSync(path.join(wd, 'dream.template.json'), 'utf8'))
        let dream = { audits: tpl.audits.map((a) => ({ nodeId: a.nodeId, trust: 'trusted', action: 'accept', evidence: ['假審計'], issues: [] })), synthesis: { summary: '假', worked: [], failed: [], patterns: [], prevDirections: [] }, guidance: { directions: [], avoid: [], openQuestions: [], improvements: [], armProposals: [] }, expansion: [], docsUpdated: [] }
        fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify(dream), 'utf8')
        return { ok: true, agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
    }

    it('結果檔須為本次之輸出且離開碼 0 —— 離開碼 1 而寫出合格之結果檔、結果檔早於本次之起算、離開碼 0 而未寫出 ⇒ 該項失敗(不採信、不寫補算檔、入待重試)', async () => {
        for (let b of ['code1valid', 'stale', 'nofile']) {
            t.cleanup()
            t = makeTmp('fillRev2')
            let { P, st, ids, runEval } = mk2((k) => (k === 0 ? b : 'ok'))
            let r = await P.fill({ targets: [ids[0], ids[1]], runEval, storeAfter: false })
            let r0 = resOf(r, ids[0])
            assert.equal(r0.postfit, 'failed', b)
            assert.deepEqual(r0.ext.ok, [], b)
            assert(r0.ext.failed.length > 0, b)
            let why = { code1valid: '離開碼 1', stale: '結果檔不是本次之輸出', nofile: '結果檔不是本次之輸出' }[b]
            assert(r0.error.includes(`求解窗後段:${why}`) && r0.error.includes(`擴充診斷:${why}`), `${b}: ${r0.error}`)
            assert.strictEqual(FK.readFill(st.rsi.root, ids[0]), null, `${b}: 不寫補算檔`)
            assert(!fs.existsSync(FK.postfitFileOf(st.rsi.root, ids[0])), `${b}: 不留完整結果檔`)
            assert.deepEqual(fstOf(st).retry.map((x) => x.id), [ids[0]], b)
            //對照: 同一次之節點 1(離開碼 0、本次之輸出)照常採信
            assert.equal(resOf(r, ids[1]).postfit, 'ok', b)
            assert(FK.readFill(st.rsi.root, ids[1]).postfit)
        }
    })

    it('逾時:求解窗後段與擴充診斷之評估逾時 ⇒ 失敗(訊息「逾時」)、暫時性、入待重試(次數 1)', async () => {
        let { P, st, ids, runEval } = mk2((k) => (k === 2 ? 'timeout' : 'ok'))
        let r = await P.fill({ runEval, storeAfter: false })
        let r2 = resOf(r, ids[2])
        assert.equal(r2.postfit, 'failed')
        assert.equal(r2.kind, 'transient')
        assert(r2.error.includes('求解窗後段:逾時') && r2.error.includes('擴充診斷:逾時'), r2.error)
        assert.deepEqual(fstOf(st).retry, [{ id: ids[2], n: 1, last: r2.error, source: 'cli' }])
    })

    it('擴充診斷之輸出為 { error } ⇒ 該診斷記為失敗、不補入樹與節點文件、不寫入補算檔(不快取);同次之其他診斷照補;入待重試', async () => {
        let { P, st, ids, runEval } = mk2((k) => (k === 1 ? 'extErr' : 'ok'))
        //節點 1 兩個診斷皆強制重算(dA 回 { error }、dB 正常)
        let r = await P.fill({ targets: [ids[1]], force: true, runEval, storeAfter: false })
        let r1 = resOf(r, ids[1])
        assert.deepEqual(r1.ext.ok, ['dB'])
        assert.deepEqual(r1.ext.failed, ['dA'])
        assert(r1.error.includes('擴充診斷:重放之輸出為錯誤:dA(boom: diag failed)'), r1.error)
        let fdoc = FK.readFill(st.rsi.root, ids[1])
        assert(fdoc.ext.dB && !('dA' in fdoc.ext), JSON.stringify(fdoc.ext))
        let n1 = P.rsi.store.getNode(ids[1])
        assert.deepEqual(n1.raw.metrics.ext.dA, { board: 101 }, '樹之 dA 未被 { error } 取代')
        assert.deepEqual(n1.raw.metrics.ext.dB, { board: 'dB-1-new' })
        //節點 1 之 dA 於樹上仍有前值(第一次建立之登錄 ⇒ 正本之值視為現行), 但本次為強制重算(force)而失敗 ⇒ 留在待重試且帶 force(下次重試仍強制重算, 直到成功;
        //  主控裁定 Gitea #178 §7 第 11 點; 原斷言為 [] —— 即該點所指之缺口); dB 已成功 ⇒ 不在 force 內
        assert.deepEqual(fstOf(st).retry, [{ id: ids[1], n: 1, last: '擴充診斷:重放之輸出為錯誤:dA(boom: diag failed)', source: 'cli', force: { ext: ['dA'] } }])
        //節點 2(正本無任何診斷): dA 回 { error } ⇒ 樹與補算檔皆無 dA、仍待算 ⇒ 入待重試; dB 照補
        let { P: P2, st: st2, ids: ids2, runEval: re2 } = (() => {
            t.cleanup()
            t = makeTmp('fillRev2')
            return mk2((k) => (k === 2 ? 'extErr' : 'ok'))
        })()
        let rr = await P2.fill({ targets: [ids2[2]], runEval: re2, storeAfter: false })
        let x2 = resOf(rr, ids2[2])
        assert.deepEqual([x2.ext.ok, x2.ext.failed, x2.postfit], [['dB'], ['dA'], 'ok'])
        let n2 = P2.rsi.store.getNode(ids2[2])
        assert(!('dA' in n2.raw.metrics.ext) && n2.raw.metrics.ext.dB, JSON.stringify(n2.raw.metrics.ext))
        assert(!('dA' in FK.readFill(st2.rsi.root, ids2[2]).ext))
        assert.deepEqual(fstOf(st2).retry.map((x) => [x.id, x.n]), [[ids2[2], 1]])
        assert(P2.fillPlanOf({ targets: [ids2[2]] }).tasks.some((x) => x.nodeId === ids2[2] && x.ext.includes('dA') && !x.ext.includes('dB') && !x.postfit), '未快取: dA 仍待算')
    })

    it('節點文件之補算註記取代同前綴之舊列(不無界成長)', async () => {
        let { P, ids, runEval } = mk2()
        for (let i = 0; i < 3; i++) {
            await P.fill({ targets: [ids[1]], force: true, postfit: false, runEval, storeAfter: false })
        }
        let notes = P.records.getNodeDoc(ids[1]).harness.notes
        assert.equal(notes.filter((s) => /^\(\d{4}-\d{2}-\d{2} 補算擴充診斷:/.test(s)).length, 1, JSON.stringify(notes))
    })

    it('原子寫入:補算檔與狀態檔皆先寫暫存檔(帶行程代號)再改名;不直接寫正式檔', async () => {
        let log = []
        let io = {
            writeFileSync: (fp, ...a) => {
                log.push(['w', path.basename(fp)])
                return fs.writeFileSync(fp, ...a)
            },
            renameSync: (a, b) => {
                log.push(['r', path.basename(a), path.basename(b)])
                return fs.renameSync(a, b)
            },
        }
        let { P, st, ids, runEval } = mk2(() => 'ok', io)
        await P.fill({ runEval, storeAfter: false })
        let tmpOf = (nm) => `${nm}.tmp-${process.pid}`
        for (let nm of ['fill_state.json', ...ids.map((id) => `${id}.json`)]) {
            let iw = log.findIndex((x) => x[0] === 'w' && x[1] === tmpOf(nm))
            let ir = log.findIndex((x) => x[0] === 'r' && x[1] === tmpOf(nm) && x[2] === nm)
            assert(iw >= 0 && ir > iw, `${nm}: ${JSON.stringify(log)}`)
            assert(!log.some((x) => x[0] === 'w' && x[1] === nm), `${nm} 不直接寫`)
        }
        assert(fs.existsSync(path.join(st.rsi.root, 'fill_state.json')))
    })

    it('重驗後節點文件之求解窗後段之列遺失 ⇒ 下一次附算只重寫節點文件補回(不評估、不動補算檔);無須補回者不列', async () => {
        let calls = 0
        let { P, st, ids, runEval } = mk2()
        let re = async (x) => {
            calls++
            return runEval(x)
        }
        await P.fill({ runEval: re, storeAfter: false })
        let d0 = P.records.getNodeDoc(ids[0])
        assert(d0.harness.summary.some((s) => s.startsWith(FP.POSTFIT_HEAD)) && d0.harness.postfit, '附算後節點文件帶此列(鑑別前提)')
        let n0 = calls
        let f0 = fs.readFileSync(FK.fillFileOf(st.rsi.root, ids[0]))
        //模擬重驗: 摘要以新者重寫、harness.postfit 不在
        let d = P.records.getNodeDoc(ids[0])
        d.harness = { ...d.harness, summary: ['S 99(重驗)'] }
        delete d.harness.postfit
        P.records.putNodeDoc(d)
        let r = await P.fill({ runEval: re, storeAfter: false })
        assert.equal(calls, n0, '不評估')
        assert.deepEqual(r.docFixed, [ids[0]])
        assert(r.lines.some((l) => l.startsWith('附算:補回節點文件之求解窗後段之列 1 個')), JSON.stringify(r.lines))
        let d1 = P.records.getNodeDoc(ids[0])
        assert(d1.harness.summary.includes('S 99(重驗)') && d1.harness.summary.some((s) => s.startsWith(FP.POSTFIT_HEAD)), JSON.stringify(d1.harness.summary))
        assert.deepEqual(d1.harness.postfit, FK.readFill(st.rsi.root, ids[0]).postfit)
        assert(fs.readFileSync(FK.fillFileOf(st.rsi.root, ids[0])).equals(f0), '補算檔不動')
        //已一致 ⇒ 不列
        let r2 = await P.fill({ runEval: re, storeAfter: false })
        assert(!('docFixed' in r2) && !r2.lines.some((l) => l.includes('補回節點文件')), JSON.stringify(r2.lines))
    })

    it('評估帳本之 meta.json 讀不到 ⇒ 評估器之指紋拋錯 ⇒ 附算中止(fill 與計畫皆拒絕);共同儲存區照常產生而求解窗後段之欄標為非現行', async () => {
        let { P, st, runEval } = mk2()
        await P.fill({ runEval, storeAfter: false })
        await P.pickStore()
        let idx0 = JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'picks', 'index.json'), 'utf8'))
        assert(idx0.items.length === 3 && idx0.items.every((x) => x.postfit && x.postfit.current === true), `附算後皆現行(鑑別前提):${JSON.stringify(idx0.items.map((x) => [x.id, x.postfit]))}`)
        fs.rmSync(path.join(st.eval.ledgerDir, 'meta.json'))
        let MSG = 'invalid evaluator fingerprint: must read the key of the evaluation ledger (meta.json)'
        assert.throws(() => FK.evaluatorFpOf(st), (e) => e.message === MSG)
        let err = await P.fill({ runEval, storeAfter: false }).then(() => null, (e) => e)
        assert(err && err.message === MSG, String(err && err.message))
        assert.throws(() => P.fillPlanOf(), (e) => e.message === MSG)
        await P.pickStore()
        let idx = JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'picks', 'index.json'), 'utf8'))
        assert(idx.items.length === 3 && idx.items.every((x) => x.postfit && x.postfit.current === false), JSON.stringify(idx.items.map((x) => x.postfit)))
    })

    it('評估器原始碼讀不到 ⇒ 指紋拋錯(不靜默略過;以複製之 fillKeys / fillPlan 於缺檔之目錄結構下載入)', async () => {
        let root = path.join(t.dir, 'fk')
        for (let dd of ['src/domain', 'src/eval', 'src/cli']) {
            fs.mkdirSync(path.join(root, dd), { recursive: true })
        }
        for (let f of ['fillKeys.mjs', 'fillPlan.mjs', 'evalVersion.mjs']) {
            fs.copyFileSync(new URL(`../src/domain/${f}`, import.meta.url), path.join(root, 'src', 'domain', f))
        }
        fs.writeFileSync(path.join(root, 'src', 'eval', 'a.mjs'), 'export default 1\n', 'utf8')
        let FKc = await import(pathToFileURL(path.join(root, 'src', 'domain', 'fillKeys.mjs')).href)
        //cli/eval.mjs 不在 ⇒ 拋錯
        assert.throws(() => FKc.evaluatorFpOf({}), (e) => e.message === 'invalid evaluator fingerprint: must read the evaluator source (cli/eval.mjs)')
        //補上 ⇒ 可算(對照: 此結構本身可用)
        fs.writeFileSync(path.join(root, 'src', 'cli', 'eval.mjs'), 'export default 2\n', 'utf8')
        assert(/^ev-[0-9a-f]{20}$/.test(FKc.evaluatorFpOf({})))
        //eval/ 不在 ⇒ 拋錯
        fs.rmSync(path.join(root, 'src', 'eval'), { recursive: true, force: true })
        assert.throws(() => FKc.evaluatorFpOf({}), (e) => e.message === 'invalid evaluator fingerprint: must read the evaluator source (eval/)')
    })

    it('狀態根無補算檔 ⇒ 共同儲存區不帶 postfit 之鍵與欄位定義(與未加入本功能時相同);有補算檔後才帶(無值者為 null);無待算時狀態檔不改寫', async () => {
        let { P, st, ids, runEval } = mk2()
        let rd = () => JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'picks', 'index.json'), 'utf8'))
        await P.pickStore()
        let idx0 = rd()
        assert(idx0.items.length === 3 && idx0.items.every((x) => !('postfit' in x)), '無補算檔 ⇒ 無此鍵')
        assert(!idx0.fields.some((f) => f.key.startsWith('postfit.')))
        assert(!fs.readFileSync(path.join(st.rsi.root, 'picks', 'README.md'), 'utf8').includes('`postfit.'))
        //只附算節點 0 ⇒ 有補算檔: 全部之列帶此鍵(節點 1、2 為 null)、位於 ext 與 holdout 之間; 欄位定義與 README 列之
        await P.fill({ targets: [ids[0]], runEval, storeAfter: false })
        await P.pickStore()
        let idx1 = rd()
        let by = Object.fromEntries(idx1.items.map((x) => [x.id, x]))
        assert(by[ids[0]].postfit && by[ids[0]].postfit.current === true)
        assert.strictEqual(by[ids[1]].postfit, null)
        let keys = Object.keys(by[ids[0]])
        assert(keys.indexOf('postfit') === keys.indexOf('ext') + 1 && keys.indexOf('holdout') === keys.indexOf('postfit') + 1, JSON.stringify(keys))
        assert(idx1.fields.some((f) => f.key.startsWith('postfit.')))
        assert(fs.readFileSync(path.join(st.rsi.root, 'picks', 'README.md'), 'utf8').includes('`postfit.'))
        //補齊後無待算 ⇒ 狀態檔不改寫(位元組與修改時刻皆不變)
        await P.fill({ runEval, storeAfter: false })
        let fp = path.join(st.rsi.root, 'fill_state.json')
        let b0 = fs.readFileSync(fp)
        let m0 = fs.statSync(fp).mtimeMs
        await new Promise((resolve) => setTimeout(resolve, 50))
        let r = await P.fill({ runEval, storeAfter: false })
        assert.equal(r.results.length, 0)
        assert(fs.readFileSync(fp).equals(b0) && fs.statSync(fp).mtimeMs === m0, '不改寫')
    })

    it('輪末鉤子於無任何作為(全部現行、無待重試)時不帶 fill、不列附算之摘要;做夢未交付時不附算(不評估)', async () => {
        let { P, st, ids, runEval } = mk2()
        await P.fill({ runEval, storeAfter: false })
        let calls = 0
        let kinds = []
        let re = async (x) => {
            calls++
            kinds.push(x.kind)
            return runEval(x)
        }
        let dispatchOf = (ok) => async (role, { prompt }) => {
            if (!ok) {
                return { ok: false, error: '假: 做夢未交付' }
            }
            let m = /請閱讀 (\S+)\/brief\.md/.exec(prompt)
            let wd = path.resolve(st.FD_ROOT, m[1])
            let tpl = JSON.parse(fs.readFileSync(path.join(wd, 'dream.template.json'), 'utf8'))
            let dream = { audits: tpl.audits.map((a) => ({ nodeId: a.nodeId, trust: 'trusted', action: 'accept', evidence: ['假審計'], issues: [] })), synthesis: { summary: '假', worked: [], failed: [], patterns: [], prevDirections: [] }, guidance: { directions: [], avoid: [], openQuestions: [], improvements: [], armProposals: [] }, expansion: [], docsUpdated: [] }
            fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify(dream), 'utf8')
            return { ok: true, agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
        }
        //全部現行 ⇒ 不評估、不帶 fill、無附算之列
        let P1 = makeProject(st, { dispatch: dispatchOf(true), gate: null, catalogFile: path.join(t.dir, 'proj', 'catalogH1.json'), runEval: re })
        let hk = await P1.domain.hooks.afterRound({ round: 1, nodes: [{ id: ids[0], status: 'executed', spec: { arms: ARMS[0], base: null } }] })
        assert(hk.dream && hk.dream.round === 1, '做夢照常套用(鑑別前提)')
        assert.equal(calls, 0)
        assert.equal('fill' in hk, false, JSON.stringify(hk.fill))
        assert(!hk.lines.some((l) => l.startsWith('附算') || l.startsWith('待補算')), JSON.stringify(hk.lines))
        //做夢未交付(時點: 規則 R-REC-51; 原載「不附算(不評估)」隨求解窗後段之時點移到派做夢之前而改): 派做夢之前之一次照常執行(本輪之節點之求解窗後段; 其結果寫入,
        //  補做夢時現行者不重算), 做夢之後之一次(擴充診斷等)不執行 —— 使節點 0 兩項皆待算: 成品改動(求解窗後段)、診斷改寫(擴充診斷)
        fs.appendFileSync(path.join(st.records.workDir, ids[0], 'pick.mjs'), '// v2\n', 'utf8')
        fs.writeFileSync(path.join(st.records.toolboxDir, 'metrics', 'dA.mjs'), 'export default { v: 11 }\n', 'utf8')
        let P2 = makeProject(st, { dispatch: dispatchOf(false), gate: null, catalogFile: path.join(t.dir, 'proj', 'catalogH2.json'), runEval: re })
        assert(P2.fillPlanOf().tasks.some((x) => x.nodeId === ids[0] && x.postfit && x.ext.length > 0), '節點 0 兩項皆待算(鑑別前提)')
        let hk2 = await P2.domain.hooks.afterRound({ round: 2, nodes: [{ id: ids[0], status: 'executed', spec: { arms: ARMS[0], base: null } }] })
        assert(!hk2.dream, '做夢未交付(鑑別前提)')
        assert.deepEqual(kinds, ['postfit'], '只執行派做夢之前之一次(求解窗後段)')
        assert.deepEqual(hk2.fill, { preDream: { n: 1, failed: 0, sec: hk2.fill.preDream.sec } })
        assert(P2.fillPlanOf().tasks.some((x) => x.nodeId === ids[0] && !x.postfit && x.ext.length > 0), '擴充診斷仍待算(做夢之後之一次未執行)')
    })

    it('附算之值記正本之選集指紋與時刻;正本重算而指紋改變 ⇒ 該成品之求解窗後段須重算、共同儲存區標為非現行;重算後恢復現行', async () => {
        let { P, st, ids, runEval } = mk2()
        await P.fill({ runEval, storeAfter: false })
        let f0 = FK.readFill(st.rsi.root, ids[0])
        assert.deepEqual(f0.postfit.canon, { selHash: 'sel-0', at: '2026-01-01T00:00:00.000Z' })
        assert.deepEqual(P.fillPlanOf().tasks, [], '附算後皆現行(鑑別前提)')
        //模擬正本重算(選集指紋改變; 成品與評估器不變)
        P.rsi.store.updateNode(ids[0], (x) => {
            x.raw = { ...x.raw, metrics: { ...x.raw.metrics, selHash: 'sel-0b' } }
        })
        let d = P.records.getNodeDoc(ids[0])
        d.harness = { ...d.harness, raw: { ...d.harness.raw, metrics: { ...d.harness.raw.metrics, selHash: 'sel-0b' } } }
        P.records.putNodeDoc(d)
        assert.deepEqual(P.fillPlanOf({ ext: false }).tasks.map((x) => [x.nodeId, x.postfit]), [[ids[0], true]])
        await P.pickStore()
        let idx = JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'picks', 'index.json'), 'utf8'))
        assert.equal(idx.items.find((x) => x.id === ids[0]).postfit.current, false)
        assert(idx.items.filter((x) => x.id !== ids[0]).every((x) => x.postfit.current === true))
        //重算後恢復現行
        await P.fill({ targets: [ids[0]], ext: false, runEval, storeAfter: false })
        assert.equal(FK.readFill(st.rsi.root, ids[0]).postfit.canon.selHash, 'sel-0b')
        assert.deepEqual(P.fillPlanOf({ ext: false }).tasks, [])
    })

    it('以縮減之虛無抽數補算擴充診斷 ⇒ 補算檔之鍵帶 nulls(與未縮減者區分);評估之參數帶 --null', async () => {
        let seen = []
        let { P, st, ids, runEval } = mk2()
        let re = async (x) => {
            seen.push(x.args)
            return runEval(x)
        }
        await P.fill({ targets: [ids[1]], force: true, postfit: false, nullDraws: 8, runEval: re, storeAfter: false })
        let f1 = FK.readFill(st.rsi.root, ids[1])
        assert.equal(f1.ext.dA.key.nulls, 8)
        assert.equal(f1.ext.dB.key.nulls, 8)
        assert(seen.length === 1 && seen[0].includes('--null') && seen[0][seen[0].indexOf('--null') + 1] === '8', JSON.stringify(seen))
        //未縮減者之鍵無 nulls
        await P.fill({ targets: [ids[0]], force: true, postfit: false, runEval: re, storeAfter: false })
        assert(!('nulls' in FK.readFill(st.rsi.root, ids[0]).ext.dA.key))
    })

    it('研究用本金(R-EV-43)併入評估器之指紋:本金改變 ⇒ 指紋改變、求解窗後段全部過時;未開啟基礎單位者不併入;meta.unit 之其他欄不併入、形狀不合者不拋錯', async () => {
        let { P, st, ids, runEval } = mk2()
        let fpMeta = path.join(st.eval.ledgerDir, 'meta.json')
        let rule = { stepSize: 0.001, minQty: 0.001, minNotional: 20 }
        let fpOf = (unit) => {
            fs.writeFileSync(fpMeta, JSON.stringify({ key: 'synthA', ...(unit === undefined ? {} : { unit }) }), 'utf8')
            return FK.evaluatorFpOf(st)
        }
        let f0 = fpOf(undefined)
        let f1 = fpOf({ rule, buffer: 0.1, uIni: 10000 })
        assert.notEqual(f1, f0, '開啟基礎單位 ⇒ 併入本金')
        assert.notEqual(fpOf({ rule, buffer: 0.1, uIni: 20000 }), f1, '本金改變 ⇒ 指紋改變')
        assert.equal(fpOf({ rule, buffer: 0.2, uIni: 10000 }), f1, '本金以外之欄不併入(已由帳本鍵涵蓋)')
        assert.equal(fpOf(null), f0, 'unit 為 null ⇒ 未開啟')
        assert.equal(fpOf({ rule }), f0, '無本金之欄 ⇒ 不併入')
        assert.equal(fpOf(5), f0, 'meta.unit 非物件 ⇒ 不併入、不拋錯')
        assert.equal(fpOf([1]), f0, 'meta.unit 為陣列 ⇒ 不併入、不拋錯')
        //接線: 附算後皆現行(鑑別前提)→ 本金改變 ⇒ 全部成品之求解窗後段須重算
        fpOf({ rule, buffer: 0.1, uIni: 10000 })
        await P.fill({ runEval, storeAfter: false })
        assert.deepEqual(P.fillPlanOf({ ext: false }).tasks, [], '附算後皆現行(鑑別前提)')
        fpOf({ rule, buffer: 0.1, uIni: 20000 })
        assert.deepEqual(P.fillPlanOf({ ext: false }).tasks.map((x) => x.nodeId).sort(), [...ids].sort())
    })

    it('持倉超過研究用本金(離開碼 3 + EVAL_UNIT_CAPITAL)⇒ 不入待重試、另列;同為離開碼 3 之挑選模組執行失敗(PICK_RUN)照舊為暫時性', async () => {
        let { P, st, ids, runEval } = mk2((k) => (k === 0 ? 'capital' : (k === 2 ? 'pickrun' : 'ok')))
        let r = await P.fill({ runEval, storeAfter: false })
        let r0 = resOf(r, ids[0])
        assert.equal(r0.kind, 'capital')
        assert.equal(r0.postfit, 'failed')
        assert(r0.error.includes('求解窗後段:boom-capital-0') && r0.error.includes('擴充診斷:boom-capital-0'), r0.error)
        assert.deepEqual(r.blocked.map((x) => [x.id, x.kind]), [[ids[0], 'capital']])
        assert(r.lines.some((l) => l.startsWith('附算之失敗而不重試:') && l.includes(`${ids[0].slice(0, 8)}(持倉超過研究用本金)`)), JSON.stringify(r.lines))
        assert.strictEqual(FK.readFill(st.rsi.root, ids[0]), null, '不寫補算檔')
        //對照: 同一離開碼之 PICK_RUN 為暫時性(依結果檔之 code 分辨, 不是依離開碼)
        assert.equal(resOf(r, ids[2]).kind, 'transient')
        assert.deepEqual(fstOf(st).retry.map((x) => x.id), [ids[2]])
        //原在待重試者本次為本金之失敗 ⇒ 移出待重試
        fs.writeFileSync(path.join(st.rsi.root, 'fill_state.json'), JSON.stringify({ ...fstOf(st), retry: [{ id: ids[0], n: 2, last: 'x' }] }), 'utf8')
        let r2 = await P.fill({ targets: [ids[0]], runEval, storeAfter: false })
        assert.deepEqual(r2.retry, [])
        assert.deepEqual(fstOf(st).retry, [])
    })

    it('本輪無節點 ⇒ 不附算(不評估、不寫補算檔);只做夢輪次只處理待重試者,其餘只列待補算', async () => {
        let { P, st, ids, runEval } = mk2()
        //本案為「輪末不處理待補算」(settings.rsi.fillBacklogSec = 0; 規則 R-REC-41 之關閉 = 改前之行為); 只做夢輪次一併處理待補算之情形見 unit-fillBacklog
        st.rsi = { ...st.rsi, fillBacklogSec: 0 }
        assert.equal(P.fillPlanOf().tasks.length, 3, '三個成品皆待算(鑑別前提)')
        let seen = []
        let re = async (x) => {
            seen.push(x.nodeId)
            return runEval(x)
        }
        //無節點、無要求 ⇒ 略過做夢, 亦不附算
        let P1 = makeProject(st, { dispatch: dreamDispatchOf(st), gate: null, catalogFile: path.join(t.dir, 'proj', 'catalogN1.json'), runEval: re })
        let hk1 = await P1.domain.hooks.afterRound({ round: 1, nodes: [] })
        assert.strictEqual(hk1.dream, null, '略過做夢(鑑別前提)')
        assert.deepEqual(seen, [])
        assert.equal('fill' in hk1, false)
        assert(!fs.existsSync(path.join(st.rsi.root, FP.FILL_DIR)), '不寫補算夾')
        assert(!fs.existsSync(path.join(st.rsi.root, 'fill_state.json')), '不寫狀態檔')
        //只做夢輪次、無待重試 ⇒ 不評估, 全部列為待補算
        let P2 = makeProject(st, { dispatch: dreamDispatchOf(st), gate: null, catalogFile: path.join(t.dir, 'proj', 'catalogN2.json'), runEval: re })
        P2.requestDreamOnly({ why: '只做夢' })
        let hk2 = await P2.domain.hooks.afterRound({ round: 2, nodes: [] })
        assert(hk2.dream && hk2.dream.dreamOnly === true, '只做夢輪次(鑑別前提)')
        assert.deepEqual(seen, [])
        assert.equal(hk2.fill.n, 0)
        assert.equal(hk2.fill.backlog.postfit, 3)
        //只做夢輪次、有待重試者 ⇒ 只評估待重試者
        fs.writeFileSync(path.join(st.rsi.root, 'fill_state.json'), JSON.stringify({ ...fstOf(st), retry: [{ id: ids[1], n: 1, last: 'x', source: 'round' }] }), 'utf8')
        let P3 = makeProject(st, { dispatch: dreamDispatchOf(st), gate: null, catalogFile: path.join(t.dir, 'proj', 'catalogN3.json'), runEval: re })
        P3.requestDreamOnly({ why: '只做夢' })
        let hk3 = await P3.domain.hooks.afterRound({ round: 3, nodes: [] })
        assert.deepEqual([...new Set(seen)], [ids[1]])
        assert.equal(hk3.fill.n, 1)
        assert.equal(hk3.fill.backlog.postfit, 2)
    })

    it('殘留暫存檔 + 評估未寫檔 ⇒ 不採信殘留之檔(該項失敗、不寫補算檔、入待重試、殘留之檔移除)', async () => {
        let { P, st, ids, runEval } = mk2((k) => (k === 0 ? 'nofile' : 'ok'))
        let dir = path.join(st.rsi.root, FP.FILL_DIR)
        fs.mkdirSync(dir, { recursive: true })
        //殘留之暫存檔: 內容合格、修改時刻在本次起算之後(只憑修改時刻擋不下; 鑑別前提)
        let fpP = path.join(dir, `${ids[0]}.postfit.tmp-${process.pid}.json`)
        let fpE = path.join(dir, `${ids[0]}.extfill.tmp-${process.pid}.json`)
        fs.writeFileSync(fpP, JSON.stringify(pfOf(0)), 'utf8')
        fs.writeFileSync(fpE, JSON.stringify({ ok: true, metrics: { selHash: 'sel-0', ext: { dB: { board: 'stale-value' } } } }), 'utf8')
        let future = new Date(Date.now() + 60000)
        fs.utimesSync(fpP, future, future)
        fs.utimesSync(fpE, future, future)
        let r = await P.fill({ targets: [ids[0]], runEval, storeAfter: false })
        let r0 = resOf(r, ids[0])
        assert.equal(r0.postfit, 'failed')
        assert.deepEqual(r0.ext, { ok: [], failed: ['dB'] })
        assert(r0.error.includes('求解窗後段:結果檔不是本次之輸出') && r0.error.includes('擴充診斷:結果檔不是本次之輸出'), r0.error)
        assert.strictEqual(FK.readFill(st.rsi.root, ids[0]), null, '不寫補算檔')
        assert(!fs.existsSync(FK.postfitFileOf(st.rsi.root, ids[0])), '不留完整結果檔')
        assert.equal(P.rsi.store.getNode(ids[0]).raw.metrics.ext.dB, undefined, '殘留之值不併入樹')
        assert.deepEqual(fstOf(st).retry.map((x) => x.id), [ids[0]])
        assert(!fs.existsSync(fpP) && !fs.existsSync(fpE), '殘留之暫存檔已移除')
    })

    it('extFill 之回傳:既有之欄皆保留(names、nNodes、results 之 nodeId / ok / filled / board 與 nodeId / ok / error);只增不減;結果依節點 id 排序', async () => {
        let { P, ids, runEval } = mk2((k) => (k === 2 ? 'code1valid' : 'ok'))
        let r = await P.extFill({ names: ['dA', 'dB'], runEval })
        assert.deepEqual(r.names, ['dA', 'dB'])
        assert.equal(r.nNodes, 3)
        //節點 1 兩者皆有 ⇒ 不列(同舊版: results 只列有待補者); 節點 0 缺 dB、節點 2 皆缺
        assert.deepEqual(r.results.map((x) => x.nodeId), [ids[0], ids[2]].sort())
        let ok0 = r.results.find((x) => x.nodeId === ids[0])
        assert.deepEqual(Object.keys(ok0).sort(), ['board', 'filled', 'nodeId', 'ok'])
        assert.deepEqual([ok0.ok, ok0.filled], [true, ['dB']])
        assert.equal(typeof ok0.board, 'string')
        let bad2 = r.results.find((x) => x.nodeId === ids[2])
        assert.deepEqual(Object.keys(bad2).sort(), ['error', 'nodeId', 'ok'])
        assert.equal(bad2.ok, false)
        assert(bad2.error.includes('離開碼 1'), bad2.error)
        //多出之欄: store(補算後重產共同儲存區之結果)
        assert.deepEqual(Object.keys(r).sort(), ['nNodes', 'names', 'results', 'store'])
        assert.equal(r.store.ok, true)
    })

    it('寫入之序:併入樹失敗 ⇒ 補算檔不寫、該成品仍待算且留在待重試(樹上之舊值不被判為現行);修好後重算即併入', async () => {
        let { P, st, ids, runEval } = mk2()
        await P.fill({ runEval, storeAfter: false })
        fs.writeFileSync(path.join(st.records.toolboxDir, 'metrics', 'dA.mjs'), 'export default { v: 99 }\n', 'utf8')
        assert(P.fillPlanOf({ postfit: false, targets: [ids[1]] }).tasks.some((x) => x.nodeId === ids[1] && x.ext.includes('dA')), '診斷改寫 ⇒ 節點 1 之 dA 過時(鑑別前提)')
        let store = P.rsi.store
        let orig = store.updateNode
        store.updateNode = function (id, fn) {
            if (id === ids[1]) {
                throw new Error('EBUSY: simulated')
            }
            return orig.call(this, id, fn)
        }
        let r = await P.fill({ targets: [ids[1]], postfit: false, runEval, storeAfter: false })
        store.updateNode = orig
        assert.equal(resOf(r, ids[1]).kind, 'transient')
        assert.deepEqual(P.rsi.store.getNode(ids[1]).raw.metrics.ext.dA, { board: 101 }, '樹上仍為舊值')
        assert.strictEqual((FK.readFill(st.rsi.root, ids[1]) || { ext: {} }).ext.dA, undefined, '補算檔不寫此值')
        assert.deepEqual(r.retry, [ids[1]], '留在待重試')
        assert(P.fillPlanOf({ postfit: false }).tasks.some((x) => x.nodeId === ids[1] && x.ext.includes('dA')), '仍待算')
        let r2 = await P.fill({ targets: [ids[1]], postfit: false, runEval, storeAfter: false })
        assert.deepEqual(P.rsi.store.getNode(ids[1]).raw.metrics.ext.dA, { board: 'dA-1-new' })
        assert.equal(FK.readFill(st.rsi.root, ids[1]).ext.dA.value.board, 'dA-1-new')
        assert.deepEqual(r2.retry, [])
    })

    it('寫入之序:節點文件寫入失敗 ⇒ 樹仍為舊值、補算檔不寫、仍待算(不致樹為新值而節點文件永留舊值)', async () => {
        let { P, st, ids, runEval } = mk2()
        await P.fill({ runEval, storeAfter: false })
        fs.writeFileSync(path.join(st.records.toolboxDir, 'metrics', 'dA.mjs'), 'export default { v: 98 }\n', 'utf8')
        let orig = P.records.putNodeDoc
        P.records.putNodeDoc = function (d) {
            if (d.nodeId === ids[1]) {
                throw new Error('EBUSY: simulated doc')
            }
            return orig.call(this, d)
        }
        let r = await P.fill({ targets: [ids[1]], postfit: false, runEval, storeAfter: false })
        P.records.putNodeDoc = orig
        assert.equal(resOf(r, ids[1]).kind, 'transient')
        assert.deepEqual(P.rsi.store.getNode(ids[1]).raw.metrics.ext.dA, { board: 101 }, '樹未先於節點文件更新')
        assert.deepEqual(r.retry, [ids[1]])
        await P.fill({ targets: [ids[1]], postfit: false, runEval, storeAfter: false })
        assert.deepEqual(P.records.getNodeDoc(ids[1]).harness.raw.metrics.ext.dA, { board: 'dA-1-new' }, '修好後節點文件與樹一致')
        assert.deepEqual(P.rsi.store.getNode(ids[1]).raw.metrics.ext.dA, { board: 'dA-1-new' })
    })

    it('寫入之序(反向):已併入而補算檔未寫成 ⇒ 值未遺失、留在待重試;下一次重算一次、結果相同且補算檔寫成', async () => {
        let blockName = null
        let io = {
            writeFileSync: (...a) => fs.writeFileSync(...a),
            renameSync: (a, b) => {
                if (blockName && path.basename(b) === blockName) {
                    throw Object.assign(new Error('EBUSY: simulated fill file'), { code: 'EBUSY' })
                }
                return fs.renameSync(a, b)
            },
        }
        let n = 0
        let { P, st, ids, runEval } = mk2(() => 'ok', io)
        let re = async (x) => {
            n++
            return runEval(x)
        }
        await P.fill({ runEval: re, storeAfter: false })
        //擴充診斷
        fs.writeFileSync(path.join(st.records.toolboxDir, 'metrics', 'dA.mjs'), 'export default { v: 97 }\n', 'utf8')
        blockName = `${ids[1]}.json`
        let r = await P.fill({ targets: [ids[1]], postfit: false, runEval: re, storeAfter: false })
        blockName = null
        assert.equal(resOf(r, ids[1]).kind, 'transient')
        assert.deepEqual(P.rsi.store.getNode(ids[1]).raw.metrics.ext.dA, { board: 'dA-1-new' }, '值已併入樹(未遺失)')
        assert.strictEqual(FK.readFill(st.rsi.root, ids[1]).ext.dA, undefined, '補算檔未寫成(鑑別前提)')
        assert.deepEqual(r.retry, [ids[1]], '留在待重試')
        let n0 = n
        let r2 = await P.fill({ targets: [ids[1]], postfit: false, runEval: re, storeAfter: false })
        assert.equal(n - n0, 1, '重算一次')
        assert.deepEqual(P.rsi.store.getNode(ids[1]).raw.metrics.ext.dA, { board: 'dA-1-new' }, '結果相同')
        assert.equal(FK.readFill(st.rsi.root, ids[1]).ext.dA.value.board, 'dA-1-new', '補算檔已寫成')
        assert.deepEqual(r2.retry, [])
        //求解窗後段: 節點文件已有此段之值而補算檔未寫成 ⇒ 仍待算; 下一次重算後補算檔寫成
        fs.appendFileSync(path.join(st.records.workDir, ids[2], 'pick.mjs'), '// v2\n', 'utf8')
        blockName = `${ids[2]}.json`
        let r3 = await P.fill({ targets: [ids[2]], ext: false, runEval: re, storeAfter: false })
        blockName = null
        assert.equal(resOf(r3, ids[2]).kind, 'transient')
        assert.equal(P.records.getNodeDoc(ids[2]).harness.postfit.row.seatsKept, 22, '節點文件已有此段之值')
        assert(P.fillPlanOf({ ext: false }).tasks.some((x) => x.nodeId === ids[2] && x.postfit), '仍待算')
        await P.fill({ targets: [ids[2]], ext: false, runEval: re, storeAfter: false })
        assert.equal(FK.readFill(st.rsi.root, ids[2]).postfit.key.pick, FK.pickHashOf(fs.readFileSync(path.join(st.records.workDir, ids[2], 'pick.mjs'))))
    })

    it('待重試之來源:命令列之失敗 ⇒ 輪末不自動重試、只列於待補算;輪末之失敗 ⇒ 下一次輪末重試;無來源之舊紀錄視為命令列;再執行補算工具時照重試', async () => {
        let bad = new Set([0, 1, 2])
        let { P, st, ids, runEval } = mk2((k) => (bad.has(k) ? 'timeout' : 'ok'))
        let r0 = await P.fill({ runEval, storeAfter: false })
        assert.deepEqual([...r0.retry].sort(), [...ids].sort(), '命令列之全樹失敗(鑑別前提)')
        assert(fstOf(st).retry.every((x) => x.source === 'cli'), JSON.stringify(fstOf(st).retry))
        assert(r0.lines[0].includes('失敗者(再執行補算工具時重試)'), r0.lines[0])
        bad.clear()
        let seen = []
        let hookOf = (round, id, name) => makeProject(st, {
            dispatch: dreamDispatchOf(st),
            gate: null,
            catalogFile: path.join(t.dir, 'proj', `cat${name}.json`),
            runEval: async (a) => {
                seen.push(a.nodeId)
                return runEval(a)
            },
        }).domain.hooks.afterRound({ round, nodes: [{ id, status: 'executed', spec: { arms: ARMS[ids.indexOf(id)], base: null } }] })
        //輪末: 只算本輪之節點; 命令列留下之兩個成品不重試、只列於待補算
        let hk1 = await hookOf(1, ids[0], 'rA')
        assert.deepEqual([...new Set(seen)], [ids[0]])
        assert.equal(hk1.fill.backlog.postfit, 2)
        assert(hk1.lines.some((l) => l.startsWith('待補算之成品') && l.includes('求解窗後段 2 個')), JSON.stringify(hk1.lines))
        //輪末摘要另列「來源為命令列之待重試」之個數(Gitea #178 §7 第 12 點之主控裁定)
        let cliLine = (hk) => hk.lines.filter((l) => l.startsWith('待重試而來源為命令列者 ')).join('|')
        assert.equal(cliLine(hk1), '待重試而來源為命令列者 2 個(輪末不自動重試;以 `node g_rsi.mjs --mode fill` 重試)', JSON.stringify(hk1.lines))
        assert.deepEqual(fstOf(st).retry.map((x) => [x.id, x.source]).sort(), [[ids[1], 'cli'], [ids[2], 'cli']].sort(), '命令列之紀錄照留')
        //輪末之失敗 ⇒ 來源改記輪末, 下一次輪末自動重試; 命令列之紀錄仍不重試
        bad.add(1)
        seen.length = 0
        let hk2 = await hookOf(2, ids[1], 'rB')
        assert(hk2.lines.some((l) => l.includes('失敗者(下一次輪末重試)')), JSON.stringify(hk2.lines))
        assert.equal(fstOf(st).retry.find((x) => x.id === ids[1]).source, 'round')
        assert(cliLine(hk2).startsWith('待重試而來源為命令列者 1 個('), `來源改記輪末者不計: ${JSON.stringify(hk2.lines)}`)
        bad.clear()
        seen.length = 0
        let hk3 = await hookOf(3, ids[0], 'rC')
        assert(seen.includes(ids[1]), '來源為輪末者自動重試')
        assert(!seen.includes(ids[2]), '來源為命令列者不重試')
        assert(cliLine(hk3).startsWith('待重試而來源為命令列者 1 個('), `重試成功者移除、命令列者照列: ${JSON.stringify(hk3.lines)}`)
        //無來源之舊紀錄(物件與字串兩種舊格式)視為命令列
        fs.writeFileSync(path.join(st.rsi.root, 'fill_state.json'), JSON.stringify({ ...fstOf(st), retry: [{ id: ids[2], n: 1, last: 'x' }] }), 'utf8')
        seen.length = 0
        let hk4 = await hookOf(4, ids[0], 'rD')
        assert(!seen.includes(ids[2]), '物件之舊格式')
        assert(cliLine(hk4).startsWith('待重試而來源為命令列者 1 個('), `無來源欄之舊紀錄視為命令列而計入: ${JSON.stringify(hk4.lines)}`)
        fs.writeFileSync(path.join(st.rsi.root, 'fill_state.json'), JSON.stringify({ ...fstOf(st), retry: [ids[2]] }), 'utf8')
        seen.length = 0
        let hk5 = await hookOf(5, ids[0], 'rE')
        assert(!seen.includes(ids[2]), '字串之舊格式')
        assert(cliLine(hk5).startsWith('待重試而來源為命令列者 1 個('), `字串之舊格式同: ${JSON.stringify(hk5.lines)}`)
        //再執行補算工具 ⇒ 照重試
        let r9 = await P.fill({ runEval, storeAfter: false })
        assert(r9.results.some((x) => x.nodeId === ids[2] && x.postfit === 'ok'))
        assert.deepEqual(r9.retry, [])
    })

    it('狀態檔未寫成 ⇒ 不拋出:已算之結果照常回傳、補算檔與共同儲存區照常;回傳與摘要如實;輪末之 fill 帶 stateError', async () => {
        let io = {
            writeFileSync: (...a) => fs.writeFileSync(...a),
            renameSync: (a, b) => {
                if (path.basename(b) === 'fill_state.json') {
                    throw Object.assign(new Error('EPERM: simulated state file'), { code: 'EPERM' })
                }
                return fs.renameSync(a, b)
            },
        }
        let { P, st, ids, runEval } = mk2(() => 'ok', io)
        let r = await P.fill({ runEval })
        assert.equal(r.results.length, 3)
        assert(r.stateError.includes('EPERM: simulated state file'), r.stateError)
        assert(ids.every((id) => FK.readFill(st.rsi.root, id) !== null), '補算檔照常寫入')
        assert.deepEqual(r.store, { ok: true, n: 3 }, '共同儲存區照常重產')
        assert(r.lines.some((l) => l.startsWith('**附算之狀態檔未寫成**') && l.includes('本次已算 3 個成品')), JSON.stringify(r.lines))
        assert(!fs.existsSync(path.join(st.rsi.root, 'fill_state.json')))
        assert(!fs.readdirSync(st.rsi.root).some((f) => f.startsWith('fill_state.json.tmp-')), '無殘留之暫存檔')
        let e = await P.extFill({ names: ['dA'], force: true, runEval })
        assert(e.stateError.includes('EPERM: simulated state file'), JSON.stringify(e))
        let P2 = makeProject(st, { dispatch: dreamDispatchOf(st), gate: null, catalogFile: path.join(t.dir, 'proj', 'catSE.json'), runEval, io })
        let hk = await P2.domain.hooks.afterRound({ round: 1, nodes: [{ id: ids[0], status: 'executed', spec: { arms: ARMS[0], base: null } }] })
        assert(hk.dream && hk.dream.round === 1, '做夢照常套用')
        assert(hk.fill.stateError.includes('EPERM: simulated state file'), JSON.stringify(hk.fill))
        assert(hk.lines.some((l) => l.startsWith('**附算之狀態檔未寫成**')), JSON.stringify(hk.lines))
    })

    it('輪末:附算本身拋錯(評估帳本之 meta.json 不在)⇒ 做夢照常、回傳 fill = { error }、摘要列「未能執行」', async () => {
        let { st, ids, runEval } = mk2()
        let P2 = makeProject(st, { dispatch: dreamDispatchOf(st), gate: null, catalogFile: path.join(t.dir, 'proj', 'catX.json'), runEval })
        fs.rmSync(path.join(st.eval.ledgerDir, 'meta.json'))
        let hk = await P2.domain.hooks.afterRound({ round: 1, nodes: [{ id: ids[0], status: 'executed', spec: { arms: ARMS[0], base: null } }] })
        assert(hk.dream && hk.dream.round === 1, '做夢照常套用')
        assert(hk.fill && typeof hk.fill.error === 'string' && hk.fill.error.includes('invalid evaluator fingerprint'), JSON.stringify(hk.fill))
        assert(hk.lines.some((l) => l.startsWith('附算(求解窗後段與擴充診斷):**未能執行**')), JSON.stringify(hk.lines))
    })

    it('補算夾只有暫存檔(中斷之第一次補算)⇒ 共同儲存區不帶 postfit 之鍵', async () => {
        let { P, st, ids } = mk2()
        fs.mkdirSync(path.join(st.rsi.root, FP.FILL_DIR), { recursive: true })
        fs.writeFileSync(path.join(st.rsi.root, FP.FILL_DIR, `${ids[0]}.postfit.tmp-99999.json`), '{}', 'utf8')
        await P.pickStore()
        let idx = JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'picks', 'index.json'), 'utf8'))
        assert(idx.items.length === 3 && idx.items.every((x) => !('postfit' in x)), JSON.stringify(idx.items.map((x) => Object.keys(x))))
    })

    it('中斷留下之暫存檔:檔名所帶之行程代號已不存在者於附算起跑時清除;存活之行程之暫存檔與其他檔不動', async () => {
        let { P, st, ids, runEval } = mk2()
        let dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true }).stdout)
        assert(Number.isInteger(dead) && dead > 0, '已結束之行程之代號(鑑別前提)')
        let dir = path.join(st.rsi.root, FP.FILL_DIR)
        fs.mkdirSync(dir, { recursive: true })
        let gone = [path.join(dir, `${ids[0]}.postfit.tmp-${dead}.json`), path.join(dir, `${ids[0]}.extfill.tmp-${dead}.json`), path.join(dir, `${ids[0]}.json.tmp-${dead}`), path.join(st.rsi.root, `fill_state.json.tmp-${dead}`)]
        let kept = [path.join(dir, `${ids[1]}.postfit.tmp-${process.ppid}.json`), path.join(dir, `${ids[1]}.json.tmp-${process.pid}`), path.join(st.rsi.root, `fill_state.json.tmp-${process.ppid}`), path.join(st.rsi.root, `other.json.tmp-${dead}`), path.join(dir, `${ids[2]}.postfit.json`)]
        for (let fp of [...gone, ...kept]) {
            fs.writeFileSync(fp, '{}', 'utf8')
        }
        await P.fill({ targets: [], runEval, storeAfter: false })
        assert.deepEqual(gone.filter((fp) => fs.existsSync(fp)), [], '已不存在之行程之暫存檔已清除')
        assert.deepEqual(kept.filter((fp) => !fs.existsSync(fp)), [], '其餘不動')
    })

    it('重跑結果相同之失敗不入待重試:內建物件被改(EVAL_INTEGRITY)與持倉超過研究用本金另列、不列於「失敗者(…重試)」', async () => {
        let { P, st, ids, runEval } = mk2((k) => (k === 0 ? 'capital' : (k === 1 ? 'integrity' : 'ok')))
        let r = await P.fill({ runEval, storeAfter: false })
        assert.equal(resOf(r, ids[1]).kind, 'integrity')
        assert.deepEqual(r.blocked.map((x) => [x.id, x.kind]).sort(), [[ids[0], 'capital'], [ids[1], 'integrity']].sort())
        assert.deepEqual(r.retry, [])
        assert.deepEqual(fstOf(st).retry, [])
        assert(r.lines.some((l) => l.startsWith('附算之失敗而不重試:') && l.includes(`${ids[1].slice(0, 8)}(內建物件被改(完整性檢查未過))`)), JSON.stringify(r.lines))
        assert(!r.lines[0].includes('失敗者('), r.lines[0])
    })

    it('打包進主入口時(檔位於 dist/)評估器之指紋照常:以套件根下之 src/eval 為準,與深層路徑載入者同值、隨原始碼而變', async () => {
        let mkLayout = (name, dd) => {
            let root = path.join(t.dir, name)
            for (let x of [dd, 'src/eval', 'src/cli']) {
                fs.mkdirSync(path.join(root, x), { recursive: true })
            }
            for (let f of ['fillKeys.mjs', 'fillPlan.mjs', 'evalVersion.mjs']) {
                fs.copyFileSync(new URL(`../src/domain/${f}`, import.meta.url), path.join(root, dd, f))
            }
            fs.writeFileSync(path.join(root, 'src', 'eval', 'a.mjs'), 'export default 1\n', 'utf8')
            fs.writeFileSync(path.join(root, 'src', 'cli', 'eval.mjs'), 'export default 2\n', 'utf8')
            return root
        }
        let rootD = mkLayout('umd', 'dist')
        let rootS = mkLayout('esm', 'src/domain')
        let FKd = await import(pathToFileURL(path.join(rootD, 'dist', 'fillKeys.mjs')).href)
        let FKs = await import(pathToFileURL(path.join(rootS, 'src', 'domain', 'fillKeys.mjs')).href)
        let fp0 = FKd.evaluatorFpOf({})
        assert(/^ev-[0-9a-f]{20}$/.test(fp0), fp0)
        assert.equal(fp0, FKs.evaluatorFpOf({}), '兩種配置同值')
        fs.writeFileSync(path.join(rootD, 'src', 'eval', 'a.mjs'), 'export default 3\n', 'utf8')
        assert.notEqual(FKd.evaluatorFpOf({}), fp0, '隨原始碼而變')
    })

    it('子行程起不來(工作目錄不存在)⇒ runNodeProc 回 { code: null, error }(不拋出、不懸置)', async () => {
        let r = await runNodeProc(['-e', '1'], { cwd: path.join(t.dir, 'no-such-dir'), timeoutMs: 20000 })
        assert.strictEqual(r.code, null)
        assert.strictEqual(r.timeout, false)
        assert(typeof r.error === 'string' && r.error.length > 0, JSON.stringify(r))
        //對照: 工作目錄存在者照常
        let ok = await runNodeProc(['-e', 'process.stdout.write("x")'], { cwd: t.dir, timeoutMs: 20000 })
        assert.deepEqual([ok.code, ok.out, ok.timeout, ok.error], [0, 'x', false, undefined])
    })

    //強制重算之失敗者留在待重試且下次重試仍為強制重算, 直到成功(Gitea #178 §7 第 11 點之主控裁定; 不採「寫回節點文件原內容」)
    it('強制重算(--force)而樹之寫入失敗 ⇒ 該節點留在待重試且帶 force;下一次(不帶 --force)續為強制重算並收斂(樹、節點文件、補算檔一致);force 只及失敗之項目;範圍外之執行不動它', async () => {
        let { P, st, ids, runEval } = mk2()
        await P.fill({ runEval, storeAfter: false })
        assert.deepEqual(P.fillPlanOf({}).tasks, [], '鑑別前提: 第一次補齊後全部現行')
        let store = P.rsi.store
        let orig = store.updateNode
        store.updateNode = function (id, fn) {
            if (id === ids[1]) {
                throw new Error('EBUSY: simulated')
            }
            return orig.call(this, id, fn)
        }
        let r = await P.fill({ targets: [ids[1]], postfit: false, ext: ['dA'], force: true, runEval, storeAfter: false })
        store.updateNode = orig
        assert.equal(resOf(r, ids[1]).kind, 'transient')
        //鑑別前提(寫入之序: 先節點文件、再樹): 節點文件已為新值、樹仍為舊值 —— 計畫若只看「是否現行」, 此節點會被判為現行而永遠停在此不一致之狀態
        assert.deepEqual(P.records.getNodeDoc(ids[1]).harness.raw.metrics.ext.dA, { board: 'dA-1-new' })
        assert.deepEqual(P.rsi.store.getNode(ids[1]).raw.metrics.ext.dA, { board: 101 })
        assert.strictEqual((FK.readFill(st.rsi.root, ids[1]) || { ext: {} }).ext.dA, undefined, '補算檔未寫此值(寫入之序之最後一步)')
        //留在待重試, 帶 force(只列失敗之項目: 本次只強制 dA)
        assert.deepEqual(r.retry, [ids[1]])
        assert.deepEqual(fstOf(st).retry.map((x) => [x.id, x.n, x.source, x.force]), [[ids[1], 1, 'cli', { ext: ['dA'] }]])
        //下一次(不帶 --force)之計畫: 該項為強制(forced)、其餘皆現行
        let p = P.fillPlanOf({})
        assert.deepEqual(p.tasks.map((x) => [x.nodeId, x.postfit, x.ext, x.forced]), [[ids[1], false, ['dA'], { postfit: false, ext: ['dA'] }]])
        let calls = []
        let rec = async (a) => {
            calls.push([a.nodeId, a.kind, argOfA(a.args, '--ext-only')])
            return runEval(a)
        }
        //範圍外之執行(只指節點 0)⇒ 不執行該節點、待重試與 force 沿用
        await P.fill({ targets: [ids[0]], runEval: rec, storeAfter: false })
        assert.deepEqual(calls, [])
        assert.deepEqual(fstOf(st).retry.map((x) => [x.id, x.force]), [[ids[1], { ext: ['dA'] }]])
        //全樹之下一次(未帶 --force): 續為強制重算 dA(只 dA: 不及 dB 與求解窗後段)并收斂
        let r2 = await P.fill({ runEval: rec, storeAfter: false })
        assert.deepEqual(calls, [[ids[1], 'ext', 'dA']])
        assert.deepEqual(r2.retry, [])
        assert.deepEqual(fstOf(st).retry, [])
        assert.deepEqual(P.rsi.store.getNode(ids[1]).raw.metrics.ext.dA, { board: 'dA-1-new' }, '樹')
        assert.deepEqual(P.records.getNodeDoc(ids[1]).harness.raw.metrics.ext.dA, { board: 'dA-1-new' }, '節點文件')
        assert.equal(FK.readFill(st.rsi.root, ids[1]).ext.dA.value.board, 'dA-1-new', '補算檔')
        //收斂後再跑: 不重算
        let r3 = await P.fill({ runEval: rec, storeAfter: false })
        assert.equal(calls.length, 1)
        assert.deepEqual(r3.results, [])
        //節點文件之摘要: 同名診斷之列取代而不累積(失敗之一次已寫過新值, 續為強制重算後仍只一列)
        let sumA = P.records.getNodeDoc(ids[1]).harness.summary.filter((s) => String(s).startsWith('擴充診斷 dA:'))
        assert.equal(sumA.length, 1, JSON.stringify(sumA))
        assert(sumA[0].includes('dA-1-new'), sumA[0])
    })

    it('擴充診斷之輸出缺其中一個診斷之值(非物件亦非 { error })⇒ 該項記為失敗(暫時性、入待重試),其餘照補;下一次補齊', async () => {
        let bad = true
        let { P, st, ids, runEval } = mk2((k) => (k === 2 && bad ? 'extPart' : 'ok'))
        let r = await P.fill({ targets: [ids[2]], postfit: false, runEval, storeAfter: false })
        let r2 = resOf(r, ids[2])
        assert.deepEqual([r2.ext.ok, r2.ext.failed, r2.kind], [['dA'], ['dB'], 'transient'])
        assert(r2.error.includes('擴充診斷:重放之輸出無所指之診斷(dB)'), r2.error)
        assert.deepEqual(fstOf(st).retry.map((x) => [x.id, x.n]), [[ids[2], 1]], '部分缺值者亦入待重試(原只處理全部缺值)')
        let n2 = P.rsi.store.getNode(ids[2]).raw.metrics.ext
        assert(n2.dA && !n2.dB, 'dA 已併入、dB 未併入')
        bad = false
        let r3 = await P.fill({ runEval, storeAfter: false })
        assert.deepEqual(resOf(r3, ids[2]).ext, { ok: ['dB'], failed: [] })
        assert.deepEqual(fstOf(st).retry, [])
    })

    it('強制重算失敗者:持續失敗時次數累計而 force 不丟、成功後移除;求解窗後段之強制(節點文件之寫入失敗)同;來源為輪末者亦帶 force', async () => {
        let { P, st, ids, runEval } = mk2()
        await P.fill({ runEval, storeAfter: false })
        //補算檔之 at 改為遠舊之固定值: 其後以是否變動判斷重算(不依賴時鐘之解析度)
        let fpFill = FK.fillFileOf(st.rsi.root, ids[2])
        let doc0 = JSON.parse(fs.readFileSync(fpFill, 'utf8'))
        doc0.postfit.at = '2020-01-01T00:00:00.000Z'
        fs.writeFileSync(fpFill, JSON.stringify(doc0), 'utf8')
        let orig = P.records.putNodeDoc
        let failDoc = true
        P.records.putNodeDoc = function (d) {
            if (failDoc && d.nodeId === ids[2]) {
                throw new Error('EBUSY: simulated doc')
            }
            return orig.call(this, d)
        }
        for (let [k, src] of [[1, 'cli'], [2, 'round'], [3, 'cli']]) {
            let r = await P.fill({ targets: [ids[2]], ext: false, force: true, source: src, runEval, storeAfter: false })
            assert.equal(resOf(r, ids[2]).kind, 'transient', `第 ${k} 次`)
            assert.deepEqual(fstOf(st).retry.map((x) => [x.id, x.n, x.source, x.force]), [[ids[2], k, src, { postfit: true }]], `第 ${k} 次:次數累計、force 不丟、來源依最近一次`)
        }
        assert.equal(FK.readFill(st.rsi.root, ids[2]).postfit.at, '2020-01-01T00:00:00.000Z', '補算檔照留(重算未成)')
        failDoc = false
        let calls = []
        let rec = async (a) => {
            calls.push([a.nodeId, a.kind])
            return runEval(a)
        }
        //下一次(不帶 --force): 續為強制重算求解窗後段(其餘現行不重算)
        let r4 = await P.fill({ runEval: rec, storeAfter: false })
        assert.deepEqual(calls, [[ids[2], 'postfit']])
        assert.deepEqual(r4.retry, [])
        assert.deepEqual(fstOf(st).retry, [])
        assert.notEqual(FK.readFill(st.rsi.root, ids[2]).postfit.at, '2020-01-01T00:00:00.000Z', '已強制重算')
        P.records.putNodeDoc = orig
    })

    it('強制重算失敗而重算評估本身失敗(逾時)⇒ 前次之值照留、仍留在待重試帶 force;重跑結果相同之失敗(參數 / 設定)不入、force 不留;狀態檔之 force 欄形狀不合者忽略', async () => {
        let bad = 'timeout'
        let { P, st, ids, runEval } = mk2((k) => (k === 1 ? bad : 'ok'))
        bad = 'ok'
        await P.fill({ runEval, storeAfter: false })
        bad = 'timeout'
        let r = await P.fill({ targets: [ids[1]], postfit: false, ext: ['dB'], force: true, runEval, storeAfter: false })
        assert.equal(resOf(r, ids[1]).kind, 'transient')
        assert.deepEqual(fstOf(st).retry.map((x) => [x.id, x.force]), [[ids[1], { ext: ['dB'] }]], '前次之值仍現行, 但使用者要求之重算尚未完成 ⇒ 留')
        //離開碼 2(參數 / 設定; 重跑結果相同)⇒ 不入待重試(force 亦不留)
        bad = 'ok'
        let st0 = fstOf(st)
        fs.writeFileSync(path.join(st.rsi.root, 'fill_state.json'), JSON.stringify({ ...st0, retry: [] }), 'utf8')
        let P2 = { fill: (o) => P.fill({ ...o, runEval: async (a) => ({ code: 2, timeout: false }) }) }
        let r2 = await P2.fill({ targets: [ids[1]], postfit: false, ext: ['dB'], force: true, storeAfter: false })
        assert.equal(resOf(r2, ids[1]).kind, 'config')
        assert.deepEqual(fstOf(st).retry, [])
        //force 欄之形狀不合(非物件、postfit 非 true、ext 非字串陣列)⇒ 忽略: 與無 force 欄同
        fs.writeFileSync(path.join(st.rsi.root, 'fill_state.json'), JSON.stringify({ ...st0, retry: [{ id: ids[1], n: 1, last: 'x', source: 'cli', force: { postfit: 'yes', ext: [1, null, ''] } }, { id: ids[2], n: 1, last: 'x', source: 'cli', force: 5 }] }), 'utf8')
        let p = P.fillPlanOf({})
        assert.deepEqual(p.tasks, [], '形狀不合之 force 不使任何項目被強制(其餘現行)')
        //有效之 force 欄(含重複與未排序之診斷名)⇒ 正規化: 去重、排序
        fs.writeFileSync(path.join(st.rsi.root, 'fill_state.json'), JSON.stringify({ ...st0, retry: [{ id: ids[1], n: 1, last: 'x', source: 'cli', force: { postfit: true, ext: ['dB', 'dA', 'dB'] } }] }), 'utf8')
        let p2 = P.fillPlanOf({})
        assert.deepEqual(p2.tasks.map((x) => [x.nodeId, x.postfit, x.ext]), [[ids[1], true, ['dA', 'dB']]])
        //重寫之狀態檔以去重、排序之形狀記 force(範圍外之執行不評估該節點, 但狀態檔因形狀不同而重寫)
        await P.fill({ targets: [ids[0]], runEval, storeAfter: false })
        assert.deepEqual(fstOf(st).retry.map((x) => [x.id, x.force]), [[ids[1], { postfit: true, ext: ['dA', 'dB'] }]])
    })

    //settings.rsi.fillParallel(跨套件規格 K3 無效用預設、K4 檢測之值即使用之值、K7 收數字字串並轉型)
    it('併行數(fillParOf):par → settings.rsi.fillParallel → 3;數字字串轉型後使用;無效者視為未給(不拋錯);上限 8', () => {
        let { P } = mk2()
        let NONE = Symbol('none')
        let run = (setting, par) => {
            if (setting === NONE) {
                delete P.st.rsi.fillParallel
            }
            else {
                P.st.rsi.fillParallel = setting
            }
            return par === NONE ? P.fillParOf() : P.fillParOf(par)
        }
        //設定之值(未給 par)
        for (let [s, want] of [[NONE, 3], [null, 3], [1, 1], [2, 2], ['2', 2], [' 5 ', 5], ['07', 7], [8, 8], [9, 8], ['100', 8], [Number.MAX_SAFE_INTEGER, 8]]) {
            assert.strictEqual(run(s, NONE), want, `設定 ${JSON.stringify(s)}`)
        }
        //無效之設定 ⇒ 預設 3(K3: 不拋錯)
        for (let s of [0, -2, 2.5, '2.5', 'abc', '', '  ', true, false, NaN, Infinity, -Infinity, [2], {}, '0', '-1', '2 3', '0x2', 2n, () => 2]) {
            assert.strictEqual(run(s, NONE), 3, `無效之設定 ${String(typeof s === 'bigint' ? `${s}n` : (typeof s === 'function' ? 'fn' : JSON.stringify(s)))}`)
        }
        //par(命令列 --par)優先; 無效者視為未給 ⇒ 改用設定; 皆無效 ⇒ 3; 上限 8
        for (let [s, par, want] of [[1, 3, 3], [1, '3', 3], [1, 12, 8], [1, '12', 8], [5, 'abc', 5], [NONE, 'abc', 3], [1, 0, 1], [7, -1, 7], [1, true, 1], [4, 2.5, 4], [4, null, 4], [NONE, 6, 6], [NONE, ' 6 ', 6]]) {
            assert.strictEqual(run(s, par), want, `設定 ${s === NONE ? '(無)' : JSON.stringify(s)}、par ${JSON.stringify(par)}`)
        }
        //檢測之值即使用之值(K4): 數字字串 '5' 與數字 5 得同一結果
        assert.strictEqual(run('5', NONE), run(5, NONE))
    })

    it('併行數實際生效(fill):設定為數字字串亦限制同時進行之評估數;par 優先;回傳 par 為實際使用之值;上限 8', async () => {
        let { P, runEval } = mk2()
        let inflight = 0
        let maxIn = 0
        //每個評估入口先讓出微任務佇列數百次(事件輪替而非時間; 資源閘於未設上限時立即放行、無計時器), 使其他工作者有機會起跑 —— 同時進行之數即受併行數所限
        let gated = async (a) => {
            inflight++
            maxIn = Math.max(maxIn, inflight)
            for (let i = 0; i < 300; i++) {
                await Promise.resolve()
            }
            let out = await runEval(a)
            inflight--
            return out
        }
        let one = async (setting, par, force) => {
            P.st.rsi.fillParallel = setting
            inflight = 0
            maxIn = 0
            let r = await P.fill({ force, postfit: true, ext: false, ...(par === undefined ? {} : { par }), runEval: gated, storeAfter: false })
            return { max: maxIn, par: r.par, n: r.results.length }
        }
        //三個成品皆待算(第一次): 設定 '2'(數字字串)⇒ 同時進行 2
        assert.deepEqual(await one('2', undefined, false), { max: 2, par: 2, n: 3 })
        //par 優先: 設定 3、par 1 ⇒ 序列
        assert.deepEqual(await one(3, 1, true), { max: 1, par: 1, n: 3 })
        //設定 '3' ⇒ 3(三個成品皆同時)
        assert.deepEqual(await one('3', undefined, true), { max: 3, par: 3, n: 3 })
        //無效設定 ⇒ 預設 3
        assert.deepEqual(await one('abc', undefined, true), { max: 3, par: 3, n: 3 })
        //上限 8: 回傳之 par 為實際使用之值(成品只有 3 個, 同時進行數受成品數所限)
        assert.deepEqual(await one('100', undefined, true), { max: 3, par: 8, n: 3 })
        assert.deepEqual(await one(1, 99, true), { max: 3, par: 8, n: 3 })
    })

    it('settings.rsi.autoFill:只有 false 關閉輪末之附算(其餘值 —— 未給、null、0、字串、true —— 皆照常附算)', async () => {
        let bad = (v) => v === undefined ? 'undefined' : JSON.stringify(v)
        for (let v of [false, undefined, null, 0, 'false', true, '']) {
            t.cleanup()
            t = makeTmp('fillRev2')
            let { st, ids, runEval } = mk2()
            let seen = []
            if (v === undefined) {
                delete st.rsi.autoFill
            }
            else {
                st.rsi.autoFill = v
            }
            let P2 = makeProject(st, {
                dispatch: dreamDispatchOf(st),
                gate: null,
                catalogFile: path.join(t.dir, 'proj', 'catAF.json'),
                runEval: async (a) => {
                    seen.push(a.nodeId)
                    return runEval(a)
                },
            })
            let hk = await P2.domain.hooks.afterRound({ round: 1, nodes: [{ id: ids[0], status: 'executed', spec: { arms: ARMS[0], base: null } }] })
            assert(hk.dream, `做夢已套用(鑑別前提): ${bad(v)}`)
            if (v === false) {
                assert.deepEqual(seen, [], '關閉 ⇒ 不評估')
                assert(!('fill' in hk), '關閉 ⇒ 鉤子不帶 fill')
                assert(!hk.lines.some((l) => l.startsWith('附算(')), '關閉 ⇒ 摘要無附算之列')
            }
            else {
                assert(seen.includes(ids[0]), `未關閉(${bad(v)})⇒ 附算本輪之節點`)
                assert(hk.fill && hk.fill.n >= 1, bad(v))
            }
        }
    })

    //資訊界線(R-REC-34 ⑦): 附算只用評估帳本(止於回測期終點); 與保留期、其他標的之號無關 —— 不讀不寫 _holdout.json、_cross.json
    it('資訊界線:附算(計畫、金鑰、執行)之程式不含保留期與其他標的之檔名;實跑(含重產共同儲存區)後 _holdout.json 與 _cross.json 逐位不變', async () => {
        let DOM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'domain')
        let domSrc = fs.readFileSync(path.join(DOM, 'domain.mjs'), 'utf8')
        let a = domSrc.indexOf('//附算與補算(規則 R-REC-34')
        let b = domSrc.indexOf('//rescanTraces, ')
        assert(a > 0 && b > a, '鑑別前提: 找得到附算之區段')
        for (let [name, src] of [['fillPlan.mjs', fs.readFileSync(path.join(DOM, 'fillPlan.mjs'), 'utf8')], ['fillKeys.mjs', fs.readFileSync(path.join(DOM, 'fillKeys.mjs'), 'utf8')], ['domain.mjs 之附算區段', domSrc.slice(a, b)]]) {
            //去掉註解後之程式碼不得出現(註解可說明界線本身)
            let code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
            assert(!/_holdout|_cross|holdoutFile|crossFile/.test(code), name)
        }
        let { P, st, runEval } = mk2()
        let dir = path.join(st.rsi.root, 'picks')
        fs.mkdirSync(dir, { recursive: true })
        let ho = JSON.stringify({ asOf: '2026-01-01', items: {} })
        let cr = JSON.stringify({ asOf: '2026-01-01', items: {} })
        fs.writeFileSync(path.join(dir, '_holdout.json'), ho, 'utf8')
        fs.writeFileSync(path.join(dir, '_cross.json'), cr, 'utf8')
        let r = await P.fill({ runEval })
        assert.equal(r.store.ok, true)
        assert.equal(fs.readFileSync(path.join(dir, '_holdout.json'), 'utf8'), ho)
        assert.equal(fs.readFileSync(path.join(dir, '_cross.json'), 'utf8'), cr)
    })

    //評估器版本(EVAL_VERSION)併入評估器之指紋(Gitea #178 §7 第 3 點之主控裁定): 單一定義、附算與共同儲存區之重產用同一判準; 不以套件版號為鍵
    it('評估器版本常數:單一定義(src 內無第二份);只改該常數 ⇒ 評估器之指紋改變、附算判為過時、共同儲存區之 postfit.current 為 false(值照列);重算後恢復現行', async () => {
        let SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
        //動態匯入: 於未含 evalVersion.mjs 之版本(修前)僅本案失敗, 不使整檔無法載入
        let { EVAL_VERSION } = await import(pathToFileURL(path.join(SRC, 'domain', 'evalVersion.mjs')).href)
        //單一定義: src 內 EVAL_VERSION 之賦值只有一處(評估環境之鍵與評估器之指紋共用; 共同儲存區之重產經 evaluatorFpOf 取得同值)
        let defs = []
        let walk = (d) => {
            for (let e of fs.readdirSync(d, { withFileTypes: true })) {
                let p = path.join(d, e.name)
                if (e.isDirectory()) {
                    walk(p)
                }
                else if (/\.mjs$/.test(e.name) && /\bEVAL_VERSION\s*=[^=]/.test(fs.readFileSync(p, 'utf8'))) {
                    defs.push(path.relative(SRC, p).replace(/\\/g, '/'))
                }
            }
        }
        walk(SRC)
        assert.deepEqual(defs, ['domain/evalVersion.mjs'])
        //複本: 整個 src 複製兩份; B 只把該常數改為另一個值(其餘逐位相同)
        let mkCopy = (name, version) => {
            let root = path.join(t.dir, name)
            fs.cpSync(SRC, path.join(root, 'src'), { recursive: true })
            if (version !== null) {
                let fp = path.join(root, 'src', 'domain', 'evalVersion.mjs')
                let s = fs.readFileSync(fp, 'utf8')
                assert(/\nlet EVAL_VERSION = \d+\r?\n/.test(s), '鑑別前提: 常數之寫法')
                fs.writeFileSync(fp, s.replace(/(\nlet EVAL_VERSION = )\d+(\r?\n)/, `$1${version}$2`), 'utf8')
            }
            return path.join(root, 'src')
        }
        let A = mkCopy('evA', null)
        let B = mkCopy('evB', EVAL_VERSION + 1)
        let sameFiles = (rels) => rels.every((rel) => fs.readFileSync(path.join(A, rel)).equals(fs.readFileSync(path.join(B, rel))))
        assert(sameFiles([...fs.readdirSync(path.join(SRC, 'eval')).map((f) => `eval/${f}`), 'cli/eval.mjs', 'domain/fillKeys.mjs', 'domain/fillPlan.mjs', 'domain/pickStore.mjs', 'domain/domain.mjs']), '鑑別前提: 兩複本只有該常數檔不同')
        assert.notEqual(fs.readFileSync(path.join(A, 'domain', 'evalVersion.mjs'), 'utf8'), fs.readFileSync(path.join(B, 'domain', 'evalVersion.mjs'), 'utf8'))
        let { P, st, ids, runEval } = mk2()
        let FKa = await import(pathToFileURL(path.join(A, 'domain', 'fillKeys.mjs')).href)
        let FKb = await import(pathToFileURL(path.join(B, 'domain', 'fillKeys.mjs')).href)
        //指紋: 只改常數 ⇒ 不同; 複本 A 與原件同值(對照)
        assert.equal(FKa.evaluatorFpOf(st), FK.evaluatorFpOf(st))
        assert.notEqual(FKb.evaluatorFpOf(st), FKa.evaluatorFpOf(st))
        //原件(版本不變): 補齊後全部現行, 共同儲存區之 postfit.current 為 true
        await P.fill({ runEval, storeAfter: false })
        await P.pickStore()
        let items = () => JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'picks', 'index.json'), 'utf8')).items
        assert.equal(items().length, 3)
        assert(items().every((x) => x.postfit && x.postfit.current === true), '鑑別前提: 版本不變 ⇒ 現行')
        assert.deepEqual(P.fillPlanOf({ ext: false }).tasks, [])
        //同一個狀態根、只改該常數之專案: 附算判為過時(三個成品之求解窗後段皆須算); 共同儲存區之 postfit.current 為 false(值照列)
        let { makeProject: makeB } = await import(pathToFileURL(path.join(B, 'domain', 'domain.mjs')).href)
        let PB = makeB(st, { dispatch: async () => ({ ok: false, error: 'fake' }), gate: null, catalogFile: path.join(t.dir, 'proj', 'catB.json') })
        PB.rsi.init()
        assert.deepEqual(PB.fillPlanOf({ ext: false }).tasks.map((x) => [x.nodeId, x.postfit]).sort(), ids.map((id) => [id, true]).sort())
        await PB.pickStore()
        assert.equal(items().length, 3)
        assert(items().every((x) => x.postfit && x.postfit.current === false && typeof x.postfit.seatsKept === 'number'), `值照列、current 為 false: ${JSON.stringify(items().map((x) => x.postfit))}`)
        //以 B 重算後 ⇒ 現行(B 之判準); 原件(版本不同)判為過時
        let rB = await PB.fill({ ext: false, runEval, storeAfter: false })
        assert.equal(rB.results.length, 3)
        await PB.pickStore()
        assert(items().every((x) => x.postfit.current === true))
        assert.deepEqual(PB.fillPlanOf({ ext: false }).tasks, [])
        assert.equal(P.fillPlanOf({ ext: false }).tasks.length, 3, '原件之判準與 B 不同 ⇒ 過時')
        await P.pickStore()
        assert(items().every((x) => x.postfit.current === false), '原件重產共同儲存區 ⇒ current 為 false')
    })
})
