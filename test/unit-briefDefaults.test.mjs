import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeTexts } from '../src/domain/texts.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import * as VER from '../src/domain/verify.mjs'
import { renderContract } from '../src/tools/initProject.mjs'
import { specHash } from '../src/engineApi.mjs'
import { briefMatrix, BRIEF_LIMIT } from './tools/briefMatrix.mjs'
import { FD_ROOT, makeTmp } from './tools/synthLedger.mjs'


//任務書本文之舊預設(規則 R-REC-55)
//  規格: ①節點任務書之中性預設(恆改): accept 依 sig.mode 只看該側之在倉數(做多 book.openLong < 25、做空 book.openShort < 25)、不設每日上限;
//          入選由各策略自身之量是否達門檻決定、兩側各一條件(某側無把握者寫「該側尚無條件」而不入選,不以值域外之門檻代替)、入選數與多空組成是結果、不取名次 / 分位 / 前 K / 固定席數 / 庫比例;
//          非 A / B 層不以績效或活躍度當入選條件,入選之中性預設 =「全體」或「ctx.rand() 逐策略獨立隨機(機率固定)」;須定先後以 ctx.meta.tie[s];交付須為〔機制〕(conclusion.form)
//        ②做夢任務書之審計規程第 1 點與上列一致,並判定成品之形式(與節點自標不一致時以做夢為準,理由記於 evidence)
//        ③rsi.exposure 未關閉時側別曝險之各句不變;關閉(false)時不輸出:審計規程第 8 點之末句、量尺句之後半、可疑方向第 1 項(改列單押之界定)、節點 §6 第 7 條之「兩側席次固定」之對照版;
//          可疑方向第 4 項(同一個底之連續疊加)改列中性版(補救不用兩側席次固定之版本),各項之序號不變;
//          迴圈檢查之「下單流量偏一側」不列為問題(讀數照留)
//        ④合約與範例同步;⑤節點任務書不逾 15,000 位元組(關閉者不比開啟者長)
let st0 = getSettings()
let stOf = (exposure) => ({ ...st0, rsi: { ...st0.rsi, guides: false, formGate: false, backfill: true, rankBy: 'key', exposure } })
let txOf = (exposure) => makeTexts({ st: stOf(exposure), FD_ROOT: st0.FD_ROOT, nStrategies: 70000 })
let arm = { id: 'A04_act', layer: 'A', layerName: 'A 資格', title: '活躍度', desc: '近期有進場者', grid: null }
let toolbox = { dir: 'rsi/toolbox', index: 'rsi/toolbox/README.md', indexName: 'README.md', nTools: 3 }
let dirV = { round: 3, arms: ['A04_act'], base: null, doc: 'rsi/records/dreams/r003.md', rationale: '依據甲', expect: '預期甲', type: 'verify', claim: '主張甲', newFamily: false, index: 0, claimKey: 'abcd1234' }
let task = (o = {}) => ({ goal: 'g', type: 'explore', claim: null, arms: [arm], base: null, refs: [], direction: null, toolbox, ...o })
let nb = (tx, t) => tx.nodeBrief({ workDir: path.join(st0.records.workDir, 'nodeX'), task: t, round: 7, nodeId: 'nodeX', attempt: 1 })
let dctx = () => ({ round: 2, nodeIds: ['n1'], reworkedIds: [], workDir: path.join(st0.records.workDir, 'dream_r002'), context: { nodes: [{ nodeId: 'n1', arms: ['A04_act'], base: null, S: 1, worst: 0, excess: 0, ladder: 0, vetoed: false, claimedS: 1, nEvals: 1, nFull: 1, nFullSel: 1, issues: [], from: null, type: 'explore', docMd: 'd.md', workDir: 'rsi/work/n1' }], failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '', toolbox } })
let NEUTRAL = [
    '- 執行規則 `accept` 依 `sig.mode` 只看該側之在倉數(做多 `book.openLong < 25`、做空 `book.openShort < 25`),不設每日上限(要改執行層須指定之臂含 E 層)。',
    '- 入選:各策略依自身之量是否達門檻;兩側各一條件(無把握之側寫「該側尚無條件」而不入選,不以值域外之門檻代替);入選數與多空組成是結果(可為零),不取名次、分位、前 K、固定席數或庫比例。',
    '- 指定之臂不含 A / B 層時,不以績效或活躍度當入選條件;入選之中性預設 =「全體」或「`ctx.rand()` 逐策略獨立隨機(機率固定)」。',
    '- 須定先後時以 `ctx.meta.tie[s]`,不用序號(合約 §6)。',
]
let FORM_LINE = '**臂之貢獻以「有臂 vs 去臂(換回中性預設)」之差衡量**。交付須為〔機制〕之形式(`conclusion.form` 填 `mechanism`);做不到者如實填 `clue` 並說明(見合約 §5)。'
let ITEM8_TAIL = ' **迴圈檢查列「下單流量偏一側」、或擴充診斷之提示指出成品等同某一個固定狀態(例:`fixedState`)、同比例隨機時機之安慰劑(`placeboTiming`)無內容者,其優勢歸為側別曝險:彙整時不列 `worked`、不作為方向之起點;要保留其側內之機制者,於方向內指明以兩側席次固定之版本重做**(見 §3「可疑方向」)。'
let SUM_TAIL = '、後者是否命中下述「可疑方向」第 1 項(命中者只是側別曝險,不是進度)'
let SOLO = '  - **1. 單押之界定**:多空兩側各自運行 —— 某時段只有一側下單,是各策略自身之條件之結果,不算單押;某側於整段期間恆無入選、或該側沒有自己之入選條件者才算單押。'
let ITEM4_ON = '  - **4. 同一個底之連續疊加**(近數輪之方向與預先核對皆以同一成品或同一側別層為底):**探索類之方向與預先核對至少一半改用側別中性之底**(兩側席次固定之版本);做不到須在 `adjust` 寫理由。'
let ITEM4_OFF = '  - **4. 同一個底之連續疊加**(近數輪之方向與預先核對皆以同一成品為底):**探索類之方向與預先核對至少一半不以該成品為起點**(改為無起點之方向、其他資訊源或尚未試過之臂);做不到須在 `adjust` 寫理由。'

