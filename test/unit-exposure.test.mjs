import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { getSettings, FD_ROOT } from '../src/cfg.mjs'
import { makeProject, unproposedNoteOf, rankKeyOf, contentOf } from '../src/domain/domain.mjs'
import { EXPOSURE_DEFAULT, exposureCfgOf, exposureOf, EXPOSURE_HEAD, isExposureHint, exposureHintOf } from '../src/domain/verifyExposure.mjs'
import { rankCompareOf } from '../src/domain/rankCompare.mjs'
import { specHash } from '../src/engineApi.mjs'
import { makeTmp, writeSynthLedger } from './tools/synthLedger.mjs'


//側別曝險不作為底(規則 R-REC-48)
//  規格: ①判定 = 固定側別 ∨(席次之側別隨期改變 ∧(下單流量偏一側 ∨ 時機旗標));訓練期之診斷缺者不判;判定關閉(settings.rsi.exposure = false)者不判
//    ②兩側席次固定之成品必不命中(守門)③曝險且未放行者:補位之底不取(取其次)、方向之提出即拒(不入前緣)、前置閘門拒;放行綁選集指紋
//    ④標示:看板之「S」一欄與表前一段、搜尋地圖之量尺之格與譜系、迴圈檢查之一條、節點任務書之參考節點之註明;皆不改 S、階梯、否決、可信度
//    ⑤放行之工具 tools/exposure.mjs:列出 / 放行 / 撤銷;輪次進行中拒跑;S 與階梯不變;節點文件與提示同步
//  合成資料: 各節點之臂、輪次、S、選集指紋、做多比例、下單之兩側單數、擴充診斷之旗標逐筆相異
//下單流量偏一側之內建基準(verify.mjs 之 SIDE_FLOW; 本檔獨立寫出以免與受測者同源): 回測期 0.16、訓練期 0.22; 兩期皆 ≥ 2.5 倍或皆 ≤ 0.4 倍
let sfI = (bt, tr) => (bt >= 0.16 * 2.5 && tr >= 0.22 * 2.5) || (bt <= 0.16 * 0.4 && tr <= 0.22 * 0.4)
//metricsOf, 合成之 metrics: lr = 回測期之席次之做多比例, bt = 回測期之做空單比例(以兩側之單數表示), flags = { 診斷名: 旗標文字 }
let metricsOf = ({ lr, bt, sizeMax = 5, flags = {}, k = 1 }) => {
    let nOrd = 1000 + k
    let sh = Math.round(nOrd * bt)
    return {
        op: { eqYr: { mean: 20 + k * 1.3, min: -4 - k * 0.6, byPhase: [1, 2, 3, 4, 5, 6, 7].map((v) => v * k) }, monthlyOrders: { mean: 80 + k }, peakHold: { max: 20 + k }, bySide: { long: { orders: nOrd - sh }, short: { orders: sh } } },
        null: { mean: -4 - k, excess: 9 + k, z: 2 + k / 10, p: 0.001 * k },
        nullSideAct: { excess: 6.5 + k, p: 0.01 + k / 1000, share: 0.3 + k / 100, mean: 3 + k, half: 50, triggered: true },
        sel: { longRatio: lr, sizeMax, sizeMean: 3 + k / 10, sigPerPick: 1.1 + k / 100 },
        ext: Object.fromEntries(Object.entries(flags).map(([name, flag]) => [name, { flag }])),
    }
}
let nodeOf = ({ a, lr, bt, tr, sizeMax, flags, sel = 'selX', release = null, k = 1 }) => ({
    raw: { selHash: sel, metrics: metricsOf({ lr, bt, sizeMax, flags, k }), ...(a === null ? {} : { train: { longRatio: a, tags: [], shortShare: tr } }) },
    evidence: { trust: 'trusted', ...(release ? { exposureRelease: release } : {}) },
})

