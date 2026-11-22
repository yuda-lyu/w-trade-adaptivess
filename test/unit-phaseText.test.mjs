import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import * as CN from '../src/eval/cfgNum.mjs'
import * as FT from '../src/domain/factsText.mjs'
import { scoreOf } from '../src/eval/score.mjs'
import { summaryOf, notesOf } from '../src/domain/verify.mjs'
import { sideReadTextOf } from '../src/domain/sideRead.mjs'
import { makeTmp, writeSynthLedger, FD_ROOT } from './tools/synthLedger.mjs'


//相位數之寫法取自設定(排程第 547 項②): 看板、共同儲存區、摘要、命令列輸出與判讀之說明文字原寫死「七相位」, 改取 settings.eval.phases 之長度(phaseCountOf; 未給 = 評估器之預設 7)
//  規格之句: ① 設定 N 個相位者, 各處之「七相位」改為 N 之寫法(phaseText: 1 ~ 10 為國字、其餘為阿拉伯數字加空白); ② 預設(7)者與寫死時逐字相同; ③ 單一定義(phaseCountOf、phaseText 於 cfgNum.mjs, factsText.mjs 再匯出同一函數);
//  ④ src 內(註解除外)不再寫死「七相位」之字樣(固定文字之常數表 pickStore.mjs、score.mjs 與合約之錨點表 initProject.mjs 除外 —— 其輸出處皆以 phaseText 替換, 見各案)
//  看板、搜尋地圖、共同儲存區之整體輸出見 unit-fillCli(專案之夾具); 共同儲存區之固定文字另見 unit-pickStore
let SRC = path.join(FD_ROOT, 'src')

