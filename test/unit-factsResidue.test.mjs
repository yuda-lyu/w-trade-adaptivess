import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { EVAL_NUMS } from '../src/eval/cfgNum.mjs'
import { makeTexts } from '../src/domain/texts.mjs'
import { renderContract, initProject } from '../src/tools/initProject.mjs'
import { nullFloorText, phaseText, phaseCountOf, periodLenText, libSizeText } from '../src/domain/factsText.mjs'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'


//套件文字不寫死策略庫之事實(規則 R-REC-36)之殘留掃描: 以「各項皆與參考值不同之設定」產出合約之參考版與任務書, 參考值之全部字樣不得殘留
//  參考值 = 套件之參考設定(settings.json)與合約之參考版(contract/pick-contract.md)所寫者; 字樣之清單由參考設定之值求得(下方 PHRASES: 設定之鍵 → 該值於文字中之寫法), 不手寫日期與數字
//  已知限制: 只能抓「清單所列之寫法」殘留; 日後於合約或任務書另加以其他寫法呈現設定之值者, 須同時補 PHRASES(寫法無對應者掃描不到)
let get = (o, p) => p.split('.').reduce((a, k) => (a === undefined || a === null ? undefined : a[k]), o)
let day = (v) => String(v).slice(0, 10)
//DEFAULTS, 參考設定(settings.json)未寫而由程式取預設者之參考值: eval 之五個影響評估之數字取 EVAL_NUMS(單一定義); 資源閘之等待(cli/eval.mjs、initProject.mjs 之預設 90 秒)
let DEFAULTS = { 'resources.evalMaxWaitSec': 90 }
let refValOf = (refSt, k) => {
    let v = get(refSt, k)
    if (v !== undefined) {
        return v
    }
    let m = /^eval\.(\w+)$/.exec(k)
    return m && EVAL_NUMS[m[1]] ? EVAL_NUMS[m[1]][0] : DEFAULTS[k]
}

//PHRASES, 設定之鍵 → (參考值 ⇒ 該值於合約與任務書中之各種寫法)
let PHRASES = [
    ['periods.train.start', (v) => [day(v)]],
    ['periods.train.end', (v) => [day(v)]],
    ['periods.backtest.start', (v) => [day(v)]],
    ['periods.backtest.end', (v) => [day(v)]],
    ['periods.holdoutFrom', (v) => [day(v)]],
    ['eval.fitEnd.long', (v) => [day(v)]],
    ['eval.fitEnd.short', (v) => [day(v)]],
    ['eval.cadenceDays', (v) => [`每 ${v} 日`, `其後 ${v} 日`, `(${v} 日)`, `${v} 日地平線`, `${v} 日內`, ...(v === 7 ? ['每週'] : [])]],
    ['eval.warmupDays', (v) => [`${v} 日(暖機)`]],
    ['eval.nullDraws', (v) => [`${v} 抽`, `${v} 次`, `下限為 ${nullFloorText(v)}`]],
    ['eval.horizons', (v) => [v.join('/'), v.join(' / ')]],
    ['eval.limits.monthlyOrders', (v) => [`月均單 ≤ ${v}`]],
    ['eval.limits.peakHold', (v) => [`最大同時持倉 ≤ ${v}`]],
    ['eval.actBins', (v) => [`${v} 層`]],
    ['eval.sideActHalf', (v) => [`±${v}`, `± ${v}`]],
    ['eval.phases', (v) => [phaseText(v.length, '相位'), phaseText(v.length, '個相位'), phaseText(v.length, '個起始相位')]],
    ['score.ladder1.S', (v) => [`S ≥ ${v}`]],
    ['score.ladder1.nullP', (v) => [`p ≤ ${v}`, `p > ${v}`]],
    ['score.ladder2.freshMin', (v) => [`≥ ${v} 且最差相位`, `各地平線 ≥ ${v}`]],
    ['score.ladder2.worstPhaseMin', (v) => [`最差相位 ≥ ${v}`]],
    ['score.ladder3.monthlyOrders', (v) => [`月均單 ≤ ${v}`]],
    ['score.ladder3.peakHold', (v) => [`最大同時持倉 ≤ ${v}`]],
    ['resources.evalMaxWaitSec', (v) => [`約 ${v} 秒`]],
    ['source.barHours', (v) => [`(${v} 小時一根)`, `每日 ${24 / v} 根`, `\`barsPerDay\`(${24 / v})`]],
]