describe('側別曝險之判定(verifyExposure.mjs;規則 R-REC-48)', function () {
    it('設定之解讀:false = 關閉;未給或不合者用預設(不拋錯);flags 可為空陣列', () => {
        assert.deepEqual(EXPOSURE_DEFAULT, { flags: ['fixedState', 'placeboTiming'], minShift: 0.1 })
        assert.strictEqual(exposureCfgOf(false), null)
        for (let v of [undefined, null, true, 'on', 3, [], {}]) {
            assert.deepEqual(exposureCfgOf(v), { flags: ['fixedState', 'placeboTiming'], minShift: 0.1 }, JSON.stringify(v))
        }
        assert.deepEqual(exposureCfgOf({ minShift: 0.25, flags: ['diagA'] }), { flags: ['diagA'], minShift: 0.25 })
        assert.deepEqual(exposureCfgOf({ minShift: 1, flags: [] }), { flags: [], minShift: 1 })
        //minShift 為 (0, 1] 之數值: 範圍外、布林、NaN、±Infinity、空字串與純空白、非數字字串(含十六進位)、BigInt、包裝物件 ⇒ 預設(不當 0 或 1、不拋錯)
        for (let bad of [0, -0.1, 1.5, NaN, Infinity, -Infinity, true, false, null, '', '  ', 'abc', 'Infinity', 'NaN', '0x10', '0', '-0.1', '1.5', '0.2abc', 2n, [0.2], Object(0.2), {}]) {
            assert.equal(exposureCfgOf({ minShift: bad }).minShift, 0.1, `${typeof bad}: ${String(bad)}`)
        }
        //數字字串(跨套件規格〈輸入參數之檢測機制〉K1、K4、K7): 與數值得同一結果、且為數值(其後只用轉換值)
        for (let v of ['0.2', ' 0.2 ', '2e-1', '+0.2', '.2']) {
            assert.deepEqual(exposureCfgOf({ minShift: v }), exposureCfgOf({ minShift: 0.2 }), JSON.stringify(v))
            assert.strictEqual(typeof exposureCfgOf({ minShift: v }).minShift, 'number', JSON.stringify(v))
        }
        assert.equal(exposureCfgOf({ minShift: '1' }).minShift, 1, '上界含')
        assert.deepEqual(exposureCfgOf({ minShift: '0.25', flags: ['diagA'] }), { flags: ['diagA'], minShift: 0.25 })
        for (let bad of [[1], [''], ['  '], 'fixedState', { a: 1 }]) {
            assert.deepEqual(exposureCfgOf({ flags: bad }).flags, ['fixedState', 'placeboTiming'], JSON.stringify(bad))
        }
    })

    it('真值表:命中 = 固定側別 ∨(席次之側別隨期改變 ∧(下單流量偏一側 ∨ 所採計之旗標));與獨立之算式逐格相同(800 格)', () => {
        let cfg = exposureCfgOf()
        let n = 0
        let hits = { fs: 0, shiftSf: 0, shiftFl: 0, none: 0 }
        for (let a of [0.05, 0.3, 0.5, 0.62, 0.95]) {
            for (let b of [0.04, 0.41, 0.5, 0.73, 0.97]) {
                for (let [bt, tr] of [[0.2, 0.25], [0.45, 0.6], [0.05, 0.07], [0.45, 0.25]]) {
                    for (let flags of [{}, { fixedState: '等同固定狀態' }, { placeboTiming: '安慰劑無內容' }, { otherDiag: '他診斷' }]) {
                        for (let sizeMax of [5, 0]) {
                            let nd = nodeOf({ a, lr: b, bt, tr, sizeMax, flags, k: n % 7 + 1 })
                            let e = exposureOf(nd, cfg)
                            let btv = Math.round(Math.round((1000 + (n % 7 + 1)) * bt) / (1000 + (n % 7 + 1)) * 1000) / 1000
                            let fsX = sizeMax > 0 && ((a < 0.1 && b < 0.1) || (a > 0.9 && b > 0.9))
                            let pX = Math.abs(a - b) >= 0.1 - 1e-12
                            let flX = Object.keys(flags).some((x) => x === 'fixedState' || x === 'placeboTiming')
                            let want = fsX || (pX && (sfI(btv, tr) || flX))
                            assert.equal(e.hit, want, JSON.stringify({ a, b, bt, tr, flags, sizeMax }))
                            assert.equal(e.blocked, want)
                            assert.equal(e.released, false)
                            hits[!want ? 'none' : (fsX ? 'fs' : (sfI(btv, tr) ? 'shiftSf' : 'shiftFl'))]++
                            n++
                        }
                    }
                }
            }
        }
        assert.equal(n, 800)
        //鑑別之前提: 三種命中之途徑與不命中皆出現
        assert(hits.fs > 0 && hits.shiftSf > 0 && hits.shiftFl > 0 && hits.none > 0, JSON.stringify(hits))
    })

    it('門檻與邊界:差恰為 minShift 者成立(浮點之尾差不影響)、略低者不成立;minShift 與 flags 可由設定改;訓練期之診斷缺者不判;關閉者不判', () => {
        let cfg = exposureCfgOf()
        let sfUp = { bt: 0.45, tr: 0.6 }
        //0.6 − 0.5 於浮點為 0.09999999999999998
        assert.equal(exposureOf(nodeOf({ a: 0.5, lr: 0.6, ...sfUp }), cfg).hit, true)
        assert.equal(exposureOf(nodeOf({ a: 0.5, lr: 0.5999, ...sfUp }), cfg).hit, false)
        assert.equal(exposureOf(nodeOf({ a: 0.5, lr: 0.6, ...sfUp }), exposureCfgOf({ minShift: 0.2 })).hit, false)
        assert.equal(exposureOf(nodeOf({ a: 0.3, lr: 0.5, ...sfUp }), exposureCfgOf({ minShift: 0.2 })).hit, true)
        //門檻為數字字串者與數值同(跨套件規格 K4: 檢測通過者轉為數值後才用於判定; 差恰為門檻者成立)
        assert.equal(exposureOf(nodeOf({ a: 0.5, lr: 0.6, ...sfUp }), exposureCfgOf({ minShift: ' 0.2 ' })).hit, false)
        assert.equal(exposureOf(nodeOf({ a: 0.3, lr: 0.5, ...sfUp }), exposureCfgOf({ minShift: ' 0.2 ' })).hit, true)
        assert.equal(exposureOf(nodeOf({ a: 0.5, lr: 0.6, ...sfUp }), exposureCfgOf({ minShift: '0.1' })).hit, true)
        //flags 改設定: 只採計所列之名
        let fl = { a: 0.3, lr: 0.6, bt: 0.2, tr: 0.25, flags: { diagA: '某提示' } }
        assert.equal(exposureOf(nodeOf(fl), cfg).hit, false)
        assert.equal(exposureOf(nodeOf(fl), exposureCfgOf({ flags: ['diagA'] })).hit, true)
        assert.equal(exposureOf(nodeOf({ ...fl, flags: { fixedState: 'x' } }), exposureCfgOf({ flags: [] })).hit, false)
        //訓練期之診斷缺 ⇒ 不判(回測期即使單側且有旗標)
        assert.equal(exposureOf(nodeOf({ a: null, lr: 0.97, bt: 0.03, tr: 0.05, flags: { fixedState: 'x', placeboTiming: 'y' } }), cfg).hit, false)
        assert.equal(exposureOf(nodeOf({ a: 0.95, lr: 0.97, bt: 0.2, tr: 0.25 }), null).hit, false)
        assert.equal(exposureOf(null, cfg).hit, false)
        assert.equal(exposureOf({ raw: {} }, cfg).hit, false)
    })

    it('理由(定性、不含門檻之值)、放行綁選集指紋、迴圈檢查之一條', () => {
        let cfg = exposureCfgOf()
        assert.equal(exposureOf(nodeOf({ a: 0.95, lr: 0.97, bt: 0.45, tr: 0.6 }), cfg).why, '固定側別')
        assert.equal(exposureOf(nodeOf({ a: 0.3, lr: 0.62, bt: 0.45, tr: 0.6 }), cfg).why, '席次之側別隨期改變、下單流量偏一側')
        assert.equal(exposureOf(nodeOf({ a: 0.3, lr: 0.62, bt: 0.2, tr: 0.25, flags: { placeboTiming: 'p', fixedState: 'f' } }), cfg).why, '席次之側別隨期改變、擴充診斷 fixedState、placeboTiming 之提示')
        assert.equal(exposureOf(nodeOf({ a: 0.3, lr: 0.62, bt: 0.45, tr: 0.6, flags: { fixedState: 'f' } }), cfg).why, '席次之側別隨期改變、下單流量偏一側;席次之側別隨期改變、擴充診斷 fixedState 之提示')
        let base = { a: 0.95, lr: 0.97, bt: 0.2, tr: 0.25, sel: 'selR1' }
        let ok = exposureOf(nodeOf({ ...base, release: { selHash: 'selR1', why: 'w', at: 'x' } }), cfg)
        assert.deepEqual([ok.hit, ok.released, ok.blocked], [true, true, false])
        for (let rel of [{ selHash: 'selOther' }, { selHash: '' }, { why: 'w' }, 'selR1', null]) {
            let e = exposureOf(nodeOf({ ...base, release: rel }), cfg)
            assert.deepEqual([e.hit, e.released, e.blocked], [true, false, true], JSON.stringify(rel))
        }
        let e = exposureOf(nodeOf(base), cfg)
        assert.equal(exposureHintOf(e), `${EXPOSURE_HEAD}交付版之優勢可能來自側別之曝險(固定側別)⇒ 不作為補位之底與方向之起點(主控可逐案放行;不否決,由審計判定)`)
        assert.equal(isExposureHint(exposureHintOf(e)), true)
        assert.strictEqual(exposureHintOf(ok), null)
        assert.strictEqual(exposureHintOf(exposureOf(nodeOf({ ...base, lr: 0.5, a: 0.5 }), cfg)), null)
        //理由不含門檻之值
        assert(!/0\.1|0\.9|2\.5|0\.4/.test(exposureHintOf(e)))
    })

    it('守門:兩側席次固定之成品(每個決策恰 a 席做多、b 席做空,0.1 ≤ a ÷ (a + b) ≤ 0.9)必不命中 —— 下單偏一側、帶 fixedState / placeboTiming 之旗標亦然;席次比例隨期改變者為鑑別之對照', () => {
        let cfg = exposureCfgOf()
        //席次之做多比例 = 各決策之做多席之和 ÷ 總席之和(四捨五入至 4 位; 同評估器之算法), 兩期之決策數不同、亦有空決策
        let ratioOf = (a, b, nDec, nEmpty) => {
            let L = 0
            let T = 0
            for (let i = 0; i < nDec; i++) {
                if (i < nEmpty) {
                    continue
                }
                L += a
                T += a + b
            }
            return Math.round((L / T) * 10000) / 10000
        }
        let n = 0
        for (let a = 1; a <= 9; a++) {
            for (let b = 1; b <= 9; b++) {
                let q = a / (a + b)
                if (q < 0.1 || q > 0.9) {
                    continue
                }
                for (let [bt, tr] of [[0.45, 0.6], [0.05, 0.07], [0.2, 0.25]]) {
                    let nd = nodeOf({ a: ratioOf(a, b, 37, 3), lr: ratioOf(a, b, 113, 11), bt, tr, flags: { fixedState: '等同固定狀態', placeboTiming: '安慰劑無內容' }, k: a + b })
                    assert.equal(exposureOf(nd, cfg).hit, false, `${a} 多 ${b} 空`)
                    n++
                }
            }
        }
        assert(n > 150, String(n))
        //對照: 兩期之席次比例不同(訓練期 3 多 2 空、回測期 1 多 4 空)且下單偏一側 ⇒ 命中
        assert.equal(exposureOf(nodeOf({ a: ratioOf(3, 2, 37, 3), lr: ratioOf(1, 4, 113, 11), bt: 0.45, tr: 0.6 }), cfg).hit, true)
    })
})

