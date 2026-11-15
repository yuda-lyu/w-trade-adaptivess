import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { buildPickStore, infoOf, FIELD_DEFS } from '../src/domain/pickStore.mjs'
import { makeTmp } from './tools/synthLedger.mjs'

describe('共同儲存「自適應挑選策略」區(規則 R-REC-25;保留期只列正負號:R-BT-4)', function () {
    let t
    let st
    let id1 = 'aaaaaaaaaaaaaaa1'
    let id2 = 'bbbbbbbbbbbbbbb2'
    let id3 = 'ccccccccccccccc3'
    let doc = (id, S, extra = {}) => ({
        nodeId: id,
        round: 3,
        attempt: 1,
        status: 'executed',
        spec: { arms: ['A01_nt', 'B14_pitKey'], base: null },
        task: { goal: 'g', type: 'explore' },
        plan: {},
        code: {},
        results: { claimed: {} },
        conclusion: { outcome: 'improved', summary: '結論之摘要  含多餘空白' },
        harness: {
            ok: true,
            summary: [],
            notes: [],
            checks: { issues: ['分數不穩: 假'] },
            score: { S, ladder: 3, flags: { vetoed: false, why: [] } },
            raw: { replays: [{ S: S - 1, comp: 10, recent: 12 }], metrics: { selHash: 'h1', ledgerKey: 'k', ms: { pick: 4200 }, sel: { sigPerPick: 2.5, longRatio: 0.6 }, op: { eqYr: { mean: 12.345, min: -1.2, byPhase: [5, -1.2, 9, 20, 30, 11, 12] }, monthlyOrders: { mean: 100.04 }, peakHold: { max: 30 }, winRate: 0.45678 }, nullSideAct: { excess: 40.26, p: 0.0154 }, ext: { nullRecentAct: { side: { excess: 20.1, p: 0.03 } } } } },
        },
        audit: { round: 3, by: 'm', trust: 'trusted', action: 'accept', evidence: [], issues: [], inactiveArms: ['B14_pitKey'] },
        ...extra,
    })
    before(() => {
        t = makeTmp('pickStore')
        let d = path.join(t.dir, 'proj')
        st = { FD_ROOT: d, rsi: { root: path.join(d, 'rsi') }, records: { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), workDir: path.join(d, 'rsi/work') } }
        for (let k of Object.keys(st.records)) {
            fs.mkdirSync(st.records[k], { recursive: true })
        }
        let pick = (desc) => `export const meta = { arms: ['A01_nt'], params: { take: 40 }, desc: '${desc}' }\nexport default function pick(ctx) {\n    return []\n}\n`
        for (let [id, S] of [[id1, 10.5], [id2, 55.25]]) {
            fs.mkdirSync(path.join(st.records.workDir, id), { recursive: true })
            fs.writeFileSync(path.join(st.records.workDir, id, 'pick.mjs'), pick(`成品 ${id.slice(0, 4)}`), 'utf8')
            fs.writeFileSync(path.join(st.records.nodeDir, `${id}.json`), JSON.stringify(doc(id, S)), 'utf8')
        }
        //無迴圈重跑結果之節點(失敗者)不收
        fs.writeFileSync(path.join(st.records.nodeDir, `${id3}.json`), JSON.stringify({ ...doc(id3, 1), harness: { ok: false, error: '未交付' } }), 'utf8')
        //做夢之家族歸類(取最近一份)
        fs.writeFileSync(path.join(st.records.dreamDir, 'r003.json'), JSON.stringify({ round: 3, synthesis: { overview: { families: [{ name: '家族甲', nodes: [id2.slice(0, 8)] }] } } }), 'utf8')
    })
    after(() => {
        t.cleanup()
    })

    it('infoOf:欄位取自迴圈重跑之數字(不是 agent 自報);挑選內容 = 內建與近 90 日之超額及其均;缺欄為 null 而不拋錯', () => {
        let x = infoOf(doc(id1, 10.5), { meta: { desc: 'd', params: { a: 1 } }, fam: '家族甲', ho: { perf: '+', content: '-', asOf: '2026-11-10T00:00:00' }, storeRel: 'rsi/picks' })
        assert.deepEqual([x.id, x.short, x.round, x.type, x.base, x.family], [id1, id1.slice(0, 8), 3, 'explore', null, '家族甲'])
        assert.deepEqual([x.status.trust, x.status.action, x.status.vetoed, x.status.ladder, x.status.inactiveArms], ['trusted', 'accept', false, 3, ['B14_pitKey']])
        assert.deepEqual([x.backtest.S, x.backtest.eqYrMean, x.backtest.eqYrMin, x.backtest.nPosPhases], [10.5, 12.35, -1.2, 6])
        assert.deepEqual(x.backtest.content, { builtin: 40.3, p: 0.0154, recent: 20.1, pRecent: 0.03, mean: 30.2 })
        assert.deepEqual([x.backtest.monthlyOrders, x.backtest.peakHold, x.backtest.winRate, x.backtest.pickSec, x.backtest.selHash], [100, 30, 0.4568, 4.2, 'h1'])
        assert.deepEqual(x.backtest.replays, [{ S: 9.5, builtin: 10, recent: 12 }])
        assert.deepEqual(x.holdout, { perf: '+', content: '-', asOf: '2026-11-10T00:00:00' })
        assert.deepEqual([x.design.desc, x.design.params, x.design.summary], ['d', { a: 1 }, '結論之摘要 含多餘空白'])
        assert.equal(x.files.pick, `rsi/picks/${id1}/pick.mjs`)
        //舊節點文件缺欄: 不拋錯, 值為 null; 未給保留期者三欄皆 null
        let y = infoOf({ nodeId: id2, round: 1, spec: { arms: ['A01_nt'], base: null }, harness: { ok: true, score: { S: 1 } } })
        assert.deepEqual([y.backtest.eqYrMean, y.backtest.content.mean, y.status.trust, y.design.desc], [null, null, null, null])
        assert.deepEqual(y.holdout, { perf: null, content: null, asOf: null })
    })

    it('buildPickStore:只收有迴圈重跑結果且有交付版者;程式碼逐位複製;總表依 S 由高至低;重跑時內容不變者不重複製', async () => {
        let r = await buildPickStore(st)
        assert.deepEqual([r.n, r.copied, r.holdoutSigned], [2, 2, 0])
        assert(r.skipped.some((s) => s.startsWith(id3.slice(0, 8))), JSON.stringify(r.skipped))
        let dir = path.join(st.rsi.root, 'picks')
        for (let id of [id1, id2]) {
            assert(fs.readFileSync(path.join(dir, id, 'pick.mjs')).equals(fs.readFileSync(path.join(st.records.workDir, id, 'pick.mjs'))), '程式碼為逐位複本')
            assert.equal(JSON.parse(fs.readFileSync(path.join(dir, id, 'info.json'), 'utf8')).id, id)
        }
        assert(!fs.existsSync(path.join(dir, id3)), '無結果之節點不建夾')
        let idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
        assert.deepEqual(idx.items.map((x) => x.id), [id2, id1], '依 S 由高至低')
        assert.deepEqual([idx.items[0].family, idx.items[1].family, idx.items[0].design.desc], ['家族甲', null, `成品 ${id2.slice(0, 4)}`])
        assert.equal(idx.fields.length, FIELD_DEFS.length)
        let md = fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8')
        assert(md.indexOf(`\`${id2.slice(0, 8)}\``) < md.indexOf(`\`${id1.slice(0, 8)}\``) && md.includes('· / ·'), '總表之次序與未算之保留期欄')
        assert(fs.readFileSync(path.join(dir, 'README.md'), 'utf8').includes('只提供正負號'))
        assert.equal((await buildPickStore(st)).copied, 0, '內容未變則不重複製')
        fs.appendFileSync(path.join(st.records.workDir, id1, 'pick.mjs'), '// 改版\n')
        assert.equal((await buildPickStore(st)).copied, 1, '交付版有變(重做)⇒ 更新複本')
    })

    it('保留期之正負號:讀 _holdout.json(主控之檢定工具所寫;只有正負號)併入各策略;重產時不刪、不改該檔;未列者維持 null', async () => {
        let dir = path.join(st.rsi.root, 'picks')
        let fp = path.join(dir, '_holdout.json')
        let text = JSON.stringify({ from: '2026-08-01T00:00:00', asOf: '2026-11-10T00:00:00', items: { [id2]: { perf: '+', content: '-' } } })
        fs.writeFileSync(fp, text, 'utf8')
        let r = await buildPickStore(st)
        assert.equal(r.holdoutSigned, 1)
        assert.equal(fs.readFileSync(fp, 'utf8'), text, '正負號檔原樣保留')
        let idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
        let by = Object.fromEntries(idx.items.map((x) => [x.id, x.holdout]))
        assert.deepEqual(by[id2], { perf: '+', content: '-', asOf: '2026-11-10T00:00:00' })
        assert.deepEqual(by[id1], { perf: null, content: null, asOf: null })
        assert.equal(idx.holdoutAsOf, '2026-11-10T00:00:00')
        let md = fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8')
        assert(md.includes('| + / - |') && md.includes('| · / · |'))
        //共同儲存區內不得出現保留期之數字欄: 各策略之 holdout 只有 perf / content / asOf 三鍵
        assert(idx.items.every((x) => Object.keys(x.holdout).sort().join(',') === 'asOf,content,perf'))
    })
})
