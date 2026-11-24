import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { notesOf } from '../src/domain/verify.mjs'
import { buildPickStore, infoOf } from '../src/domain/pickStore.mjs'
import { makeTmp } from './tools/synthLedger.mjs'

//近期活躍度版之組成對照(核心以名稱讀取之擴充診斷 nullRecentAct)之「有值」之唯一判準(規則 R-REC-38 ⑥ ⑦; Gitea #199 主控另加之收斂)
//  規格: ①「有值」= m.ext.nullRecentAct 為物件、不帶 error、其 side 為物件、side.excess 為有限數值(只用超額之處不要求 p); 判準只有一處定義(src/domain/diagRead.mjs 之 recentDiagOf),
//      領域(domain.mjs; 另見 unit-searchMapRecent)、迴圈之驗證(verify.mjs 之節點文件之重放一列與重放之紀錄; 紀錄見 unit-replayExt)、共同儲存區(pickStore.mjs)共用之
//    ②有限值之輸出逐位不變
//    ③無值之形(NaN、±Infinity、字串、缺超額、null、帶 error、side 非物件、診斷非物件)於各讀取點一律視為無值: 節點文件之重放一列不列近期版之「(正本 …)」;
//      共同儲存區之 backtest.content 之 recent / pRecent 皆 null、mean = 內建之超額
//    (節點以 JSON 儲存, NaN / ±Infinity 存成 null, 只於記憶體內可能出現; 帶 error 與缺欄之形則可於檔內出現)
describe('近期活躍度版之組成對照之「有值」之唯一判準(規則 R-REC-38 ⑥ ⑦)', function () {
    this.timeout(120000)

    //有限值之形(輸出須與改前逐位相同)與無值之形
    let GOOD = [
        { name: '超額與 p 皆有限', v: { side: { excess: 20.1, p: 0.03 } }, recent: 20.1, pRecent: 0.03, mean: 30.2 },
        { name: '只給超額(不要求 p)', v: { side: { excess: 20.1 } }, recent: 20.1, pRecent: null, mean: 30.2 },
        { name: '超額為 0', v: { side: { excess: 0, p: 0.5 } }, recent: 0, pRecent: 0.5, mean: 20.1 },
        { name: '超額為負', v: { side: { excess: -3.2, p: 0.5 } }, recent: -3.2, pRecent: 0.5, mean: 18.5 },
    ]
    let BAD = [
        { name: '超額為 NaN', v: { side: { excess: NaN, p: 0.03 } } },
        { name: '超額為 Infinity', v: { side: { excess: Infinity, p: 0.03 } } },
        { name: '超額為 -Infinity', v: { side: { excess: -Infinity, p: 0.03 } } },
        { name: '超額為數字字串', v: { side: { excess: '20.1', p: 0.03 } } },
        { name: '超額為 null', v: { side: { excess: null, p: 0.03 } } },
        { name: '缺超額', v: { side: { p: 0.03 } } },
        { name: '帶 error 而仍有 side', v: { error: '診斷拋錯', side: { excess: 20.1, p: 0.03 } } },
        { name: '只有 error', v: { error: '診斷拋錯' } },
        { name: 'side 為 null', v: { side: null } },
        { name: 'side 為字串', v: { side: '20.1' } },
        { name: 'side 為陣列', v: { side: [20.1] } },
        { name: '缺 side', v: { text: '近期版' } },
        { name: '診斷為字串', v: '20.1' },
        { name: '診斷為 null', v: null },
    ]

    describe('① 取值函數(純函數)', function () {
        it('有限之超額者回該 side(同一個物件); 其餘(非有限、字串、缺、null、帶 error、非物件)回 null', async () => {
            //動態匯入: 於未含本檔之版本(修前)僅本案失敗, 不使整檔無法載入
            let { recentDiagOf } = await import('../src/domain/diagRead.mjs')
            for (let g of GOOD) {
                assert.strictEqual(recentDiagOf({ ext: { nullRecentAct: g.v } }), g.v.side, g.name)
            }
            for (let b of BAD) {
                assert.strictEqual(recentDiagOf({ ext: { nullRecentAct: b.v } }), null, b.name)
            }
            for (let m of [null, undefined, {}, { ext: null }, { ext: 'x' }, { ext: {} }, { ext: { other: { side: { excess: 1 } } } }]) {
                assert.strictEqual(recentDiagOf(m), null, JSON.stringify(m))
            }
        })
    })

    describe('② 節點文件之重放一列(notesOf)', function () {
        let m0 = { op: { eqYr: { byPhase: [1, 2, 3] }, monthlyOrders: { mean: 1 } }, nullSideAct: { excess: 4.4 } }
        let line = (ls) => ls.find((l) => l.startsWith('換亂數種子與同分次序之重放')) || ''
        let rp = [{ S: 2.5, comp: 3.3, recent: null }, { S: 3.5, comp: 5.5, recent: null }]
        let HEAD = '換亂數種子與同分次序之重放(迴圈;組成對照 32 抽): S 2.5 / 3.5;組成對照之超額 3.3 / 5.5(正本 4.4);近期活躍度之組成對照之超額 — / —'
        let TAIL = ' —— 每次同時換 ctx.rand 之種子與同分次序(ctx.meta.tie、同一進場棒之訊號先後);含隨機抽取、或主鍵大量同分(入選者實際由 tie 決定)之成品其結果隨之波動;各次之 S 與主分數相差很大者,主分數不可靠;**判內容以正本與各次重放之超額之平均為準,不以單抽**'
        it('有限值: 近期版之「(正本 x)」照列(改前原文之字面值); 不帶此診斷者不列', () => {
            for (let g of GOOD) {
                let ls = line(notesOf({ ...m0, ext: { nullRecentAct: g.v } }, [2.5, 3.5], null, rp))
                assert.equal(ls, `${HEAD}(正本 ${g.recent.toFixed(1)})${TAIL}`, g.name)
            }
            assert.equal(line(notesOf(m0, [2.5, 3.5], null, rp)), `${HEAD}${TAIL}`)
        })
        it('無值之形: 不列近期版之「(正本 …)」(NaN / Infinity 不寫成 "NaN" / "Infinity"; 帶 error 者不列)', () => {
            for (let b of BAD) {
                assert.equal(line(notesOf({ ...m0, ext: { nullRecentAct: b.v } }, [2.5, 3.5], null, rp)), `${HEAD}${TAIL}`, b.name)
            }
        })
    })

    describe('③ 共同儲存區(infoOf、buildPickStore)', function () {
        let id1 = 'aaaaaaaaaaaaaaa1'
        let id2 = 'bbbbbbbbbbbbbbb2'
        let mk = (id, S, nra) => ({
            nodeId: id,
            round: 3,
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
                score: { S, ladder: 3, flags: { vetoed: false, why: [] } },
                raw: { replays: [{ S: S - 1, comp: 10, recent: 12 }], metrics: { selHash: 'h1', ledgerKey: 'k', ms: { pick: 4200 }, sel: { sigPerPick: 2.5, longRatio: 0.6 }, op: { eqYr: { mean: 12.345, min: -1.2, byPhase: [5, -1.2, 9, 20, 30, 11, 12] }, monthlyOrders: { mean: 100.04 }, peakHold: { max: 30 }, winRate: 0.45678 }, nullSideAct: { excess: 40.26, p: 0.0154 }, ext: nra === undefined ? {} : { nullRecentAct: nra } } },
            },
            audit: { round: 3, by: 'm', trust: 'trusted', action: 'accept', evidence: [], issues: [], inactiveArms: [] },
        })
        it('infoOf: 有限值之 backtest.content 逐位不變(改前原文之字面值); 無值之形 ⇒ recent / pRecent 皆 null、mean = 內建之超額', () => {
            for (let g of GOOD) {
                assert.deepStrictEqual(infoOf(mk(id1, 10.5, g.v)).backtest.content, { builtin: 40.3, p: 0.0154, recent: g.recent, pRecent: g.pRecent, mean: g.mean }, g.name)
            }
            //不帶此診斷者(改前亦如此)
            assert.deepStrictEqual(infoOf(mk(id1, 10.5)).backtest.content, { builtin: 40.3, p: 0.0154, recent: null, pRecent: null, mean: 40.3 })
            for (let b of BAD) {
                assert.deepStrictEqual(infoOf(mk(id1, 10.5, b.v)).backtest.content, { builtin: 40.3, p: 0.0154, recent: null, pRecent: null, mean: 40.3 }, b.name)
            }
        })
        it('buildPickStore: 帶 error 之診斷(仍有 side)之節點 ⇒ info.json / index.json / INDEX.md 之近期版皆無值; 有限值者不變', async () => {
            let t = makeTmp('recentDiagStore')
            try {
                let d = path.join(t.dir, 'proj')
                let st = { FD_ROOT: d, rsi: { root: path.join(d, 'rsi') }, records: { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), workDir: path.join(d, 'rsi/work') } }
                for (let k of Object.keys(st.records)) {
                    fs.mkdirSync(st.records[k], { recursive: true })
                }
                let docs = [mk(id1, 10.5, { side: { excess: 20.1, p: 0.03 } }), mk(id2, 55.25, { error: '診斷拋錯', side: { excess: 33.3, p: 0.02 } })]
                for (let doc of docs) {
                    fs.mkdirSync(path.join(st.records.workDir, doc.nodeId), { recursive: true })
                    fs.writeFileSync(path.join(st.records.workDir, doc.nodeId, 'pick.mjs'), `export const meta = { arms: ['A01_nt'], params: {}, desc: 'd' }\nexport default function pick(ctx) {\n    return []\n}\n`, 'utf8')
                    fs.writeFileSync(path.join(st.records.nodeDir, `${doc.nodeId}.json`), JSON.stringify(doc), 'utf8')
                }
                await buildPickStore(st)
                let dir = path.join(st.rsi.root, 'picks')
                let info = (id) => JSON.parse(fs.readFileSync(path.join(dir, id, 'info.json'), 'utf8'))
                assert.deepEqual(info(id1).backtest.content, { builtin: 40.3, p: 0.0154, recent: 20.1, pRecent: 0.03, mean: 30.2 })
                assert.deepStrictEqual(info(id2).backtest.content, { builtin: 40.3, p: 0.0154, recent: null, pRecent: null, mean: 40.3 })
                let idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
                assert.deepStrictEqual(idx.items.map((x) => [x.id, x.backtest.content.recent, x.backtest.content.mean]), [[id2, null, 40.3], [id1, 20.1, 30.2]])
                let md = fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8')
                let row = (id) => md.split('\n').find((l) => l.includes(id.slice(0, 8))) || ''
                assert(row(id1).includes('40.3 / 20.1(0.0154)'), row(id1))
                assert(row(id2).includes('40.3 / —(0.0154)'), row(id2))
            }
            finally {
                t.cleanup()
            }
        })
    })
})
