import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { scoreOf } from '../src/eval/score.mjs'
import * as CN from '../src/eval/cfgNum.mjs'
import { specHash } from '../src/engineApi.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//「有內容」之 p 之門檻(contentPMax)與評估器之 scoreOf 對 ladder1.nullP 之解讀同一個(排程第 612 項 ①; R-EV-55 之餘; 規則 R-EV-57)
//  規格之句 ⇒ 案: 「同一鍵(ladder1.nullP)於兩處之解讀相同」= 全表(nullP × 組成對照之 p): 搜尋地圖之「有內容」(P.hasContent)≡ scoreOf 之階梯 1 之組成對照條件(p ≤ nullP);
//    「nullP: 0 取 0」= 0 與 '0' 之列; 「經 evalScoreOf 取值」= 數字字串 / 未給 / null 之列; 「搜尋地圖之輸出」= SEARCH_MAP.md 之「有內容」標記
//  修前(1.0.48): contentPMax = `evalScoreOf(...).ladder1.nullP || 0.05` ⇒ nullP 為 0 時取 0.05(scoreOf 取 0)
//  新增之具名匯出以命名空間取得(修前之複本無此匯出時, 本檔仍可載入, 各案以斷言失敗呈現)
let { evalScoreOf } = CN
let LIM = { monthlyOrders: 400, peakHold: 50 }
let SC = { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] }

