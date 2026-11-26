/* eslint-disable no-template-curly-in-string -- 診斷之原始碼字串(寫入合成專案之 metrics/)內含樣板字面值 */
import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { getSettings } from '../src/cfg.mjs'
import { makeProject, rankKeyOf } from '../src/domain/domain.mjs'
import { makeVerify, notesOf, replicaExtOf, replicaExtArgsOf, replayExtOf, boardMeanOf, extBoardMeansOf, REPLICA_EXT } from '../src/domain/verify.mjs'
import { specHash } from '../src/engineApi.mjs'
import { makeTmp, writeSynthLedger, FD_ROOT } from './tools/synthLedger.mjs'


//迴圈之重放一併載入擴充診斷(規則 R-REC-42)
//  規格: ①重放(換亂數種子與同分次序)於 nullRecentAct 之外, 依 settings.rsi.replicaExt 另載入擴充診斷: 'board'(預設)= 正本之完整評估中帶看板值者 | 'all' | 'none'(= 改前)| 診斷名之陣列; 無效者視為未給
//    ②重放之結果檔(harness_seed*.json)帶診斷值; 重放之紀錄(raw.replays[].ext)存各診斷之看板值與 neutralExec 之 delta; 不寫回正本之 metrics.ext
//    ③看板之「正本與重放之均」一欄與節點文件之重放一列並列各診斷之看板值之多抽之均(數字逐位取均; 樣板不同或少於 2 抽者不列)
//    ④不改重放本身(種子、同分次序、次數、虛無抽數)與正本之數字; 診斷於重放拋錯者不影響重放之 S 與既有之兩項(組成對照、近期版);
//      另載入之診斷使該次重放失敗者(完整性錯誤、逾時)⇒ 以改前之引數再重放一次
//    ⑤無診斷之專案、'none' ⇒ 重放之引數、紀錄、看板與節點文件與改前相同
describe('迴圈之重放一併載入擴充診斷(規則 R-REC-42)', function () {
    this.timeout(600000)

    describe('純函數', function () {
        it('① replicaExtOf:預設 board;all / none / 名之陣列(去重排序);無效者視為未給', () => {
            assert.equal(REPLICA_EXT, 'board')
            assert.equal(replicaExtOf({}), 'board')
            assert.equal(replicaExtOf(null), 'board')
            for (let v of ['board', 'all', 'none']) {
                assert.equal(replicaExtOf({ replicaExt: v }), v)
            }
            assert.deepEqual(replicaExtOf({ replicaExt: ['dB', 'dA', 'dB'] }), ['dA', 'dB'])
            assert.deepEqual(replicaExtOf({ replicaExt: [] }), [])
            for (let bad of ['ALL', 'x', 1, true, { a: 1 }, ['dA', 1], ['dA,dB'], ['d A'], [''], [null]]) {
                assert.equal(replicaExtOf({ replicaExt: bad }), 'board', JSON.stringify(bad))
            }
        })
        it('① replicaExtArgsOf:none 與所指為空 ⇒ 改前之引數(字面值);board = 正本帶看板值者;all ⇒ 不指名;名之陣列', () => {
            let m = { ext: { 'dB': { board: '1.0 / 2.0' }, 'dA': { board: 3 }, 'dN': { text: '無看板值' }, 'dE': { error: '拋錯', board: '9' }, 'nullRecentAct': { board: '0.5', side: {} }, 'd,x': { board: '1' } } }
            assert.deepEqual(replicaExtArgsOf('none', m), ['--ext-only', 'nullRecentAct'])
            assert.deepEqual(replicaExtArgsOf('board', { ext: {} }), ['--ext-only', 'nullRecentAct'])
            assert.deepEqual(replicaExtArgsOf('board', null), ['--ext-only', 'nullRecentAct'])
            assert.deepEqual(replicaExtArgsOf('board', m), ['--ext-only', 'nullRecentAct,dA,dB'], '帶看板值者(出錯、無看板值、含逗號之名除外;nullRecentAct 不重列)')
            assert.deepEqual(replicaExtArgsOf('all', m), [])
            assert.deepEqual(replicaExtArgsOf(['dZ', 'dA'], m), ['--ext-only', 'nullRecentAct,dA,dZ'])
            assert.deepEqual(replicaExtArgsOf([], m), ['--ext-only', 'nullRecentAct'])
        })
        //規格(Gitea #199 主控之裁定 1; R-REC-42 ①): replicaExt 為 'board'(含未給之預設)時, 所載入之診斷另加 neutralExec ——
        //  條件: 正本之 metrics.ext.neutralExec 經 neutralDeltaOf 判為有值(物件、非陣列、不帶 error、delta 為有限數值), 不論其有無看板值(提案 §3 第 2 點: 重放之紀錄帶其 delta, 為排序鍵所讀);
        //  'all' 本即含之; 'none' 照改前; 明列之陣列照所列(不自動加); 正本無此診斷或為無值之形者, 'board' 之引數與前一輪逐字相同
        it('① replicaExtArgsOf:board 另加正本之 neutralExec(有有限之 delta 者,不論有無看板值);無值之形、none、all、名之陣列不另加', () => {
            let base = { dA: { board: '1.0' }, dB: { board: '2.0' } }
            let ARGS0 = ['--ext-only', 'nullRecentAct,dA,dB']
            //有有限之 delta 而無看板值 ⇒ 另加
            assert.deepEqual(replicaExtArgsOf('board', { ext: { ...base, neutralExec: { delta: 3.2, sNeutral: 41.1 } } }), ['--ext-only', 'nullRecentAct,dA,dB,neutralExec'])
            //delta 為 0 或負 ⇒ 仍為有值
            for (let d of [0, -4.5]) {
                assert.deepEqual(replicaExtArgsOf('board', { ext: { ...base, neutralExec: { delta: d } } }), ['--ext-only', 'nullRecentAct,dA,dB,neutralExec'], String(d))
            }
            //只有 neutralExec(其他診斷皆無看板值)⇒ nullRecentAct + neutralExec
            assert.deepEqual(replicaExtArgsOf('board', { ext: { neutralExec: { delta: 1 }, dN: { text: '無看板值' } } }), ['--ext-only', 'nullRecentAct,neutralExec'])
            //有看板值又有 delta ⇒ 只列一次(去重); 依名排序
            assert.deepEqual(replicaExtArgsOf('board', { ext: { ...base, neutralExec: { delta: 3.2, board: '38.2 / Δ 3.2' } } }), ['--ext-only', 'nullRecentAct,dA,dB,neutralExec'])
            //有看板值而無 delta ⇒ 照改前(由看板值載入)
            assert.deepEqual(replicaExtArgsOf('board', { ext: { ...base, neutralExec: { board: '38.2' } } }), ['--ext-only', 'nullRecentAct,dA,dB,neutralExec'])
            //無值之形(無看板值者)⇒ 與前一輪逐字相同: 未載入、帶 error、非物件、陣列、缺 delta、delta 為字串 / null / NaN / ±Infinity
            let noVal = [undefined, { error: '診斷拋錯', delta: 3.2 }, 'x', [3.2], { sNeutral: 30.1 }, { delta: '3.2' }, { delta: null }, { delta: NaN }, { delta: Infinity }, { delta: -Infinity }, null]
            for (let ne of noVal) {
                assert.deepEqual(replicaExtArgsOf('board', { ext: { ...base, ...(ne === undefined ? {} : { neutralExec: ne }) } }), ARGS0, JSON.stringify(ne))
            }
            assert.deepEqual(replicaExtArgsOf('board', { ext: { ...base, neutralExec: { error: '拋錯', board: '9', delta: 3 } } }), ARGS0, '帶 error 者連看板值亦不載入(同改前)')
            assert.deepEqual(replicaExtArgsOf('board', { ext: 'x' }), ['--ext-only', 'nullRecentAct'])
            assert.deepEqual(replicaExtArgsOf('board', null), ['--ext-only', 'nullRecentAct'])
            //none / all / 名之陣列: 不另加
            let m = { ext: { ...base, neutralExec: { delta: 3.2 } } }
            assert.deepEqual(replicaExtArgsOf('none', m), ['--ext-only', 'nullRecentAct'])
            assert.deepEqual(replicaExtArgsOf('all', m), [])
            assert.deepEqual(replicaExtArgsOf(['dA'], m), ['--ext-only', 'nullRecentAct,dA'], '明列之陣列照所列(排序鍵每抽用正本之差)')
            assert.deepEqual(replicaExtArgsOf(['dA', 'neutralExec'], m), ['--ext-only', 'nullRecentAct,dA,neutralExec'], '明列者照載入')
            assert.deepEqual(replicaExtArgsOf([], m), ['--ext-only', 'nullRecentAct'])
        })
        it('② replayExtOf:各診斷之看板值(與正本同一套清理)與 neutralExec 之 delta;出錯、無看板值者不存;皆無 ⇒ null', () => {
            assert.strictEqual(replayExtOf({ ext: {} }), null)
            assert.strictEqual(replayExtOf(null), null)
            assert.strictEqual(replayExtOf({ ext: { dN: { text: 'x' }, dE: { error: 'e', board: '1' } } }), null)
            assert.deepEqual(replayExtOf({ ext: { dA: { board: 'a | b\nc', text: 't', groups: [1, 2] }, dN: { text: 'x' }, neutralExec: { board: '38.2 / Δ 17.4', delta: 17.43, sNeutral: 38.24 } } }), { dA: { board: 'a b c' }, neutralExec: { board: '38.2 / Δ 17.4', delta: 17.43 } })
            //neutralExec 無看板值而有 delta ⇒ 只存 delta; delta 非有限 ⇒ 不存
            assert.deepEqual(replayExtOf({ ext: { neutralExec: { delta: 0 } } }), { neutralExec: { delta: 0 } })
            assert.strictEqual(replayExtOf({ ext: { neutralExec: { delta: '1' } } }), null)
            assert.strictEqual(replayExtOf({ ext: { neutralExec: { delta: 1, error: 'e' } } }), null)
        })
        it('③ boardMeanOf:數字逐位取均(小數位數取各抽之最多者);樣板不同、少於 2 抽、無數字 ⇒ null', () => {
            //獨立之算式: (38.2 + 36.9 + 39.1) / 3 = 38.07 → 38.1;(17.4 + 18.0 + 16.5) / 3 = 17.3
            assert.equal(boardMeanOf(['38.2 / Δ 17.4', '36.9 / Δ 18.0', '39.1 / Δ 16.5']), '38.1 / Δ 17.3')
            assert.equal(boardMeanOf(['12.3 / p 0.0303', '10.1 / p 0.05']), '11.2 / p 0.0402')
            assert.equal(boardMeanOf([3, 4]), '4', '數字(整數 ⇒ 0 位小數;3.5 四捨五入)')
            assert.equal(boardMeanOf(['g0 -1.2 / g1 20.3', 'g0 1.0 / g1 22.1']), 'g0 -0.1 / g1 21.2', '帶號之數與文字內之數(g0、g1)')
            assert.equal(boardMeanOf(['-0.1', '0.1', '-0.1']), '0.0', '負零寫為 0.0((-0.1 + 0.1 − 0.1) / 3 = −0.033 → −0.0)')
            assert.strictEqual(boardMeanOf(['1.0 / 2.0', '1.0 / —']), null, '一抽為「—」⇒ 樣板不同')
            assert.strictEqual(boardMeanOf(['+1.0', '-1.0']), null, '「+」書寫者與不帶者樣板不同')
            assert.strictEqual(boardMeanOf(['做空 3.1', '做多 2.0']), null, '文字不同')
            assert.strictEqual(boardMeanOf(['1.5']), null, '少於 2 抽')
            assert.strictEqual(boardMeanOf(['甲', '甲']), null, '無數字')
            assert.strictEqual(boardMeanOf(null), null)
        })
        it('③ extBoardMeansOf:只列正本有看板值、至少一次重放帶其值且可取均者;重放皆未帶 ext ⇒ [](與改前相同)', () => {
            let m = { ext: { dA: { board: '10.0 / 1' }, dB: { board: '5.0' }, dC: { board: 'x' }, dD: { board: '7.0' } } }
            assert.deepEqual(extBoardMeansOf(m, [{ S: 1 }, { S: 2 }]), [])
            assert.deepEqual(extBoardMeansOf(m, null), [])
            let rp = [{ S: 1, ext: { dA: { board: '12.0 / 3' }, dB: { board: '6.0' }, dC: { board: 'y' } } }, { S: 2, ext: { dA: { board: '14.0 / 5' } } }]
            assert.deepEqual(extBoardMeansOf(m, rp), [{ name: 'dA', label: 'dA', value: '12.0 / 3', n: 3 }, { name: 'dB', label: 'dB', value: '5.5', n: 2 }], 'dC 文字不同、dD 重放無值 ⇒ 不列')
        })
        it('③⑤ notesOf:重放帶 ext 者於重放一列並列看板值之均;未帶者與改前相同(字面值)', () => {
            let m = { op: { eqYr: { byPhase: [1, 2, 3] }, monthlyOrders: { mean: 1 } }, nullSideAct: { excess: 4.4 }, ext: { dA: { board: '10.0 / 1', text: '診斷甲' } } }
            let line = (ls) => ls.find((l) => l.startsWith('換亂數種子與同分次序之重放')) || ''
            let rp0 = [{ S: 2.5, comp: 3.3, recent: null }, { S: 3.5, comp: 5.5, recent: null }]
            //改前之該列之字面值
            let OLD = '換亂數種子與同分次序之重放(迴圈;組成對照 32 抽): S 2.5 / 3.5;組成對照之超額 3.3 / 5.5(正本 4.4);近期活躍度之組成對照之超額 — / — —— 每次同時換 ctx.rand 之種子與同分次序(ctx.meta.tie、同一進場棒之訊號先後);含隨機抽取、或主鍵大量同分(入選者實際由 tie 決定)之成品其結果隨之波動;各次之 S 與主分數相差很大者,主分數不可靠;**判內容以正本與各次重放之超額之平均為準,不以單抽**'
            assert.equal(line(notesOf(m, [2.5, 3.5], null, rp0)), OLD)
            let rp1 = rp0.map((x, i) => ({ ...x, ext: { dA: { board: `${12 + 2 * i}.0 / ${3 + 2 * i}` } } }))
            assert.equal(line(notesOf(m, [2.5, 3.5], null, rp1)), OLD.replace(' —— 每次同時換', ';擴充診斷之看板值之均(正本與各次重放):dA 12.0 / 3(3 抽) —— 每次同時換'))
            //其餘各列不變
            assert.deepStrictEqual(notesOf(m, [2.5, 3.5], null, rp1).filter((l) => !l.startsWith('換亂數種子')), notesOf(m, [2.5, 3.5], null, rp0).filter((l) => !l.startsWith('換亂數種子')))
        })
    })

    describe('看板(真之樹與領域)', function () {
        let t
        beforeEach(() => {
            t = makeTmp('replayExtBoard')
        })
        afterEach(() => {
            t.cleanup()
        })
        let mk = (rpExtOf) => {
            let st = getSettings()
            let d = path.join(t.dir, `proj_${Math.random().toString(36).slice(2, 8)}`)
            st.resources = {}
            st.rsi = { ...st.rsi, root: path.join(d, 'rsi') }
            st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
            st.eval.ledgerDir = path.join(d, 'ledger')
            fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
            fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthRX' }), 'utf8')
            let P = makeProject(st, { dispatch: async () => ({ ok: false, error: 'fake' }), gate: null, catalogFile: path.join(d, 'catalog.json') })
            P.rsi.init()
            let ids = []
            for (let k = 1; k <= 2; k++) {
                let spec = { arms: [['A01_nt', 'A02_ntPit'][k - 1]], base: null }
                let id = P.idOf(spec)
                ids.push(id)
                let metrics = { selHash: `sel-${k}`, op: { eqYr: { mean: 20 + k, min: -3 - k, byPhase: [1, 2, 3].map((v) => v * k) }, monthlyOrders: { mean: 90 + k }, peakHold: { max: 25 + k } }, null: { mean: -5 - k, excess: 10 + k, z: 2 + k / 10, p: 0.001 * k }, nullSideAct: { excess: 5 + k, p: 0.01 * k, share: 0.3, mean: 2 + k, half: 50, triggered: true }, ext: { dA: { board: `${10 * k}.0 / ${k}` } } }
                let replays = [0, 1].map((i) => ({ S: 30 + k + i, comp: 6 + k + i, recent: null, ...(rpExtOf ? { ext: rpExtOf(k, i) } : {}) }))
                P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round: 1, raw: { metrics, issues: [], seedS: replays.map((x) => x.S), replays }, score: { S: 30 + k, ladder: 1, flags: { vetoed: false, why: [] } }, evidence: { trust: 'trusted' } })
            }
            P.writeBoard()
            return { ids, board: fs.readFileSync(path.join(st.rsi.root, 'ARMS_BOARD.md'), 'utf8') }
        }
        let cellOf = (x, k) => {
            let ls = x.board.split('\n')
            let head = ls.find((l) => l.startsWith('| 節點 | 臂 |')).split('|').map((s) => s.trim())
            let ci = head.findIndex((h) => h.startsWith('正本與重放之 S 之均'))
            return { head: head[ci], cell: ls.find((l) => l.startsWith(`| \`${x.ids[k - 1]}\` |`)).split('|')[ci].trim() }
        }
        it('③⑤ 重放帶看板值 ⇒「正本與重放之均」一欄之末並列;表頭與表前之說明只在有此類節點時改變;未帶者逐字相同', () => {
            let x0 = mk(null)
            assert.equal(cellOf(x0, 1).head, '正本與重放之 S 之均;超額之均(組成對照 / 近期活躍度版)')
            assert.equal(cellOf(x0, 1).cell, '31.3;7.0 / —')
            assert(!x0.board.includes('各擴充診斷之看板值之多抽之均'))
            //重放之 ext 帶其他診斷而無正本有值者之看板值 ⇒ 無可列 ⇒ 與未帶者逐字相同
            assert.equal(mk(() => ({ dZ: { board: '1.0' } })).board, x0.board)
            let x1 = mk((k, i) => ({ dA: { board: `${10 * k + 2 + 2 * i}.0 / ${k + 1 + i}` } }))
            assert.equal(cellOf(x1, 1).head, '正本與重放之 S 之均;超額之均(組成對照 / 近期活躍度版);擴充診斷之看板值之均')
            //節點 1: dA = (10 + 12 + 14) / 3 = 12.0;(1 + 2 + 3) / 3 = 2
            assert.equal(cellOf(x1, 1).cell, '31.3;7.0 / —;dA 12.0 / 2')
            assert.equal(cellOf(x1, 2).cell, '32.3;8.0 / —;dA 22.0 / 3')
            assert(x1.board.includes('「正本與重放之均」一欄之末另列**各擴充診斷之看板值之多抽之均**'))
            //只一次重放帶值 ⇒ 標抽數
            let x2 = mk((k, i) => (i === 0 ? { dA: { board: `${10 * k + 2}.0 / ${k + 1}` } } : {}))
            assert.equal(cellOf(x2, 1).cell, '31.3;7.0 / —;dA 11.0 / 2(2 抽)')
        })
    })

    describe('迴圈之驗證(子行程:合成帳本 + 真之評估入口)', function () {
        let t
        before(() => {
            t = makeTmp('replayExtRun')
        })
        after(() => {
            t.cleanup()
        })
        //含亂數之挑選(重放之選集與 S 隨種子而變 ⇒ 兩次重放皆執行)
        let PICK = 'export default function pick(ctx) {\n    let ids = []\n    for (let s = 0; s < ctx.n; s++) {\n        if (ctx.rand() < 0.3) {\n            ids.push(s)\n        }\n    }\n    return ids\n}\n'
        //診斷: dA(只 simulate 一次; 看板值隨選集而變)、dE(拋錯)、dN(無看板值)、neutralExec(看板值與 delta)、nullRecentAct(近期版)
        let DIAGS = {
            dA: 'export default function (api) {\n    let sels = api.phases.map((ph) => ph.sels)\n    let r = api.simulate(sels, null, { accept: (sig, book) => book.open < 5 })\n    return { text: "甲", board: `${r.mean.toFixed(2)} / ${api.obs.mean.toFixed(2)}` }\n}\n',
            dE: 'export default function (api) {\n    throw new Error("診斷乙拋錯")\n}\n',
            dN: 'export default function (api) {\n    return { text: "丙(無看板值)" }\n}\n',
            neutralExec: 'export default function (api) {\n    let sels = api.phases.map((ph) => ph.sels)\n    let r = api.simulate(sels, null, { accept: (sig, book) => book.open < 30 })\n    let s0 = 0.7 * api.obs.mean + 0.3 * Math.min(...api.obs.byPhase)\n    let s1 = 0.7 * r.mean + 0.3 * Math.min(...r.byPhase)\n    let d = Math.round((s0 - s1) * 100) / 100\n    return { text: "中性", sNeutral: Math.round(s1 * 100) / 100, delta: d, board: `${s1.toFixed(1)} / Δ ${d.toFixed(1)}` }\n}\n',
            nullRecentAct: 'export default function (api) {\n    let r = api.replaceNull({ actDays: 90 })\n    return { text: "近期版", side: { excess: r.excess, p: r.p, z: r.z }, board: `${r.excess.toFixed(1)} / p ${r.p}` }\n}\n',
        }
        let mkProj = (name, { diags = Object.keys(DIAGS), replicaExt, extra = {} } = {}) => {
            let root = path.join(t.dir, name)
            writeSynthLedger(path.join(root, 'ledger', 'eval'), { n: 60, nBars: 2400, seed: 7 })
            fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
            let st0 = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
            let st = {
                ...st0,
                periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } },
                eval: { ledgerDir: './ledger/eval', warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws: 8, seed: 1, replicaSeeds: 2, replicaNullDraws: 8, fitEnd: { long: '2022-11-01T00:00:00', short: '2023-02-01T00:00:00' }, limits: { monthlyOrders: 4000, peakHold: 500 }, timeoutSec: 240 },
                rsi: { ...st0.rsi, root: './rsi', ...(replicaExt !== undefined ? { replicaExt } : {}) },
                records: { nodeDir: './rsi/records/nodes', dreamDir: './rsi/records/dreams', trashDir: './rsi/records/trash', workDir: './rsi/work', toolboxDir: './rsi/toolbox' },
                resources: {},
            }
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(st, null, 1), 'utf8')
            fs.writeFileSync(path.join(root, 'g_eval.mjs'), `process.env.ARSI_ROOT = ${JSON.stringify(root)}\nawait import(${JSON.stringify(pathToFileURL(path.join(FD_ROOT, 'src', 'cli', 'eval.mjs')).href)})\n`, 'utf8')
            for (let nm of diags) {
                fs.writeFileSync(path.join(root, 'rsi', 'toolbox', 'metrics', `${nm}.mjs`), DIAGS[nm], 'utf8')
            }
            for (let [nm, src] of Object.entries(extra)) {
                fs.writeFileSync(path.join(root, 'rsi', 'toolbox', 'metrics', `${nm}.mjs`), src, 'utf8')
            }
            let wd = path.join(root, 'rsi', 'work', 'n1')
            fs.mkdirSync(wd, { recursive: true })
            fs.writeFileSync(path.join(wd, 'pick.mjs'), PICK, 'utf8')
            //設定之絕對路徑(makeVerify 只讀 st 之 eval / rsi / periods / score / backtest)
            let s = { ...st, FD_ROOT: root, eval: { ...st.eval, ledgerDir: path.join(root, 'ledger', 'eval') }, rsi: { ...st.rsi, root: path.join(root, 'rsi') }, records: { nodeDir: path.join(root, 'rsi/records/nodes'), dreamDir: path.join(root, 'rsi/records/dreams'), trashDir: path.join(root, 'rsi/records/trash'), workDir: path.join(root, 'rsi/work'), toolboxDir: path.join(root, 'rsi/toolbox') } }
            return { root, wd, st: s }
        }
        let verifyOf = async (p) => {
            let verify = makeVerify({ st: p.st, FD_ROOT: p.root, layerOfSpec: () => 'A' })
            return verify({ nodeId: 'n1', spec: { arms: ['A01_nt'], base: null }, workDir: p.wd })
        }
        let seedJson = (p, i) => JSON.parse(fs.readFileSync(path.join(p.wd, `harness_seed${i}.json`), 'utf8'))
        let replayLine = (v) => v.notes.find((l) => l.startsWith('換亂數種子與同分次序之重放')) || ''
        let res = {}

        it('①②④ 預設(board):重放之結果檔帶帶看板值之診斷之值;紀錄存看板值與 delta;正本之 metrics.ext 不含重放之值;重放之 S、組成對照、近期版與只載入 nullRecentAct 者逐位相同', async () => {
            let p = mkProj('board')
            let v = await verifyOf(p)
            assert.equal(v.ok, true, JSON.stringify(v).slice(0, 600))
            res.board = { p, v }
            assert.equal(v.raw.replays.length, 2, '兩次重放皆執行(鑑別前提:含亂數)')
            for (let i = 1; i <= 2; i++) {
                let o = seedJson(p, i)
                //載入範圍 = 正本帶看板值者(dA、neutralExec)+ nullRecentAct;dE(出錯)、dN(無看板值)不載入
                assert.deepEqual(Object.keys(o.metrics.ext).sort(), ['dA', 'neutralExec', 'nullRecentAct'])
                assert.deepEqual(v.raw.replays[i - 1].ext, { dA: { board: o.metrics.ext.dA.board }, neutralExec: { board: o.metrics.ext.neutralExec.board, delta: o.metrics.ext.neutralExec.delta }, nullRecentAct: { board: o.metrics.ext.nullRecentAct.board } })
            }
            //正本之 ext 為正本自己之完整評估所得(五個診斷;dE 為 error)
            assert.deepEqual(Object.keys(v.raw.metrics.ext).sort(), ['dA', 'dE', 'dN', 'neutralExec', 'nullRecentAct'])
            assert(v.raw.metrics.ext.dE.error)
            //對照: 'none'(改前之引數)⇒ 重放之 S、組成對照、近期版逐位相同, 紀錄不帶 ext
            let q = mkProj('none', { replicaExt: 'none' })
            let w = await verifyOf(q)
            res.none = { p: q, v: w }
            assert.deepEqual(w.raw.replays.map(({ S, comp, recent }) => ({ S, comp, recent })), v.raw.replays.map(({ S, comp, recent }) => ({ S, comp, recent })))
            assert(w.raw.replays.every((x) => !('ext' in x)))
            assert.deepEqual(w.raw.seedS, v.raw.seedS)
            assert.equal(w.raw.metrics.selHash, v.raw.metrics.selHash)
            assert.deepEqual(Object.keys(seedJson(q, 1).metrics.ext), ['nullRecentAct'])
            //③ 節點文件之重放一列: 預設者多列看板值之均, 其餘相同
            assert.equal(replayLine(v).replace(/;擴充診斷之看板值之均\(正本與各次重放\):[^—]* ——/, ' ——'), replayLine(w))
            assert(replayLine(v).includes(';擴充診斷之看板值之均(正本與各次重放):dA ') && replayLine(v).includes('neutralExec '), replayLine(v))
        })

        it('④ 診斷於重放拋錯者不影響重放之 S 與既有之兩項(指名載入 dE)', async () => {
            let p = mkProj('err', { replicaExt: ['dE'] })
            let v = await verifyOf(p)
            let o = seedJson(p, 1)
            assert(o.metrics.ext.dE && o.metrics.ext.dE.error, '重放之結果檔記其錯誤')
            assert.deepEqual(v.raw.replays.map(({ S, comp, recent }) => ({ S, comp, recent })), res.none.v.raw.replays.map(({ S, comp, recent }) => ({ S, comp, recent })))
            assert(v.raw.replays.every((x) => x.ext && !('dE' in x.ext) && Object.keys(x.ext).join() === 'nullRecentAct'), '拋錯者不存(只存 nullRecentAct 之看板值)')
            assert(!v.issues.some((s) => s.includes('重放失敗') || s.includes('一併載入擴充診斷時失敗')), JSON.stringify(v.issues))
        })

        it('④ 另載入之診斷使該次重放失敗(完整性錯誤)⇒ 以改前之引數再重放一次:重放之 S 與既有之兩項不受影響,迴圈檢查列出', async () => {
            //dBrk: 正本(種子 1)不動作而帶看板值(⇒ 預設之範圍會載入); 重放(種子 2、3)改寫內建物件 ⇒ 該次評估以完整性錯誤失敗
            //  判別正本與重放: api.rand(0) 之首值(評估器之 mulberry32(種子 + 32452843); 由本測試以同一函數算出正本之值寫入診斷)
            let { mulberry32 } = await import('../src/eval/evalCore.mjs')
            let r1 = mulberry32(1 + 32452843)()
            let dBrk = `export default function (api) {\n    if (api.rand(0)() !== ${String(r1)}) {\n        Object.defineProperty(Array.prototype, 'zzBrk', { value: 1, configurable: true })\n    }\n    return { text: "破", board: "1.0" }\n}\n`
            let p = mkProj('brk', { extra: { dBrk } })
            let v = await verifyOf(p)
            assert.equal(v.ok, true)
            assert(v.raw.metrics.ext.dBrk && v.raw.metrics.ext.dBrk.board === '1.0', '正本照常(鑑別前提)')
            assert.equal(v.issues.filter((s) => s.includes('一併載入擴充診斷時失敗,已改為只載入 nullRecentAct 重放')).length, 2, JSON.stringify(v.issues))
            assert(!v.issues.some((s) => s.startsWith('換亂數種子與同分次序之重放失敗')), JSON.stringify(v.issues))
            assert.deepEqual(v.raw.replays.map(({ S, comp, recent }) => ({ S, comp, recent })), res.none.v.raw.replays.map(({ S, comp, recent }) => ({ S, comp, recent })))
            assert(v.raw.replays.every((x) => x.ext && Object.keys(x.ext).join() === 'nullRecentAct'), '再重放者只有 nullRecentAct 之值')
            assert.deepEqual(Object.keys(seedJson(p, 1).metrics.ext), ['nullRecentAct'], '再重放之結果檔(改前之引數)')
        })

        it('⑤ 無診斷之專案:重放之紀錄、節點文件之各列與 none 者相同;all ⇒ 另載入無看板值者', async () => {
            let p = mkProj('nodiag', { diags: [] })
            let v = await verifyOf(p)
            let q = mkProj('nodiagNone', { diags: [], replicaExt: 'none' })
            let w = await verifyOf(q)
            assert.deepStrictEqual(v.raw.replays, w.raw.replays)
            assert.deepEqual(v.notes, w.notes)
            let a = mkProj('all', { replicaExt: 'all' })
            let va = await verifyOf(a)
            assert.deepEqual(Object.keys(seedJson(a, 1).metrics.ext).sort(), ['dA', 'dE', 'dN', 'neutralExec', 'nullRecentAct'])
            assert.deepEqual(va.raw.replays.map(({ S, comp, recent }) => ({ S, comp, recent })), res.none.v.raw.replays.map(({ S, comp, recent }) => ({ S, comp, recent })))
        })

        //規格(Gitea #199 主控之裁定 3): 另載入之診斷即使自己抽亂數(api.replaceNull 之抽取、api.rand), 重放之 S、組成對照、近期版與 nullRecentAct 之輸出皆與只載入 nullRecentAct 者逐位相同
        //  (診斷之亂數皆由評估之種子與診斷自己之呼叫參數導出, 各診斷互不消耗對方之亂數; 診斷載入之序 = 檔名之序: aDraw 在 nullRecentAct 之前、zDraw 在其後, 兩種序皆涵蓋)
        it('⑥ 另載入會抽亂數之診斷(檔名序在 nullRecentAct 之前與之後各一): none / board / all 三者之重放之 S、組成對照、近期版及 nullRecentAct 之輸出逐位相同', async () => {
            let aDraw = 'export default function (api) {\n    let r = api.replaceNull({ draws: 6 })\n    let u = api.rand(3)()\n    return { text: "先", board: `${r.excess.toFixed(2)} / p ${r.p.toFixed(3)} / ${u.toFixed(4)}` }\n}\n'
            let zDraw = 'export default function (api) {\n    let r = api.replaceNull({ actDays: 30, draws: 5 })\n    let u = api.rand(7)()\n    return { text: "後", board: `${r.excess.toFixed(2)} / p ${r.p.toFixed(3)} / ${u.toFixed(4)}` }\n}\n'
            let strip = (e) => {
                let { ms, ...rest } = e
                return rest
            }
            let runs = {}
            for (let mode of ['none', 'board', 'all']) {
                let p = mkProj(`draw_${mode}`, { replicaExt: mode, extra: { aDraw, zDraw } })
                let v = await verifyOf(p)
                assert.equal(v.ok, true, `${mode}: ${JSON.stringify(v).slice(0, 400)}`)
                assert.equal(v.raw.replays.length, 2, `${mode}: 兩次重放皆執行(鑑別前提:含亂數之挑選)`)
                runs[mode] = { p, v, seeds: [1, 2].map((i) => seedJson(p, i)) }
            }
            //載入之診斷(結果檔之 ext 之鍵): none = 只 nullRecentAct; board = 帶看板值者(含兩個抽亂數者); all = 共用工具區之全部
            assert.deepEqual(Object.keys(runs.none.seeds[0].metrics.ext), ['nullRecentAct'])
            assert.deepEqual(Object.keys(runs.board.seeds[0].metrics.ext).sort(), ['aDraw', 'dA', 'neutralExec', 'nullRecentAct', 'zDraw'])
            assert.deepEqual(Object.keys(runs.all.seeds[0].metrics.ext).sort(), ['aDraw', 'dA', 'dE', 'dN', 'neutralExec', 'nullRecentAct', 'zDraw'])
            //鑑別前提: 抽亂數之診斷確實隨重放之種子而變(兩次重放之看板值不同)、同一次重放於 board 與 all 之值相同(診斷之值不受同時載入之其他診斷影響)
            for (let nm of ['aDraw', 'zDraw']) {
                assert.notEqual(runs.board.seeds[0].metrics.ext[nm].board, runs.board.seeds[1].metrics.ext[nm].board, `${nm}: 抽取隨種子而變`)
                for (let i = 0; i < 2; i++) {
                    assert.equal(runs.all.seeds[i].metrics.ext[nm].board, runs.board.seeds[i].metrics.ext[nm].board, `${nm}: 重放 ${i + 1} 於 board 與 all 之值相同`)
                }
            }
            assert(runs.none.v.raw.replays.every((x) => Number.isFinite(x.S) && Number.isFinite(x.comp) && Number.isFinite(x.recent)), '三項皆為有限數值(鑑別前提)')
            //三種範圍之重放: S、組成對照、近期版逐位相同; 結果檔之分數、組成對照(完整物件)、選集指紋、nullRecentAct 之輸出(去耗時)亦逐位相同
            for (let mode of ['board', 'all']) {
                assert.deepEqual(runs[mode].v.raw.replays.map(({ S, comp, recent }) => ({ S, comp, recent })), runs.none.v.raw.replays.map(({ S, comp, recent }) => ({ S, comp, recent })), `${mode}: 重放之 S / comp / recent`)
                assert.deepEqual(runs[mode].v.raw.seedS, runs.none.v.raw.seedS, `${mode}: seedS`)
                for (let i = 0; i < 2; i++) {
                    let a = runs[mode].seeds[i]
                    let b = runs.none.seeds[i]
                    assert.deepStrictEqual(a.score, b.score, `${mode} 重放 ${i + 1}: score`)
                    assert.deepEqual(a.metrics.nullSideAct, b.metrics.nullSideAct, `${mode} 重放 ${i + 1}: nullSideAct`)
                    assert.equal(a.metrics.selHash, b.metrics.selHash, `${mode} 重放 ${i + 1}: selHash`)
                    assert.deepEqual(strip(a.metrics.ext.nullRecentAct), strip(b.metrics.ext.nullRecentAct), `${mode} 重放 ${i + 1}: nullRecentAct 之輸出`)
                }
                //節點文件之重放一列: 前段(S、組成對照、近期版)相同
                let head = (ls) => replayLine({ notes: ls }).split(';擴充診斷之看板值之均')[0].split(' —— 每次同時換')[0]
                assert.equal(head(runs[mode].v.notes), head(runs.none.v.notes), `${mode}: 重放一列之前段`)
            }
        })

        //規格(Gitea #199 主控之裁定 1): 'board'(含預設)另載入正本之 neutralExec(有有限之 delta 而無看板值者): 重放之紀錄帶其 delta, 排序鍵(rankKeyOf)依各抽自己之差計
        //  (與用正本之差者可分辨); 'none' ⇒ 不載入、鍵用正本之差(同改前); 明列之陣列(不含它)⇒ 不載入、鍵用正本之差
        it('⑧ board(預設)另載入正本之 neutralExec(無看板值):重放之紀錄帶其 delta、排序鍵依各抽之差計;none 與不含它之名之陣列 ⇒ 不載入、鍵用正本之差', async () => {
            //中性執行之診斷: 只有 delta 與 sNeutral, 無看板值(board)
            let neNb = 'export default function (api) {\n    let sels = api.phases.map((ph) => ph.sels)\n    let r = api.simulate(sels, null, { accept: (sig, book) => book.open < 30 })\n    let s0 = 0.7 * api.obs.mean + 0.3 * Math.min(...api.obs.byPhase)\n    let s1 = 0.7 * r.mean + 0.3 * Math.min(...r.byPhase)\n    let d = Math.round((s0 - s1) * 100) / 100\n    return { text: "中性(無看板值)", sNeutral: Math.round(s1 * 100) / 100, delta: d }\n}\n'
            let diags = ['dA', 'dE', 'dN', 'nullRecentAct']
            let run = async (name, replicaExt) => {
                let p = mkProj(name, { diags, replicaExt, extra: { neutralExec: neNb } })
                let v = await verifyOf(p)
                assert.equal(v.ok, true, `${name}: ${JSON.stringify(v).slice(0, 400)}`)
                assert.equal(v.raw.replays.length, 2, `${name}: 兩次重放皆執行(鑑別前提:含亂數之挑選)`)
                return { p, v, seeds: [1, 2].map((i) => seedJson(p, i)) }
            }
            let b = await run('neNbBoard', undefined)
            let d0 = b.v.raw.metrics.ext.neutralExec.delta
            assert(Number.isFinite(d0) && !('board' in b.v.raw.metrics.ext.neutralExec), '正本之 neutralExec 有有限之 delta 而無看板值(鑑別前提)')
            //載入範圍: 帶看板值者(dA)+ nullRecentAct + 正本之 neutralExec(dE 出錯、dN 無看板值不載入)
            for (let s of b.seeds) {
                assert.deepEqual(Object.keys(s.metrics.ext).sort(), ['dA', 'neutralExec', 'nullRecentAct'])
            }
            //紀錄: 帶其 delta(重放之結果檔之值); 無看板值者只存 delta
            for (let i = 0; i < 2; i++) {
                assert.deepEqual(b.v.raw.replays[i].ext.neutralExec, { delta: b.seeds[i].metrics.ext.neutralExec.delta }, `重放 ${i + 1} 之紀錄`)
                assert(Number.isFinite(b.v.raw.replays[i].ext.neutralExec.delta))
            }
            assert(b.v.raw.replays.some((x) => x.ext.neutralExec.delta !== d0), '至少一次重放之 delta 異於正本之 delta(鑑別前提)')
            //排序鍵: 依各抽自己之差 = ((S0 − d0) + (S1 − d1) + (S2 − d2)) / 3; 用正本之差者 = ((S0 − d0) + (S1 − d0) + (S2 − d0)) / 3
            let S0 = b.v.score.S
            let [r1, r2] = b.v.raw.replays
            let perDraw = ((S0 - d0) + (r1.S - r1.ext.neutralExec.delta) + (r2.S - r2.ext.neutralExec.delta)) / 3
            let withD0 = ((S0 - d0) + (r1.S - d0) + (r2.S - d0)) / 3
            assert.notEqual(perDraw, withD0, '依各抽之差與依正本之差可分辨(鑑別前提)')
            assert.strictEqual(rankKeyOf({ score: { S: S0 }, raw: b.v.raw }), perDraw)
            //none: 只載入 nullRecentAct、紀錄不帶 ext、鍵用正本之差(重放之 S 與 board 者逐位相同 ⇒ 鍵 = withD0)
            let n = await run('neNbNone', 'none')
            for (let s of n.seeds) {
                assert.deepEqual(Object.keys(s.metrics.ext), ['nullRecentAct'])
            }
            assert(n.v.raw.replays.every((x) => !('ext' in x)))
            assert.deepEqual(n.v.raw.replays.map((x) => x.S), b.v.raw.replays.map((x) => x.S))
            assert.strictEqual(rankKeyOf({ score: { S: n.v.score.S }, raw: n.v.raw }), withD0)
            //名之陣列(不含 neutralExec): 照所列、不自動加; 鍵用正本之差
            let a = await run('neNbArr', ['dA'])
            for (let s of a.seeds) {
                assert.deepEqual(Object.keys(s.metrics.ext).sort(), ['dA', 'nullRecentAct'])
            }
            assert(a.v.raw.replays.every((x) => x.ext && !('neutralExec' in x.ext)))
            assert.strictEqual(rankKeyOf({ score: { S: a.v.score.S }, raw: a.v.raw }), withD0)
            //all: 本即含之(共用工具區之全部)
            let all = await run('neNbAll', 'all')
            for (let s of all.seeds) {
                assert(s.metrics.ext.neutralExec && Number.isFinite(s.metrics.ext.neutralExec.delta))
            }
            assert.strictEqual(rankKeyOf({ score: { S: all.v.score.S }, raw: all.v.raw }), perDraw)
        })

        //規格(Gitea #199 主控之裁定 1): 正本之 neutralExec 為無值之形(帶 error、缺 delta)者, board 之載入範圍與前一輪相同(不載入它)
        it('⑧ 正本之 neutralExec 無值(診斷自述 error、缺 delta)⇒ board 不載入它(重放之結果檔與紀錄與前一輪相同)', async () => {
            let forms = {
                neErr: 'export default function (api) {\n    return { text: "中性", error: "診斷自述失敗", delta: 3.2 }\n}\n',
                neNoDelta: 'export default function (api) {\n    return { text: "中性", sNeutral: 30.1 }\n}\n',
            }
            for (let [name, src] of Object.entries(forms)) {
                let p = mkProj(name, { diags: ['dA', 'nullRecentAct'], extra: { neutralExec: src } })
                let v = await verifyOf(p)
                assert.equal(v.ok, true, `${name}: ${JSON.stringify(v).slice(0, 400)}`)
                assert.equal(v.raw.replays.length, 2, `${name}: 兩次重放皆執行`)
                assert(v.raw.metrics.ext.neutralExec, `${name}: 正本有此診斷(鑑別前提)`)
                for (let i = 1; i <= 2; i++) {
                    assert.deepEqual(Object.keys(seedJson(p, i).metrics.ext).sort(), ['dA', 'nullRecentAct'], name)
                }
                assert(v.raw.replays.every((x) => x.ext && Object.keys(x.ext).sort().join() === 'dA,nullRecentAct'), name)
            }
        })

        //規格(規則 R-REC-38 ⑦): 重放之紀錄之近期版(recent)與節點文件之重放一列之近期版之「(正本 …)」同取 recentDiagOf 之「有值」(物件、不帶 error、超額為有限數值; 只用超額之處不要求 p)
        //  診斷自行回帶 error 或形狀不合之物件(評估器照存; 核心不會同時給 error 與 side, 此為檔內可出現之形; NaN / Infinity 存檔成 null 而僅見於記憶體, 由 unit-recentDiag 之純函數與 notesOf 涵蓋)
        it('R-REC-38 ⑦ 近期活躍度版之診斷之各形: 帶 error(仍有 side)、超額為字串 ⇒ 重放之紀錄之 recent 為 null、重放一列不列近期版之「(正本 …)」; 只給超額(無 p)⇒ 取其超額; 有限值者(對照)不變', async () => {
            let variants = [
                { name: 'nraErr', body: '{ text: "近期版", error: "診斷自述失敗", side: { excess: 3, p: 0.1 }, board: "x" }', recent: null },
                { name: 'nraStr', body: '{ text: "近期版", side: { excess: "3", p: 0.1 }, board: "x" }', recent: null },
                { name: 'nraNoP', body: '{ text: "近期版", side: { excess: 3 }, board: "x" }', recent: 3 },
            ]
            for (let x of variants) {
                let p = mkProj(x.name, { replicaExt: 'none', extra: { nullRecentAct: `export default function (api) {\n    return ${x.body}\n}\n` } })
                let v = await verifyOf(p)
                assert.equal(v.ok, true, `${x.name}: ${JSON.stringify(v).slice(0, 400)}`)
                assert.equal(v.raw.replays.length, 2, `${x.name}: 兩次重放皆執行`)
                let o = seedJson(p, 1)
                assert(o.metrics.ext.nullRecentAct.side.excess === 3 || o.metrics.ext.nullRecentAct.side.excess === '3', `${x.name}: 重放之結果檔帶其 side(鑑別前提)`)
                assert(Number.isFinite(v.raw.replays[0].comp), `${x.name}: 組成對照照常(鑑別前提)`)
                assert.deepStrictEqual(v.raw.replays.map((r) => r.recent), [x.recent, x.recent], `${x.name}: ${JSON.stringify(v.raw.replays)}`)
                //重放一列: 近期版之「(正本 x)」只在正本有值時列(正本之診斷與重放同形)
                assert.equal(/近期活躍度之組成對照之超額 [^(;]*\(正本 3\.0\)/.test(replayLine(v)), x.recent === 3, `${x.name}: ${replayLine(v)}`)
                if (x.recent === null) {
                    assert(replayLine(v).includes('近期活躍度之組成對照之超額 — / — ——'), `${x.name}: ${replayLine(v)}`)
                }
            }
            //對照: 有限值之診斷(res.none)者之近期版為有限數值, 重放一列列「(正本 x)」
            assert(res.none.v.raw.replays.every((x) => Number.isFinite(x.recent)))
            assert(/近期活躍度之組成對照之超額 [-\d.]+ \/ [-\d.]+\(正本 [-\d.]+\)/.test(replayLine(res.none.v)), replayLine(res.none.v))
        })
    })
})