describe('任務書之舊預設(規則 R-REC-55)', function () {
    this.timeout(120000)

    it('節點任務書 §1:新之中性預設四條緊接首句之後(探索、驗證、有無起點皆同),其後為形式之一句;舊預設(book.open < 30、選集 40、排序同分為次鍵)不殘留;側別曝險之開關不影響此段', () => {
        for (let exposure of [true, false]) {
            let tx = txOf(exposure)
            for (let t of [task(), task({ type: 'verify', claim: '主張甲', direction: dirV }), task({ toolbox: null })]) {
                let s = nb(tx, t)
                let ls = s.split('\n')
                let i = ls.findIndex((l) => l.startsWith('「以臂為主軸」:'))
                assert(i > 0 && ls[i].includes('(固定,不是調參對象;必須偏離時說明理由)'), ls[i])
                assert.deepEqual(ls.slice(i + 2, i + 6), NEUTRAL)
                assert.deepEqual(ls.slice(i + 6, i + 8), ['', FORM_LINE])
                for (let old of ['book.open < 30', '選集 40', '排序同分以', '只能「全體」或「以 `ctx.rand()` 隨機」', '必須偏離時在 `code.notes` 說明理由', '本節點之成績則看回測期之 S 與最差相位(§5)']) {
                    assert(!s.includes(old), `舊句不殘留:${old}`)
                }
            }
        }
    })

    it('做夢任務書之審計規程第 1 點:中性預設與節點任務書一致,並要求判定成品之形式(與節點自標不一致時以做夢為準、理由記於 evidence);舊預設不殘留', () => {
        for (let exposure of [true, false]) {
            let d = txOf(exposure).dreamBrief(dctx())
            let l1 = d.split('\n').find((l) => l.startsWith('1. **讀成品**'))
            for (let k of ['`accept` 依 `sig.mode` 只看該側之在倉數 —— 做多 `book.openLong < 25`、做空 `book.openShort < 25`,無日上限', '入選由各策略自身之量是否達門檻決定、兩側各一條件、入選數與多空組成是結果,不取名次、分位、前 K、固定席數或庫比例', '非指定之層不以績效 / 活躍度當入選條件', '須定先後者以 `ctx.meta.tie`', '**判定成品之形式**', '`form` 填 `mechanism`', '填 `clue`', '範本已預填節點之自標;與節點自標不一致時以你為準,理由記於 `evidence`']) {
                assert(l1.includes(k), `第 1 點含「${k}」`)
            }
            assert(!d.includes('book.open < 30') && !d.includes('選集 40'), '舊預設不殘留')
        }
    })

    it('側別曝險之各句:rsi.exposure 未關閉(true、物件、未給)⇒ 照列;關閉(false)⇒ 審計規程第 8 點之末句、量尺句之後半不列,可疑方向第 1 項改列單押之界定、第 4 項改列中性版(序號不變);節點任務書 §6 第 7 條只留自報', () => {
        for (let exposure of [true, { minShift: 0.2 }, undefined, false]) {
            let off = exposure === false
            let tx = txOf(exposure)
            let d = tx.dreamBrief(dctx())
            let ls = d.split('\n')
            assert.equal(d.includes(ITEM8_TAIL), !off, `第 8 點之末句(${JSON.stringify(exposure)})`)
            let l8 = ls.find((l) => l.startsWith('8. **審組成**'))
            assert(l8.endsWith(off ? '只在其比例與成品相差 < 10% 時才可用來判時機**。' : '(見 §3「可疑方向」)。'), l8.slice(-60))
            let sum = ls.find((l) => l.startsWith('- `synthesis`:'))
            assert.equal(sum.includes(SUM_TAIL), !off)
            assert(sum.endsWith(off ? '(進度之量尺),並寫明兩者是否為同一個。' : '(命中者只是側別曝險,不是進度)。'), sum.slice(-60))
            let iH = ls.findIndex((l) => l.startsWith('- **可疑方向**('))
            let iD = ls.findIndex((l) => l.startsWith('- `guidance.directions`:'))
            let items = ls.slice(iH + 2, iD).map((l) => (/^ {2}- \*\*(\d)\. ([^*]+)\*\*/.exec(l) || []).slice(1).join(' '))
            assert.deepEqual(items, [off ? '1 單押之界定' : '1 側別曝險冒充挑選', '2 以庫彙總量定側別或席次', '3 以落後之延續規則定側別', '4 同一個底之連續疊加', '5 成員依賴', '6 內容只在庫之某一類成員成立'])
            assert.equal(ls.includes(SOLO), off, '單押之界定(固定文字)')
            //第 4 項:開啟者原句、關閉者中性版(各恰一次; 字面值)
            assert.equal(ls.filter((l) => l === ITEM4_ON).length, off ? 0 : 1, '第 4 項之原句')
            assert.equal(ls.filter((l) => l === ITEM4_OFF).length, off ? 1 : 0, '第 4 項之中性版')
            assert.equal(d.includes('兩側席次固定'), !off)
            //節點任務書 §6 第 7 條
            let e = nb(tx, task())
            let v = nb(tx, task({ type: 'verify', claim: '主張甲', direction: dirV }))
            let l7 = (s) => s.split('\n').find((l) => l.startsWith('7. **資訊來源**:'))
            let SELF = '7. **資訊來源**:成品用到庫彙總量(第 3 級,見合約 §5)者,於 `conclusion.summary` 自報「資訊來源:第 3 級(用到之彙總量是什麼)」'
            if (off) {
                assert.equal(l7(e), `${SELF}。`)
                assert.equal(l7(v), `${SELF}。`)
            }
            else {
                assert.equal(l7(e), `${SELF};探索類另交一個「兩側席次固定」之對照版(可即 \`control.mjs\`,或另存一檔並完整評估一次,計入評估次數),並寫出兩者之組成對照之超額。`)
                assert.equal(l7(v), `${SELF};驗證類不另交對照版。`)
            }
            assert.equal(e.includes('兩側席次固定'), !off)
        }
    })

    it('節點任務書之大小:側別曝險關閉者之全部情境不逾 15,000 位元組、且不長於開啟者', () => {
        let on = briefMatrix({ makeTexts, st: stOf(true) })
        let off = briefMatrix({ makeTexts, st: stOf(false) })
        assert.equal(on.length, off.length)
        off.forEach((r, i) => {
            assert(r.bytes <= BRIEF_LIMIT, `${r.type}/${r.base}/${r.toolbox}/${r.store}: ${r.bytes}`)
            assert(r.bytes <= on[i].bytes, `${r.type}/${r.base}: 關閉 ${r.bytes} > 開啟 ${on[i].bytes}`)
        })
        assert(off.some((r, i) => r.bytes < on[i].bytes), '鑑別前提:探索類之關閉者確實較短')
    })

    it('「下單流量偏一側」之判定(sideFlowIssueOfSt;迴圈之驗證與補算共用):rsi.exposure === false ⇒ 不列;其餘(未給、true、物件)= sideFlowIssue(門檻取 settings.score.sideFlow)', () => {
        assert.equal(typeof VER.sideFlowIssueOfSt, 'function', '有 sideFlowIssueOfSt')
        let pairs = [[0.53, 0.728], [0.05, 0.08], [0.3, 0.5], [0.891, 0.433]]
        for (let [bt, tr] of pairs) {
            for (let exposure of [undefined, true, { minShift: 0.3 }]) {
                let st = { rsi: { exposure }, score: { sideFlow: { hi: 2.4 } } }
                assert.equal(VER.sideFlowIssueOfSt(bt, tr, st), VER.sideFlowIssue(bt, tr, { hi: 2.4 }), `${bt}/${tr}/${JSON.stringify(exposure)}`)
            }
            assert.equal(VER.sideFlowIssueOfSt(bt, tr, { rsi: { exposure: false }, score: {} }), null)
        }
        //鑑別前提: 至少一組在未關閉時列出
        assert(VER.sideFlowIssueOfSt(0.53, 0.728, { rsi: {} }) !== null)
        assert(VER.sideFlowIssueOfSt(0.53, 0.728, {}) !== null && VER.sideFlowIssueOfSt(0.53, 0.728, null) !== null, '設定缺 ⇒ 照列')
        //接線(單一定義套到兩個呼叫點; 迴圈之驗證須實跑評估器, 此處以原始碼核對其呼叫點): makeVerify 與 rescanSideFlow 皆經 sideFlowIssueOfSt, 不直接呼叫 sideFlowIssue
        let code = (rel) => fs.readFileSync(path.join(FD_ROOT, rel), 'utf8').split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n')
        let v = code('src/domain/verify.mjs')
        assert(v.includes('let sf = sideFlowIssueOfSt(shortShareOf(out.metrics), train.shortShare, st)'), 'makeVerify 經 sideFlowIssueOfSt')
        assert(!/sideFlowIssue\(shortShareOf\(out\.metrics\)/.test(v), 'makeVerify 不直接呼叫 sideFlowIssue')
        let dm = code('src/domain/domain.mjs')
        assert(dm.includes('let issue = sideFlowIssueOfSt(bt, tr, st)') && !/\bsideFlowIssue\(/.test(dm), 'rescanSideFlow 經 sideFlowIssueOfSt')
    })

    it('「下單流量偏一側」之門檻取值(R-EV-57 之 K3 × R-REC-55 ③): sideFlowIssueOfSt 之門檻由 sideFlowCfgOf 單一來源取值 —— score.sideFlow 給了無效之值取內建值、數字字串轉為數值、不以原值合併;關閉者對任何值皆 null', () => {
        let def = VER.sideFlowCfgOf(null)
        //鑑別前提: 取一組「內建門檻下不列、而原值合併(null 當 0)下會列」之值; 另取一組「內建門檻下列出」者
        let calm = [(def.baseShort.backtest + def.baseShort.train) / 2, (def.baseShort.backtest + def.baseShort.train) / 2]
        assert.equal(VER.sideFlowIssue(calm[0], calm[1], null), null, '前提: 全體隨機之比例附近不列')
        let hot = [0.99, 0.99]
        assert.notEqual(VER.sideFlowIssue(hot[0], hot[1], null), null, '前提: 極端偏空者於內建門檻下列出')
        //無效之值 ⇒ 該鍵取內建值(與未給相同); 數字字串 ⇒ 同其數值
        for (let sf of [null, 'x', 5, [], { hi: null }, { hi: 'x' }, { hi: -1 }, { hi: 0 }, { lo: null }, { lo: -2 }, { baseShort: null }, { baseShort: { backtest: 0 } }, { baseShort: { train: 'a' } }, { baseShort: { backtest: 2 } }]) {
            let st = { rsi: {}, score: { sideFlow: sf } }
            for (let [bt, tr] of [calm, hot]) {
                assert.equal(VER.sideFlowIssueOfSt(bt, tr, st), VER.sideFlowIssue(bt, tr, null), `無效之值取內建值: ${JSON.stringify(sf)} ${bt}/${tr}`)
                assert.equal(VER.sideFlowIssueOfSt(bt, tr, { rsi: { exposure: false }, score: { sideFlow: sf } }), null, `關閉者不列: ${JSON.stringify(sf)}`)
            }
        }
        let st2 = { rsi: {}, score: { sideFlow: { hi: '1.5', baseShort: { backtest: '0.4', train: '0.4' } } } }
        let st3 = { rsi: {}, score: { sideFlow: { hi: 1.5, baseShort: { backtest: 0.4, train: 0.4 } } } }
        for (let [bt, tr] of [[0.7, 0.7], [0.5, 0.5], [0.61, 0.59]]) {
            assert.equal(VER.sideFlowIssueOfSt(bt, tr, st2), VER.sideFlowIssueOfSt(bt, tr, st3), `數字字串同其數值: ${bt}/${tr}`)
        }
        assert.notEqual(VER.sideFlowIssueOfSt(0.7, 0.7, st3), null, '前提: 自訂之門檻(0.4 × 1.5 = 0.6)下 0.7 列出')
        assert.equal(VER.sideFlowIssueOfSt(0.5, 0.5, st3), null, '前提: 自訂之門檻下 0.5 不列(內建之基準下則另論)')
    })

    it('補算(rescanSideFlow):側別曝險關閉者移除既有之「下單流量偏一側」、不新增,讀數(raw.train.shortShare 與補充列)照補;未關閉者照列', () => {
        let t = makeTmp('briefDefaultsFlow')
        try {
            for (let exposure of [false, true]) {
                let st = getSettings()
                let d = path.join(t.dir, `p_${exposure}`)
                st.resources = {}
                st.rsi = { ...st.rsi, root: path.join(d, 'rsi'), docLimits: false, autoFill: false, formGate: false, backfill: true, rankBy: 'key', exposure }
                st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
                st.eval.ledgerDir = path.join(d, 'ledger')
                fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
                fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthFlow' }), 'utf8')
                let P = makeProject(st, { dispatch: async () => ({ ok: false }), gate: null, catalogFile: path.join(d, 'catalog.json') })
                P.rsi.init()
                let spec = { arms: ['A01_nt'], base: null }
                let id = P.idOf(spec)
                //回測期做空比 0.53、訓練期 0.728 ⇒ 兩期皆 ≥ 2.5 倍(偏做空)
                let side = (sh, n) => ({ op: { bySide: { long: { orders: n - Math.round(n * sh) }, short: { orders: Math.round(n * sh) } } } })
                let metrics = { ...side(0.53, 1000), sel: { longRatio: 0.5 } }
                metrics.op = { ...metrics.op, eqYr: { mean: 5, min: -2, byPhase: [5, 5, 5, 5, 5, 5, 5] }, monthlyOrders: { mean: 50 }, peakHold: { max: 10 } }
                let OLD = '下單流量偏一側: (舊)'
                P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round: 1, raw: { selHash: 'sf', metrics, issues: [OLD], train: { longRatio: 0.5, tags: [] } }, score: { S: 5, ladder: 0, flags: { vetoed: false, why: [] } }, evidence: { trust: 'trusted' } })
                P.records.putNodeDoc({ nodeId: id, round: 1, attempt: 1, status: 'verified', spec, harness: { ok: true, notes: [], checks: { issues: ['其他問題', OLD] } } })
                fs.mkdirSync(path.join(st.records.workDir, id), { recursive: true })
                fs.writeFileSync(path.join(st.records.workDir, id, 'harness_full.json'), JSON.stringify({ metrics }), 'utf8')
                fs.writeFileSync(path.join(st.records.workDir, id, 'harness_train.json'), JSON.stringify({ metrics: { ...side(0.728, 800), sel: { longRatio: 0.5, tags: [] } } }), 'utf8')
                assert.equal(P.rescanSideFlow(), 1)
                let n = P.rsi.store.getNode(id)
                assert.equal(n.raw.train.shortShare, 0.728, '讀數照補')
                let flows = n.raw.issues.filter((s) => s.startsWith('下單流量偏一側'))
                let docIssues = P.records.getNodeDoc(id).harness.checks.issues
                if (exposure === false) {
                    assert.deepEqual(flows, [], '關閉 ⇒ 不列(舊條移除)')
                    assert.deepEqual(docIssues, ['其他問題'])
                }
                else {
                    assert.equal(flows.length, 1)
                    assert(flows[0].startsWith('下單流量偏一側: 做空單之比例 訓練期 0.728 / 回測期 0.53'), flows[0])
                    assert.deepEqual(docIssues.slice(0, 1), ['其他問題'])
                }
            }
        }
        finally {
            t.cleanup()
        }
    })

    it('合約與範例:中性預設之敘述與 accept 之範例改為兩側各自之上限(25);判讀名詞之形式;舊寫法(book.open < 30、選集 40)不殘留;renderContract 之錨點不受影響(每根 24 小時與參考設定照改寫)', () => {
        let ref = fs.readFileSync(path.join(FD_ROOT, 'contract', 'pick-contract.md'), 'utf8')
        assert(!ref.includes('book.open < 30') && !ref.includes('選集 40'), '合約之舊預設不殘留')
        assert(ref.includes('    return sig.mode === 1 ? book.openLong < 25 : book.openShort < 25'), '範例之 accept')
        assert(ref.includes('節點任務之中性預設為各側只看該側之在倉數(做多 `book.openLong < 25`、做空 `book.openShort < 25`)、不設日上限;入選由各策略自身之量是否達門檻決定(兩側各一條件),入選數與多空組成是結果,不取名次、分位、前 K、固定席數或庫比例'))
        assert(ref.includes('  - **形式**:成品之入選方式 ——〔機制〕(`mechanism`)= 逐策略之入選條件'))
        assert(ref.includes('某側於整段期間恆無入選、或該側沒有自己之入選條件者才算單押。'))
        let st = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
        assert.doesNotThrow(() => renderContract(ref, { barHours: 24, settings: st }))
        assert.equal(renderContract(ref, { barHours: 4, settings: st }), ref, '參考設定與每根 4 小時 ⇒ 逐字相同')
        let ex = fs.readFileSync(path.join(FD_ROOT, 'examples', 'pick_example.mjs'), 'utf8')
        assert(ex.includes('    return sig.mode === 1 ? book.openLong < 25 : book.openShort < 25') && !ex.includes('book.open < 30'))
    })
})
