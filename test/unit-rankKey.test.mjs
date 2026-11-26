import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeProject, rankKeyOf } from '../src/domain/domain.mjs'
import { specHash } from '../src/engineApi.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//排序鍵(規則 R-REC-40): 看板與搜尋地圖之「最佳 / 最高」、節點任務書之參考節點、補位之底共用一個鍵(rankKeyOf)
//  規格: ①鍵 = 各抽(正本與各次重放)之值之均; 一抽之值 = 該抽之 S, 正本有中性執行之差(metrics.ext.neutralExec.delta 為有限數值、不帶 error)者先減去該抽之差(重放未帶其值者用正本之差)
//    ②無重放且無該差者 = 正本之 S(逐位相同); 正本之 S 非有限數值者為 null; S 非有限數值之重放不計入
//    ③用鍵處: 看板之節點一覽之次序與各臂之「回測期最佳 S」、搜尋地圖之各「最高」(本輪、量尺、有內容、子集、各層)、任務書之參考節點、補位之底
//    ④依鍵之結果與依 S 之結果相同之處逐字不變; 不同之處列依鍵之結果、S 照列並註明排序鍵(說明之一段 / 一句只在有不同時出現)
//    ⑤同鍵之次序: 各處沿用現行之同分規則(看板與搜尋地圖、參考節點 = 穩定排序之先者; 補位之底 = 依 id)
//  接縫不用替身: 真 w-recursi 之樹 + 本套件真實之領域(makeProject 之 writeBoard → writeSearchMap、taskFor、domain.carriers); 節點以 putNode 直接入樹
//  合成資料: 各欄之值逐節點相異; 重放之 S 依情境取不同之組(mild = 次序不變、big = 次序改變、real = 含分母型之成品)
describe('排序鍵:量尺、參考節點、補位之底與「最佳」(規則 R-REC-40)', function () {
    this.timeout(120000)

    describe('rankKeyOf(純函數)', function () {
        let nd = (S, replays, ext, extra = {}) => ({ score: { S }, raw: { metrics: { ext: ext || {} }, ...(replays ? { replays } : {}) }, ...extra })
        it('② 無重放且無中性執行之差 ⇒ 正本之 S(逐位相同);正本之 S 非有限數值 ⇒ null', () => {
            assert.strictEqual(rankKeyOf(nd(41.07)), 41.07)
            assert.strictEqual(rankKeyOf(nd(-9.36, [])), -9.36)
            assert.strictEqual(rankKeyOf({ score: { S: 12.5 } }), 12.5, '無 raw')
            for (let bad of [NaN, Infinity, -Infinity, null, undefined, '12.5']) {
                assert.strictEqual(rankKeyOf(nd(bad, [{ S: 1 }])), null, String(bad))
            }
            assert.strictEqual(rankKeyOf(null), null)
            assert.strictEqual(rankKeyOf({}), null)
        })
        it('① 有重放 ⇒ 各抽之 S 之均;S 非有限數值之重放不計入', () => {
            //獨立之算式: (41.07 + 43.88 + 47.65) / 3
            assert.strictEqual(rankKeyOf(nd(41.07, [{ S: 43.88, comp: 1 }, { S: 47.65, comp: 2 }])), (41.07 + 43.88 + 47.65) / 3)
            assert.strictEqual(rankKeyOf(nd(10, [{ S: 20 }, { S: NaN }, { S: null }, { S: '30' }, null, { S: Infinity }])), 15)
            //鑑別前提: 均 ≠ 正本之 S
            assert.notEqual(rankKeyOf(nd(41.07, [{ S: 43.88 }])), 41.07)
        })
        it('① 各抽之值全相同(重放之 S 恰等於正本之 S)⇒ 該值本身(逐位),不留和除以抽數之 1 ULP 尾差(同 S 之節點之同分次序不被尾差改變)', () => {
            //鑑別前提: 以和除以抽數之均於此值有尾差(三個 3.3 之均為 3.2999999999999994)
            assert.notStrictEqual((3.3 + 3.3 + 3.3) / 3, 3.3)
            assert.strictEqual(rankKeyOf(nd(3.3, [{ S: 3.3 }, { S: 3.3 }])), 3.3)
            assert.strictEqual(rankKeyOf(nd(3.3, [{ S: 3.3 }])), 3.3)
            //有中性執行之差者亦然: 各抽減同一個差後仍相同 ⇒ 該值本身(3.3 − 1.1)
            assert.strictEqual(rankKeyOf(nd(3.3, [{ S: 3.3 }, { S: 3.3 }], { neutralExec: { delta: 1.1 } })), 3.3 - 1.1)
            //不全相同者仍為均(獨立之算式)
            assert.strictEqual(rankKeyOf(nd(3.3, [{ S: 3.3 }, { S: 3.4 }])), (3.3 + 3.3 + 3.4) / 3)
        })
        it('① 正本有中性執行之差 ⇒ 各抽先減去差(重放未帶者用正本之差、帶者用其自己之差)', () => {
            let ne = (delta, more = {}) => ({ neutralExec: { delta, sNeutral: 0, ...more } })
            //只有正本: 73.14 − 23.56
            assert.strictEqual(rankKeyOf(nd(73.14, null, ne(23.56))), 73.14 - 23.56)
            //重放未帶其值: 各抽皆減正本之差
            assert.strictEqual(rankKeyOf(nd(73.14, [{ S: 70.02 }, { S: 67.31 }], ne(23.56))), ((73.14 - 23.56) + (70.02 - 23.56) + (67.31 - 23.56)) / 3)
            //重放帶其值: 用其自己之差(另一次重放未帶 ⇒ 用正本之差)
            assert.strictEqual(rankKeyOf(nd(73.14, [{ S: 70.02, ext: ne(18.47) }, { S: 67.31 }], ne(23.56))), ((73.14 - 23.56) + (70.02 - 18.47) + (67.31 - 23.56)) / 3)
            //差為 0(執行規則等同中性)⇒ 與無此診斷者相同(重放之均)
            assert.strictEqual(rankKeyOf(nd(41.07, [{ S: 43.88 }, { S: 47.65 }], ne(0))), rankKeyOf(nd(41.07, [{ S: 43.88 }, { S: 47.65 }])))
            //差為負 ⇒ 鍵高於 S(依規格:有值者一律以中性執行之 S 為準)
            assert.strictEqual(rankKeyOf(nd(-38.66, null, ne(12.71))), -38.66 - 12.71)
            assert.strictEqual(rankKeyOf(nd(-51.37, null, ne(-12.71))), -51.37 + 12.71)
        })
        it('① 中性執行之無值之形(未載入、帶 error、非物件、陣列、缺欄、字串、null、NaN、±Infinity)⇒ 視為無值;正本無值而重放帶值者亦不採', () => {
            let rp = [{ S: 43.88 }, { S: 47.65 }]
            let want = rankKeyOf(nd(41.07, rp))
            let forms = [
                ['帶 error', { neutralExec: { error: '診斷拋錯', delta: 23.56 } }],
                ['非物件', { neutralExec: 'x' }],
                ['陣列', { neutralExec: [23.56] }],
                ['null', { neutralExec: null }],
                ['缺 delta', { neutralExec: { sNeutral: 30.12 } }],
                ['delta 為字串', { neutralExec: { delta: '23.56' } }],
                ['delta 為 null', { neutralExec: { delta: null } }],
                ['delta 為 NaN', { neutralExec: { delta: NaN } }],
                ['delta 為 Infinity', { neutralExec: { delta: Infinity } }],
                ['delta 為 -Infinity', { neutralExec: { delta: -Infinity } }],
                ['ext 非物件', null],
            ]
            for (let [name, ext] of forms) {
                let n = nd(41.07, rp, null)
                n.raw.metrics.ext = ext
                assert.strictEqual(rankKeyOf(n), want, name)
            }
            //正本無值而重放帶值 ⇒ 不採(以正本為準)
            assert.strictEqual(rankKeyOf(nd(41.07, [{ S: 43.88, ext: { neutralExec: { delta: 5 } } }, { S: 47.65 }])), want)
            //鑑別前提: 有值者之鍵與無值者不同
            assert.notEqual(rankKeyOf(nd(41.07, rp, { neutralExec: { delta: 23.56 } })), want)
        })
    })

    describe('用鍵之各處(真之樹與領域)', function () {
        let t
        beforeEach(() => {
            t = makeTmp('rankKey')
        })
        afterEach(() => {
            t.cleanup()
        })
        //N: 節點之表(各欄逐節點相異; 合成之值); 重放之 S: mild = 各節點 +0.3 / −0.1(次序不變), big = 節點 1 降、節點 4 升(次序改變), real = big 之節點 1 改為 68.91 / 66.05(配中性執行之差 21.43)
        let N = [
            { k: 1, arms: ['A01_nt'], S: 71.37, round: 1, trust: 'trusted', b: [12.3, 0.011, 0.31, 3.1], big: [44.2, 45.9], real: [68.91, 66.05], delta: 21.43, sub: true },
            { k: 2, arms: ['A02_ntPit'], S: 57.48, round: 1, trust: 'partial', b: [8.7, 0.021, 0.42, 4.2], big: [56.11, 54.06] },
            { k: 3, arms: ['B14_pitKey'], S: 55.62, round: 2, trust: 'trusted', b: [6.1, 0.031, 0.22, 5.3], big: [55.83, 55.79] },
            { k: 4, arms: ['A01_nt', 'B15_newKey'], S: 54.27, round: 2, trust: 'trusted', b: [9.9, 0.012, 0.36, 6.4], big: [57.35, 61.82], sub: true },
            { k: 5, arms: ['A04_act'], S: 49.83, round: 1, trust: 'trusted', b: [3.3, 0.041, 0.44, 7.5], big: [48.97, 47.21] },
            { k: 6, arms: ['A05_nKeys'], S: 43.76, round: 2, trust: 'trusted', b: [-1.1, 0.6, 0.8, 8.6], big: [42.18, 43.55] },
            { k: 7, arms: ['A06_scarce'], S: 76.4, round: 2, trust: 'trusted', vetoed: true, b: [15.5, 0.013, 0.12, 9.7], big: [75.4, 77.41] },
            { k: 8, arms: ['A07_modePure'], S: 33.25, round: 1, trust: null, b: [4.4, 0.022, 0.27, 10.8], big: [38.04, 39.62] },
        ]
        let rpOf = (x, rp) => (rp === 'mild' ? [Math.round((x.S + 0.3) * 100) / 100, Math.round((x.S - 0.1) * 100) / 100] : (rp === 'real' ? (x.real || x.big) : (rp === 'big' ? x.big : null)))
        //mk, 暫存夾之專案 + 依 nodes 入樹; rp = 重放之組(null = 無重放); neOf(x) → 該節點之 metrics.ext.neutralExec(undefined = 不帶); patch = 讀出節點時改值(非有限數值只能如此塞入)
        let mk = ({ rp = null, neOf = () => undefined, nodes = N, patch = null } = {}) => {
            let st = getSettings()
            let d = path.join(t.dir, `proj_${Math.random().toString(36).slice(2, 8)}`)
            st.resources = {}
            st.rsi = { ...st.rsi, root: path.join(d, 'rsi') }
            st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
            st.eval.ledgerDir = path.join(d, 'ledger')
            fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
            fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthRank' }), 'utf8')
            let P = makeProject(st, { dispatch: async () => ({ ok: false, error: 'fake' }), gate: null, catalogFile: path.join(d, 'catalog.json') })
            P.rsi.init()
            let ids = {}
            for (let x of nodes) {
                let spec = { arms: x.arms.slice().sort(), base: null }
                let id = P.idOf(spec)
                ids[x.k] = id
                let [excess, p, share, mean] = x.b
                let ne = neOf(x)
                let rs = rpOf(x, rp)
                let metrics = {
                    selHash: `sel-${x.k}`,
                    op: { eqYr: { mean: 20 + x.k * 1.1, min: -3 - x.k * 0.7, byPhase: [1, 2, 3, 4, 5, 6, 7].map((v) => v * x.k) }, monthlyOrders: { mean: 90 + x.k }, peakHold: { max: 25 + x.k } },
                    null: { mean: -5 - x.k, excess: 10 + x.k, z: 2 + x.k / 10, p: 0.001 * x.k },
                    nullSideAct: { excess, p, share, mean, half: 50, triggered: true },
                    ext: { ...(ne !== undefined ? { neutralExec: ne } : {}), ...(x.sub ? { subDiag: { subset: '子集甲' } } : {}) },
                }
                let raw = { metrics, issues: [], ...(rs ? { seedS: rs.slice(), replays: rs.map((s, i) => ({ S: s, comp: excess + i + 0.5, recent: null })) } : {}) }
                P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round: x.round, raw, score: { S: x.S, ladder: 1, flags: { vetoed: !!x.vetoed, why: [] } }, evidence: { trust: x.trust } })
            }
            if (patch) {
                let get0 = P.rsi.store.getNode
                P.rsi.store.getNode = (nid) => patch(get0(nid))
            }
            P.writeBoard()
            let rd = (f) => fs.readFileSync(path.join(st.rsi.root, f), 'utf8')
            let refs = P.taskFor({ arms: ['C19_jaccard'], base: null }).refs.filter((r) => r.kind === 'node')
            let rel = path.relative(st.FD_ROOT, d).replace(/\\/g, '/')
            return { P, st, ids, board: rd('ARMS_BOARD.md'), map: rd('SEARCH_MAP.md'), refs, carriers: P.domain.carriers(), rel }
        }
        let id8 = (x, k) => x.ids[k].slice(0, 8)
        let kOfId = (x, id) => Number(Object.keys(x.ids).find((k) => x.ids[k] === id))
        let tableOrder = (x) => x.board.split('\n').filter((l) => /^\| `[0-9a-f]{16}` \|/.test(l)).map((l) => kOfId(x, l.split('`')[1]))
        let rowOf = (x, k) => x.board.split('\n').find((l) => l.startsWith(`| \`${x.ids[k]}\` |`)) || ''
        let sCell = (x, k) => rowOf(x, k).split('|')[4].trim()
        let armCell = (x, arm) => ((x.board.split('\n').find((l) => l.startsWith(`| ${arm} |`)) || '').split('|')[6] || '').trim()
        let roundRow = (x, r) => (x.map.split('\n').find((l) => l.startsWith(`| r00${r} |`)) || '').split('|').map((s) => s.trim())
        let layerRow = (x, ly) => (x.map.split('\n').find((l) => new RegExp(`^\\| ${ly} `).test(l)) || '').split('|').map((s) => s.trim())
        //改前之原文(1.0.35): 看板之節點一覽之標題、參考節點之文字之開頭; 搜尋地圖 §1 之說明一列
        let HEAD0 = '## 節點一覽(未被否決者在前;其內依回測期之 S 由高至低)'
        let GAUGE0 = '**進度之量尺 = 「有內容且可信」者之最高者**,列其 S / 最差相位 / 七相位平均 / 對組成對照之超額 / 組成之水準(組成對照之均;S ≈ 組成之水準 + 挑選內容,判進度以超額為主)。**「挑選內容」= 超額之均**:選集之每隻訊號數為全體隨機之 2 倍以上者用近期活躍度版之組成對照,其餘用內建者,取正本與各次重放之平均;挑選內容最高者不等於 S 最高者時兩者並列。「本輪最高 S」含組成,不作量尺。'
        let noKeyText = (x, why) => {
            assert(x.board.split('\n').includes(HEAD0), `${why}: 看板標題為改前原文`)
            assert(x.map.split('\n').includes(GAUGE0), `${why}: 搜尋地圖之說明為改前原文`)
            //(臂目錄之層名與臂名本有「排序鍵」二字 ⇒ 只核本規則之字樣)
            assert(!/依排序鍵|\*\*排序鍵\*\*|\(排序鍵 /.test(x.board) && !/依排序鍵|\*\*排序鍵\*\*/.test(x.map), `${why}: 看板與搜尋地圖無排序鍵之註記`)
            assert(x.refs.every((r) => r.why.startsWith('目前回測期 S 較高之節點(臂 ') && !r.why.includes('排序鍵')), `${why}: 參考節點之文字為改前之格式`)
        }

        it('④ 無重放無診斷:各處依 S(與改前之原文、改前之次序相同);有重放而各處之次序不變:同(無排序鍵之字樣)', () => {
            let x0 = mk()
            noKeyText(x0, '無重放')
            //次序 = 未被否決者依 S 由高至低、被否決者在後(改前之規則)
            assert.deepEqual(tableOrder(x0), [1, 2, 3, 4, 5, 6, 8, 7])
            assert.equal(sCell(x0, 1), '**71.37**')
            assert.equal(armCell(x0, 'A01_nt'), '71.4')
            //搜尋地圖: 第 1 輪之本輪最高 S = 節點 1; 第 2 輪之量尺 = 節點 1(有內容且可信之最高 S)
            assert.equal(roundRow(x0, 1)[4], `71.4(\`${id8(x0, 1)}\`)`)
            assert(roundRow(x0, 2)[5].startsWith(`\`${id8(x0, 1)}\`:71.4 / `), roundRow(x0, 2)[5])
            //參考節點(已審者在前、其內依 S): 1、2、3; 字面值(改前之格式)
            assert.deepEqual(x0.refs.map((r) => kOfId(x0, r.nodeId)), [1, 2, 3])
            assert.equal(x0.refs[0].why, `目前回測期 S 較高之節點(臂 A01_nt;**回測期 S 71.37**、最差相位 -3.7、對隨機挑之超額 11.0;審計:可信;其挑選模組在 ${x0.rel}/rsi/work/${x0.ids[1]}/pick.mjs)`)
            //量尺之子集(節點 1、4): S 最高 = 節點 1(改前之格式)
            assert(x0.map.includes(`其中 2 個屬此子集):S 最高 \`${id8(x0, 1)}\` 71.4(最差相位 -3.7`), x0.map.split('\n').find((l) => l.startsWith('- 「子集甲」')))
            //補位之底 = 可信、未被否決者之 S 最高者 = 節點 1
            assert.equal(x0.carriers.D27_dedup.base, x0.ids[1])
            //有重放而次序不變(各節點 +0.3 / −0.1)
            let x1 = mk({ rp: 'mild' })
            noKeyText(x1, '次序不變之重放')
            assert.deepEqual(tableOrder(x1), tableOrder(x0))
            assert.deepEqual(x1.refs.map((r) => r.nodeId), x0.refs.map((r) => r.nodeId))
            assert.equal(x1.carriers.D27_dedup.base, x0.ids[1])
            //鑑別前提: 重放使鍵與 S 不同(但次序相同)
            assert.notEqual(rankKeyOf(x1.P.rsi.store.getNode(x1.ids[1])), 71.37)
        })

        it('①③ 有重放而次序改變:各用鍵處改依排序鍵(鍵 = 正本與重放之 S 之均),S 照列並註明排序鍵;說明之一段 / 一句各出現一次', () => {
            let x = mk({ rp: 'big' })
            //看板之節點一覽: 依鍵 —— 4(57.81)、2(55.88)、3(55.75)、1(53.82)、5(48.67)、6(43.16)、8(36.97);被否決者在後
            assert.deepEqual(tableOrder(x), [4, 2, 3, 1, 5, 6, 8, 7])
            assert(x.board.includes('## 節點一覽(未被否決者在前;其內依排序鍵由高至低 —— 見表前之「排序鍵」一段)') && !x.board.includes(HEAD0))
            assert.equal(x.board.split('\n').filter((l) => l.startsWith('**排序鍵**(節點一覽之次序、各可選臂之「回測期最佳 S」依此;')).length, 1)
            assert.equal(sCell(x, 4), '**54.27**(排序鍵 57.81)')
            assert.equal(sCell(x, 1), '**71.37**(排序鍵 53.82)')
            //鍵與 S 相同(四捨五入至小數第 2 位)者不註: 被否決之節點 7((76.4 + 75.4 + 77.41) / 3 = 76.403)
            assert.equal(sCell(x, 7), '**76.4**')
            //各可選臂之「回測期最佳 S」: A01_nt 含節點 1、4 ⇒ 依鍵為節點 4(列其 S 並註明);只含一個節點之臂不變
            assert.equal(armCell(x, 'A01_nt'), '54.3(依排序鍵;排序鍵 57.8)')
            assert.equal(armCell(x, 'A02_ntPit'), '57.5')
            assert(x.board.includes('「回測期最佳 S」標「依排序鍵」者:此臂之 S 最高者與排序鍵最高者不同'))
            //搜尋地圖: 第 1 輪之本輪最高 = 節點 2(鍵 55.9 > 節點 1 之 53.8);第 2 輪之量尺 = 節點 4;各層之「有內容者之最高 S」(A:4、B:4)
            assert.equal(roundRow(x, 1)[4], `57.5〔依排序鍵 55.9〕(\`${id8(x, 2)}\`)`)
            assert(roundRow(x, 2)[5].startsWith(`\`${id8(x, 4)}\`:54.3〔依排序鍵 57.8〕 / -5.8 / 24.4 / 9.9 / 6.4`), roundRow(x, 2)[5])
            assert.equal(roundRow(x, 2)[6], `54.3〔依排序鍵 57.8〕(\`${id8(x, 4)}\`)`)
            //第 2 輪之本輪最高(含被否決之節點 7;依鍵亦為 7)⇒ 不註
            assert.equal(roundRow(x, 2)[4], `76.4(\`${id8(x, 7)}\`)`)
            //第 1 輪之量尺(可信且有內容: 1、5)⇒ 依鍵仍為 1 ⇒ 不註(同一格內依鍵與依 S 相同者不變)
            assert(roundRow(x, 1)[5].startsWith(`\`${id8(x, 1)}\`:71.4 / `), roundRow(x, 1)[5])
            //量尺之子集(節點 1、4): 依鍵 = 節點 4 ⇒ 改稱「排序鍵最高」並註明
            assert(x.map.includes(`其中 2 個屬此子集):排序鍵最高 \`${id8(x, 4)}\` 54.3〔依排序鍵 57.8〕(最差相位 -5.8`), x.map.split('\n').find((l) => l.startsWith('- 「子集甲」')))
            assert.equal(layerRow(x, 'A')[7], `54.3〔依排序鍵 57.8〕(\`${id8(x, 4)}\`)`)
            assert.equal(layerRow(x, 'B')[7], `54.3〔依排序鍵 57.8〕(\`${id8(x, 4)}\`)`)
            assert.equal(x.map.split('\n').filter((l) => l.startsWith(GAUGE0) && l.includes('標「〔依排序鍵 …〕」者:該處之「最高」以**排序鍵**選取')).length, 1, '§1 之說明末加一句')
            //參考節點: 依鍵 4、2、3(文字註明依排序鍵與各節點之鍵)
            assert.deepEqual(x.refs.map((r) => kOfId(x, r.nodeId)), [4, 2, 3])
            assert.equal(x.refs[0].why, `目前排序鍵較高之節點(依排序鍵選取,不依單抽之 S;臂 A01_nt+B15_newKey;**回測期 S 54.27**、排序鍵 57.81(正本與各次重放之 S 之均)、最差相位 -5.8、對隨機挑之超額 14.0;審計:可信;其挑選模組在 ${x.rel}/rsi/work/${x.ids[4]}/pick.mjs)`)
            //補位之底: 可信、未被否決者之鍵最高 = 節點 4;載體之臂 = 底之臂 + 該臂
            assert.equal(x.carriers.D27_dedup.base, x.ids[4])
            assert.deepEqual(x.carriers.D27_dedup.arms, ['A01_nt', 'B15_newKey', 'D27_dedup'])
        })

        it('①③ 有中性執行之差(分母型之成品:S 最高而鍵較低)⇒ 不再是最佳、不被選為補位之底與參考節點;其餘節點之差為 0 者之鍵 = 重放之均', () => {
            let ne = (x) => ({ applicable: true, sObs: x.S, sNeutral: Math.round((x.S - (x.delta || 0)) * 100) / 100, delta: x.delta || 0, board: `${(x.S - (x.delta || 0)).toFixed(1)} / Δ ${(x.delta || 0).toFixed(1)}` })
            let x = mk({ rp: 'real', neOf: ne })
            //節點 1: (71.37 − 21.43 + 68.91 − 21.43 + 66.05 − 21.43) / 3 = 47.35 ⇒ 排在節點 5(48.67)之後
            assert.deepEqual(tableOrder(x), [4, 2, 3, 5, 1, 6, 8, 7])
            assert.equal(sCell(x, 1), '**71.37**(排序鍵 47.35)')
            assert(x.board.includes('成品有擴充診斷 `neutralExec` 之值者'))
            assert.equal(roundRow(x, 1)[4], `57.5〔依排序鍵 55.9〕(\`${id8(x, 2)}\`)`, '第 1 輪之本輪最高 S 不是節點 1')
            //第 1 輪之量尺(可信且有內容: 1、5)⇒ 節點 5(鍵 48.7 > 47.3)
            assert(roundRow(x, 1)[5].startsWith(`\`${id8(x, 5)}\`:49.8〔依排序鍵 48.7〕 / `), roundRow(x, 1)[5])
            assert(!x.refs.some((r) => r.nodeId === x.ids[1]), '節點 1 不為參考節點')
            assert(x.refs.every((r) => r.why.includes('以中性執行之 S 計')), '有其值者註明')
            assert.notEqual(x.carriers.D27_dedup.base, x.ids[1])
            assert.equal(x.carriers.D27_dedup.base, x.ids[4])
            //對照(鑑別前提): 同一棵樹不帶中性執行之值 ⇒ 節點 1 之鍵 = 68.78, 為補位之底
            let y = mk({ rp: 'real' })
            assert.equal(y.carriers.D27_dedup.base, x.ids[1])
            assert.deepEqual(tableOrder(y).slice(0, 2), [1, 4])
        })

        it('① 中性執行之無值之形(帶 error、字串、缺欄、null、NaN、±Infinity)⇒ 各檔與不帶此診斷者逐字相同', () => {
            let y = mk({ rp: 'mild' })
            let forms = [
                ['帶 error', () => ({ error: '診斷拋錯', delta: 23.56 })],
                ['字串', () => ({ delta: '23.56' })],
                ['缺 delta', () => ({ sNeutral: 30.12 })],
                ['delta 為 null', () => ({ delta: null })],
            ]
            for (let [name, f] of forms) {
                let x = mk({ rp: 'mild', neOf: f })
                assert.deepEqual(x.ids, y.ids)
                assert.equal(x.board, y.board, `看板(${name})`)
                assert.equal(x.map, y.map, `搜尋地圖(${name})`)
                assert.deepEqual(x.refs.map((r) => r.nodeId), y.refs.map((r) => r.nodeId), `參考節點(${name})`)
                assert.deepStrictEqual(x.carriers, y.carriers, `補位(${name})`)
            }
            for (let [name, v] of [['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity]]) {
                let patch = (n) => {
                    if (n && n.raw && n.raw.metrics && n.raw.metrics.ext && n.raw.metrics.ext.neutralExec) {
                        n.raw.metrics.ext.neutralExec.delta = v
                    }
                    return n
                }
                let x = mk({ rp: 'mild', neOf: () => ({ delta: 23.56 }), patch })
                assert.equal(x.board, y.board, `看板(${name})`)
                assert.equal(x.map, y.map, `搜尋地圖(${name})`)
                assert.deepStrictEqual(x.carriers, y.carriers, `補位(${name})`)
            }
            //鑑別前提: 有限之差會改變次序
            let z = mk({ rp: 'mild', neOf: (x) => ({ delta: x.k === 1 ? 23.56 : 0 }) })
            assert.notDeepEqual(tableOrder(z), tableOrder(y))
        })

        it('⑤ 同鍵之次序:看板、搜尋地圖與參考節點 = 穩定排序之先者(同改前之同分規則);補位之底 = 依 id', () => {
            //節點 a、b: S 與重放皆相同(鍵相同); 節點 c: S 較低而鍵與之相同之情形以相同之重放造出不易, 改以 S 相同、鍵相同之兩節點核對同分規則
            let nodes = [
                { k: 1, arms: ['A01_nt'], S: 44.18, round: 1, trust: 'trusted', b: [9.1, 0.011, 0.31, 3.1], big: [46.03, 49.71] },
                { k: 2, arms: ['A02_ntPit'], S: 44.18, round: 1, trust: 'trusted', b: [8.2, 0.012, 0.32, 3.2], big: [46.03, 49.71] },
                { k: 3, arms: ['A04_act'], S: 45.0, round: 1, trust: 'trusted', b: [7.3, 0.013, 0.33, 3.3], big: [43.0, 44.0] },
            ]
            let x = mk({ rp: 'big', nodes })
            //鑑別前提: 入樹之次序與 id 之次序相反(先入者之 id 較大)—— 否則「依索引」與「依 id」之同分規則無從分辨; 不然則倒序入樹再做一次
            if (x.ids[1] < x.ids[2]) {
                x = mk({ rp: 'big', nodes: [nodes[1], nodes[0], nodes[2]] })
            }
            let idxOrder = x.P.rsi.store.listIndex().map((r) => kOfId(x, r.id)).filter((k) => k === 1 || k === 2)
            let lo = [x.ids[1], x.ids[2]].sort()[0]
            assert.notEqual(x.ids[idxOrder[0]], lo, '鑑別前提: 先入樹者之 id 較大')
            //依鍵: 1 與 2(46.64)、3(44.0);1 與 2 同鍵 ⇒ 入樹之次序(穩定排序)
            let order = tableOrder(x)
            assert.deepEqual(order.slice(0, 2), idxOrder, '同鍵者依索引之次序(同改前之同分規則)')
            assert.equal(order[2], 3)
            assert.deepEqual(x.refs.map((r) => kOfId(x, r.nodeId)).slice(0, 2), idxOrder)
            //補位之底: 同鍵者依 id(小者)
            assert.equal(x.carriers.D27_dedup.base, lo)
        })
    })
})
