import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { specHash } from '../src/engineApi.mjs'
import * as FP from '../src/domain/fillPlan.mjs'
import * as FK from '../src/domain/fillKeys.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//附算與補算之執行(規則 R-REC-34; 使用端提案, 純新增): makeProject 之 fill / extFill 與輪末鉤子之附算段
//  接縫不用替身: 真之樹、節點文件、補算檔、共同儲存區與輪末鉤子(含 arsi.runDream); 只有「評估之執行本身」(runEval: g_eval.mjs 之子行程)換成假的 ——
//  假評估依參數寫出結果檔(--period postfit ⇒ 求解窗後段之結果; --ext-only ⇒ 該診斷之值), 並記錄每次之參數
describe('附算與補算之執行(規則 R-REC-34)', function () {
    this.timeout(60000)
    let t
    beforeEach(() => {
        t = makeTmp('fillRun')
    })
    afterEach(() => {
        t.cleanup()
    })
    let ARMS = [['A01_nt'], ['A01_nt', 'B14_pitKey'], ['B14_pitKey']]
    let argOfA = (args, k) => {
        let i = args.indexOf(k); return i >= 0 ? args[i + 1] : null
    }
    //各節點之值皆不同(選集指紋、診斷之值、求解窗後段之超額), 使錯位可被看出
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
    //mk, 暫存夾之專案: 3 個已執行之節點(工作夾有 pick.mjs 與 harness_full.json、樹有正本之數字、節點文件)、共用工具區 metrics/ 之兩個診斷
    let mk = ({ failPostfit = new Set(), badSel = new Set() } = {}) => {
        let st = getSettings()
        let d = path.join(t.dir, 'proj')
        //資源閘關閉、併行 1(參考設定之資源閘會使工作者等待全機之負載降下, 測試之耗時與成敗隨機器之負載而變)
        st.resources = {}
        st.rsi = { ...st.rsi, fillParallel: 1 }
        st.rsi.root = path.join(d, 'rsi')
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
            fs.writeFileSync(path.join(wd, 'pick.mjs'), `export const meta = { arms: ${JSON.stringify(arms)}, desc: '成品 ${k}' }\nexport default function pick(ctx) {\n    return [${k}]\n}\n`, 'utf8')
            fs.writeFileSync(path.join(wd, 'harness_full.json'), JSON.stringify({ ok: true, at: `2026-01-0${k + 1}T00:00:00.000Z`, metrics: { selHash: `sel-${k}` } }), 'utf8')
            //節點 0 之正本缺 dB; 節點 1 兩者皆有; 節點 2 皆缺
            let ext = k === 0 ? { dA: { board: 100 + k } } : (k === 1 ? { dA: { board: 100 + k }, dB: { board: 200 + k } } : {})
            let metrics = { selHash: `sel-${k}`, ext, op: { eqYr: { mean: 12.5 + k, min: -1.5 - k, byPhase: [1, 2, 3, 4, 5, 6, 7].map((v) => v + k) }, monthlyOrders: { mean: 90 + k }, peakHold: { max: 30 - k }, winRate: 0.4 + k / 100 } }
            P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round: 1, raw: { metrics, issues: [] }, score: { S: 10 + k, ladder: 3, flags: { vetoed: false, why: [] } } })
            P.records.putNodeDoc({ nodeId: id, round: 1, attempt: 1, status: 'verified', spec, task: { goal: 'g', type: 'explore' }, plan: {}, code: {}, results: { claimed: {} }, conclusion: { outcome: 'improved', summary: `摘要 ${k}` }, harness: { ok: true, summary: [`既有之列 ${k}`], notes: [], checks: { issues: [] }, score: { S: 10 + k, ladder: 3, flags: { vetoed: false, why: [] } }, raw: { metrics } } })
            return id
        })
        let calls = []
        let runEval = async ({ nodeId, kind, args }) => {
            calls.push({ nodeId, kind, args })
            let k = ids.indexOf(nodeId)
            let out = argOfA(args, '--out')
            if (kind === 'postfit') {
                assert.equal(argOfA(args, '--period'), 'postfit')
                if (failPostfit.has(k)) {
                    return { code: 1, timeout: false }
                }
                fs.writeFileSync(out, JSON.stringify(pfOf(k)), 'utf8')
                return { code: 0, timeout: false }
            }
            let names = argOfA(args, '--ext-only').split(',')
            fs.writeFileSync(out, JSON.stringify({ ok: true, metrics: { selHash: badSel.has(k) ? 'other' : `sel-${k}`, ext: Object.fromEntries(names.map((nm) => [nm, { board: `${nm}-${k}-new`, flag: k === 2 ? `提示 ${nm}` : undefined }])) } }), 'utf8')
            return { code: 0, timeout: false }
        }
        return { P, st, ids, calls, runEval }
    }
    let wdOf = (st, id) => path.join(st.records.workDir, id)
    //tmpLeft, 補算夾內是否殘留暫存檔(帶行程代號者)
    let tmpLeft = (st) => fs.existsSync(path.join(st.rsi.root, FP.FILL_DIR)) && fs.readdirSync(path.join(st.rsi.root, FP.FILL_DIR)).some((f) => f.includes('.tmp-'))

    it('全樹之第一次補齊:各成品之求解窗後段與所缺之診斷;補算檔另存、正本之結果檔與樹之數字不動;節點文件之摘要一列;共同儲存區帶 postfit;再跑一次不重算', async () => {
        let { P, st, ids, calls, runEval } = mk()
        let full0 = ids.map((id) => fs.readFileSync(path.join(wdOf(st, id), 'harness_full.json'), 'utf8'))
        let r = await P.fill({ runEval })
        assert.deepEqual(r.plan, { nTasks: 3, nCurrent: 0 })
        //評估之次數: 每個成品 postfit 1 次; 所缺之診斷合為 1 次(節點 0: dB; 節點 1: 無; 節點 2: dA、dB)
        let byNode = ids.map((id) => calls.filter((c) => c.nodeId === id).map((c) => `${c.kind}:${argOfA(c.args, '--ext-only') || ''}`).sort())
        assert.deepEqual(byNode, [['ext:dB', 'postfit:'], ['postfit:'], ['ext:dA,dB', 'postfit:']])
        assert(calls.every((c) => c.args.includes('--no-log') && c.args[c.args.indexOf('--mode') + 1] === 'full'))
        let resBy = Object.fromEntries(r.results.map((x) => [x.nodeId, [x.postfit, x.ext.ok, x.ext.failed, x.error]]))
        assert.deepEqual(ids.map((id) => resBy[id]), [['ok', ['dB'], [], null], ['ok', [], [], null], ['ok', ['dA', 'dB'], [], null]])
        assert.deepEqual(r.results.map((x) => x.nodeId), [...ids].sort(), '依節點 id 之序')
        let evaluator = FK.evaluatorFpOf(st)
        assert.equal(r.evaluator, evaluator)
        for (let [k, id] of ids.entries()) {
            let wd = wdOf(st, id)
            assert.equal(fs.readFileSync(path.join(wd, 'harness_full.json'), 'utf8'), full0[k], '正本之結果檔不動')
            assert(!tmpLeft(st), '暫存之結果檔已移除')
            assert(!fs.existsSync(path.join(wd, 'harness_fill.json')) && !fs.existsSync(path.join(wd, 'harness_postfit.json')), '工作夾內不寫')
            //求解窗後段之完整結果檔(評估器之輸出原樣)另存, 供診斷工具直接讀
            assert.deepEqual(JSON.parse(fs.readFileSync(FK.postfitFileOf(st.rsi.root, id), 'utf8')), pfOf(k))
            let f = JSON.parse(fs.readFileSync(FK.fillFileOf(st.rsi.root, id), 'utf8'))
            assert.equal(f.nodeId, id)
            let pickHash = FK.pickHashOf(fs.readFileSync(path.join(wd, 'pick.mjs')))
            assert.equal(f.schema, FP.FILL_SCHEMA)
            assert.deepEqual(f.postfit.key, { pick: pickHash, evaluator })
            assert.deepEqual(f.postfit.row, FP.postfitRowOf(pfOf(k)))
            let n = P.rsi.store.getNode(id)
            assert.equal(n.score.S, 10 + k, '分數不動')
            assert.equal(n.raw.metrics.selHash, `sel-${k}`, '選集指紋不動')
            let doc = P.records.getNodeDoc(id)
            assert.deepEqual(doc.harness.postfit.row, f.postfit.row)
            assert.equal(doc.harness.summary.filter((s) => String(s).startsWith(FP.POSTFIT_HEAD)).length, 1)
            assert.equal(doc.harness.summary[0], `既有之列 ${k}`, '既有之摘要列照留')
            assert.equal(doc.harness.summary.find((s) => String(s).startsWith(FP.POSTFIT_HEAD)), FP.postfitLineOf(f.postfit.row))
        }
        //擴充診斷: 所補者併入樹與節點文件、記於補算檔(鍵含診斷之雜湊); 正本已有者不動
        let diags = Object.fromEntries(FK.diagsOf(st.records.toolboxDir).map((x) => [x.name, x.hash]))
        let n0 = P.rsi.store.getNode(ids[0])
        assert.deepEqual(n0.raw.metrics.ext, { dA: { board: 100 }, dB: { board: 'dB-0-new' } })
        let f0 = JSON.parse(fs.readFileSync(FK.fillFileOf(st.rsi.root, ids[0]), 'utf8'))
        assert.deepEqual(Object.keys(f0.ext), ['dB'])
        assert.equal(f0.ext.dB.key.diag, diags.dB)
        let n2 = P.rsi.store.getNode(ids[2])
        assert.deepEqual(Object.keys(n2.raw.metrics.ext), ['dA', 'dB'])
        assert(n2.raw.issues.some((s) => String(s).includes('提示 dA')), '新補之診斷之提示列入迴圈檢查')
        assert.deepEqual(P.records.getNodeDoc(ids[2]).harness.raw.metrics.ext.dB, { board: 'dB-2-new', flag: '提示 dB' })
        //狀態: 診斷之登錄(第一次 ⇒ since null)、待重試 0
        let fst = JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'fill_state.json'), 'utf8'))
        assert.deepEqual(fst.registry, { dA: { hash: diags.dA, since: null }, dB: { hash: diags.dB, since: null } })
        assert.deepEqual(fst.retry, [])
        //共同儲存區(storeAfter): 各列之 postfit = 補算檔之值 + at + current; 總表之欄不含此段
        assert.deepEqual(r.store, { ok: true, n: 3 })
        let idx = JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'picks', 'index.json'), 'utf8'))
        for (let x of idx.items) {
            let k = ids.indexOf(x.id)
            assert.deepEqual(x.postfit, { ...FP.postfitRowOf(pfOf(k)), at: JSON.parse(fs.readFileSync(FK.fillFileOf(st.rsi.root, x.id), 'utf8')).postfit.at, current: true })
            assert.deepEqual(JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'picks', x.id, 'info.json'), 'utf8')).postfit, x.postfit)
        }
        assert(!fs.readFileSync(path.join(st.rsi.root, 'picks', 'INDEX.md'), 'utf8').includes('求解窗後段'), '總表不加此欄')
        //再跑一次: 全部現行 ⇒ 不評估
        let n0calls = calls.length
        let r2 = await P.fill({ runEval })
        assert.equal(calls.length, n0calls)
        assert.deepEqual(r2.plan, { nTasks: 0, nCurrent: 3 })
        assert.deepEqual(r2.lines, [])
    })

    it('targets 以外者入待補算(摘要列出補齊之指令);失敗者記為待重試、不拋錯,下一次成功即移除;選集指紋與正本不同之重放不併入', async () => {
        let { P, st, ids, calls, runEval } = mk({ failPostfit: new Set([1]), badSel: new Set([2]) })
        let r = await P.fill({ targets: [ids[1], ids[2]], runEval, storeAfter: false })
        assert.deepEqual(calls.map((c) => c.nodeId).filter((v, i, a) => a.indexOf(v) === i).sort(), [ids[1], ids[2]].sort())
        assert.deepEqual(r.backlog, { postfit: [ids[0]], ext: { dA: [], dB: [ids[0]] } })
        let byId = Object.fromEntries(r.results.map((x) => [x.nodeId, x]))
        assert.equal(byId[ids[1]].postfit, 'failed')
        assert(byId[ids[1]].error.startsWith('求解窗後段:離開碼 1'), byId[ids[1]].error)
        assert.deepEqual(byId[ids[2]].ext, { ok: [], failed: ['dA', 'dB'] })
        assert(byId[ids[2]].error.includes('選集指紋與正本不同'), byId[ids[2]].error)
        assert.deepEqual(P.rsi.store.getNode(ids[2]).raw.metrics.ext, {}, '未併入')
        //失敗者之已成功之部分照寫(節點 2 之求解窗後段)
        assert.equal(JSON.parse(fs.readFileSync(FK.fillFileOf(st.rsi.root, ids[2]), 'utf8')).postfit.row.seatsKept, 22)
        assert(!fs.existsSync(FK.fillFileOf(st.rsi.root, ids[1])), '全部失敗者不寫補算檔')
        assert(!fs.existsSync(FK.postfitFileOf(st.rsi.root, ids[1])) && !tmpLeft(st), '失敗者無完整結果檔、暫存檔已移除')
        assert.equal(JSON.parse(fs.readFileSync(FK.postfitFileOf(st.rsi.root, ids[2]), 'utf8')).metrics.selHash, 'pf-sel-2')
        //待重試: 節點 1(暫時性之失敗)入、節點 2(選集指紋不同 = 須重驗)不入而另列
        assert.deepEqual(r.retry, [ids[1]])
        assert.deepEqual(r.blocked.map((x) => [x.id, x.kind]), [[ids[2], 'reverify']])
        let fr1 = JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'fill_state.json'), 'utf8')).retry
        assert.deepEqual(fr1.map((x) => [x.id, x.n]), [[ids[1], 1]])
        assert(fr1[0].last.startsWith('求解窗後段:離開碼 1'), fr1[0].last)
        assert.equal(r.lines.length, 3)
        assert(r.lines[0].includes('**失敗 1**') && r.lines[0].includes('**失敗 2 項**'), r.lines[0])
        assert(r.lines[0].includes(`失敗者(再執行補算工具時重試):${ids[1].slice(0, 8)}`) && !r.lines[0].includes(`${ids[2].slice(0, 8)}(`), r.lines[0])
        assert.equal(r.lines[1], '待補算之成品(不在本次之範圍;以 `node g_rsi.mjs --mode fill` 補齊,可中斷續跑):求解窗後段 1 個;擴充診斷 dB 1 個')
        assert.equal(r.lines[2], `附算之失敗而不重試:${ids[2].slice(0, 8)}(須重驗:選集指紋與正本不同)`)
        //修好後只跑節點 1 ⇒ 節點 1 移出待重試
        let r2 = await P.fill({
            targets: [ids[1]],
            runEval: async (a) => {
                let out = argOfA(a.args, '--out')
                fs.writeFileSync(out, JSON.stringify(pfOf(9)), 'utf8')
                return { code: 0, timeout: false }
            },
            storeAfter: false
        })
        assert.equal(r2.results[0].postfit, 'ok')
        assert.deepEqual(r2.retry, [])
        //其後之重算失敗 ⇒ 前次之完整結果檔與補算檔之值照留; 重入待重試
        let r3 = await P.fill({ targets: [ids[1]], force: true, runEval: async () => ({ code: 1, timeout: false }), storeAfter: false })
        assert.equal(r3.results[0].postfit, 'failed')
        assert.equal(JSON.parse(fs.readFileSync(FK.postfitFileOf(st.rsi.root, ids[1]), 'utf8')).metrics.selHash, 'pf-sel-9')
        assert.equal(JSON.parse(fs.readFileSync(FK.fillFileOf(st.rsi.root, ids[1]), 'utf8')).postfit.row.seatsKept, 29)
        //強制重算(--force)之失敗者留在待重試、且帶 force(下次重試仍為強制重算, 直到成功; 主控裁定: Gitea #178 §7 第 11 點):
        //  前次之值雖仍現行(強制重算失敗而前次之值照留), 使用者要求之重算尚未完成 ⇒ 不以「已現行」移出待重試(原斷言為 [] —— 即該點所指之缺口)
        assert.deepEqual(r3.retry, [ids[1]])
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'fill_state.json'), 'utf8')).retry.map((x) => [x.id, x.force]), [[ids[1], { postfit: true, ext: ['dA', 'dB'] }]], '強制重算之項目(求解窗後段與兩個診斷)皆記入 force')
    })

    it('快取之鍵:成品重做(內容變)⇒ 該成品之求解窗後段重算;診斷改寫 ⇒ 正本之評估早於改寫者重補、其後者不補;評估器之指紋變(帳本之鍵變)⇒ 共同儲存區標 current: false 而值照列', async () => {
        let { P, st, ids, calls, runEval } = mk()
        await P.fill({ runEval })
        let n1 = calls.length
        //成品重做: 節點 1 之 pick.mjs 改變
        fs.appendFileSync(path.join(wdOf(st, ids[1]), 'pick.mjs'), '// v2\n', 'utf8')
        let p = P.fillPlanOf()
        assert.deepEqual(p.tasks.map((x) => [x.nodeId, x.postfit, x.ext]), [[ids[1], true, []]])
        //重做後之共同儲存區: 成品之雜湊不符 ⇒ postfit 為 null(舊值不列)
        await P.pickStore()
        let it1 = JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'picks', ids[1], 'info.json'), 'utf8'))
        assert.strictEqual(it1.postfit, null)
        await P.fill({ runEval, storeAfter: false })
        assert.deepEqual(calls.slice(n1).map((c) => [c.nodeId, c.kind]), [[ids[1], 'postfit']])
        //重算 ⇒ 節點文件之摘要之該列取代(仍只 1 列)、補算檔之鍵為新成品之雜湊
        let sum1 = P.records.getNodeDoc(ids[1]).harness.summary
        assert.equal(sum1.filter((s) => String(s).startsWith(FP.POSTFIT_HEAD)).length, 1, JSON.stringify(sum1))
        assert.equal(JSON.parse(fs.readFileSync(FK.fillFileOf(st.rsi.root, ids[1]), 'utf8')).postfit.key.pick, FK.pickHashOf(fs.readFileSync(path.join(wdOf(st, ids[1]), 'pick.mjs'))))
        //診斷改寫: dA 之內容變 ⇒ 登錄之 since = 此刻; 正本(harness_full.json 之 at 為 2026-01)早於之 ⇒ 樹上有 dA 之節點 0、1 重補 dA(節點 2 之 dA 來自補算檔而鍵之診斷雜湊不同 ⇒ 亦重補)
        fs.writeFileSync(path.join(st.records.toolboxDir, 'metrics', 'dA.mjs'), 'export default { v: 11 }\n', 'utf8')
        let n2 = calls.length
        let r = await P.fill({ runEval, storeAfter: false })
        assert.deepEqual(calls.slice(n2).map((c) => [ids.indexOf(c.nodeId), c.kind, argOfA(c.args, '--ext-only')]).sort(), [[0, 'ext', 'dA'], [1, 'ext', 'dA'], [2, 'ext', 'dA']])
        let fst = JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'fill_state.json'), 'utf8'))
        assert.notEqual(fst.registry.dA.since, null)
        assert.equal(fst.registry.dB.since, null)
        assert.deepEqual(r.results.map((x) => x.ext.ok), [['dA'], ['dA'], ['dA']])
        //其後之完整評估(harness_full.json 之 at 晚於 since)且樹上有值 ⇒ 不補: 以節點 0 為例(去掉其補算檔之 dA、正本時刻改為未來)
        let wd0 = wdOf(st, ids[0])
        let f0 = JSON.parse(fs.readFileSync(FK.fillFileOf(st.rsi.root, ids[0]), 'utf8'))
        delete f0.ext.dA
        fs.writeFileSync(FK.fillFileOf(st.rsi.root, ids[0]), JSON.stringify(f0), 'utf8')
        fs.writeFileSync(path.join(wd0, 'harness_full.json'), JSON.stringify({ ok: true, at: '2099-01-01T00:00:00.000Z' }), 'utf8')
        assert.deepEqual(P.fillPlanOf().tasks, [])
        //評估器之指紋: 帳本之鍵變 ⇒ 全部之求解窗後段過時; 共同儲存區照列舊值、current: false
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthB' }), 'utf8')
        assert.deepEqual(P.fillPlanOf({ ext: false }).tasks.map((x) => x.postfit), [true, true, true])
        await P.pickStore()
        let idx = JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'picks', 'index.json'), 'utf8'))
        assert(idx.items.every((x) => x.postfit && x.postfit.current === false && typeof x.postfit.seatsKept === 'number'))
    })

    it('extFill(既有之入口):照舊之回傳形;補算之值另存於補算檔;指名不存在之診斷拋錯;補算後共同儲存區同步', async () => {
        let { P, st, ids, calls, runEval } = mk()
        await assert.rejects(() => P.extFill({ names: ['noSuch'], runEval }), (e) => /無此擴充診斷/.test(e.message))
        let r = await P.extFill({ names: ['dB'], only: [ids[0].slice(0, 8)], runEval })
        assert.equal(r.nNodes, 1)
        assert.deepEqual(r.results.map((x) => [x.nodeId, x.ok, x.filled]), [[ids[0], true, ['dB']]])
        assert(calls.every((c) => c.kind === 'ext'), '只補擴充診斷(不算求解窗後段)')
        assert.equal(JSON.parse(fs.readFileSync(FK.fillFileOf(st.rsi.root, ids[0]), 'utf8')).ext.dB.value.board, 'dB-0-new')
        let idx = JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'picks', 'index.json'), 'utf8'))
        assert.equal(idx.items.find((x) => x.id === ids[0]).ext.dB.board, 'dB-0-new', '共同儲存區已同步')
        let r2 = await P.extFill({ names: ['dB'], only: [ids[0].slice(0, 8)], runEval })
        assert.deepEqual(r2.results, [], '已有值 ⇒ 不重算')
    })

    it('輪末鉤子:本輪審計之節點與待重試者附算(其餘入待補算);摘要列出;回傳帶 fill;附算拋錯不影響輪次', async () => {
        let st = null
        let calls = []
        let made = null
        //做夢: 依範本交付(全部採納); 評估: 假
        let dispatchOf = (getSt) => async (role, { prompt }) => {
            let s = getSt()
            let m = /請閱讀 (\S+)\/brief\.md/.exec(prompt)
            let wd = path.resolve(s.FD_ROOT, m[1])
            let tpl = JSON.parse(fs.readFileSync(path.join(wd, 'dream.template.json'), 'utf8'))
            let dream = { audits: tpl.audits.map((a) => ({ nodeId: a.nodeId, trust: 'trusted', action: 'accept', evidence: ['假審計'], issues: [] })), synthesis: { summary: '假', worked: [], failed: [], patterns: [], prevDirections: [] }, guidance: { directions: [], avoid: [], openQuestions: [], improvements: [], armProposals: [] }, expansion: [], docsUpdated: [] }
            fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify(dream), 'utf8')
            return { ok: true, agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
        }
        made = mk()
        st = made.st
        let runEval = async (a) => {
            calls.push(a)
            return made.runEval(a)
        }
        let P = makeProject(st, { dispatch: dispatchOf(() => st), gate: null, catalogFile: path.join(t.dir, 'proj', 'catalog2.json'), runEval })
        let ids = made.ids
        //節點 2 前次附算失敗而待重試
        fs.writeFileSync(path.join(st.rsi.root, 'fill_state.json'), JSON.stringify({ schema: 'arsi.fillState/1', registry: null, retry: [{ id: ids[2], n: 1, last: 'x', source: 'round' }] }), 'utf8')
        let hk = await P.domain.hooks.afterRound({ round: 1, nodes: [{ id: ids[0], status: 'executed', spec: { arms: ARMS[0], base: null } }] })
        let touched = [...new Set(calls.map((c) => c.nodeId))].sort()
        assert.deepEqual(touched, [ids[0], ids[2]].sort(), '本輪之節點 + 待重試者')
        assert(hk.lines.some((l) => l.startsWith('附算(求解窗後段與擴充診斷;佐證,不改 S):2 個成品')), JSON.stringify(hk.lines))
        assert(hk.lines.some((l) => l.startsWith('待補算之成品') && l.includes('求解窗後段 1 個')), JSON.stringify(hk.lines))
        assert.deepEqual(hk.fill, { n: 2, failed: 0, retry: 0, backlog: { postfit: 1, ext: 0 }, sec: hk.fill.sec })
        //附算於共同儲存區重產之前 ⇒ 本輪節點之列已帶 postfit
        let idx = JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'picks', 'index.json'), 'utf8'))
        assert.equal(idx.items.find((x) => x.id === ids[0]).postfit.seatsKept, 20)
        assert.strictEqual(idx.items.find((x) => x.id === ids[1]).postfit, null)
        //附算拋錯(狀態檔損毀之一例: 評估器之指紋無從求得以外之錯 —— 以注入之評估拋錯模擬)⇒ 不影響輪次
        let P2 = makeProject(st, {
            dispatch: dispatchOf(() => st),
            gate: null,
            catalogFile: path.join(t.dir, 'proj', 'catalog3.json'),
            runEval: async () => {
                throw new Error('假評估拋錯')
            }
        })
        fs.appendFileSync(path.join(wdOf(st, ids[1]), 'pick.mjs'), '// v3\n', 'utf8')
        let hk2 = await P2.domain.hooks.afterRound({ round: 2, nodes: [{ id: ids[1], status: 'executed', spec: { arms: ARMS[1], base: null } }] })
        //(本合成專案之做夢不更新 sgud/ ⇒ 鉤子另有「做夢未更新」之失敗, 與附算無關)
        assert(hk2.dream && hk2.dream.round === 2, '做夢照常套用')
        assert(!(hk2.errors || []).some((e) => /附算|評估/.test(String(e))), JSON.stringify(hk2.errors))
        assert.equal(hk2.fill.failed, 1)
        assert(hk2.lines.some((l) => l.includes('失敗者(下一次輪末重試)') && l.includes(ids[1].slice(0, 8))), JSON.stringify(hk2.lines))
        //關閉: settings.rsi.autoFill === false ⇒ 不附算、回傳無 fill
        let st3 = { ...st, rsi: { ...st.rsi, autoFill: false } }
        let n3 = calls.length
        let P3 = makeProject(st3, { dispatch: dispatchOf(() => st3), gate: null, catalogFile: path.join(t.dir, 'proj', 'catalog4.json'), runEval })
        let hk3 = await P3.domain.hooks.afterRound({ round: 3, nodes: [{ id: ids[1], status: 'executed', spec: { arms: ARMS[1], base: null } }] })
        assert.equal(calls.length, n3)
        assert.equal('fill' in hk3, false)
        assert(!hk3.lines.some((l) => l.startsWith('附算')))
    })
})
