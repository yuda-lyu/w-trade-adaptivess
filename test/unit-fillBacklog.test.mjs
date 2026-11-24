import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { makeTexts, FILL_BACKLOG_ON, FILL_BACKLOG_OFF } from '../src/domain/texts.mjs'
import { specHash } from '../src/engineApi.mjs'
import { sha } from '../src/engineProtocol.mjs'
import * as FP from '../src/domain/fillPlan.mjs'
import * as FK from '../src/domain/fillKeys.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//輪末之附算一併處理待補算(規則 R-REC-41): 輪末之附算於本輪之成品(與待重試者)處理完後, 接著處理樹上其餘之待補算
//  規格: ①與 --mode fill 同一套計畫(planFill)、同一組鍵(fillKeys)、同一個執行 ⇒ 所補之值與鍵與 --mode fill 所得者相同
//    ②依成品之先後(樹之索引之序); 總時長之上限 settings.rsi.fillBacklogSec(預設 FILL_BACKLOG_SEC; 0 = 不處理, 同改前); 達上限後不再取新者, 尚餘者列於摘要
//      (「待補算之成品」一列照舊, 另列一列本次處理數與尚餘數); 中斷可續(每個成品算完即寫入); 失敗之分類照現行
//    ③待重試之紀錄中之成品不在此列(來源為命令列或已達上限者照現行不於輪末重試)
//    ④於看板與共同儲存區重產之前完成(輪末鉤子返回後才起下一輪)⇒ 下一輪之任務書、補位與看板讀得到新補之值
//    ⑤無待補算者輪末之輸出與改前相同; --mode fill 之行為不變(不給 backlogSec)
//    ⑥做夢任務書之擴建一節之一句隨開啟與否(FILL_BACKLOG_ON / FILL_BACKLOG_OFF; 關閉者為改前之原文)
//    ⑦不重試之失敗(重跑結果相同)記於狀態檔之 blocked(sig = 該次失敗之項目之待算之鍵之指紋): 只有輪末之一併處理待補算略過「原因未變」者(sig 相同),
//      sig 不同者(診斷改寫、新增診斷、評估器或成品改變)再取一次; 本輪之成品、待重試者與 --mode fill 照現行; 無此類失敗者狀態檔不帶此欄
//  接縫不用替身: 真之樹、節點文件、補算檔、共同儲存區與輪末鉤子(含 arsi.runDream); 只有「評估之執行本身」(runEval)與計時(inject.clock)換成假的
describe('輪末之附算一併處理待補算(規則 R-REC-41)', function () {
    this.timeout(120000)
    let t
    beforeEach(() => {
        t = makeTmp('fillBacklog')
    })
    afterEach(() => {
        t.cleanup()
    })
    let ARMS = [['A01_nt'], ['A01_nt', 'B14_pitKey'], ['B14_pitKey'], ['A04_act']]
    let argOfA = (args, k) => {
        let i = args.indexOf(k); return i >= 0 ? args[i + 1] : null
    }
    //各成品之值皆不同(求解窗後段之超額、診斷之值)
    let pfOf = (k) => ({
        ok: true,
        period: { name: 'postfit', start: '2025-04-08T04:00:00', end: '2025-10-06T00:00:00' },
        score: null,
        metrics: { selHash: `pf-sel-${k}`, nullSideAct: { p: 0.01 + k / 100, z: 2 + k, excess: 10 + k }, afterFit: { seatsKept: 20 + k, seatsDropped: 5 + k, orders: 100 + k, halves: null } },
    })
    //mk, 暫存夾之專案: 4 個已執行之節點(第 1 輪)、共用工具區之兩個診斷; 正本之 ext: 節點 0 缺 dB、節點 1 皆有、節點 2 皆缺、節點 3 缺 dA
    //  rsiOver = settings.rsi 之覆寫; tick = 每次評估使假時鐘前進之毫秒(inject.clock)
    let mk = ({ rsiOver = {}, tick = 0, failOf = () => false } = {}) => {
        let st = getSettings()
        let d = path.join(t.dir, `proj_${Math.random().toString(36).slice(2, 8)}`)
        st.resources = {}
        //成員穩健性(規則 R-REC-51; 預設開啟)關閉: 本檔之範圍為求解窗後段與擴充診斷之一併處理(成員穩健性之待補算只列、不取, 見 unit-memberCheck)
        st.rsi = { ...st.rsi, fillParallel: 1, memberCheck: false, ...rsiOver }
        st.rsi.root = path.join(d, 'rsi')
        st.rsi.docLimits = false //輪末鉤子之專案文件自動整理(R-REC-17)取本庫自身之 sgud; 測試不得改寫入版控之文件(R-PKG-10)
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthBL' }), 'utf8')
        fs.mkdirSync(path.join(st.records.toolboxDir, 'metrics'), { recursive: true })
        fs.writeFileSync(path.join(st.records.toolboxDir, 'metrics', 'dA.mjs'), 'export default { v: 1 }\n', 'utf8')
        fs.writeFileSync(path.join(st.records.toolboxDir, 'metrics', 'dB.mjs'), 'export default { v: 2 }\n', 'utf8')
        let clock = { now: 1000000 }
        let calls = []
        let ids = []
        let runEval = async ({ nodeId, kind, args }) => {
            calls.push({ nodeId, kind, args })
            clock.now += tick
            let k = ids.indexOf(nodeId)
            let out = argOfA(args, '--out')
            //failOf 之回傳: true = 暫時性之失敗(離開碼 1); 'capital' = 持倉超過研究用本金(離開碼 3、EVAL_UNIT_CAPITAL); 'reverify' = 擴充診斷之重放之選集指紋與正本不同
            let f = failOf(k, kind)
            if (f === 'capital') {
                fs.writeFileSync(out, JSON.stringify({ ok: false, code: 'EVAL_UNIT_CAPITAL', error: `持倉超過研究用本金(合成 ${k}-${kind})` }), 'utf8')
                return { code: 3, timeout: false }
            }
            if (f && f !== 'reverify') {
                return { code: 1, timeout: false }
            }
            if (kind === 'postfit') {
                fs.writeFileSync(out, JSON.stringify(pfOf(k)), 'utf8')
                return { code: 0, timeout: false }
            }
            let names = argOfA(args, '--ext-only').split(',')
            fs.writeFileSync(out, JSON.stringify({ ok: true, metrics: { selHash: f === 'reverify' ? `sel-${k}-x${calls.length}` : `sel-${k}`, ext: Object.fromEntries(names.map((nm) => [nm, { board: `${nm}-${k}-v` }])) } }), 'utf8')
            return { code: 0, timeout: false }
        }
        //做夢: 依範本交付(全部採納)
        let dispatch = async (role, { prompt }) => {
            let m = /請閱讀 (\S+)\/brief\.md/.exec(prompt)
            let wd = path.resolve(st.FD_ROOT, m[1])
            let tpl = JSON.parse(fs.readFileSync(path.join(wd, 'dream.template.json'), 'utf8'))
            let dream = { audits: tpl.audits.map((a) => ({ nodeId: a.nodeId, trust: 'trusted', action: 'accept', evidence: ['假審計'], issues: [] })), synthesis: { summary: '假', worked: [], failed: [], patterns: [], prevDirections: [] }, guidance: { directions: [], avoid: [], openQuestions: [], improvements: [], armProposals: [] }, expansion: [], docsUpdated: [] }
            fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify(dream), 'utf8')
            return { ok: true, agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
        }
        let P = makeProject(st, { dispatch, gate: null, catalogFile: path.join(d, 'catalog.json'), runEval, clock: () => clock.now })
        P.rsi.init()
        for (let [k, arms] of ARMS.entries()) {
            let spec = { arms, base: null }
            let id = P.idOf(spec)
            ids.push(id)
            let wd = path.join(st.records.workDir, id)
            fs.mkdirSync(wd, { recursive: true })
            fs.writeFileSync(path.join(wd, 'pick.mjs'), `export default function pick(ctx) {\n    return [${k}]\n}\n`, 'utf8')
            fs.writeFileSync(path.join(wd, 'harness_full.json'), JSON.stringify({ ok: true, at: `2026-01-0${k + 1}T00:00:00.000Z`, metrics: { selHash: `sel-${k}` } }), 'utf8')
            let ext = [{ dA: { board: 100 } }, { dA: { board: 101 }, dB: { board: 201 } }, {}, { dB: { board: 203 } }][k]
            let metrics = { selHash: `sel-${k}`, ext, op: { eqYr: { mean: 12.5 + k, min: -1.5 - k, byPhase: [1, 2, 3].map((v) => v + k) }, monthlyOrders: { mean: 90 + k }, peakHold: { max: 30 - k }, winRate: 0.4 } }
            P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round: 1, raw: { metrics, issues: [] }, score: { S: 10 + k, ladder: 3, flags: { vetoed: false, why: [] } } })
            P.records.putNodeDoc({ nodeId: id, round: 1, attempt: 1, status: 'verified', spec, task: { goal: 'g', type: 'explore' }, plan: {}, code: {}, results: { claimed: {} }, conclusion: { outcome: 'improved', summary: `摘要 ${k}` }, harness: { ok: true, summary: [`既有之列 ${k}`], notes: [], checks: { issues: [] }, score: { S: 10 + k, ladder: 3, flags: { vetoed: false, why: [] } }, raw: { metrics } } })
        }
        let hook = (round, ks) => P.domain.hooks.afterRound({ round, nodes: ks.map((k) => ({ id: ids[k], status: 'executed', spec: { arms: ARMS[k], base: null } })) })
        return { P, st, ids, calls, runEval, clock, hook }
    }
    //valuesOf, 各成品之補算檔(去時刻)、樹之 ext、節點文件之求解窗後段之列: 與 --mode fill 所得者比對用
    let valuesOf = (x) => x.ids.map((id) => {
        let f = FK.readFill(x.st.rsi.root, id)
        let strip = (o) => (o ? JSON.parse(JSON.stringify(o, (k, v) => (k === 'at' ? undefined : v))) : null)
        let doc = x.P.records.getNodeDoc(id)
        return { fill: strip(f), ext: x.P.rsi.store.getNode(id).raw.metrics.ext, pfLine: (doc.harness.summary || []).find((s) => String(s).startsWith(FP.POSTFIT_HEAD)) || null }
    })
    //argsOf, 該成品之各次評估之參數(去 --out 之暫存路徑; 專案夾之路徑換為 <proj>, 兩份專案之暫存夾名不同)
    let projOf = (x) => path.dirname(x.st.rsi.root)
    let argsOf = (x, id) => x.calls.filter((c) => c.nodeId === id).map((c) => `${c.kind}:${c.args.filter((a, i, arr) => arr[i - 1] !== '--out').join(' ').split(projOf(x)).join('<proj>')}`).sort()
    let norm = (lines, x) => lines.map((l) => l.replace(/;\d+ 秒/, ';N 秒').split(path.relative(x.st.FD_ROOT, projOf(x)).replace(/\\/g, '/')).join('<proj>'))

    it('fillBacklogSecOf:未給或無效(負數、小數、非數字、null、NaN、布林)⇒ 預設;0 與數字字串照用', () => {
        assert.equal(FP.FILL_BACKLOG_SEC, 1800)
        for (let [v, want] of [[undefined, 1800], [0, 0], ['0', 0], [600, 600], ['600', 600], [-1, 1800], [1.5, 1800], ['x', 1800], [null, 1800], [NaN, 1800], [Infinity, 1800], [true, 1800], [[600], 1800]]) {
            assert.equal(FP.fillBacklogSecOf({ fillBacklogSec: v }), want, String(v))
        }
        assert.equal(FP.fillBacklogSecOf(null), 1800)
        assert.equal(FP.fillBacklogSecOf({}), 1800)
    })

    it('fillLinesOf:有 backlogRun 才多一列(本次處理數與尚餘數);未帶者與改前之輸出相同(字面值)', () => {
        let r = { results: [{ nodeId: 'a1b2c3d4e5', postfit: 'ok', ext: { ok: ['dA'], failed: [] }, error: null, kind: null }], backlog: { postfit: ['x1'], ext: { dA: ['x1'], dB: [] } }, sec: 12.4, source: 'round', retryInfo: [] }
        //改前(1.0.35)之輸出之字面值
        let OLD = ['附算(求解窗後段與擴充診斷;佐證,不改 S):1 個成品;求解窗後段 成功 1;擴充診斷 補入 1 項;12 秒', '待補算之成品(不在本次之範圍;以 `node g_rsi.mjs --mode fill` 補齊,可中斷續跑):求解窗後段 1 個;擴充診斷 dA 1 個']
        assert.deepEqual(FP.fillLinesOf(r), OLD)
        assert.deepEqual(FP.fillLinesOf({ ...r, backlogRun: { n: 2, rest: 1, capSec: 900 } }), [OLD[0], '附算一併處理待補算(樹上既有之成品,依成品之先後;總時長上限 900 秒):本次 2 個成品;**尚餘 1 個成品**(已達上限,留待下一次輪末)', OLD[1]])
        assert.deepEqual(FP.fillLinesOf({ ...r, backlog: { postfit: [], ext: {} }, backlogRun: { n: 3, rest: 0, capSec: 1800 } }), [OLD[0], '附算一併處理待補算(樹上既有之成品,依成品之先後;總時長上限 1800 秒):本次 3 個成品;已補齊'])
        //⑦ 略過(前次失敗而不重試、原因未變)者另註其數, 且不寫「已補齊」; skipped 0 者與未帶者逐字相同
        assert.deepEqual(FP.fillLinesOf({ ...r, backlogRun: { n: 3, rest: 0, capSec: 1800, skipped: 2 } }), [OLD[0], '附算一併處理待補算(樹上既有之成品,依成品之先後;總時長上限 1800 秒):本次 3 個成品;另 2 個前次失敗而不重試、原因未變,未取(以 `node g_rsi.mjs --mode fill --only <id>` 個別處理)', OLD[1]])
        assert.deepEqual(FP.fillLinesOf({ ...r, backlogRun: { n: 2, rest: 1, capSec: 900, skipped: 1 } })[1], '附算一併處理待補算(樹上既有之成品,依成品之先後;總時長上限 900 秒):本次 2 個成品;**尚餘 1 個成品**(已達上限,留待下一次輪末);另 1 個前次失敗而不重試、原因未變,未取(以 `node g_rsi.mjs --mode fill --only <id>` 個別處理)')
        assert.deepEqual(FP.fillLinesOf({ ...r, backlogRun: { n: 3, rest: 0, capSec: 1800, skipped: 0 } }), FP.fillLinesOf({ ...r, backlogRun: { n: 3, rest: 0, capSec: 1800 } }))
    })

    //⑧ 本次取用之待補算中有失敗者(Gitea #199 主控之裁定 2): 不寫「已補齊」, 改註失敗之個數; 無失敗且尚餘 0 者照寫「已補齊」
    let HEAD_BL = (n, cap = 1800) => `附算一併處理待補算(樹上既有之成品,依成品之先後;總時長上限 ${cap} 秒):本次 ${n} 個成品`
    let FAIL_NOTE = (f) => `;本次取用者中 **${f} 個失敗**(失敗者見「附算」與「附算之失敗而不重試」之列)`
    it('⑧ fillLinesOf:backlogRun 帶 failed(取用者中失敗之個數)⇒ 不寫「已補齊」、改註失敗之個數;與尚餘、略過併存時各自照列;failed 為 0 或未帶 ⇒ 逐字同前', () => {
        let r = { results: [{ nodeId: 'a1b2c3d4e5', postfit: 'ok', ext: { ok: ['dA'], failed: [] }, error: null, kind: null }], backlog: { postfit: [], ext: {} }, sec: 12.4, source: 'round', retryInfo: [] }
        let line = (br) => FP.fillLinesOf({ ...r, backlogRun: br })[1]
        //尚餘 0、無略過、有失敗 ⇒ 不寫「已補齊」
        assert.equal(line({ n: 3, rest: 0, capSec: 1800, failed: 2 }), HEAD_BL(3) + FAIL_NOTE(2))
        assert(!line({ n: 3, rest: 0, capSec: 1800, failed: 1 }).includes('已補齊'))
        //無失敗(未帶、0)且尚餘 0 ⇒ 照寫「已補齊」(同前)
        assert.equal(line({ n: 3, rest: 0, capSec: 1800 }), `${HEAD_BL(3)};已補齊`)
        assert.equal(line({ n: 3, rest: 0, capSec: 1800, failed: 0 }), `${HEAD_BL(3)};已補齊`)
        //尚餘 > 0 且有失敗 ⇒ 兩者皆列(尚餘在前)
        assert.equal(line({ n: 2, rest: 1, capSec: 900, failed: 1 }), `${HEAD_BL(2, 900)};**尚餘 1 個成品**(已達上限,留待下一次輪末)${FAIL_NOTE(1)}`)
        //略過與失敗併存 ⇒ 失敗在前、略過在後
        assert.equal(line({ n: 3, rest: 0, capSec: 1800, skipped: 2, failed: 1 }), `${HEAD_BL(3)}${FAIL_NOTE(1)};另 2 個前次失敗而不重試、原因未變,未取(以 \`node g_rsi.mjs --mode fill --only <id>\` 個別處理)`)
        //非正整數之 failed(負數、小數、字串、NaN)視為無
        for (let bad of [-1, 1.5, '2', NaN, null, true]) {
            assert.equal(line({ n: 3, rest: 0, capSec: 1800, failed: bad }), `${HEAD_BL(3)};已補齊`, String(bad))
        }
    })

    it('⑦ fillSigSrcOf:同一組項目與鍵者相同(與鍵之先後無關);項目、診斷之雜湊、虛無抽數、成品、評估器之任一不同者不同;only 只取所列之項目', () => {
        let kp = (p) => ({ pick: p, evaluator: 'ev1' })
        let kd = (p, h, extra = {}) => ({ pick: p, evaluator: 'ev1', diag: h, ...extra })
        let t0 = { postfit: true, ext: ['dA', 'dB'], keys: { postfit: kp('p1'), ext: { dA: kd('p1', 'ha'), dB: kd('p1', 'hb') } } }
        let s0 = FP.fillSigSrcOf(t0)
        assert.equal(s0, '{"postfit":["p1","ev1",null,null],"ext":[["dA",["p1","ev1","ha",null]],["dB",["p1","ev1","hb",null]]]}')
        assert.equal(FP.fillSigSrcOf({ ...t0, keys: { ext: { dB: kd('p1', 'hb'), dA: kd('p1', 'ha') }, postfit: { evaluator: 'ev1', pick: 'p1' } } }), s0, '與鍵之先後無關')
        for (let [why, t] of [
            ['少一個診斷', { keys: { postfit: kp('p1'), ext: { dA: kd('p1', 'ha') } } }],
            ['無求解窗後段', { keys: { postfit: null, ext: t0.keys.ext } }],
            ['診斷之雜湊', { keys: { postfit: kp('p1'), ext: { dA: kd('p1', 'ha2'), dB: kd('p1', 'hb') } } }],
            ['虛無抽數', { keys: { postfit: kp('p1'), ext: { dA: kd('p1', 'ha', { nulls: 8 }), dB: kd('p1', 'hb') } } }],
            ['成品', { keys: { postfit: kp('p2'), ext: { dA: kd('p2', 'ha'), dB: kd('p2', 'hb') } } }],
            ['評估器', { keys: { postfit: { pick: 'p1', evaluator: 'ev2' }, ext: t0.keys.ext } }],
        ]) {
            assert.notEqual(FP.fillSigSrcOf(t), s0, why)
        }
        //only: 只取所列之項目 ⇒ 與只含這些項目之任務相同
        assert.strictEqual(FP.fillSigSrcOf(t0, { postfit: false, ext: ['dB'] }), FP.fillSigSrcOf({ keys: { postfit: null, ext: { dB: kd('p1', 'hb') } } }))
        assert.equal(FP.fillSigSrcOf(t0, { postfit: true, ext: [] }), FP.fillSigSrcOf({ keys: { postfit: kp('p1'), ext: {} } }))
    })

    it('①②④ 預設開啟:本輪之節點之後依成品之先後補入其餘之待補算;所補之值、鍵與評估之參數與 --mode fill 所得者相同;看板與共同儲存區即帶其值', async () => {
        let x = mk()
        let hk = await x.hook(1, [2])
        //評估之先後: 本輪之節點 2 在前, 其後依樹之索引之序(0、1、3)
        let order = [...new Set(x.calls.map((c) => x.ids.indexOf(c.nodeId)))]
        assert.deepEqual(order, [2, 0, 1, 3])
        assert(hk.lines.includes('附算一併處理待補算(樹上既有之成品,依成品之先後;總時長上限 1800 秒):本次 3 個成品;已補齊'), JSON.stringify(hk.lines))
        assert(hk.lines.some((l) => l.startsWith('附算(求解窗後段與擴充診斷;佐證,不改 S):4 個成品')), JSON.stringify(hk.lines))
        assert(!hk.lines.some((l) => l.startsWith('待補算之成品')), '已補齊 ⇒ 無待補算之列')
        assert.deepEqual(hk.fill.backlog, { postfit: 0, ext: 0 })
        assert.equal(hk.fill.n, 4)
        assert.deepEqual(x.P.fillPlanOf().tasks, [], '全部現行')
        //④ 看板與共同儲存區於附算之後重產 ⇒ 帶新補之值(節點 2 之 dA、dB; 節點 0 之 dB)
        let board = fs.readFileSync(path.join(x.st.rsi.root, 'ARMS_BOARD.md'), 'utf8')
        assert(board.includes('dB dB-0-v') && board.includes('dA dA-2-v;dB dB-2-v'), '看板帶新補之值')
        let idx = JSON.parse(fs.readFileSync(path.join(x.st.rsi.root, 'picks', 'index.json'), 'utf8'))
        assert.equal(idx.items.find((it) => it.id === x.ids[3]).ext.dA.board, 'dA-3-v')
        assert.equal(idx.items.find((it) => it.id === x.ids[1]).postfit.seatsKept, 21)
        //① 與 --mode fill(全部成品、targets = null)所得者相同: 同一棵樹之另一份專案
        let y = mk()
        let r = await y.P.fill({ runEval: y.runEval, storeAfter: false })
        assert.equal(r.results.length, 4)
        assert.deepStrictEqual(valuesOf(x), valuesOf(y), '補算檔(去時刻)、樹之 ext、節點文件之求解窗後段之列')
        for (let k = 0; k < 4; k++) {
            assert.deepEqual(argsOf(x, x.ids[k]), argsOf(y, y.ids[k]), `節點 ${k} 之評估之參數`)
        }
        //鑑別前提: 關閉者(fillBacklogSec 0)只算本輪之節點 ⇒ 其餘之值不同
        let z = mk({ rsiOver: { fillBacklogSec: 0 } })
        let hz = await z.hook(1, [2])
        assert.deepEqual([...new Set(z.calls.map((c) => z.ids.indexOf(c.nodeId)))], [2])
        assert.notDeepEqual(valuesOf(z), valuesOf(y))
        assert(hz.lines.some((l) => l.startsWith('待補算之成品')) && !hz.lines.some((l) => l.startsWith('附算一併處理待補算')))
    })

    it('① 第一輪後新增一個診斷檔:第二輪之輪末把第一輪之成品一併補入(其值與 --mode fill 所得者相同)', async () => {
        let x = mk()
        await x.P.fill({ runEval: x.runEval, storeAfter: false })
        assert.deepEqual(x.P.fillPlanOf().tasks, [], '第一輪後全部現行(鑑別前提)')
        fs.writeFileSync(path.join(x.st.records.toolboxDir, 'metrics', 'dC.mjs'), 'export default { v: 3 }\n', 'utf8')
        let n0 = x.calls.length
        let hk = await x.hook(2, [1])
        let c2 = x.calls.slice(n0)
        assert.deepEqual(c2.map((c) => [x.ids.indexOf(c.nodeId), c.kind, argOfA(c.args, '--ext-only')]), [[1, 'ext', 'dC'], [0, 'ext', 'dC'], [2, 'ext', 'dC'], [3, 'ext', 'dC']])
        assert(hk.lines.includes('附算一併處理待補算(樹上既有之成品,依成品之先後;總時長上限 1800 秒):本次 3 個成品;已補齊'), JSON.stringify(hk.lines))
        for (let k = 0; k < 4; k++) {
            assert.deepEqual(x.P.rsi.store.getNode(x.ids[k]).raw.metrics.ext.dC, { board: `dC-${k}-v` })
        }
        //與 --mode fill 所得者相同: 另一份專案先全補、再加 dC、再以 --mode fill 補
        let y = mk()
        await y.P.fill({ runEval: y.runEval, storeAfter: false })
        fs.writeFileSync(path.join(y.st.records.toolboxDir, 'metrics', 'dC.mjs'), 'export default { v: 3 }\n', 'utf8')
        await y.P.fill({ runEval: y.runEval, storeAfter: false })
        assert.deepStrictEqual(valuesOf(x), valuesOf(y))
    })

    it('② 總時長之上限:達上限後不再取新者(已開始者照常完成),尚餘者列於摘要;下一次輪末續算(中斷可續)', async () => {
        //假時鐘: 每次評估前進 400 秒; 上限 1000 秒 ⇒ 本輪之節點 2(2 次評估 = 800 秒)後尚未達上限 ⇒ 取節點 0(1 次 = 1200 秒)⇒ 達上限, 節點 1、3 不取
        let x = mk({ rsiOver: { fillBacklogSec: 1000 }, tick: 400000 })
        let hk = await x.hook(1, [2])
        assert.deepEqual([...new Set(x.calls.map((c) => x.ids.indexOf(c.nodeId)))], [2, 0])
        assert(hk.lines.includes('附算一併處理待補算(樹上既有之成品,依成品之先後;總時長上限 1000 秒):本次 1 個成品;**尚餘 2 個成品**(已達上限,留待下一次輪末)'), JSON.stringify(hk.lines))
        //「待補算之成品」一列照舊(只列尚餘者): 節點 1、3 之求解窗後段, 節點 3 之 dA
        assert(hk.lines.includes('待補算之成品(不在本次之範圍;以 `node g_rsi.mjs --mode fill` 補齊,可中斷續跑):求解窗後段 2 個;擴充診斷 dA 1 個'), JSON.stringify(hk.lines))
        assert.deepEqual(hk.fill.backlog, { postfit: 2, ext: 1 })
        assert(FK.readFill(x.st.rsi.root, x.ids[0]) && !FK.readFill(x.st.rsi.root, x.ids[1]) && !FK.readFill(x.st.rsi.root, x.ids[3]), '已取者已寫入、未取者未寫')
        //下一次輪末(本輪無新節點之重做: 以節點 0 為本輪之節點)⇒ 續算節點 1、3
        x.calls.length = 0
        let hk2 = await x.hook(2, [0])
        assert.deepEqual([...new Set(x.calls.map((c) => x.ids.indexOf(c.nodeId)))], [1, 3], '節點 0 已現行 ⇒ 不評估;續算尚餘者')
        assert(hk2.lines.includes('附算一併處理待補算(樹上既有之成品,依成品之先後;總時長上限 1000 秒):本次 2 個成品;已補齊'), JSON.stringify(hk2.lines))
        assert.deepEqual(x.P.fillPlanOf().tasks, [])
    })

    it('② 併行(2 個工作者)時:第 2 個以後之工作者過資源閘後再核一次上限(過閘期間已達上限者不取)', async () => {
        //假時鐘: 每次評估前進 400 秒; 上限 600 秒。工作者 1 取本輪之節點 2(其第一次評估 ⇒ 400 秒)後, 工作者 2 於 400 秒時核上限(未達)而過資源閘;
        //  過閘之後工作者 1 已做第二次評估(800 秒)⇒ 工作者 2 再核一次即達上限而不取 ⇒ 待補算 0 個
        //  (資源閘於無門檻時立即放行; 先後由微任務之次序決定, 不依計時器)
        //  時點(規則 R-REC-51): 本輪之節點之求解窗後段移到派做夢之前 ⇒ 輪末鉤子之做夢之後之一次只剩一次評估, 本案之先後不再出現 ⇒
        //  以 fill 直接呼叫(輪末之做夢之後之一次之同一組參數: targets、source 'round'、backlogSec)保留「本次之待算兩次評估 + 待補算」之先後
        let run = (x) => x.P.fill({ targets: [x.ids[2]], storeAfter: false, source: 'round', backlogSec: FP.fillBacklogSecOf(x.st.rsi), runEval: x.runEval })
        let x = mk({ rsiOver: { fillBacklogSec: 600, fillParallel: 2 }, tick: 400000 })
        let hk = await run(x)
        assert.deepEqual([...new Set(x.calls.map((c) => x.ids.indexOf(c.nodeId)))], [2])
        assert(hk.lines.includes('附算一併處理待補算(樹上既有之成品,依成品之先後;總時長上限 600 秒):本次 0 個成品;**尚餘 3 個成品**(已達上限,留待下一次輪末)'), JSON.stringify(hk.lines))
        //對照(鑑別前提): 上限足夠 ⇒ 兩個工作者把待補算全部取完
        let y = mk({ rsiOver: { fillBacklogSec: 1000000, fillParallel: 2 }, tick: 400000 })
        await run(y)
        assert.deepEqual([...new Set(y.calls.map((c) => y.ids.indexOf(c.nodeId)))].sort(), [0, 1, 2, 3])
    })

    it('②③ 失敗之分類照現行(暫時性之失敗入待重試、來源為輪末 ⇒ 下一次輪末重試);待重試之紀錄中之成品(來源為命令列、已達上限)不在一併處理之列', async () => {
        //節點 3 之求解窗後段失敗(暫時性)
        let x = mk({ failOf: (k, kind) => k === 3 && kind === 'postfit' })
        //節點 1 為命令列留下之待重試(輪末不自動重試)
        fs.writeFileSync(path.join(x.st.rsi.root, 'fill_state.json'), JSON.stringify({ schema: 'arsi.fillState/1', registry: null, retry: [{ id: x.ids[1], n: 1, last: 'x', source: 'cli' }] }), 'utf8')
        let hk = await x.hook(1, [2])
        assert.deepEqual([...new Set(x.calls.map((c) => x.ids.indexOf(c.nodeId)))], [2, 0, 3], '節點 1(命令列之待重試)不取')
        let fst = JSON.parse(fs.readFileSync(path.join(x.st.rsi.root, 'fill_state.json'), 'utf8'))
        assert.deepEqual(fst.retry.map((r) => [x.ids.indexOf(r.id), r.source, r.n]).sort(), [[1, 'cli', 1], [3, 'round', 1]].sort())
        assert(hk.lines.some((l) => l.includes('失敗者(下一次輪末重試)') && l.includes(x.ids[3].slice(0, 8))), JSON.stringify(hk.lines))
        assert(hk.lines.includes('待重試而來源為命令列者 1 個(輪末不自動重試;以 `node g_rsi.mjs --mode fill` 重試)'), JSON.stringify(hk.lines))
        //已達上限之待重試(來源為輪末、n = 3)亦不取
        let y = mk()
        fs.writeFileSync(path.join(y.st.rsi.root, 'fill_state.json'), JSON.stringify({ schema: 'arsi.fillState/1', registry: null, retry: [{ id: y.ids[3], n: 3, last: 'x', source: 'round' }] }), 'utf8')
        await y.hook(1, [2])
        assert.deepEqual([...new Set(y.calls.map((c) => y.ids.indexOf(c.nodeId)))], [2, 0, 1], '節點 3(已達上限)不取')
    })

    it('⑧ 本次取用之待補算中有失敗者(暫時性、重跑結果相同)⇒ 不寫「已補齊」、註失敗之個數(只計取用之待補算;本輪之成品之失敗不計);無失敗者照寫「已補齊」', async () => {
        //節點 3(待補算)之求解窗後段失敗(暫時性): 取用者 0、1、3 ⇒ 失敗 1
        //  fillOf = fill 之直接呼叫(取回傳之 backlogRun 之 failed 欄); hook = 輪末鉤子(取摘要之列)
        let fillOf = (x) => x.P.fill({ targets: [x.ids[2]], source: 'round', backlogSec: 1800, runEval: x.runEval, storeAfter: false })
        let x = mk({ failOf: (k, kind) => k === 3 && kind === 'postfit' })
        let hk = await x.hook(1, [2])
        assert.deepEqual([...new Set(x.calls.map((c) => x.ids.indexOf(c.nodeId)))], [2, 0, 1, 3])
        assert(hk.lines.includes(`${HEAD_BL(3)}${FAIL_NOTE(1)}`), JSON.stringify(hk.lines))
        assert(!hk.lines.some((l) => l.includes('已補齊')), JSON.stringify(hk.lines))
        let x2 = mk({ failOf: (k, kind) => k === 3 && kind === 'postfit' })
        assert.equal((await fillOf(x2)).backlogRun.failed, 1)
        //節點 0(capital)與節點 3(擴充診斷之 reverify): 重跑結果相同之失敗亦計(2 個); 節點 3 只有擴充診斷失敗(鑑別: 不只計求解窗後段之失敗)
        let failY = (k, kind) => (k === 0 ? 'capital' : (k === 3 && kind === 'ext' ? 'reverify' : false))
        let y = mk({ failOf: failY })
        let hky = await y.hook(1, [2])
        assert(hky.lines.includes(`${HEAD_BL(3)}${FAIL_NOTE(2)}`), JSON.stringify(hky.lines))
        assert(hky.lines.some((l) => l.startsWith('附算之失敗而不重試:')), '失敗之內容見「附算之失敗而不重試」之列(提示所指)')
        assert.equal((await fillOf(mk({ failOf: failY }))).backlogRun.failed, 2)
        //本輪之成品(節點 2)失敗而待補算皆成功 ⇒ 不計於取用者之失敗 ⇒ 照寫「已補齊」、backlogRun 不帶 failed
        let failZ = (k, kind) => k === 2 && kind === 'postfit'
        let z = mk({ failOf: failZ })
        let hkz = await z.hook(1, [2])
        assert(hkz.lines.some((l) => l.includes('失敗者(下一次輪末重試)') && l.includes(z.ids[2].slice(0, 8))), '節點 2 失敗(鑑別前提)')
        assert(hkz.lines.includes(`${HEAD_BL(3)};已補齊`), JSON.stringify(hkz.lines))
        let rz = await fillOf(mk({ failOf: failZ }))
        assert.equal(rz.results.filter((r) => r.postfit === 'failed').length, 1, '本次之範圍內有失敗(鑑別前提)')
        assert.equal('failed' in rz.backlogRun, false)
        //全部成功 ⇒ 照寫「已補齊」、backlogRun 不帶 failed
        let w = mk()
        let hkw = await w.hook(1, [2])
        assert(hkw.lines.includes(`${HEAD_BL(3)};已補齊`), JSON.stringify(hkw.lines))
        assert.equal('failed' in (await fillOf(mk())).backlogRun, false)
    })

    it('⑤ 無待補算者:輪末之輸出、評估與改前相同(與關閉者逐列相同);只做夢輪次亦一併處理(開啟時)', async () => {
        let run = async (rsiOver) => {
            let x = mk({ rsiOver })
            await x.P.fill({ runEval: x.runEval, storeAfter: false })
            fs.appendFileSync(path.join(x.st.records.workDir, x.ids[2], 'pick.mjs'), '// v2\n', 'utf8')
            x.calls.length = 0
            let hk = await x.hook(2, [2])
            return { hk, x, calls: x.calls.map((c) => [x.ids.indexOf(c.nodeId), c.kind]) }
        }
        let on = await run({})
        let off = await run({ fillBacklogSec: 0 })
        assert.deepEqual(norm(on.hk.lines, on.x), norm(off.hk.lines, off.x))
        assert.deepEqual(on.calls, off.calls)
        assert.deepEqual({ ...on.hk.fill, sec: 0 }, { ...off.hk.fill, sec: 0 })
        assert(!on.hk.lines.some((l) => l.startsWith('附算一併處理待補算')))
        //只做夢輪次(本輪無節點): 開啟者一併處理待補算
        let x = mk()
        x.P.requestDreamOnly({ why: '只做夢' })
        let hk = await x.hook(3, [])
        assert(hk.dream && hk.dream.dreamOnly === true, '只做夢輪次(鑑別前提)')
        assert.deepEqual([...new Set(x.calls.map((c) => x.ids.indexOf(c.nodeId)))], [0, 1, 2, 3])
        assert(hk.lines.includes('附算一併處理待補算(樹上既有之成品,依成品之先後;總時長上限 1800 秒):本次 4 個成品;已補齊'), JSON.stringify(hk.lines))
    })

    it('⑤ --mode fill 之行為不變(不給 backlogSec ⇒ targets 以外者照列為待補算、不評估)', async () => {
        let x = mk()
        let r = await x.P.fill({ targets: [x.ids[2]], runEval: x.runEval, storeAfter: false })
        assert.deepEqual([...new Set(x.calls.map((c) => x.ids.indexOf(c.nodeId)))], [2])
        assert.deepEqual(r.backlog, { postfit: [x.ids[0], x.ids[1], x.ids[3]].sort(), ext: { dA: [x.ids[3]], dB: [x.ids[0]] } })
        assert.equal('backlogRun' in r, false)
    })

    //⑦ 不重試之失敗(config / capital / integrity / reverify)之紀錄: 狀態檔之 blocked = [{ id, kind, sig }](sig = 該次失敗之項目之待算之鍵之指紋)
    //  只有輪末之一併處理待補算會略過「紀錄之 sig 與現行之待算之 sig 相同」者(原因未變 ⇒ 重跑結果相同); 本輪之成品、待重試者、--mode fill 照現行
    let SKIP_LINE = (n, k) => `附算一併處理待補算(樹上既有之成品,依成品之先後;總時長上限 1800 秒):本次 ${n} 個成品;另 ${k} 個前次失敗而不重試、原因未變,未取(以 \`node g_rsi.mjs --mode fill --only <id>\` 個別處理)`
    let fstOf = (x) => JSON.parse(fs.readFileSync(path.join(x.st.rsi.root, 'fill_state.json'), 'utf8'))
    let rawStOf = (x) => fs.readFileSync(path.join(x.st.rsi.root, 'fill_state.json'), 'utf8')
    let nodesCalled = (x) => [...new Set(x.calls.map((c) => x.ids.indexOf(c.nodeId)))]
    //sigNow, 該成品現行之完整待算(求解窗後段 + 全部診斷)之指紋
    let sigNow = (x, k) => sha(FP.fillSigSrcOf(x.P.fillPlanOf({ targets: [x.ids[k]] }).tasks[0]), 16)

    it('⑦①② 待補算之成品得不重試之失敗(capital;另一個 reverify)⇒ 記入;下一次輪末不再執行、摘要註明略過;診斷改寫或新增 ⇒ 再取一次', async () => {
        let failing = true
        //節點 0: 求解窗後段與擴充診斷皆 capital; 節點 3: 求解窗後段成功、擴充診斷 reverify(失敗之項目只有 dA)
        let x = mk({ failOf: (k, kind) => (!failing ? false : k === 0 ? 'capital' : (k === 3 && kind === 'ext' ? 'reverify' : false)) })
        let hk = await x.hook(1, [2])
        assert.deepEqual(nodesCalled(x), [2, 0, 1, 3])
        assert(hk.lines.includes(`附算之失敗而不重試:${x.ids[0].slice(0, 8)}(持倉超過研究用本金)、${x.ids[3].slice(0, 8)}(須重驗:選集指紋與正本不同)`), JSON.stringify(hk.lines))
        let want = [[0, 'capital'], [3, 'reverify']].map(([k, kind]) => ({ id: x.ids[k], kind, sig: sigNow(x, k) })).sort((a, b) => (a.id < b.id ? -1 : 1))
        assert.deepEqual(fstOf(x).blocked, want, '記入狀態檔(依 id 排序)')
        assert.deepEqual(x.P.fillPlanOf({ targets: [x.ids[3]] }).tasks[0].ext, ['dA'], '節點 3 只剩 dA 待算(求解窗後段已成功; 鑑別前提)')
        //① 下一次輪末: 兩者皆略過(評估之呼叫 0 次); 仍列於「待補算之成品」; 不寫「已補齊」; 狀態檔不改寫
        let raw1 = rawStOf(x)
        x.calls.length = 0
        let hk2 = await x.hook(2, [1])
        assert.deepEqual(x.calls, [], '不再執行')
        assert(hk2.lines.includes(SKIP_LINE(0, 2)), JSON.stringify(hk2.lines))
        assert(hk2.lines.includes('待補算之成品(不在本次之範圍;以 `node g_rsi.mjs --mode fill` 補齊,可中斷續跑):求解窗後段 1 個;擴充診斷 dA 1 個、dB 1 個'), JSON.stringify(hk2.lines))
        assert(!hk2.lines.some((l) => l.includes('已補齊')))
        assert.equal(rawStOf(x), raw1, '狀態檔逐位不變')
        //② 診斷改寫(dA 之雜湊改變)⇒ 兩者之待算之鍵皆變 ⇒ 再取一次(仍失敗 ⇒ 以新之指紋記入); 其後無改變之輪末又略過
        fs.writeFileSync(path.join(x.st.records.toolboxDir, 'metrics', 'dA.mjs'), 'export default { v: 11 }\n', 'utf8')
        x.calls.length = 0
        let hk3 = await x.hook(3, [1])
        assert.deepEqual(nodesCalled(x), [1, 0, 2, 3])
        //(節點 0、3 再取一次而仍失敗 ⇒ 不寫「已補齊」, 註失敗之個數; Gitea #199 主控之裁定 2)
        assert(hk3.lines.includes(`${HEAD_BL(3)}${FAIL_NOTE(2)}`), JSON.stringify(hk3.lines))
        assert(!hk3.lines.some((l) => l.includes('已補齊')), JSON.stringify(hk3.lines))
        assert.deepEqual(fstOf(x).blocked.map((b) => [x.ids.indexOf(b.id), b.sig === sigNow(x, x.ids.indexOf(b.id))]).sort(), [[0, true], [3, true]])
        assert.notDeepEqual(fstOf(x).blocked, want, '指紋已更新')
        x.calls.length = 0
        let hk4 = await x.hook(4, [1])
        assert.deepEqual(x.calls, [])
        assert(hk4.lines.includes(SKIP_LINE(0, 2)), JSON.stringify(hk4.lines))
        //② 新增診斷 ⇒ 待算之項目改變 ⇒ 再取一次
        fs.writeFileSync(path.join(x.st.records.toolboxDir, 'metrics', 'dC.mjs'), 'export default { v: 3 }\n', 'utf8')
        x.calls.length = 0
        await x.hook(5, [1])
        assert.deepEqual(nodesCalled(x), [1, 0, 2, 3])
        //③ --mode fill(命令列)不略過: 仍失敗者照常執行、紀錄以同一指紋留存; 原因消失後成功 ⇒ 自紀錄移除(只有此欄改變亦改寫狀態檔; 無紀錄者不帶此欄)
        x.calls.length = 0
        let r1 = await x.P.fill({ targets: [x.ids[0]], runEval: x.runEval, storeAfter: false })
        assert.deepEqual(nodesCalled(x), [0], '命令列之範圍內者照常執行')
        assert.deepEqual(r1.blocked.map((b) => [b.id, b.kind]), [[x.ids[0], 'capital']])
        let bl5 = fstOf(x).blocked
        failing = false
        x.calls.length = 0
        let r2 = await x.P.fill({ runEval: x.runEval, storeAfter: false })
        assert.deepEqual(nodesCalled(x).sort(), [0, 3])
        assert.deepEqual(r2.blocked, [])
        assert(bl5.length === 2 && !('blocked' in fstOf(x)), '成功者自紀錄移除; 無紀錄 ⇒ 不帶此欄')
        assert.deepEqual(Object.keys(fstOf(x)), ['schema', 'updatedAt', 'evaluator', 'registry', 'retry'])
        assert.deepEqual(x.P.fillPlanOf().tasks, [])
    })

    it('⑦③ 紀錄之移除:已不在附算之節點之列、或已不需計算(未執行亦然)者移除;其餘沿用', async () => {
        let failing = true
        //節點 0: 全部 capital; 節點 2(本輪之成品): 只有求解窗後段 capital; 節點 3: 擴充診斷(只有 dA)reverify
        let x = mk({ failOf: (k, kind) => (!failing ? false : (k === 0 || (k === 2 && kind === 'postfit')) ? 'capital' : (k === 3 && kind === 'ext' ? 'reverify' : false)) })
        await x.hook(1, [2])
        assert.deepEqual(fstOf(x).blocked.map((b) => [x.ids.indexOf(b.id), b.kind]).sort(), [[0, 'capital'], [2, 'capital'], [3, 'reverify']])
        //節點 0 之成品夾移除(不在附算之節點之列); 診斷 dA 自共用工具區移除(節點 3 已無待算; 未執行); 節點 2 之求解窗後段仍待算
        fs.rmSync(path.join(x.st.records.workDir, x.ids[0]), { recursive: true, force: true })
        fs.rmSync(path.join(x.st.records.toolboxDir, 'metrics', 'dA.mjs'))
        x.calls.length = 0
        let r = await x.P.fill({ targets: [x.ids[1]], runEval: x.runEval, storeAfter: false })
        assert.deepEqual(x.calls, [], '本次無評估(鑑別前提: 移除不依執行)')
        assert.deepEqual(r.skipped, [`${x.ids[0].slice(0, 8)}(工作夾無 pick.mjs)`], '節點 0 不在附算之節點之列(鑑別前提)')
        assert.deepEqual(fstOf(x).blocked, [{ id: x.ids[2], kind: 'capital', sig: sigNow(x, 2) }], '節點 0、3 移除; 節點 2 仍待算 ⇒ 沿用')
        //節點 2 以命令列補齊 ⇒ 移除
        failing = false
        await x.P.fill({ targets: [x.ids[2]], runEval: x.runEval, storeAfter: false })
        assert(!('blocked' in fstOf(x)))
    })

    it('⑦④ 舊狀態檔(無此欄)、無不重試之失敗 ⇒ 狀態檔之欄與改前相同、無改變之輪末不改寫;摘要不帶略過之註', async () => {
        let x = mk()
        await x.P.fill({ targets: [x.ids[2]], runEval: x.runEval, storeAfter: false })
        assert.deepEqual(Object.keys(fstOf(x)), ['schema', 'updatedAt', 'evaluator', 'registry', 'retry'], '無此類失敗 ⇒ 不寫此欄')
        let hk = await x.hook(1, [2])
        assert(hk.lines.includes('附算一併處理待補算(樹上既有之成品,依成品之先後;總時長上限 1800 秒):本次 3 個成品;已補齊'), JSON.stringify(hk.lines))
        assert(!hk.lines.some((l) => l.includes('前次失敗而不重試')))
        let raw = rawStOf(x)
        x.calls.length = 0
        let hk2 = await x.hook(2, [2])
        assert.deepEqual(x.calls, [])
        assert.equal(rawStOf(x), raw, '無改變 ⇒ 不改寫')
        assert(!hk2.lines.some((l) => l.startsWith('附算一併處理待補算')))
        //舊檔之此欄形狀不合者視為空(不當作損毀): 其餘之欄照讀
        fs.writeFileSync(path.join(x.st.rsi.root, 'fill_state.json'), JSON.stringify({ ...fstOf(x), blocked: [{ id: x.ids[0] }, 5, { id: x.ids[1], kind: 'transient', sig: 'abc' }] }), 'utf8')
        let r = await x.P.fill({ targets: [x.ids[1]], runEval: x.runEval, storeAfter: false })
        assert(!r.stateNote, '不當作損毀')
        assert(!('blocked' in fstOf(x)), '形狀不合之項略去 ⇒ 改寫為無此欄')
    })

    it('⑦⑤ 本輪之成品得不重試之失敗 ⇒ 記入;下一次輪末其在待補算內而被略過(同關閉者之「只列不跑」);再為本輪之成品時照常執行', async () => {
        let failOf = (k) => (k === 2 ? 'capital' : false)
        let x = mk({ failOf })
        await x.hook(1, [2])
        assert.deepEqual(fstOf(x).blocked.map((b) => [x.ids.indexOf(b.id), b.kind]), [[2, 'capital']])
        x.calls.length = 0
        let hk2 = await x.hook(2, [1])
        assert.deepEqual(x.calls, [])
        assert(hk2.lines.includes(SKIP_LINE(0, 1)), JSON.stringify(hk2.lines))
        assert(hk2.lines.includes('待補算之成品(不在本次之範圍;以 `node g_rsi.mjs --mode fill` 補齊,可中斷續跑):求解窗後段 1 個;擴充診斷 dA 1 個、dB 1 個'), JSON.stringify(hk2.lines))
        //關閉者(改前): 第二次輪末亦不執行節點 2(只算本輪之節點 1)
        let z = mk({ rsiOver: { fillBacklogSec: 0 }, failOf })
        await z.hook(1, [2])
        z.calls.length = 0
        await z.hook(2, [1])
        assert.deepEqual(nodesCalled(z), [1])
        //本輪之成品(targets)不受此欄影響
        x.calls.length = 0
        await x.hook(3, [2])
        assert.deepEqual(nodesCalled(x), [2])
    })

    it('⑥ 做夢任務書之擴建一節:開啟者為 FILL_BACKLOG_ON、關閉者(0 或 autoFill false)為改前之原文', () => {
        let st0 = getSettings()
        let toolbox = { dir: 'rsi/toolbox', index: 'rsi/toolbox/README.md', indexName: 'README.md', nTools: 3 }
        let node = { nodeId: 'n1', arms: ['A04_act'], base: null, S: -12.3, worst: -30.1, excess: 8.2, ladder: 0, vetoed: false, claimedS: -12.3, nEvals: 6, nFull: 4, nFullSel: 4, issues: [], from: null, type: 'explore', docMd: 'd.md', workDir: 'rsi/work/n1' }
        let brief = (rsiOver) => makeTexts({ st: { ...st0, rsi: { ...st0.rsi, guides: false, ...rsiOver } }, FD_ROOT: st0.FD_ROOT, nStrategies: 70000 }).dreamBrief({ round: 9, nodeIds: ['n1'], reworkedIds: [], workDir: path.join(st0.records.workDir, 'dream_r009'), context: { nodes: [node], failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '2. 更新文件', toolbox } })
        let cnt = (s, p) => s.split(p).length - 1
        for (let [name, over, on] of [['預設', {}, true], ['600', { fillBacklogSec: 600 }, true], ['數字字串', { fillBacklogSec: '600' }, true], ['無效 ⇒ 預設', { fillBacklogSec: -5 }, true], ['0', { fillBacklogSec: 0 }, false], ['autoFill false', { autoFill: false }, false]]) {
            let b = brief(over)
            assert.equal(cnt(b, FILL_BACKLOG_ON), on ? 1 : 0, name)
            assert.equal(cnt(b, FILL_BACKLOG_OFF), on ? 0 : 1, name)
        }
        //兩者除該句外逐字相同
        assert.equal(brief({}).split(FILL_BACKLOG_ON).join(FILL_BACKLOG_OFF), brief({ fillBacklogSec: 0 }))
        //改前之原文(字面值)
        assert.equal(FILL_BACKLOG_OFF, '要讓既有節點也有其值,於改進項(迴圈架構)寫「請主控補算 <診斷名>」(主控以現行評估器重放各成品、只併入該診斷之輸出,不動數字),並註明該診斷是否用到虛無。')
    })
})
