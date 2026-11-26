import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import * as CN from '../src/eval/cfgNum.mjs'
import * as FT from '../src/domain/factsText.mjs'
import { summaryOf, notesOf } from '../src/domain/verify.mjs'
import { getSettings } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { specHash } from '../src/engineApi.mjs'
import { makeTmp, writeSynthLedger, FD_ROOT } from './tools/synthLedger.mjs'


//相位數取該結果實際所算者(排程第 547 項②之接續; 原取設定之 eval.phases 之長度: --mode quick 實算 2 個相位而畫面寫「七相位」)
//  規格之句: ① 說明某一次評估之結果之相位數之文字(g_eval 畫面之新鮮度列、輪末摘要、節點文件)= 該結果之 metrics.phases 之長度(無此欄者取 op.eqYr.byPhase 之長度);
//    ② 說明一組結果(看板、搜尋地圖、共同儲存區之總表與一頁摘要之欄標、側別讀數)之相位數 = 各列之相位數(皆同者); 各列不同、或皆無此欄者取設定之 eval.phases 之長度(未給 = 7);
//    ③ 單一定義(phaseCountOfMetrics、phaseCountOfAll 在 src/eval/cfgNum.mjs); ④ 預設(皆 7 個相位)與寫死時逐字相同;
//    ⑤ 說明正本評估之設定者(任務書、合約之參考版、回測期旗標之判讀 flags.why)與外部提供之正負號(保留期、其他標的)取設定之長度(無實算之結果可取)
//  修前(取設定之長度)之紅: 各案之「實算 ≠ 設定」者
let SRC = path.join(FD_ROOT, 'src')