describe('「有內容」之 p 之門檻與 scoreOf 之 ladder1.nullP 同一解讀(R-EV-57)', function () {
    this.timeout(240000)
    let t
    beforeEach(() => {
        t = makeTmp('contentNullP')
    })
    afterEach(() => {
        t.cleanup()
    })
    let mk = (score) => {
        let st = getSettings()
        let d = path.join(t.dir, `proj_${Math.random().toString(36).slice(2, 8)}`)
        st.resources = {}
        st.rsi = { ...st.rsi, root: path.join(d, 'rsi'), docLimits: false, maxArmsPerNode: 4, autoFill: false }
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthNP' }), 'utf8')
        if (score === undefined) {
            delete st.score
        }
        else {
            st.score = score
        }
        let P = makeProject(st, { dispatch: async () => ({ ok: false, error: 'fake' }), gate: null, catalogFile: path.join(d, 'catalog.json') })
        P.rsi.init()
        return { P, st }
    }
    //組成對照(nullSideAct)之 p 為 p、超額為正、組成可重現之比例 < 0.8 ⇒ 「有內容」之唯一變數為 p 與門檻
    let metricsOf = (p, k = 0) => ({
        op: { eqYr: { mean: 40 + k, min: 30 + k }, monthlyOrders: { mean: 80 + k }, peakHold: { max: 25 } },
        fresh: { 7: { eqYr: { mean: 20 } }, 30: { eqYr: { mean: 20 } } },
        sel: { sizeMax: 40 },
        null: { p: 0 },
        nullSideAct: { excess: 3 + k, p, share: 0.3, mean: 5, half: 50, triggered: true },
        ext: {},
    })
    let nodeOf = (p) => ({ raw: { metrics: metricsOf(p) } })

    //nullP 之寫法 × 組成對照之 p(各列逐格相異): 預期 = p ≤ evalScoreOf 之 nullP(未給 / null = 預設 0.05)
    let NULLPS = [0, '0', ' 0 ', 0.01, '0.02', 0.05, undefined, null]
    let PS = [0, 0.005, 0.01, 0.02, 0.05, 0.06]
    it('全表:P.hasContent(搜尋地圖之「有內容」)≡ scoreOf 之階梯 1 之組成對照條件(p ≤ nullP);nullP 為 0 / \'0\' 者取 0(原: 取 0.05)', () => {
        let nBad = 0
        for (let np of NULLPS) {
            let score = np === undefined ? undefined : { ...SC, ladder1: { S: 15, nullP: np } }
            let { P } = mk(score)
            //規格: 門檻 = evalScoreOf 之 ladder1.nullP(單一來源; 未給 = 0.05)
            let eff = evalScoreOf(score, 'score').ladder1.nullP
            for (let p of PS) {
                let want = p <= eff
                //scoreOf 對同一個 p 之解讀(階梯 1 之組成對照條件; 其餘各項皆設為必過 ⇒ 階梯 ≥ 1 ⇔ p ≤ nullP)
                let lad = scoreOf(metricsOf(p), { limits: LIM, score: score === undefined ? undefined : score }).ladder
                assert.equal(lad >= 1, want, `前提: scoreOf(nullP=${JSON.stringify(np)}, p=${p}) 之階梯 ${lad}`)
                if (P.hasContent(nodeOf(p)) !== want) {
                    nBad++
                }
                assert.equal(P.hasContent(nodeOf(p)), want, `nullP=${JSON.stringify(np)} p=${p}: hasContent 應 ${want}(scoreOf 之階梯 ${lad})`)
            }
        }
        assert.equal(nBad, 0)
        //鑑別前提: 全表內 nullP 取 0 者有「p 介於 0 與 0.05 之間」之格(0.005 ~ 0.02 ⇒ 取 0.05 與取 0 之結果不同)
        assert(PS.some((p) => p > 0 && p < 0.05))
    })

    it('搜尋地圖之輸出:nullP 為 0 者,p 為 0.02 之節點不標「有內容」、p 為 0 者標;未給 nullP(預設 0.05)者兩者皆標', () => {
        let put = (P, { arms, S, p, k }) => {
            let spec = { arms, base: null }
            let id = P.idOf(spec)
            let metrics = {
                op: { eqYr: { mean: 18 + k * 1.7, min: -2 - k * 0.4, byPhase: [1, 2, 3, 4, 5, 6, 7].map((v) => v + k) }, monthlyOrders: { mean: 60 + k }, peakHold: { max: 12 + k } },
                null: { mean: -3 - k, excess: 7 + k, z: 1.8 + k / 10, p: 0.002 * (k + 1), sigPerPick: 1.0 },
                nullSideAct: { excess: 4 + k, p, share: 0.3 + k / 100, mean: 5 + k, half: 50, triggered: true },
                sel: { longRatio: 0.5 + k / 100, sizeMax: 4, sizeMean: 3, sigPerPick: 1.05 + k / 100 },
                ext: {},
            }
            let raw = { selHash: `s${k}`, metrics, issues: [], train: { longRatio: 0.51 + k / 100, tags: [], shortShare: 0.24 } }
            P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round: 1, raw, score: { S, ladder: 1, flags: { vetoed: false, why: [] } }, evidence: { trust: 'trusted' } })
            return id
        }
        let flags = (P, st, ids) => {
            P.writeBoard()
            let m = fs.readFileSync(path.join(st.rsi.root, 'SEARCH_MAP.md'), 'utf8')
            return ids.map((id) => {
                let l = m.split('\n').find((s) => s.includes(`\`${id.slice(0, 8)}\` `))
                assert(l, `搜尋地圖有節點 ${id.slice(0, 8)}`)
                return l.includes(';**有內容**')
            })
        }
        let a = mk({ ...SC, ladder1: { S: 15, nullP: 0 } })
        let idsA = [put(a.P, { arms: ['A01_nt'], S: 50, p: 0.02, k: 1 }), put(a.P, { arms: ['A04_act'], S: 40, p: 0, k: 2 })]
        assert.deepEqual(flags(a.P, a.st, idsA), [false, true], 'nullP 為 0: p 0.02 ⇒ 否、p 0 ⇒ 是(與 scoreOf 相同)')
        let b = mk(undefined)
        let idsB = [put(b.P, { arms: ['A01_nt'], S: 50, p: 0.02, k: 1 }), put(b.P, { arms: ['A04_act'], S: 40, p: 0, k: 2 })]
        assert.deepEqual(flags(b.P, b.st, idsB), [true, true], '未給 nullP(預設 0.05): 兩者皆是')
    })
})