describe('套件文字不寫死策略庫之事實:殘留掃描(規則 R-REC-36)', function () {
    this.timeout(120000)
    let t
    let ref
    let refSt
    before(() => {
        t = makeTmp('factsResidue')
        ref = fs.readFileSync(path.join(FD_ROOT, 'contract', 'pick-contract.md'), 'utf8')
        refSt = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
    })
    after(() => {
        t.cleanup()
    })

    //參考設定之各項(PHRASES 所列之鍵)皆須存在(清單由它求得; 缺者即清單與參考設定脫鉤)
    let refPhrases = () => {
        let out = []
        for (let [k, f] of PHRASES) {
            let v = refValOf(refSt, k)
            assert(v !== undefined, `參考設定缺 ${k} 且無預設(PHRASES 與 settings.json 脫鉤)`)
            for (let p of f(v)) {
                out.push([k, p])
            }
        }
        //回測期長度(約 N 個月)與策略隻數之舊寫法: 前者由參考設定之回測期求得; 後者為 1.0.26 寫死之字面(隻數不在設定內)
        out.push(['periods.backtest(長度)', periodLenText(refSt.periods.backtest.start, refSt.periods.backtest.end)])
        out.push(['nStrategies(1.0.26 之字面)', '約 7 萬隻'])
        return out
    }
    //各項皆與參考值不同之設定(其餘之鍵沿用參考設定)
    let otherAll = () => {
        let s = JSON.parse(JSON.stringify(refSt))
        s.source.barHours = 24
        s.periods = { train: { start: '2030-01-01T00:00:00', end: '2031-01-01T00:00:00' }, backtest: { start: '2031-01-01T00:00:00', end: '2031-06-01T00:00:00' }, holdoutFrom: '2031-06-02T00:00:00' }
        Object.assign(s.eval, { cadenceDays: 5, warmupDays: 120, phases: [0, 1, 2], horizons: [2, 4, 9], nullDraws: 32, fitEnd: { long: '2030-05-01T00:00:00', short: '2030-11-02T00:00:00' }, limits: { monthlyOrders: 350, peakHold: 40 }, actBins: 8, sideActHalf: 40 })
        s.score = { ...s.score, ladder1: { S: 12, nullP: 0.02 }, ladder2: { freshMin: 8, worstPhaseMin: 4 }, ladder3: { monthlyOrders: 250, peakHold: 25 } }
        s.resources = { ...s.resources, evalMaxWaitSec: 120 }
        return s
    }

    it('前提: 「各項皆與參考值不同」之設定確實每個鍵(PHRASES 所列者)之值皆不同於參考設定;PHRASES 之各鍵於參考版文字有對應之寫法(清單不是空轉)', () => {
        let o = otherAll()
        for (let [k] of PHRASES) {
            assert.notDeepStrictEqual(get(o, k), refValOf(refSt, k), `${k} 與參考值相同`)
        }
        //鑑別: 參考版(以參考設定產出者)含 PHRASES 所列之大多數寫法 —— 沒有任何對應者表示該鍵之寫法與文字脫鉤
        let hit = new Set()
        for (let [k, p] of refPhrases()) {
            if (ref.includes(p)) {
                hit.add(k)
            }
        }
        for (let [k] of PHRASES) {
            if (['eval.fitEnd.long', 'eval.fitEnd.short', 'periods.holdoutFrom'].includes(k)) {
                assert(hit.has(k), `${k}: 參考版應含其日期`)
            }
        }
        assert(hit.size >= 18, `參考版含 ${hit.size} 個鍵之寫法(< 18 表示清單與合約脫鉤): ${[...hit].join(', ')}`)
    })

    it('合約之參考版:以各項皆不同之設定產出,參考值之字樣不得殘留(每根 1 日;掃描清單由參考設定求得)', () => {
        let d = renderContract(ref, { barHours: 24, settings: otherAll() })
        let left = refPhrases().filter(([, p]) => d.includes(p)).map(([k, p]) => `${k}: ${JSON.stringify(p)}`)
        assert.deepEqual(left, [], '殘留之參考值字樣')
        //相位數寫成設定之個數(3 個)
        for (let s of ['三個起始相位(日)各跑一遍取平均', '三個相位同向比平均高更重要', '三相位等效年化', '同劑量虛無 32 抽']) {
            assert(d.includes(s) || d.includes(s.replace('三相位等效年化', '等效年化之三相位平均')), s)
        }
        //不是相位之「七」不被改寫: 擴充診斷之「既有七欄」
        assert(d.includes('既有七欄') && ref.includes('既有七欄'))
    })

    it('合約之參考版:每根 4 小時而其餘各項皆不同 ⇒ 同樣不殘留(週期之字句不改寫、事實一律取自設定)', () => {
        let o = otherAll()
        o.source.barHours = 4
        let d = renderContract(ref, { barHours: 4, settings: o })
        let skip = new Set(['source.barHours'])
        let left = refPhrases().filter(([k, p]) => !skip.has(k) && d.includes(p)).map(([k, p]) => `${k}: ${JSON.stringify(p)}`)
        assert.deepEqual(left, [])
        assert(d.includes('(4 小時一根)') && d.includes('每日 6 根'), '週期之字句為每根 4 小時')
    })

    it('合約之參考版與 initProject:影響評估之數字給了而無效 ⇒ 拋 invalid eval.<鍵>(initProject 不寫任何檔,V17);數字字串與數字者逐字相同', () => {
        let cases = [['warmupDays', true, 'a non-negative number'], ['cadenceDays', 0, 'a positive number'], ['nullDraws', 1.5, 'a non-negative integer'], ['actBins', 300, 'an integer from 1 to 256'], ['sideActHalf', 'abc', 'a non-negative integer']]
        for (let [k, v, desc] of cases) {
            let s = JSON.parse(JSON.stringify(refSt))
            s.eval[k] = v
            s.resources = {} //本案之設定只供 initProject 讀(不起子行程); 同檔須關閉資源閘(R-RUN-10 之靜態守門)
            assert.throws(() => renderContract(ref, { settings: s }), (err) => err.message === `invalid eval.${k}: must be ${desc}`, k)
            let root = path.join(t.dir, `init_${k}`)
            fs.mkdirSync(root, { recursive: true })
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(s), 'utf8')
            assert.throws(() => initProject({ root }), (err) => err.message === `invalid eval.${k}: must be ${desc}`, `initProject ${k}`)
            assert.deepEqual(fs.readdirSync(root), ['settings.json'], `${k}: 不寫任何檔`)
        }
        let mk = (o) => {
            let s = JSON.parse(JSON.stringify(refSt))
            Object.assign(s.eval, o)
            return s
        }
        assert.strictEqual(renderContract(ref, { settings: mk({ warmupDays: '90', cadenceDays: '5', nullDraws: '32', actBins: '8', sideActHalf: '40' }) }), renderContract(ref, { settings: mk({ warmupDays: 90, cadenceDays: 5, nullDraws: 32, actBins: 8, sideActHalf: 40 }) }))
        //未給(缺或 null)= 評估器之預設 = 參考版所寫之值 ⇒ 逐字相同
        assert.strictEqual(renderContract(ref, { settings: mk({ actBins: null, sideActHalf: undefined }) }), ref)
    })

    describe('任務書(節點與做夢)', function () {
        let stOf = (root, st) => ({
            ...st,
            FD_ROOT: root,
            rsi: { root: path.join(root, 'rsi'), guides: false, maxArmsPerNode: 3 },
            records: { nodeDir: path.join(root, 'rsi/records/nodes'), dreamDir: path.join(root, 'rsi/records/dreams'), workDir: path.join(root, 'rsi/work') },
            eval: { ...st.eval, ledgerDir: path.join(root, 'ledger') },
        })
        let toolbox = { dir: 'rsi/toolbox', index: 'rsi/toolbox/README.md', indexName: 'README.md', nTools: 3 }
        let node = { nodeId: 'n1', arms: ['A04_act'], base: null, S: 1, worst: 0, excess: 0, ladder: 0, vetoed: false, claimedS: 1, nEvals: 3, nFull: 2, nFullSel: 2, issues: [], from: null, type: 'explore', docMd: 'd.md', workDir: 'rsi/work/n1' }
        let arm = { id: 'A04_act', layer: 'A', layerName: '資格層', title: '近期活躍度門檻', desc: 'd', grid: null }
        let briefs = (st, root, nStrategies) => {
            let tx = makeTexts({ st, FD_ROOT: root, ...(nStrategies ? { nStrategies } : {}) })
            return [
                tx.nodeBrief({ workDir: path.join(st.records.workDir, 'nodeX'), task: { goal: 'g', type: 'explore', claim: null, arms: [arm], base: null, refs: [], direction: null, toolbox }, round: 2, nodeId: 'nodeX', attempt: 1 }),
                tx.dreamBrief({ round: 2, nodeIds: ['n1'], reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r002'), context: { nodes: [node], failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '2. 更新文件', toolbox } }),
            ]
        }

        it('各項皆不同之設定 ⇒ 任務書不含參考值之字樣(隻數、決策間隔、地平線、求解窗、回測期長度、相位數、虛無抽數、p 門檻)', () => {
            //共同儲存區(總表)有無兩種狀態各掃一次: 有總表者做夢任務書多一段(總表之欄之說明含「七相位」之字樣)
            for (let hasStore of [false, true]) {
                let root = path.join(t.dir, hasStore ? 'tb_other_store' : 'tb_other')
                if (hasStore) {
                    fs.mkdirSync(path.join(root, 'rsi', 'picks'), { recursive: true })
                    fs.writeFileSync(path.join(root, 'rsi', 'picks', 'INDEX.md'), '# index\n', 'utf8')
                }
                let st = stOf(root, otherAll())
                let [nb, db] = briefs(st, root, 31234)
                //任務書不含「保留期起點」「資源閘之等待」「硬上限」以外之合約專屬事實; 逐項掃描參考值之字樣
                let text = `${nb}\n${db}`
                let skip = new Set(['source.barHours', 'periods.holdoutFrom', 'eval.sideActHalf', 'eval.actBins', 'resources.evalMaxWaitSec'])
                let left = refPhrases().filter(([k, p]) => !skip.has(k) && text.includes(p)).map(([k, p]) => `${k}: ${JSON.stringify(p)}`)
                assert.deepEqual(left, [], `殘留之參考值字樣(共同儲存區${hasStore ? '有' : '無'})`)
                //取自設定之值確實出現(鑑別: 掃描不是因任務書不含該段而空過)
                for (let s of ['約 3 萬隻', '每 5 日', '2 / 4 / 9 日新鮮度', '求解窗止於 2030-05-01', '回測期只有約 5 個月', '三相位', '三個相位', '(32 抽)為準', 'p ≤ 0.02', 'p > 0.02', ...(hasStore ? ['回測期 S、三相位、挑選內容'] : [])]) {
                    assert(text.includes(s), `任務書應含「${s}」(共同儲存區${hasStore ? '有' : '無'})`)
                }
                //不是相位之「七」不被改寫: 臂之層數(A ~ G 七層)
                assert(text.includes('A ~ G 七層') && text.includes('現有七層'))
            }
        })

        it('相位數寫法:1 ~ 10 為國字、其餘為阿拉伯數字加空白;未給(或空陣列)= 7;不是相位數之「七」不受影響', () => {
            assert.deepEqual([phaseText(1, '相位'), phaseText(3, '個相位'), phaseText(7, '相位'), phaseText(10, '相位'), phaseText(11, '相位'), phaseText(12, '個相位')], ['一相位', '三個相位', '七相位', '十相位', '11 相位', '12 個相位'])
            assert.deepEqual([phaseCountOf(undefined), phaseCountOf({}), phaseCountOf({ phases: [] }), phaseCountOf({ phases: [0, 3] }), phaseCountOf({ phases: 'x' })], [7, 7, 7, 2, 7])
            let root = path.join(t.dir, 'tb_phases')
            let base = otherAll()
            for (let [phases, want, not] of [[undefined, '七相位', '三相位'], [[0, 1, 2, 3, 4, 5, 6], '七個相位', '三個相位'], [[0, 3], '二相位', '七相位'], [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], '12 相位', '七相位']]) {
                let st = stOf(root, base)
                if (phases === undefined) {
                    delete st.eval.phases
                }
                else {
                    st.eval.phases = phases
                }
                let [nb, db] = briefs(st, root)
                for (let tx of [nb, db]) {
                    assert(tx.includes(want) && !tx.includes(not), `${JSON.stringify(phases)}: 含「${want}」不含「${not}」`)
                    assert(!/七(相位|個相位|個起始相位)/.test(tx) || phaseCountOf(st.eval) === 7, `${JSON.stringify(phases)}: 不留「七相位」`)
                }
            }
        })

        it('虛無抽數、p 門檻等於參考值者,文字與寫死時逐字相同(64 抽、p ≤ 0.05、七相位)', () => {
            let root = path.join(t.dir, 'tb_ref')
            let st = stOf(root, JSON.parse(JSON.stringify(refSt)))
            let [nb, db] = briefs(st, root)
            assert(db.includes('(64 抽)為準') && db.includes('單抽即可能過 p ≤ 0.05。') && db.includes('其 p > 0.05 者') && db.includes('七個相位是否同向') && db.includes('七個相位都同向') && nb.includes('七個相位同向') && db.includes('七相位;挑選函數'), '參考設定 ⇒ 與 1.0.26 寫死之字面相同')
            //共同儲存區有總表者,做夢任務書另有總表之欄之說明(含相位數之字樣): 參考設定 ⇒ 仍為「七相位」
            let rootS = path.join(t.dir, 'tb_ref_store')
            fs.mkdirSync(path.join(rootS, 'rsi', 'picks'), { recursive: true })
            fs.writeFileSync(path.join(rootS, 'rsi', 'picks', 'INDEX.md'), '# index\n', 'utf8')
            let [, dbS] = briefs(stOf(rootS, JSON.parse(JSON.stringify(refSt))), rootS)
            assert(dbS.includes('回測期 S、七相位、挑選內容'), '有總表者之說明')
            //nullDraws 以數字字串給者與數字者逐字相同(檢測之值即使用之值)
            let st2 = stOf(root, JSON.parse(JSON.stringify(refSt)))
            st2.eval.nullDraws = '32'
            st2.score.ladder1.nullP = '0.02'
            let st3 = stOf(root, JSON.parse(JSON.stringify(refSt)))
            st3.eval.nullDraws = 32
            st3.score.ladder1.nullP = 0.02
            assert.deepEqual(briefs(st2, root), briefs(st3, root))
            //無效 ⇒ 拒絕(不退回預設)
            let st4 = stOf(root, JSON.parse(JSON.stringify(refSt)))
            st4.eval.nullDraws = -1
            assert.throws(() => briefs(st4, root), (err) => err.message === 'invalid eval.nullDraws: must be a non-negative integer')
            //決策間隔給了而無效 ⇒ 拒絕(不退回預設 7 而寫「每週」)
            for (let v of ['x', 0, -7, true]) {
                let st5 = stOf(root, JSON.parse(JSON.stringify(refSt)))
                st5.eval.cadenceDays = v
                assert.throws(() => briefs(st5, root), (err) => err.message === 'invalid eval.cadenceDays: must be a positive number', String(v))
            }
        })
    })

    it('下限之寫法:1 ÷ (1 + 抽數)四捨五入至小數第 4 位(同評估器之 p;64 抽 = 0.0154)', () => {
        assert.deepEqual([nullFloorText(64), nullFloorText(32), nullFloorText(4), nullFloorText(1), nullFloorText(99), nullFloorText(999)], ['0.0154', '0.0303', '0.2', '0.5', '0.01', '0.001'])
        assert.equal(libSizeText(70000), '約 7 萬隻')
    })
})