describe('相位數取實際所算者(排程第 547 項②之接續)', function () {
    this.timeout(300000)
    let t = makeTmp('phaseActual')
    after(() => t.cleanup())

    describe('單一定義: phaseCountOfMetrics、phaseCountOfAll', () => {
        it('phaseCountOfMetrics: metrics.phases 之長度優先, 其次 op.eqYr.byPhase 之長度; 兩者皆無或非非空陣列者 null', () => {
            assert.strictEqual(CN.phaseCountOfMetrics({ phases: [0, 3] }), 2)
            assert.strictEqual(CN.phaseCountOfMetrics({ phases: [0, 3], op: { eqYr: { byPhase: [1, 2, 3] } } }), 2, 'phases 優先')
            assert.strictEqual(CN.phaseCountOfMetrics({ op: { eqYr: { byPhase: [1, 2, 3] } } }), 3)
            assert.strictEqual(CN.phaseCountOfMetrics({ phases: [], op: { eqYr: { byPhase: [1, 2] } } }), 2, '空之 phases 不採')
            assert.strictEqual(CN.phaseCountOfMetrics({ phases: 'x', op: { eqYr: { byPhase: 5 } } }), null)
            assert.strictEqual(CN.phaseCountOfMetrics({ op: { eqYr: { byPhase: [] } } }), null)
            for (let v of [undefined, null, 0, '', {}, [], { op: null }, { op: { eqYr: null } }]) {
                assert.strictEqual(CN.phaseCountOfMetrics(v), null)
            }
            assert.strictEqual(FT.phaseCountOfMetrics, CN.phaseCountOfMetrics, 'factsText.mjs 再匯出同一函數')
            assert.strictEqual(FT.phaseCountOfAll, CN.phaseCountOfAll)
        })

        it('phaseCountOfAll: 各列皆同者取該數(null 之列不計); 各列不同或皆無者取設定之長度(未給 = 7)', () => {
            let ev3 = { phases: [0, 1, 3] }
            assert.strictEqual(CN.phaseCountOfAll([2, 2, 2], ev3), 2)
            assert.strictEqual(CN.phaseCountOfAll([null, 2, null], ev3), 2)
            assert.strictEqual(CN.phaseCountOfAll([2, 7], ev3), 3, '各列不同 ⇒ 設定')
            assert.strictEqual(CN.phaseCountOfAll([], ev3), 3)
            assert.strictEqual(CN.phaseCountOfAll([null], ev3), 3)
            assert.strictEqual(CN.phaseCountOfAll([null, null], undefined), 7)
            assert.strictEqual(CN.phaseCountOfAll([5], null), 5)
            assert.strictEqual(CN.phaseCountOfAll([0, 0], ev3), 3, '0 不計(長度為 0 之 byPhase 不是實算之相位數)')
            assert.strictEqual(CN.phaseCountOfAll([-1, 2.5, 2], ev3), 2, '負數與小數不計')
            assert.strictEqual(CN.phaseCountOfAll([2, 2], { phases: [0, 1, 3] }), 2, '設定不同於各列 ⇒ 仍取各列(鑑別: 設定 3 ≠ 各列 2)')
            assert.strictEqual(CN.phaseCountOfAll(undefined, ev3), 3, '非陣列 ⇒ 設定')
        })

        it('節點文件(verify.mjs 之 summaryOf 欄標、notesOf 新鮮度列)取結果之相位數: phases 優先於 byPhase; 皆無者 7(同改前)', () => {
            let mk = (phases, byPhase) => ({ ...(phases ? { phases } : {}), op: { eqYr: { mean: 1, min: 0, byPhase }, monthlyOrders: { mean: 1 }, peakHold: { max: 1 }, nDecisions: byPhase || [] }, null: null, selHash: 'h', fresh: { 7: { eqYr: { mean: 3.14 } } } })
            let label = (m) => summaryOf(m, { S: 1, ladder: 1 }).find((x) => x.key === 'eqYrMean').label
            assert.strictEqual(label(mk([0, 3], [1, 2, 3, 4, 5, 6, 7])), '等效年化 二相位平均(%;回測期)', 'phases 優先於 byPhase')
            assert.strictEqual(label(mk(null, [1, 2, 3])), '等效年化 三相位平均(%;回測期)')
            assert.strictEqual(label(mk(null, undefined)), '等效年化 七相位平均(%;回測期)')
            assert.strictEqual(notesOf(mk([0, 3], [1, 2, 3, 4, 5, 6, 7])).find((l) => l.startsWith('新鮮度(')), '新鮮度(二相位均 %): 7d 3.1')
        })
    })

    describe('g_eval.mjs 之畫面「新鮮度(N 相位均 %)」= 該次評估實際所算之相位數(結果檔 metrics.phases 之長度)', () => {
        let root = path.join(t.dir, 'proj')
        let W = path.join(root, 'rsi', 'work', 'w1')
        writeSynthLedger(path.join(root, 'ledger', 'eval'), { n: 40, nBars: 2400, seed: 5 })
        fs.mkdirSync(W, { recursive: true })
        fs.writeFileSync(path.join(W, 'pick.mjs'), 'export default function pick(ctx) {\n    let ids = []\n    for (let s = 0; s < ctx.n; s += 3) ids.push(s)\n    return ids\n}\n', 'utf8')
        //run: settings 之 phases(undefined = 不給)、命令列之其餘引數 ⇒ { line: 畫面之新鮮度列, n: 結果檔 metrics.phases 之長度, nBy: 結果檔 op.eqYr.byPhase 之長度 }
        let run = (phases, args, tag) => {
            let ev = { ledgerDir: './ledger/eval', warmupDays: 60, cadenceDays: 7, horizons: [7], nullDraws: 0, seed: 1, limits: { monthlyOrders: 400, peakHold: 50 } }
            if (phases !== undefined) {
                ev.phases = phases
            }
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
                periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } },
                eval: ev,
                score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] },
                rsi: { root: './rsi' },
                records: { workDir: './rsi/work' },
                dispatch: {},
            }), 'utf8')
            let e = { ...process.env, ARSI_ROOT: root }
            delete e.ARSI_HARNESS
            let fpOut = path.join(root, `out_${tag}.json`)
            let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'eval.mjs'), '--pick', path.join(W, 'pick.mjs'), '--out', fpOut, '--no-log', ...args], { cwd: root, env: e, windowsHide: true, encoding: 'utf8', timeout: 240000 })
            assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(0, 500))
            let o = JSON.parse(fs.readFileSync(fpOut, 'utf8'))
            return { line: `${r.stdout}`.split(/\r?\n/).find((l) => l.startsWith('新鮮度(')), n: o.metrics.phases.length, nBy: o.metrics.op.eqYr.byPhase.length }
        }
        let D12 = Array.from({ length: 12 }, (v, i) => i)

        it('--mode quick 實算 2 個相位(0 與 3): 設定未給(7)⇒ 二相位均(原: 七相位均); 設定 12 個 ⇒ 二相位均(原: 12 相位均); 設定 2 個 ⇒ 二相位均; 結果檔 metrics.phases 之長度 = 2', () => {
            for (let [nm, ph] of [['未給', undefined], ['十二個', D12], ['兩個', [0, 3]], ['七個', [0, 1, 2, 3, 4, 5, 6]]]) {
                let r = run(ph, ['--mode', 'quick'], `q_${nm}`)
                assert.strictEqual(r.n, 2, nm)
                assert.strictEqual(r.nBy, 2, nm)
                assert(r.line.startsWith('新鮮度(二相位均 %):'), `${nm}: ${r.line}`)
            }
        })

        it('--phases 覆寫 ⇒ 依覆寫之個數(quick、full 皆然; 原: 設定之長度); 畫面之字 = 結果檔 metrics.phases 之長度', () => {
            let r1 = run([0, 3], ['--mode', 'quick', '--phases', '0,1,3'], 'q_over')
            assert.strictEqual(r1.n, 3)
            assert(r1.line.startsWith('新鮮度(三相位均 %):'), r1.line)
            let r2 = run(undefined, ['--mode', 'quick', '--phases', '0,1,2,3,4,5,6,7,8,9,10,11'], 'q_over12')
            assert.strictEqual(r2.n, 12)
            assert(r2.line.startsWith('新鮮度(12 相位均 %):'), r2.line)
            let r3 = run([0, 3], ['--mode', 'full', '--phases', '0,1,3'], 'f_over')
            assert.strictEqual(r3.n, 3)
            assert(r3.line.startsWith('新鮮度(三相位均 %):'), r3.line)
        })

        it('--mode full 算設定之全部相位: 兩個 ⇒ 二相位均; 十二個 ⇒ 12 相位均; 未給(預設 7)⇒ 七相位均(逐字同改前)', () => {
            for (let [nm, ph, n, word] of [['兩個', [0, 3], 2, '二相位'], ['十二個', D12, 12, '12 相位'], ['未給', undefined, 7, '七相位']]) {
                let r = run(ph, ['--mode', 'full'], `f_${nm}`)
                assert.strictEqual(r.n, n, nm)
                assert(r.line.startsWith(`新鮮度(${word}均 %):`), `${nm}: ${r.line}`)
            }
        })
    })

    describe('看板、搜尋地圖: 各節點之結果所算之相位數(皆同者); 各節點不同或皆無此欄者取設定', () => {
        //mk: 預設設定之 eval.phases 為 settings.json 所給之 7 個; 專案夾於暫存
        let n = 0
        let mk = (phases = [0, 1, 2, 3, 4, 5, 6]) => {
            let st = getSettings()
            let d = path.join(t.dir, `proj_${n++}`)
            st.resources = {}
            st.rsi = { ...st.rsi, root: path.join(d, 'rsi'), docLimits: false, maxArmsPerNode: 4 }
            st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
            st.eval = { ...st.eval, ledgerDir: path.join(d, 'ledger'), phases }
            fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
            fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthPhase' }), 'utf8')
            let dispatch = async () => {
                throw new Error('fake: 不派工')
            }
            let P = makeProject(st, { dispatch, gate: null, catalogFile: path.join(d, 'catalog.json') })
            P.rsi.init()
            return { P, st }
        }
        let armIds = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'arms', 'base.json'), 'utf8')).arms.filter((a) => a.selectable === true).map((a) => a.id)
        //put: nPh = 該節點之評估所算之相位數(metrics.phases 與 op.eqYr.byPhase 之長度); null = 兩欄皆無(舊資料、手寫之 metrics); 每節點之臂、選集指紋、各欄之值逐筆相異
        let put = (P, k, nPh, round = 1) => {
            let spec = { arms: [armIds[k]], base: null }
            let id = P.idOf(spec)
            let byPhase = nPh === null ? undefined : Array.from({ length: nPh }, (v, i) => 1 + i + k * 0.37)
            let metrics = {
                ...(nPh === null ? {} : { phases: Array.from({ length: nPh }, (v, i) => i) }),
                op: { eqYr: { mean: 18 + k * 1.7, min: -2 - k * 0.4, ...(byPhase ? { byPhase } : {}) }, monthlyOrders: { mean: 60 + k }, peakHold: { max: 12 + k }, bySide: { long: { orders: 800 + k }, short: { orders: 200 + k } } },
                null: { mean: -3 - k, excess: 7 + k, z: 1.8 + k / 10, p: 0.002 * k, sigPerPick: 1.0 },
                nullSideAct: { excess: 2 + k * 0.8, p: 0.01 + k / 1000, share: 0.2 + k / 100, mean: 5 + k, half: 50, triggered: true },
                sel: { longRatio: 0.2 + ((k * 7) % 11) / 20, sizeMax: 4, sizeMean: 3, sigPerPick: 1.05 + k / 100 },
                ext: {},
            }
            let raw = { selHash: `s${k}`, metrics, issues: [], train: { longRatio: 0.5, tags: [], shortShare: 0.24 } }
            P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round, raw, score: { S: 40 + k * 2.1, ladder: 1, flags: { vetoed: false, why: [] } }, evidence: { trust: 'trusted' } })
            return id
        }
        let read = (st, f) => fs.readFileSync(path.join(st.rsi.root, f), 'utf8')
        let boardOf = (x) => {
            x.P.writeBoard()
            x.P.writeSearchMap()
            return { board: read(x.st, 'ARMS_BOARD.md'), map: read(x.st, 'SEARCH_MAP.md') }
        }
        //看板之三處(S 之定義一句、超額之說明、節點一覽之欄標)與搜尋地圖之兩處(量尺之說明、逐輪趨勢之表頭)
        //  標點以 . 比對(原文之括號、減號為全形或特殊字元)
        let phraseOf = (o) => [o.board.match(/S = 0\.7 × 等效年化之(.{1,3}?)平均/), o.board.match(/超額.{1,4}等效年化之(.{1,3}?)平均 . 同劑量虛無均/), o.board.match(/\| 最差相位 \| (.{1,3}?)平均 \|/), o.map.match(/最差相位 \/ (.{1,3}?)平均 \/ 對組成對照之超額 \/ 組成之水準.組成對照之均/), o.map.match(/之最高者.S \/ 最差相位 \/ (.{1,3}?)平均 \/ 超額 \/ 組成之水準/)].map((m) => (m ? m[1] : null))

        it('各節點之評估皆算 2 個相位而設定為 7 個 ⇒ 看板與搜尋地圖寫「二相位」(原: 七相位)', () => {
            let x = mk()
            for (let k = 0; k < 4; k++) {
                put(x.P, k, 2, 1 + (k % 2))
            }
            let o = boardOf(x)
            assert.deepEqual(phraseOf(o), ['二相位', '二相位', '二相位', '二相位', '二相位'])
            assert(!o.board.includes('七相位') && !o.map.includes('七相位'), '無七相位之字樣')
        })

        it('各節點皆算 7 個而設定為 2 個(設定改動之後尚未重算)⇒ 寫實算之「七相位」(不寫設定之二相位)', () => {
            let x = mk([0, 3])
            for (let k = 0; k < 3; k++) {
                put(x.P, k, 7)
            }
            let o = boardOf(x)
            assert.deepEqual(phraseOf(o), ['七相位', '七相位', '七相位', '七相位', '七相位'])
            assert(!o.board.includes('二相位') && !o.map.includes('二相位'))
        })

        it('各節點之相位數不同 ⇒ 取設定之長度; 皆無此欄(手寫之 metrics)⇒ 取設定之長度; 無節點 ⇒ 取設定之長度', () => {
            let x = mk([0, 1, 3])
            put(x.P, 0, 2)
            put(x.P, 1, 7)
            put(x.P, 2, null)
            assert.deepEqual(phraseOf(boardOf(x)), ['三相位', '三相位', '三相位', '三相位', '三相位'], '不同 ⇒ 設定(三個)')
            let y = mk([0, 1, 3])
            put(y.P, 0, null)
            put(y.P, 1, null)
            assert.deepEqual(phraseOf(boardOf(y)), ['三相位', '三相位', '三相位', '三相位', '三相位'], '皆無 ⇒ 設定(三個)')
            let z = mk([0, 3])
            assert.deepEqual(phraseOf(boardOf(z)), ['二相位', '二相位', '二相位', '二相位', '二相位'], '無節點 ⇒ 設定(二個)')
            //某些節點無此欄、其餘皆 2 個 ⇒ 無此欄者不計 ⇒ 二相位
            let w = mk()
            put(w.P, 0, 2)
            put(w.P, 1, null)
            put(w.P, 2, 2)
            assert.deepEqual(phraseOf(boardOf(w)), ['二相位', '二相位', '二相位', '二相位', '二相位'])
        })

        it('搜尋地圖之側別讀數(相異之成品 ≥ 10 個): 「做多比例與 N 相位平均之相關」之 N = 各節點實算之相位數', () => {
            let x = mk()
            for (let k = 0; k < 12; k++) {
                put(x.P, k, 2, 1 + (k % 3))
            }
            let o = boardOf(x)
            let line = o.map.split('\n').find((l) => l.startsWith('- 側別讀數'))
            assert(line && line.includes('做多比例與二相位平均之相關'), line)
            let y = mk()
            for (let k = 0; k < 12; k++) {
                put(y.P, k, 7, 1 + (k % 3))
            }
            let line7 = boardOf(y).map.split('\n').find((l) => l.startsWith('- 側別讀數'))
            assert(line7 && line7.includes('做多比例與七相位平均之相關'), line7)
        })

        it('說明正本評估之設定者不隨節點之相位數變動: 做夢任務書之 state.md 填寫指引仍取設定之長度(無節點之結果可取)', () => {
            //原始碼: 該處之 phT 不帶節點(取設定)
            let src = fs.readFileSync(path.join(SRC, 'domain', 'domain.mjs'), 'utf8')
            assert(/各列 id、臂、S、' \+ phT\('相位'\) \+ '平均、最差相位/.test(src), '做夢任務書之填寫指引取設定')
        })
    })

    describe('一頁摘要(tools/roundDigest.mjs)之欄標: 該輪各節點之結果所算之相位數(皆同者); 其餘取設定', () => {
        let nodeDoc = (id, nPh) => ({
            nodeId: id,
            round: 1,
            attempt: 1,
            status: 'executed',
            spec: { arms: ['A01_nt'], base: null },
            task: { goal: 'g', type: 'explore' },
            plan: {},
            code: {},
            results: { claimed: {} },
            conclusion: { outcome: 'improved', summary: '摘要' },
            harness: {
                ok: true,
                summary: [],
                notes: [],
                checks: { issues: [] },
                score: { S: 20.5, ladder: 1, flags: { vetoed: false, why: [] } },
                raw: { replays: [], metrics: { selHash: 'h1', phases: Array.from({ length: nPh }, (v, i) => i), op: { eqYr: { mean: 12.3, min: -1.2, byPhase: Array.from({ length: nPh }, (v, i) => i + 1) }, monthlyOrders: { mean: 10 }, peakHold: { max: 3 }, winRate: 0.5 }, null: { p: 0.01, excess: 1 }, sel: { sigPerPick: 2, longRatio: 0.5 } } },
            },
            audit: { round: 1, by: 'm', trust: 'trusted', action: 'accept', evidence: [], issues: [], inactiveArms: [] },
        })
        let digestHead = (nPhs, phases) => {
            let root = path.join(t.dir, `dg_${nPhs.join('_')}_${phases === undefined ? 'u' : phases.length}`)
            let nd = path.join(root, 'rsi', 'records', 'nodes')
            fs.mkdirSync(nd, { recursive: true })
            fs.mkdirSync(path.join(root, 'rsi', 'records', 'dreams'), { recursive: true })
            fs.mkdirSync(path.join(root, 'rsi', 'work'), { recursive: true })
            nPhs.forEach((nPh, i) => {
                let id = `${String(i + 1).repeat(16)}`
                fs.writeFileSync(path.join(nd, `${id}.json`), JSON.stringify(nodeDoc(id, nPh)), 'utf8')
            })
            let ev = { ledgerDir: './ledger/eval', warmupDays: 60, cadenceDays: 7, horizons: [7], nullDraws: 0, seed: 1, limits: { monthlyOrders: 400, peakHold: 50 } }
            if (phases !== undefined) {
                ev.phases = phases
            }
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
                periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } },
                eval: ev,
                score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] },
                rsi: { root: './rsi' },
                records: { nodeDir: './rsi/records/nodes', dreamDir: './rsi/records/dreams', workDir: './rsi/work' },
                dispatch: {},
            }), 'utf8')
            let r = spawnSync(process.execPath, [path.join(SRC, 'tools', 'roundDigest.mjs'), '1'], { cwd: root, env: { ...process.env, ARSI_ROOT: root }, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(0, 600))
            return `${r.stdout}`.split(/\r?\n/).find((l) => l.startsWith('| 節點 | 類型 |'))
        }

        it('各節點皆算 2 個相位、設定 7 個 ⇒ 「二相位平均 / 最差相位」(原: 七相位); 皆 7 個、設定 2 個 ⇒ 七相位; 不同或設定未給 ⇒ 設定', () => {
            assert(digestHead([2, 2], [0, 1, 2, 3, 4, 5, 6]).includes('| 二相位平均 / 最差相位 |'))
            assert(digestHead([7, 7], [0, 3]).includes('| 七相位平均 / 最差相位 |'))
            assert(digestHead([2, 7], [0, 1, 3]).includes('| 三相位平均 / 最差相位 |'), '不同 ⇒ 設定')
            assert(digestHead([7], undefined).includes('| 七相位平均 / 最差相位 |'), '預設 7 ⇒ 逐字同改前')
        })
    })

    describe('原始碼: 說明某結果之相位數者經 phaseCountOfMetrics / phaseCountOfAll(單一定義); 取設定者限於說明正本評估之設定之處', () => {
        let srcOf = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')
        it('eval.mjs 之畫面、rsi.mjs 之輪末摘要、roundDigest.mjs 之欄、domain.mjs 與 pickStore.mjs 之彙整輸出皆取實算之相位數', () => {
            assert(/新鮮度\(\$\{phaseText\(phaseCountOfAll\(\[phaseCountOfMetrics\(m\)\], st\.eval\), '相位'\)\}均 %\)/.test(srcOf('cli/eval.mjs')), 'eval.mjs 之新鮮度列')
            assert(/\$\{phaseText\(bestPh, '相位'\)\}均 \$\{best\.eqYrMean\}/.test(srcOf('cli/rsi.mjs')), 'rsi.mjs 之輪末摘要')
            assert(/bestPh = phaseCountOfAll\(\[phaseCountOfMetrics\(m\)\], st\.eval\)/.test(srcOf('cli/rsi.mjs')), 'rsi.mjs 之 bestPh 取自該節點之 metrics')
            assert(/phaseCountOfAll\(rows\.map\(\(d\) => phaseCountOfMetrics\(/.test(srcOf('tools/roundDigest.mjs')), 'roundDigest.mjs 之欄')
            let dm = srcOf('domain/domain.mjs')
            assert(/let nPhOf = \(ns\) => phaseCountOfAll\(ns\.map\(\(n\) => phaseCountOfMetrics\(n\.raw && n\.raw\.metrics\)\), st\.eval\)/.test(dm), 'domain.mjs 之 nPhOf')
            assert(/let phT = \(tail, ns\) => phaseText\(ns \? nPhOf\(ns\) : phaseCountOf\(st\.eval\), tail\)/.test(dm), 'domain.mjs 之 phT')
            assert.strictEqual((dm.match(/phT\('相位', nodes\)/g) || []).length, 5, '看板 3 處 + 搜尋地圖 2 處皆傳節點')
            assert(!/phaseCountOf\(st\.eval\)\)/.test(dm.split('\n').filter((l) => /sideReadTextOf\(/.test(l)).join('\n')), '側別讀數不取設定')
            assert.strictEqual((dm.match(/sideReadTextOf\(sideReadOfTree\((nodes|ns)\), nPhOf\((nodes|ns)\)\)/g) || []).length, 2, '側別讀數 2 處')
            let ps = srcOf('domain/pickStore.mjs')
            assert(/phaseCountOfAll\(items\.map\(\(x\) => \(Array\.isArray\(x\.backtest\.eqYrByPhase\) \? x\.backtest\.eqYrByPhase\.length : null\)\), st\.eval\)/.test(ps), 'pickStore.mjs 之 nPhBt 取自各策略之 eqYrByPhase')
        })
    })
})