describe('相位數之寫法取自 eval.phases(排程第 547 項②)', function () {
    this.timeout(300000)
    let t = makeTmp('phaseText')
    after(() => t.cleanup())

    it('phaseCountOf / phaseText: 單一定義於 cfgNum.mjs, factsText.mjs 再匯出同一函數; 未給或空陣列 = 預設 7; 1 ~ 10 國字、其餘阿拉伯數字加空白', () => {
        assert.strictEqual(FT.phaseCountOf, CN.phaseCountOf)
        assert.strictEqual(FT.phaseText, CN.phaseText)
        assert.strictEqual(CN.phaseCountOf(undefined), 7)
        assert.strictEqual(CN.phaseCountOf({}), 7)
        assert.strictEqual(CN.phaseCountOf({ phases: [] }), 7)
        assert.strictEqual(CN.phaseCountOf({ phases: [0, 3] }), 2)
        assert.strictEqual(CN.phaseCountOf({ phases: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }), 11)
        assert.deepEqual([1, 2, 7, 10, 11, 12].map((n) => CN.phaseText(n, '相位')), ['一相位', '二相位', '七相位', '十相位', '11 相位', '12 相位'])
    })

    it('scoreOf 之判讀文字(flags.why)內之「七相位皆為正」: 依 nPh 寫(above、fail); 預設 7 逐字相同; 其餘之旗標不含', () => {
        let m = { op: { eqYr: { mean: 20, min: 5 }, monthlyOrders: { mean: 10 }, peakHold: { max: 3 } }, null: { p: 0.01 }, fresh: { 7: { eqYr: { mean: 12 } } }, sel: { sizeMax: 3 } }
        let score = { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] }
        let whyOf = (backtest, nPh) => scoreOf(m, { limits: {}, score, evidence: { backtest }, ...(nPh === undefined ? {} : { nPh }) }).flags.why.join('|')
        assert(whyOf('above').includes('尚未達「七相位皆為正」'), '預設')
        assert(whyOf('fail').includes('樣本外未達「七相位皆為正」'))
        assert(whyOf('above', 7).includes('尚未達「七相位皆為正」'))
        assert(whyOf('above', 2).includes('尚未達「二相位皆為正」') && !whyOf('above', 2).includes('七相位'), whyOf('above', 2))
        assert(whyOf('fail', 12).includes('樣本外未達「12 相位皆為正」'))
        assert(!whyOf('pass', 2).includes('相位皆為正'), 'pass 之句不含')
    })

    it('verify.mjs 之 summaryOf(欄標)與 notesOf(新鮮度一列): 相位數 = 該評估結果之 byPhase 之長度(= 完整評估所算之相位數); 無 byPhase 者取預設 7', () => {
        let mk = (byPhase) => ({ op: { eqYr: { mean: 1, min: 0, byPhase }, monthlyOrders: { mean: 1 }, peakHold: { max: 1 }, nDecisions: byPhase || [] }, null: null, selHash: 'h', fresh: { 7: { eqYr: { mean: 3.14 } } } })
        let label = (m) => summaryOf(m, { S: 1, ladder: 1 }).find((x) => x.key === 'eqYrMean').label
        assert.strictEqual(label(mk([1, 2])), '等效年化 二相位平均(%;回測期)')
        assert.strictEqual(label(mk([1, 2, 3, 4, 5, 6, 7])), '等效年化 七相位平均(%;回測期)')
        assert.strictEqual(label(mk(undefined)), '等效年化 七相位平均(%;回測期)')
        assert.strictEqual(label(mk([])), '等效年化 七相位平均(%;回測期)')
        let fresh = (m) => notesOf(m).find((l) => l.startsWith('新鮮度('))
        assert.strictEqual(fresh(mk([1, 2])), '新鮮度(二相位均 %): 7d 3.1')
        assert.strictEqual(fresh(mk([1, 2, 3, 4, 5, 6, 7])), '新鮮度(七相位均 %): 7d 3.1')
    })

    it('sideReadTextOf(搜尋地圖與輪末摘要之側別讀數一列): 第二個參數 = 相位數(預設 7)', () => {
        let sr = { n: 12, r: 0.5, nTop: 10, topLo: 0.2, topHi: 0.8, warn: { corr: false, short: false, long: false } }
        assert.strictEqual(sideReadTextOf(sr).line, '- 側別讀數(回測期;相異成品 12 個):做多比例與七相位平均之相關 0.50;排序鍵前 10 名之做多比例 0.20 ~ 0.80。')
        assert.strictEqual(sideReadTextOf(sr, 7).line, sideReadTextOf(sr).line)
        assert.strictEqual(sideReadTextOf(sr, 2).line, '- 側別讀數(回測期;相異成品 12 個):做多比例與二相位平均之相關 0.50;排序鍵前 10 名之做多比例 0.20 ~ 0.80。')
        assert.strictEqual(sideReadTextOf(null, 2).line, '')
    })

    //  排程第 547 項②之接續(取實算): --mode quick 恆實算 2 個相位(0 與 3), 畫面之字與設定之 eval.phases 之長度無關(原: 取設定之長度, quick 亦寫設定之長度);
    //  --mode full、--phases 覆寫、結果檔 metrics.phases 之長度與看板、搜尋地圖、摘要等見 unit-phaseActual
    describe('g_eval.mjs 之畫面「新鮮度(N 相位均 %)」(--mode quick): 實算 2 個相位 ⇒ 恆為二相位均, 與設定之 eval.phases 之長度無關', () => {
        let root = path.join(t.dir, 'proj')
        let W = path.join(root, 'rsi', 'work', 'w1')
        writeSynthLedger(path.join(root, 'ledger', 'eval'), { n: 40, nBars: 2400, seed: 5 })
        fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
        fs.mkdirSync(W, { recursive: true })
        fs.writeFileSync(path.join(W, 'pick.mjs'), 'export default function pick(ctx) {\n    let ids = []\n    for (let s = 0; s < ctx.n; s += 3) ids.push(s)\n    return ids\n}\n', 'utf8')
        let run = (phases) => {
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
            let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'eval.mjs'), '--pick', path.join(W, 'pick.mjs'), '--mode', 'quick', '--no-log'], { cwd: root, env: e, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(0, 500))
            return `${r.stdout}`.split(/\r?\n/).find((l) => l.startsWith('新鮮度('))
        }
        it('設定之 phases 為兩個、三個、十二個、未給(評估器之預設 7)、七個 ⇒ quick 皆實算 2 個相位 ⇒ 二相位均(原: 取設定之長度)', () => {
            for (let ph of [[0, 3], [0, 1, 3], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], undefined, [0, 1, 2, 3, 4, 5, 6]]) {
                assert(run(ph).startsWith('新鮮度(二相位均 %):'), `${JSON.stringify(ph)}: ${run(ph)}`)
            }
        })
    })

    describe('src 之原始碼盤點: 不再寫死「七相位」(註解除外; 固定文字之常數表與合約之錨點表除外)', () => {
        //例外之檔: pickStore.mjs(欄位定義、欄標題、README 之固定文字; 輸出處以 phSub 依相位數替換)、score.mjs(OOS_WHY; 輸出處依 nPh 替換)、tools/initProject.mjs(合約之錨點表: 以 ph() 改寫為設定之相位數; R-REC-36)
        let ALLOW = ['domain/pickStore.mjs', 'eval/score.mjs', 'tools/initProject.mjs']
        let walk = (dir, out = []) => {
            for (let f of fs.readdirSync(dir, { withFileTypes: true })) {
                let fp = path.join(dir, f.name)
                if (f.isDirectory()) {
                    walk(fp, out)
                }
                else if (f.name.endsWith('.mjs')) {
                    out.push(fp)
                }
            }
            return out
        }
        let isComment = (line, i) => {
            let s = line.trimStart()
            if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) {
                return true
            }
            let j = line.indexOf('//')
            return j >= 0 && j < i && !/['"`]/.test(line.slice(0, j))
        }
        it('非註解行之「七相位」只出現於例外之檔; 例外之檔之出處各有替換之寫法(phSub / replace(/七相位/g, …) / v.ph(…))', () => {
            let bad = []
            let n = 0
            for (let fp of walk(SRC)) {
                let rel = path.relative(SRC, fp).replace(/\\/g, '/')
                fs.readFileSync(fp, 'utf8').split(/\r?\n/).forEach((line, li) => {
                    let i = line.indexOf('七相位')
                    if (i < 0 || isComment(line, i)) {
                        return
                    }
                    n++
                    if (!ALLOW.includes(rel)) {
                        bad.push(`${rel}:${li + 1}`)
                    }
                })
            }
            assert(n >= 10, `鑑別前提: 例外之檔內仍有固定文字(掃描有效): ${n}`)
            assert.deepEqual(bad, [])
            let ps = fs.readFileSync(path.join(SRC, 'domain', 'pickStore.mjs'), 'utf8')
            assert(ps.includes('let phSub = (s, nPh) => s.replace(/七相位/g, phaseText(nPh, \'相位\'))'))
            let sc = fs.readFileSync(path.join(SRC, 'eval', 'score.mjs'), 'utf8')
            assert(sc.includes('.replace(/七相位/g, phaseText(nPh, \'相位\'))'))
            assert(fs.readFileSync(path.join(SRC, 'tools', 'initProject.mjs'), 'utf8').includes('v.ph(\'相位\')'))
        })

        //  排程第 547 項②之接續(取實算): 說明某結果之相位數者改取該結果之 metrics(phaseCountOfMetrics / phaseCountOfAll), 見 unit-phaseActual 之原始碼案與各輸出之行為案;
        //  此處只守「說明正本評估之設定者」仍取設定: 做夢任務書之 state.md 填寫指引(phT 不帶節點)與任務書、合約之參考版(texts.mjs 之 ph、initProject.mjs 之 v.ph)
        it('相位數之寫法: 說明正本評估之設定者(texts.mjs 之 ph、initProject.mjs 之 v.ph、domain.mjs 之 phT 不帶節點者)取設定之長度 phaseText(phaseCountOf(…))', () => {
            let has = (rel, re) => assert(re.test(fs.readFileSync(path.join(SRC, rel), 'utf8')), `${rel}: ${re}`)
            has('domain/texts.mjs', /let ph = \(tail\) => phaseText\(phaseCountOf\(ev0\), tail\)/)
            has('tools/initProject.mjs', /ph: \(tail\) => phaseText\(phaseCountOf\(ev\), tail\)/)
            has('domain/domain.mjs', /let phT = \(tail, ns\) => phaseText\(ns \? nPhOf\(ns\) : phaseCountOf\(st\.eval\), tail\)/)
            assert.strictEqual((fs.readFileSync(path.join(SRC, 'domain', 'domain.mjs'), 'utf8').match(/phT\('相位'\)/g) || []).length, 1, 'domain.mjs 不帶節點者 1 處(做夢任務書之填寫指引)')
        })

        it('scoreOf 之呼叫端(score.mjs 以外之 src)一律傳 nPh: phaseCountOf(st.eval)(少傳之處於 phases ≠ 7 時 flags.why 仍寫「七相位」); sideReadTextOf 之呼叫端一律傳相位數', () => {
            let sc = []
            let sr = []
            for (let fp of walk(SRC)) {
                let rel = path.relative(SRC, fp).replace(/\\/g, '/')
                fs.readFileSync(fp, 'utf8').split(/\r?\n/).forEach((line, li) => {
                    let s = line.trimStart()
                    if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*') || /^(import|export)\b/.test(s)) {
                        return
                    }
                    if (rel !== 'eval/score.mjs' && /\bscoreOf\(/.test(line)) {
                        sc.push({ at: `${rel}:${li + 1}`, ok: line.includes('nPh: phaseCountOf(st.eval)') })
                    }
                    if (rel !== 'domain/sideRead.mjs' && /\bsideReadTextOf\(/.test(line)) {
                        sr.push({ at: `${rel}:${li + 1}`, ok: /sideReadTextOf\(sideReadOfTree\((nodes|ns)\), nPhOf\((nodes|ns)\)\)/.test(line) })
                    }
                })
            }
            //鑑別前提: 掃描確實找到各呼叫端(domain 3、verify 3、eval 1; domain 之側別讀數 2)
            assert.strictEqual(sc.length, 7, JSON.stringify(sc))
            assert.strictEqual(sr.length, 2, JSON.stringify(sr))
            assert.deepEqual(sc.filter((x) => !x.ok).map((x) => x.at), [])
            assert.deepEqual(sr.filter((x) => !x.ok).map((x) => x.at), [])
        })

        it('flags.why 之「七相位」於節點文件之判讀(verify.mjs、domain.mjs 之 scoreOf 帶回測期旗標者)取設定之相位數: 以 scoreOf 之 nPh 驗(見上), 此處驗 phaseCountOf 對設定之各形(未給、空陣列、非陣列)', () => {
            assert.strictEqual(CN.phaseCountOf({ phases: 'x' }), 7)
            assert.strictEqual(CN.phaseCountOf({ phases: null }), 7)
            assert.strictEqual(CN.phaseCountOf(null), 7)
            assert.strictEqual(CN.phaseCountOf({ phases: [0] }), 1)
        })
    })
})