describe('側別曝險之效果(makeProject;規則 R-REC-48)', function () {
    this.timeout(180000)
    let t
    beforeEach(() => {
        t = makeTmp('exposure')
    })
    afterEach(() => {
        t.cleanup()
    })
    //mk, 暫存夾之專案(假派工; 做夢依 dream.template.json 交付 dreamDirs 所給之方向); rsiExtra 併入 st.rsi
    let mk = ({ dreamDirs = null, rsiExtra = {}, inject = {} } = {}) => {
        let st = getSettings()
        let d = path.join(t.dir, `proj_${Math.random().toString(36).slice(2, 8)}`)
        st.resources = {}
        st.rsi = { ...st.rsi, root: path.join(d, 'rsi'), docLimits: false, maxArmsPerNode: 4, ...rsiExtra }
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthExpo' }), 'utf8')
        let dispatch = async (role, { prompt }) => {
            if (role !== 'dream' || !dreamDirs) {
                throw new Error('fake: 不派工')
            }
            let m = /請閱讀 (\S+)\/brief\.md/.exec(prompt)
            let wd = path.resolve(st.FD_ROOT, m[1])
            let tpl = JSON.parse(fs.readFileSync(path.join(wd, 'dream.template.json'), 'utf8'))
            let dream = {
                audits: tpl.audits.map((x) => ({ nodeId: x.nodeId, trust: 'trusted', action: 'accept', evidence: ['假審計'], issues: [] })),
                synthesis: { summary: '假做夢', worked: [], failed: [], patterns: [], prevDirections: [] },
                guidance: { directions: dreamDirs(), avoid: [], openQuestions: [], improvements: [], armProposals: [] },
                expansion: [],
                docsUpdated: [],
            }
            fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify(dream), 'utf8')
            return { ok: true, agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
        }
        let P = makeProject(st, { dispatch, gate: null, catalogFile: path.join(d, 'catalog.json'), ...inject })
        P.rsi.init()
        return { P, st }
    }
    //put, 已執行之節点入樹: x = { a(訓練期之做多比例; null = 無訓練期之診斷), lr, bt, tr, flags }; 未給者為兩側正常、無旗標(不命中)
    let put = (P, { arms, base = null, round, S, sel, k, trust = 'trusted', x = {}, reps = null }) => {
        let spec = { arms, base }
        let id = P.idOf(spec)
        let a = x.a === undefined ? 0.5 + k / 100 : x.a
        let metrics = metricsOf({ lr: x.lr === undefined ? 0.52 + k / 100 : x.lr, bt: x.bt === undefined ? 0.2 : x.bt, flags: x.flags || {}, k })
        let raw = { selHash: sel, metrics, issues: [], ...(a === null ? {} : { train: { longRatio: a, tags: [], shortShare: x.tr === undefined ? 0.25 : x.tr } }), ...(reps ? { seedS: reps.slice(), replays: reps.map((s, i) => ({ S: s, comp: 3.5 + k + i, recent: null })) } : {}) }
        P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round, raw, score: { S, ladder: 1, flags: { vetoed: false, why: [] } }, evidence: { trust } })
        return id
    }
    let FIX = { a: 0.95, lr: 0.97 }
    let read = (st, f) => fs.readFileSync(path.join(st.rsi.root, f), 'utf8')

    it('補位之底:排序鍵最高者為曝險 ⇒ 取其次;皆曝險 ⇒ 無底(單臂根節點);放行者照取;放行綁選集指紋(指紋改變即失效)', () => {
        let { P } = mk()
        let ex = put(P, { arms: ['A01_nt'], round: 1, S: 71.3, sel: 'sel-ex', k: 1, x: FIX })
        let ok = put(P, { arms: ['A04_act'], round: 1, S: 52.6, sel: 'sel-ok', k: 2 })
        assert.equal(P.domain.carriers().D30_volumeCut.base, ok)
        assert.deepEqual(P.domain.carriers().D30_volumeCut.arms, ['A04_act', 'D30_volumeCut'])
        //皆曝險 ⇒ 無底
        P.rsi.store.updateNode(ok, (n) => {
            n.raw.train = { longRatio: 0.3, tags: [], shortShare: 0.6 }
            n.raw.metrics = metricsOf({ lr: 0.62, bt: 0.45, k: 2 })
        })
        assert.deepStrictEqual(P.domain.carriers().D30_volumeCut, { arms: ['D30_volumeCut'], base: null })
        //放行(綁選集指紋)⇒ 照取; 指紋改變 ⇒ 失效
        P.rsi.setEvidence(ex, { exposureRelease: { selHash: 'sel-ex', why: 'w', at: '2026-01-01T00:00:00.000Z' } }, { ref: 't', note: 'n' })
        assert.equal(P.domain.carriers().D30_volumeCut.base, ex)
        P.rsi.store.updateNode(ex, (n) => {
            n.raw.selHash = 'sel-ex2'
        })
        assert.deepStrictEqual(P.domain.carriers().D30_volumeCut, { arms: ['D30_volumeCut'], base: null })
    })

    it('判定關閉(settings.rsi.exposure = false)⇒ 底照取曝險者、閘門與方向不拒、看板與搜尋地圖無標示', () => {
        let { P, st } = mk({ rsiExtra: { exposure: false } })
        let ex = put(P, { arms: ['A01_nt'], round: 1, S: 71.3, sel: 'sel-ex', k: 1, x: FIX })
        put(P, { arms: ['A04_act'], round: 1, S: 52.6, sel: 'sel-ok', k: 2 })
        assert.equal(P.exposureOn, false)
        assert.equal(P.domain.carriers().D30_volumeCut.base, ex)
        assert.deepEqual(P.domain.gates.pre({ arms: ['A01_nt', 'B14_pitKey'], base: ex }, { view: { nodes: P.rsi.view.policyView().filter((n) => !n.aliasOf) } }), { ok: true })
        P.writeBoard()
        let bd = read(st, 'ARMS_BOARD.md')
        assert(!bd.includes('「S」一欄標「曝險」者') && !bd.includes('** 曝險') && !bd.includes('**後者為側別曝險**'))
        assert(!/側別曝險/.test(read(st, 'SEARCH_MAP.md')))
    })

    it('前置閘門與方向之提出:起點為曝險 ⇒ 拒(理由之字面值;不入前緣;輪末摘要之「方向未入前緣」列出);起點為別名而其正本為曝險 ⇒ 亦拒;放行者照常', () => {
        let { P } = mk()
        let ex = put(P, { arms: ['A01_nt'], round: 1, S: 71.3, sel: 'sel-ex', k: 1, x: FIX })
        let why = `起點 ${ex.slice(0, 8)} 為側別曝險之成品(固定側別);不作為起點(主控可經 tools/exposure.mjs 逐案放行)`
        let view = { nodes: P.rsi.view.policyView().filter((n) => !n.aliasOf) }
        assert.deepEqual(P.domain.gates.pre({ arms: ['A01_nt', 'B14_pitKey'], base: ex }, { view }), { ok: false, why })
        let nf = P.rsi.store.listFrontier().length
        let r = P.proposeDirection({ arms: ['A01_nt', 'B14_pitKey'], base: ex, type: 'explore', rationale: '延伸' }, 2)
        assert.equal(r.ok, false)
        assert.equal(r.note, why)
        assert.equal(P.rsi.store.listFrontier().length, nf, '不入前緣(不留存根)')
        assert.deepEqual(unproposedNoteOf([r].map((x) => ({ ...x, arms: ['A01_nt', 'B14_pitKey'], base: ex }))).slice(1), [`方向未入前緣:方向 1(A01_nt + B14_pitKey;起點 ${ex.slice(0, 8)}):${why}`.slice(0, 1000)])
        //別名之正本為曝險(別名本身之紀錄不是曝險)⇒ 改掛後亦拒
        let alias = put(P, { arms: ['A02_ntPit'], round: 2, S: 71.3, sel: 'sel-ex', k: 3 })
        let canonOf = P.rsi.aliasMap()
        let [aliasId, canonId] = [...canonOf][0]
        assert.deepEqual([aliasId, canonId].sort(), [alias, ex].sort())
        let r2 = P.proposeDirection({ arms: ['A01_nt', 'C23_recent365'], base: aliasId, type: 'explore', rationale: '延伸 2' }, 2)
        if (canonId === ex) {
            assert.equal(r2.ok, false)
            assert(r2.note.startsWith(why), r2.note)
        }
        //放行 ⇒ 照常入前緣
        P.rsi.setEvidence(ex, { exposureRelease: { selHash: 'sel-ex', why: 'w', at: '2026-01-01T00:00:00.000Z' } }, { ref: 't', note: 'n' })
        assert.deepEqual(P.domain.gates.pre({ arms: ['A01_nt', 'B14_pitKey'], base: ex }, { view }), { ok: true })
        assert.equal(P.proposeDirection({ arms: ['A01_nt', 'B14_pitKey'], base: ex, type: 'explore', rationale: '延伸' }, 2).ok, true)
    })

    it('標示:看板之「S」一欄與表前一段、搜尋地圖之量尺之格與譜系、迴圈檢查之一條(重產時移除已放行者)、節點任務書之參考節點之註明;S 與階梯不變', () => {
        let { P, st } = mk()
        let ex = put(P, { arms: ['A01_nt'], round: 1, S: 71.3, sel: 'sel-ex', k: 1, x: FIX })
        let ok = put(P, { arms: ['A04_act'], round: 1, S: 52.6, sel: 'sel-ok', k: 2 })
        let sf = put(P, { arms: ['A02_ntPit'], round: 1, S: 48.9, sel: 'sel-sf', k: 3, x: { a: 0.3, lr: 0.62, bt: 0.45, tr: 0.6 } })
        P.writeBoard()
        let board = read(st, 'ARMS_BOARD.md')
        let rowOf = (md, id) => md.split('\n').find((l) => l.startsWith(`| \`${id}\``))
        assert(rowOf(board, ex).includes('| **71.3** 曝險 |'), rowOf(board, ex))
        assert(rowOf(board, sf).includes('| **48.9** 曝險 |'))
        assert(rowOf(board, ok).includes('| **52.6** |'))
        let para = board.split('\n').find((l) => l.startsWith('「S」一欄標「曝險」者'))
        assert(para.endsWith(`:\`${ex.slice(0, 8)}\`(固定側別);\`${sf.slice(0, 8)}\`(席次之側別隨期改變、下單流量偏一側)。`) || para.endsWith(`:\`${sf.slice(0, 8)}\`(席次之側別隨期改變、下單流量偏一側);\`${ex.slice(0, 8)}\`(固定側別)。`), para)
        assert(!/0\.1|minShift/.test(para), '看板之段落不列門檻之值')
        let map = read(st, 'SEARCH_MAP.md')
        assert(map.split('\n').some((l) => l.includes(`\`${ex.slice(0, 8)}\` A01_nt(`) && l.includes(';trusted;**側別曝險**')), '譜系之列')
        assert(!map.split('\n').some((l) => l.includes(`\`${ok.slice(0, 8)}\` A04_act(`) && l.includes('側別曝險')))
        //迴圈檢查: 節點文件與樹之 raw.issues 皆加一條(refreshEvalHints; 同兩條提示之時點)
        let docOf = (id, k) => ({ nodeId: id, round: 1, attempt: 1, status: 'verified', createdAt: '2026-01-01T00:00:00.000Z', spec: P.rsi.store.getNode(id).spec, task: { goal: '合成', type: 'explore', claim: null, arms: [], base: null, refs: [], direction: null }, agent: { role: 'node', kind: 'fake', model: 'fake-node', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T01:00:00.000Z', durationSec: 600 + k, ok: true, error: null }, plan: { target: 't', approach: 'a', hypotheses: [] }, code: { artifact: 'pick.mjs', files: [], reused: [] }, results: { claimed: { S: 1 }, experiments: [] }, conclusion: { outcome: 'neutral', summary: 's', findings: [], limitations: [], nextIdeas: [] }, harness: { ok: true, summary: [], notes: [], score: { S: 1, ladder: 1, flags: { vetoed: false, why: [] } }, fingerprint: 'f', checks: { issues: ['既有之一條'], nEvals: 2 }, validation: null, raw: {}, evalJson: null, error: null }, audit: null, history: [] })
        for (let [i, id] of [ex, ok, sf].entries()) {
            P.records.putNodeDoc(docOf(id, i))
        }
        P.refreshEvalHints([ex, ok, sf])
        let hint = `${EXPOSURE_HEAD}交付版之優勢可能來自側別之曝險(固定側別)⇒ 不作為補位之底與方向之起點(主控可逐案放行;不否決,由審計判定)`
        assert.deepEqual(P.records.getNodeDoc(ex).harness.checks.issues, ['既有之一條', hint])
        assert.deepEqual(P.rsi.store.getNode(ex).raw.issues, [hint])
        assert.deepEqual(P.records.getNodeDoc(ok).harness.checks.issues, ['既有之一條'])
        //放行後重產 ⇒ 移除; 看板標「曝險(已放行)」(此處直接記入樹之 evidence: setEvidence 會以合成之 metrics 重算 S, 其路徑由工具之案驗)
        P.rsi.store.updateNode(ex, (x) => {
            x.evidence = { ...x.evidence, exposureRelease: { selHash: 'sel-ex', why: 'w', at: '2026-01-01T00:00:00.000Z' } }
        })
        P.refreshEvalHints([ex])
        assert.deepEqual(P.records.getNodeDoc(ex).harness.checks.issues, ['既有之一條'])
        P.writeBoard()
        assert(rowOf(read(st, 'ARMS_BOARD.md'), ex).includes('| **71.3** 曝險(已放行) |'), rowOf(read(st, 'ARMS_BOARD.md'), ex))
        //節點任務書之參考節點: 照列並註明
        let t2 = P.taskFor({ arms: ['B14_pitKey'], base: null }, null, { nodeId: 'zz-self' })
        let refEx = t2.refs.find((r) => r.nodeId === ex)
        let refSf = t2.refs.find((r) => r.nodeId === sf)
        let refOk = t2.refs.find((r) => r.nodeId === ok)
        assert(refEx && refEx.why.includes(';側別曝險(已放行);'), refEx && refEx.why)
        assert(refSf && refSf.why.includes(';側別曝險(不作為起點);'), refSf && refSf.why)
        assert(refOk && !refOk.why.includes('側別曝險'))
        //S 與階梯不變
        assert.deepEqual([P.rsi.store.getNode(ex).score.S, P.rsi.store.getNode(ex).score.ladder], [71.3, 1])
    })

    it('輪末:派做夢之前之提示含曝險之一條;做夢之方向以曝險者為起點 ⇒ 輪末摘要列「方向未入前緣」', async () => {
        let ex = null
        let { P } = mk({ dreamDirs: () => [{ arms: ['A01_nt', 'B14_pitKey'], base: ex, type: 'explore', rationale: '延伸曝險者' }] })
        ex = put(P, { arms: ['A01_nt'], round: 1, S: 71.3, sel: 'sel-ex', k: 1, x: FIX })
        put(P, { arms: ['A04_act'], round: 1, S: 52.6, sel: 'sel-ok', k: 2 })
        let r = await P.domain.hooks.afterRound({ round: 1, nodes: [P.rsi.store.getNode(ex)] })
        let miss = r.lines.filter((l) => l.startsWith('方向未入前緣'))
        assert.equal(miss.length, 1, r.lines.join('\n'))
        assert(miss[0].includes(`為側別曝險之成品(固定側別);不作為起點`), miss[0])
        assert(r.lines.some((l) => l.startsWith('**方向未入前緣 1 條**')))
    })

    //--mode validate 之重掃(rescanTraces; 排程第 591 項之主控另加之專用案): 與兩條提示同一個判定之入口(evalHintsAll)與同一個標頭之替換(isEvalHint);
    //  規格: ①命中且未放行者之節點文件與樹之 raw.issues 各加一條(置於末尾、其餘照留)②放行者不加、已有者移除; 不命中者之舊條亦移除(替換)③再掃不重寫
    //  ④判定之入口拋錯 ⇒ 既有之曝險提示照留(不被當成掃描項清掉)、重掃不中斷
    it('--mode validate 之重掃(rescanTraces):對全樹重產「提示(側別曝險)」—— 命中且未放行者加一條、放行者與不命中者之舊條移除、再掃不重寫;判定之入口拋錯 ⇒ 既有之曝險提示照留', () => {
        let docFor = (P, id, k, issues) => ({ nodeId: id, round: 1, attempt: 1, status: 'verified', createdAt: '2026-01-01T00:00:00.000Z', spec: P.rsi.store.getNode(id).spec, task: { goal: '合成', type: 'explore', claim: null, arms: [], base: null, refs: [], direction: null }, agent: { role: 'node', kind: 'fake', model: 'fake-node', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T01:00:00.000Z', durationSec: 600 + k, ok: true, error: null }, plan: { target: 't', approach: 'a', hypotheses: [] }, code: { artifact: 'pick.mjs', files: [], reused: [] }, results: { claimed: { S: 1 }, experiments: [] }, conclusion: { outcome: 'neutral', summary: 's', findings: [], limitations: [], nextIdeas: [] }, harness: { ok: true, summary: [], notes: [], score: { S: 1, ladder: 1, flags: { vetoed: false, why: [] } }, fingerprint: 'f', checks: { issues, nEvals: 2 }, validation: null, raw: {}, evalJson: null, error: null }, audit: null, history: [] })
        let hintFs = `${EXPOSURE_HEAD}交付版之優勢可能來自側別之曝險(固定側別)⇒ 不作為補位之底與方向之起點(主控可逐案放行;不否決,由審計判定)`
        let hintSf = `${EXPOSURE_HEAD}交付版之優勢可能來自側別之曝險(席次之側別隨期改變、下單流量偏一側)⇒ 不作為補位之底與方向之起點(主控可逐案放行;不否決,由審計判定)`
        let REL = { selHash: 'sel-rel', why: 'w', at: '2026-01-01T00:00:00.000Z' }
        //五個節點: ex(固定側別)、sf(席次隨期改變而下單偏一側)、ok(不命中)、rel(固定側別而已放行; 其文件帶舊條)、stale(不命中而其文件帶舊條); 各節點之文件皆有舊之一條「既有之一條」與工作夾
        let setup = (inject = {}) => {
            let { P, st } = mk({ inject })
            let ids = {
                ex: put(P, { arms: ['A01_nt'], round: 1, S: 71.3, sel: 'sel-ex', k: 1, x: FIX }),
                sf: put(P, { arms: ['A02_ntPit'], round: 1, S: 48.9, sel: 'sel-sf', k: 3, x: { a: 0.3, lr: 0.62, bt: 0.45, tr: 0.6 } }),
                ok: put(P, { arms: ['A04_act'], round: 1, S: 52.6, sel: 'sel-ok', k: 2 }),
                rel: put(P, { arms: ['B14_pitKey'], round: 1, S: 40.1, sel: 'sel-rel', k: 4, x: FIX }),
                stale: put(P, { arms: ['C23_recent365'], round: 1, S: 38.5, sel: 'sel-stale', k: 5 }),
            }
            P.rsi.store.updateNode(ids.rel, (n) => {
                n.evidence = { ...n.evidence, exposureRelease: REL }
                n.raw.issues = [hintFs]
            })
            P.rsi.store.updateNode(ids.stale, (n) => {
                n.raw.issues = [hintFs]
            })
            let old = { ex: [], sf: [], ok: [], rel: [hintFs], stale: [hintFs] }
            for (let [i, [name, id]] of Object.entries(ids).entries()) {
                P.records.putNodeDoc(docFor(P, id, i, ['既有之一條', ...old[name]]))
                fs.mkdirSync(path.join(st.records.workDir, id), { recursive: true })
            }
            let docIssues = (name) => P.records.getNodeDoc(ids[name]).harness.checks.issues
            let treeIssues = (name) => P.rsi.store.getNode(ids[name]).raw.issues
            return { P, ids, docIssues, treeIssues }
        }
        //(1)(2)(3) 判定之入口照常
        let x = setup()
        //鑑別之前提: 五個節點之判定(命中與放行)如上
        let flagsOf = (k) => {
            let e = x.P.exposureOf(x.P.rsi.store.getNode(x.ids[k]))
            return [e.hit, e.blocked]
        }
        assert.deepEqual(['ex', 'sf', 'ok', 'rel', 'stale'].map(flagsOf), [[true, true], [true, true], [false, false], [true, false], [false, false]])
        assert.equal(x.P.rescanTraces(), 4, 'ex、sf 各加一條; rel(已放行)、stale(不命中)之舊條移除; ok 不變')
        assert.deepEqual(x.docIssues('ex'), ['既有之一條', hintFs])
        assert.deepEqual(x.treeIssues('ex'), [hintFs], '樹之 raw.issues 同一份')
        assert.deepEqual(x.docIssues('sf'), ['既有之一條', hintSf])
        assert.deepEqual(x.treeIssues('sf'), [hintSf])
        assert.deepEqual(x.docIssues('ok'), ['既有之一條'])
        assert.deepEqual(x.docIssues('rel'), ['既有之一條'], '已放行者之舊條移除')
        assert.deepEqual(x.treeIssues('rel'), [])
        assert.deepEqual(x.docIssues('stale'), ['既有之一條'], '不命中者之舊條移除(替換)')
        assert.deepEqual(x.treeIssues('stale'), [])
        assert.equal(x.P.rescanTraces(), 0, '再掃不重寫')
        //放行 ex 之後重掃: 其條移除(只此一個節點變動)
        x.P.rsi.store.updateNode(x.ids.ex, (n) => {
            n.evidence = { ...n.evidence, exposureRelease: { ...REL, selHash: 'sel-ex' } }
        })
        assert.equal(x.P.rescanTraces(), 1)
        assert.deepEqual(x.docIssues('ex'), ['既有之一條'])
        assert.deepEqual(x.treeIssues('ex'), [])
        assert.deepEqual(x.docIssues('sf'), ['既有之一條', hintSf], '其餘不動')
        //(4) 判定之入口拋錯(inject.evalHints): 既有之曝險提示照留(節點文件與樹皆不被清掉)、重掃不中斷
        let boom = () => {
            throw new Error('假之判定失敗')
        }
        let y = setup({ evalHints: boom })
        y.P.rsi.store.updateNode(y.ids.ex, (n) => {
            n.raw.issues = [hintFs]
        })
        let dx = y.P.records.getNodeDoc(y.ids.ex)
        dx.harness.checks.issues = ['既有之一條', hintFs]
        y.P.records.putNodeDoc(dx)
        assert.equal(y.P.rescanTraces(), 0, '判定失敗 ⇒ 各節點之既有之提示照留(含已放行 / 不命中者之舊條)')
        assert.deepEqual(y.docIssues('ex'), ['既有之一條', hintFs])
        assert.deepEqual(y.treeIssues('ex'), [hintFs])
        assert.deepEqual(y.docIssues('rel'), ['既有之一條', hintFs])
        assert.deepEqual(y.docIssues('sf'), ['既有之一條'], '判定失敗 ⇒ 不產生新條')
    })
})

describe('放行之工具 tools/exposure.mjs(規則 R-REC-48)', function () {
    this.timeout(300000)
    let t
    let root
    let ids = {}
    let sc = {}
    let run = (args, env = {}) => {
        let e = { ...process.env, ARSI_ROOT: root, ...env }
        delete e.ARSI_AGENT_ROLE
        let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'tools', 'exposure.mjs'), ...args], { cwd: t.dir, env: e, windowsHide: true, encoding: 'utf8', timeout: 150000 })
        return { status: r.status, stdout: r.stdout, stderr: r.stderr }
    }
    let projOf = () => {
        let st = getSettings()
        st.rsi = { ...st.rsi, root: path.join(root, 'rsi') }
        st.records = { nodeDir: path.join(root, 'rsi/records/nodes'), dreamDir: path.join(root, 'rsi/records/dreams'), trashDir: path.join(root, 'rsi/records/trash'), workDir: path.join(root, 'rsi/work'), toolboxDir: path.join(root, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(root, 'ledger')
        st.resources = {}
        let P = makeProject(st, { dispatch: async () => ({ ok: false }), gate: null, catalogFile: path.join(root, 'catalog_t.json') })
        P.rsi.init()
        return P
    }
    before(() => {
        t = makeTmp('exposureTool')
        root = path.join(t.dir, 'proj')
        fs.mkdirSync(path.join(root, 'skills', 'node_modules', 'w-dispatch-ai'), { recursive: true })
        fs.writeFileSync(path.join(root, 'skills', 'node_modules', 'w-dispatch-ai', 'package.json'), JSON.stringify({ name: 'w-dispatch-ai', main: 'index.cjs' }))
        //假派工套件(同 unit-agentGuard; 本檔不派工)
        fs.writeFileSync(path.join(root, 'skills', 'node_modules', 'w-dispatch-ai', 'index.cjs'), 'module.exports = { providers: [{ id: \'oc:opencode/m-free\', kind: \'opencode\', provider: \'opencode\', model: \'opencode/m-free\' }], readEnvFile: () => ({}), opencodeGoUsage: async () => ({ ok: true, usage: {} }), dispatchOpencode: async () => ({ ok: false, error: \'stub\' }), dispatchClaude: async () => ({ ok: false, error: \'stub\' }), getQuotaClaude: async () => ({ ok: true, windows: [] }) }\n')
        fs.mkdirSync(path.join(root, 'arms'), { recursive: true })
        fs.copyFileSync(path.join(FD_ROOT, 'arms', 'base.json'), path.join(root, 'arms', 'base.json'))
        writeSynthLedger(path.join(root, 'ledger'), { n: 40, nBars: 2400, seed: 11 })
        let st = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
        st.periods = { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } }
        st.eval = { ...st.eval, ledgerDir: './ledger', warmupDays: 60, phases: [0, 3], horizons: [7], nullDraws: 4 }
        delete st.eval.fitEnd
        st.dispatch = { skillsRoot: path.join(root, 'skills'), envFile: path.join(root, '.env') }
        st.rsi = { ...st.rsi, root: './rsi' }
        st.agents = { node: { kind: 'opencode', id: 'oc:opencode/m-free', variant: 'high', timeoutMin: 1 }, dream: { kind: 'claude', model: 'claude-opus-5-5', effort: 'xhigh', timeoutMin: 1 } }
        st.records = { nodeDir: './rsi/records/nodes', dreamDir: './rsi/records/dreams', trashDir: './rsi/records/trash', workDir: './rsi/work', toolboxDir: './rsi/toolbox' }
        st.resources = {}
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(st, null, 1))
        fs.writeFileSync(path.join(root, '.env'), 'X=1\n')
        let P = projOf()
        let putN = (arms, S0, sel, k, x) => {
            let S = S0
            let spec = { arms, base: null }
            let id = P.idOf(spec)
            let metrics = metricsOf({ lr: x.lr, bt: x.bt, k })
            let raw = { selHash: sel, metrics, issues: [], train: { longRatio: x.a, tags: [], shortShare: x.tr } }
            //S 與階梯 = 領域之計分(放行之 setEvidence 會重算; 兩者須一致才驗得出「不變」)
            let score = P.domain.score(raw, { spec, evidence: { trust: 'trusted' } })
            S = score.S
            P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round: 1, raw, score, evidence: { trust: 'trusted' } })
            sc[sel] = score
            P.records.putNodeDoc({ nodeId: id, round: 1, attempt: 1, status: 'verified', createdAt: '2026-01-01T00:00:00.000Z', spec, task: { goal: '合成', type: 'explore', claim: null, arms: [], base: null, refs: [], direction: null }, agent: { role: 'node', kind: 'fake', model: 'fake-node', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T01:00:00.000Z', durationSec: 600 + k, ok: true, error: null }, plan: { target: 't', approach: 'a', hypotheses: [] }, code: { artifact: 'pick.mjs', files: [], reused: [] }, results: { claimed: { S }, experiments: [] }, conclusion: { outcome: 'neutral', summary: 's', findings: [], limitations: [], nextIdeas: [] }, harness: { ok: true, summary: [], notes: [], score: { S, ladder: 2, flags: { vetoed: false, why: [] } }, fingerprint: sel, checks: { issues: [], nEvals: 2 }, validation: null, raw: {}, evalJson: null, error: null }, audit: null, history: [] })
            return id
        }
        ids.ex = putN(['A01_nt'], 66.4, 'selT-ex', 1, { a: 0.96, lr: 0.98, bt: 0.2, tr: 0.25 })
        ids.ok = putN(['A04_act'], 44.1, 'selT-ok', 2, { a: 0.5, lr: 0.55, bt: 0.2, tr: 0.25 })
        P.refreshEvalHints([ids.ex, ids.ok])
    })
    after(() => {
        t.cleanup()
    })

    it('列出(無引數):曝險之節點、理由與是否已放行;離開碼 0', () => {
        let r = run([])
        assert.equal(r.status, 0, r.stderr)
        assert.equal(r.stdout, `樹上側別曝險之節點 1 個(未放行者不作為補位之底與方向之起點)\n- ${ids.ex}(A01_nt;S ${sc['selT-ex'].S}):固定側別;未放行\n`)
    })

    it('不合者:缺 --why、前綴不唯一或不符、非曝險者、未放行而撤銷 ⇒ 離開碼 2(不寫);輪次進行中 ⇒ 離開碼 3', () => {
        let before = JSON.stringify(projOf().rsi.store.getNode(ids.ex).evidence)
        assert.equal(run(['--node', ids.ex.slice(0, 10)]).status, 2)
        assert.equal(run(['--node', 'zzzz', '--why', 'w']).status, 2)
        assert.equal(run(['--node', ids.ok.slice(0, 10), '--why', 'w']).status, 2)
        assert.equal(run(['--undo', '--node', ids.ex.slice(0, 10), '--why', 'w']).status, 2)
        //輪次進行中(本行程之 pid 持有輪次鎖)
        let fpLock = path.join(root, 'rsi', 'logs', 'round.lock')
        fs.mkdirSync(path.dirname(fpLock), { recursive: true })
        fs.writeFileSync(fpLock, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), beatAt: new Date().toISOString() }))
        let rl = run(['--node', ids.ex.slice(0, 10), '--why', 'w'])
        fs.rmSync(fpLock, { force: true })
        assert.equal(rl.status, 3, rl.stdout + rl.stderr)
        assert.equal(JSON.stringify(projOf().rsi.store.getNode(ids.ex).evidence), before)
    })

    it('放行與撤銷:綁選集指紋、S 與階梯不變、節點文件之 control 同步、提示即時改寫、看板重產', () => {
        let r = run(['--node', ids.ex.slice(0, 10), '--why', '主控核對:兩側席次固定之版本仍有內容'])
        assert.equal(r.status, 0, r.stdout + r.stderr)
        assert(r.stdout.startsWith(`已放行 ${ids.ex.slice(0, 8)} 之側別曝險(固定側別;綁選集指紋 selT-ex)(S ${sc['selT-ex'].S}、階梯 ${sc['selT-ex'].ladder} 不變);節點文件已同步;`), r.stdout)
        let P = projOf()
        let n = P.rsi.store.getNode(ids.ex)
        assert.equal(n.evidence.exposureRelease.selHash, 'selT-ex')
        assert.equal(n.evidence.exposureRelease.why, '主控核對:兩側席次固定之版本仍有內容')
        assert.deepEqual([n.score.S, n.score.ladder], [sc['selT-ex'].S, sc['selT-ex'].ladder])
        assert.deepEqual(P.records.getNodeDoc(ids.ex).control.exposureRelease.fingerprint, 'selT-ex')
        assert.deepEqual(n.raw.issues.filter(isExposureHint), [])
        assert(fs.readFileSync(path.join(root, 'rsi', 'ARMS_BOARD.md'), 'utf8').includes(`| **${sc['selT-ex'].S}** 曝險(已放行) |`))
        assert(fs.readFileSync(path.join(root, 'rsi', 'records', 'nodes', `${ids.ex}.md`), 'utf8').includes('- 側別曝險之放行(主控;'))
        assert.equal(run([]).stdout.split('\n')[1], `- ${ids.ex}(A01_nt;S ${sc['selT-ex'].S}):固定側別;已放行`)
        //撤銷
        let u = run(['--undo', '--node', ids.ex.slice(0, 10), '--why', '撤銷'])
        assert.equal(u.status, 0, u.stdout + u.stderr)
        let P2 = projOf()
        assert.strictEqual(P2.rsi.store.getNode(ids.ex).evidence.exposureRelease, null)
        assert.strictEqual(P2.records.getNodeDoc(ids.ex).control.exposureRelease, null)
        assert.equal(P2.rsi.store.getNode(ids.ex).raw.issues.filter(isExposureHint).length, 1)
        assert.deepEqual([P2.rsi.store.getNode(ids.ex).score.S, P2.rsi.store.getNode(ids.ex).score.ladder], [sc['selT-ex'].S, sc['selT-ex'].ladder])
    })

    it('tools/rankCompare.mjs(唯讀;規則 R-REC-49 之估法):各列 = rankCompareOf 對同一組候選之結果;補位之底之比較;不寫任何檔', () => {
        let P = projOf()
        let hashOf = () => JSON.stringify(fs.readdirSync(path.join(root, 'rsi'), { recursive: true }).sort().map((f) => {
            let fp = path.join(root, 'rsi', f); return fs.statSync(fp).isFile() ? `${f}:${fs.readFileSync(fp, 'utf8')}` : f
        }))
        let h0 = hashOf()
        let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'tools', 'rankCompare.mjs'), '--k', '1'], { cwd: t.dir, env: { ...process.env, ARSI_ROOT: root }, windowsHide: true, encoding: 'utf8', timeout: 150000 })
        assert.equal(r.status, 0, r.stderr)
        let rows = [ids.ex, ids.ok].map((id) => P.rsi.store.getNode(id)).map((n) => ({ id: n.id, key: rankKeyOf(n), content: contentOf(n).v, exposure: P.exposureOf(n).hit }))
        let w = rankCompareOf(rows, { k: 1 })
        let s8 = (id) => id.slice(0, 8)
        let f2 = (v) => (v === null ? '—' : v.toFixed(2))
        let L = r.stdout.split('\n')
        //候選之列(規則 R-REC-49 ⑤: 候選另須「有內容」, 並列不符者之個數; 本樹之兩者皆有內容)
        assert.equal(L[1], '候選(可信、未被否決、有內容且有挑選內容之值)2 個;另有挑選內容之值而不符「有內容」者 0 個(不計入;主鍵視同無其值)')
        assert.equal(L[2], `第一名:排序鍵 ${s8(w.firstKey)} / 挑選內容 ${s8(w.firstContent)}(${w.sameFirst ? '相同' : '不同'})`)
        assert.equal(L[3], `兩種次序之相關:Spearman ρ ${f2(w.spearman)}、Kendall τ-b ${f2(w.kendall)}`)
        assert.equal(L[4], `前 1 名之交集 ${w.overlap} 個;其中側別曝險者:排序鍵之前 1 名 ${w.exposureKey} 個、挑選內容之前 1 名 ${w.exposureContent} 個`)
        assert(L[5].startsWith('補位之底(各可選臂之載體之起點;'), L[5])
        //鑑別之前提: 兩者之第一名不同(挑選內容: ok 之組成對照較高)
        assert.equal(w.firstContent, ids.ok)
        assert.equal(hashOf(), h0, '不寫任何檔')
    })

    it('一頁摘要(tools/roundDigest.mjs)之「一眼看完」:輪末摘要有「量尺(並列…」與「側別讀數之警示」之列者各取一列;無者不列', () => {
        let fd = path.join(root, 'rsi', 'rounds', 'r001')
        fs.mkdirSync(fd, { recursive: true })
        let la = '量尺(並列;樹上可信者):挑選內容最高且可信者 `aaaa1111`(挑選內容 3.0,內建組成對照,1 抽之均;S 40.0) / 排序鍵最高且可信者 `bbbb2222`(S 50.0;排序鍵 50.0)'
        let lb = '側別讀數之警示:績效與做多比例高度相關(相異成品 12 個)⇒ 樹上之高分可能來自側別之曝險,宜以兩側席次固定之版本與成員穩健性核對'
        let R = (lines) => ({ round: 1, at: '2026-01-02T00:00:00.000Z', wallMin: 3.2, summary: { nExecuted: 2, nError: 0 }, hook: { failed: false, lines } })
        let dig = () => {
            let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'tools', 'roundDigest.mjs'), '1'], { cwd: t.dir, env: { ...process.env, ARSI_ROOT: root }, windowsHide: true, encoding: 'utf8', timeout: 150000 })
            assert.equal(r.status, 0, r.stderr)
            let s = r.stdout
            return s.slice(s.indexOf('## 一眼看完'), s.indexOf('\n## ', s.indexOf('## 一眼看完') + 3))
        }
        fs.writeFileSync(path.join(fd, 'ROUND.json'), JSON.stringify(R(['整體研判:x', la, '其他之列', lb, `${la}(第二列)`])))
        let a = dig()
        assert(a.includes(`\n- ${la}\n`) && a.includes(`\n- ${lb}\n`), a)
        assert(!a.includes('(第二列)'), '各取第一列')
        fs.writeFileSync(path.join(fd, 'ROUND.json'), JSON.stringify(R(['整體研判:x', '其他之列'])))
        let b = dig()
        assert(!b.includes('量尺(並列') && !b.includes('側別讀數之警示'), b)
        fs.rmSync(fd, { recursive: true, force: true })
    })
})
