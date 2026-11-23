import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { pathToFileURL } from 'url'
import * as VF from '../src/domain/verify.mjs'
import * as CFG from '../src/cfg.mjs'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'


//settings.score.sideFlow(下單流量偏一側之提示用; hi、lo、baseShort.*)之取值與 score.freqBands 之順序(排程第 612 項 ②; 規則 R-EV-57)
//  規格之句 ⇒ 案:
//    ① 「提示用、不否決 ⇒ K3: 給了而無效取預設」= 各鍵 × 無效值之全表(只該鍵退回預設、其餘鍵照給); 非物件之 sideFlow / baseShort = 未給(原: 展開字串或陣列之元素於結果物件)
//    ② 「數字字串轉數值」= 字串 ≡ 數字(sideFlowCfgOf、sideFlowIssue、「下單之做空比例」一列)
//    ③ 「null 不再使判讀恆成立」= sideFlowIssue 之行為案(原: hi 為 null ⇒ 門檻 0 ⇒ 每個成品皆被標「偏做空」)
//    ④ 「freqBands 之 b1 > b2 屬給了而無效 ⇒ 拒收(R-EV-44 ④之二; 它決定搜尋地圖之格)」= 讀設定時拒收(getSettings、各進入檔 ERROR + 離開碼 2); 比較用轉換值(['9', '10'] 合格);
//       b1 = b2 合格;不合者不影響他種無效之既有處置(其訊息與處置不變)
//  修前(1.0.48): sideFlowCfgOf 以原值合併而不檢; freqBands 只檢「恰兩個非負數」
let { sideFlowCfgOf, sideFlowIssue, SIDE_FLOW, notesOf } = VF
let NODE = process.execPath
let DEF = { baseShort: { backtest: 0.16, train: 0.22 }, hi: 2.5, lo: 0.4 }

describe('settings.score.sideFlow 之取值(K3)與 score.freqBands 之順序(R-EV-57)', function () {
    this.timeout(300000)
    let t = makeTmp('sideFlowCfg')
    after(() => t.cleanup())

    describe('sideFlowCfgOf: 取值', () => {
        it('預設: 未給 / null / 非物件(字串、數字、布林、陣列)⇒ 內建值(原: 展開字串與陣列之元素,結果物件多出 0、1、2 … 之鍵); 鍵與次序只有 baseShort、hi、lo', () => {
            for (let c of [undefined, null, 'abc', '', 5, true, false, [], [1, 2], () => 1]) {
                let r = sideFlowCfgOf(c)
                assert.deepEqual(r, DEF, `${typeof c}: ${JSON.stringify(c)}`)
                assert.deepEqual(Object.keys(r).sort(), ['baseShort', 'hi', 'lo'], `${JSON.stringify(c)}: 不帶多餘之鍵`)
            }
            assert.deepEqual(SIDE_FLOW, DEF, '內建值')
            //baseShort 非物件 ⇒ 該節未給
            for (let bs of ['x', 3, true, [], [0.1], null]) {
                assert.deepEqual(sideFlowCfgOf({ hi: 3, baseShort: bs }), { ...DEF, hi: 3 }, JSON.stringify(bs))
            }
            //未知之鍵不入回傳
            assert.deepEqual(sideFlowCfgOf({ hi: 3, extra: 1, baseShort: { x: 9, backtest: 0.2 } }), { hi: 3, lo: 0.4, baseShort: { backtest: 0.2, train: 0.22 } })
        })

        it('有效值照用;數字字串(含頭尾空白、科學記號)轉為數值(原: 字串原樣留在結果物件)', () => {
            let a = sideFlowCfgOf({ hi: 3, lo: 0.5, baseShort: { backtest: 0.2, train: 0.3 } })
            assert.deepEqual(a, { hi: 3, lo: 0.5, baseShort: { backtest: 0.2, train: 0.3 } })
            let b = sideFlowCfgOf({ hi: ' 3 ', lo: '0.5', baseShort: { backtest: '0.2', train: ' 3e-1 ' } })
            assert.deepEqual(b, a, '字串 ≡ 數字')
            assert.strictEqual(typeof b.hi, 'number')
            assert.strictEqual(typeof b.baseShort.backtest, 'number')
            //邊界: lo 為 0(只判「皆為 0」)、baseShort 為 1、hi 小於 1 皆為有效之數
            assert.deepEqual(sideFlowCfgOf({ lo: 0, hi: 0.5, baseShort: { backtest: 1, train: 1 } }), { hi: 0.5, lo: 0, baseShort: { backtest: 1, train: 1 } })
            //部分鍵: 只動給了之鍵
            assert.deepEqual(sideFlowCfgOf({ baseShort: { train: 0.3 } }), { ...DEF, baseShort: { backtest: 0.16, train: 0.3 } })
        })

        //各鍵 × 無效值之全表(只該鍵退回預設; 其餘鍵照給): [鍵之路徑, 該鍵之預設, 無效值]
        let BAD = ['abc', '', '  ', true, false, [], {}, NaN, Infinity, -Infinity, '0x10', '1,5', 10n, [0.3], () => 1]
        let KEYS = [
            [['hi'], 2.5, [0, '0', -1, '-2.5']],
            [['lo'], 0.4, [-0.1, '-1']],
            [['baseShort', 'backtest'], 0.16, [0, '0', -0.1, 1.5, '2']],
            [['baseShort', 'train'], 0.22, [0, '0', -0.1, 1.5, '2']],
        ]
        for (let [p, def, extraBad] of KEYS) {
            let name = p.join('.')
            let setAt = (v) => (p.length === 1 ? { [p[0]]: v } : { [p[0]]: { [p[1]]: v } })
            let getAt = (r) => (p.length === 1 ? r[p[0]] : r[p[0]][p[1]])
            it(`${name}: 給了而無效(非有限數、布林、陣列、物件、空字串、超出值域)⇒ 該鍵取預設 ${def}(K3; 不拋、不影響其餘之鍵); null ⇒ 預設(原: null 覆蓋預設)`, () => {
                //其餘之鍵給非預設之有效值, 證明只該鍵退回預設
                let others = { hi: 3, lo: 0.5, baseShort: { backtest: 0.2, train: 0.3 } }
                let want = JSON.parse(JSON.stringify(others))
                if (p.length === 1) {
                    delete others[p[0]]
                    want[p[0]] = def
                }
                else {
                    delete others.baseShort[p[1]]
                    want.baseShort[p[1]] = def
                }
                for (let v of [...BAD, ...extraBad, null, undefined]) {
                    let cfg = JSON.parse(JSON.stringify(others))
                    if (p.length === 1) {
                        cfg[p[0]] = v
                    }
                    else {
                        cfg.baseShort[p[1]] = v
                    }
                    let r = sideFlowCfgOf(cfg)
                    assert.deepEqual(r, want, `${name} = ${typeof v === 'bigint' ? `${v}n` : (typeof v === 'function' ? 'fn' : JSON.stringify(v))}`)
                    assert(Object.values(r).every((x) => typeof x === 'number' || (x && typeof x === 'object')))
                }
                //有效值照用(對照)
                assert.strictEqual(getAt(sideFlowCfgOf(setAt(p.length === 1 ? 1.2 : 0.5))), p.length === 1 ? 1.2 : 0.5)
            })
        }
    })

    describe('sideFlowIssue 與「下單之做空比例」一列: 取值經 sideFlowCfgOf', () => {
        it('hi 為 null / 非數字 ⇒ 用預設 2.5(原: null 使門檻為 0 ⇒ 每個成品皆被標「下單偏做空」;非數字使判讀恆為 null)', () => {
            //預設下 bt = tr = 0.2: 0.2 < 0.16 × 2.5 = 0.4 且 > 0.16 × 0.4 = 0.064 ⇒ 不偏
            assert.strictEqual(sideFlowIssue(0.2, 0.2, null), null)
            for (let hi of [null, undefined, 'abc', '', false, true, [], {}, NaN, 0, -1]) {
                assert.strictEqual(sideFlowIssue(0.2, 0.2, { hi }), null, `hi=${JSON.stringify(hi)}`)
            }
            //hi 為非預設之有效值(含數字字串)⇒ 照用: hi 1 ⇒ 0.2 ≥ 0.16 且 0.2 < 0.22 ⇒ 訓練期不到 ⇒ null; hi 0.9 ⇒ 兩期皆到
            assert.strictEqual(sideFlowIssue(0.2, 0.2, { hi: 1 }), null)
            let issue = sideFlowIssue(0.2, 0.2, { hi: '0.9' })
            assert(typeof issue === 'string' && issue.includes('偏做空側') && issue.includes('≥ 0.9 倍'), String(issue))
            assert.strictEqual(sideFlowIssue(0.2, 0.2, { hi: 0.9 }), issue, '字串 ≡ 數字')
        })

        it('lo 為 null ⇒ 用預設 0.4;baseShort 為 null / 非數字 ⇒ 用預設(原: 以 null 為基準 ⇒ 乘積 0 ⇒ 判讀恆成立)', () => {
            //預設: bt 0.05 ≤ 0.16 × 0.4 = 0.064 且 tr 0.05 ≤ 0.22 × 0.4 = 0.088 ⇒ 偏做多側
            let base = sideFlowIssue(0.05, 0.05, null)
            assert(typeof base === 'string' && base.includes('偏做多側'), String(base))
            assert.strictEqual(sideFlowIssue(0.05, 0.05, { lo: null }), base)
            assert.strictEqual(sideFlowIssue(0.05, 0.05, { lo: 'abc' }), base)
            for (let bs of [{ backtest: null }, { train: null }, { backtest: 'abc', train: true }, { backtest: 0, train: 0 }]) {
                assert.strictEqual(sideFlowIssue(0.2, 0.2, { baseShort: bs }), null, JSON.stringify(bs))
                assert.strictEqual(sideFlowIssue(0.05, 0.05, { baseShort: bs }), base, JSON.stringify(bs))
            }
            //基準之數字字串 ≡ 數字
            assert.strictEqual(sideFlowIssue(0.5, 0.5, { baseShort: { backtest: '0.1', train: '0.1' } }), sideFlowIssue(0.5, 0.5, { baseShort: { backtest: 0.1, train: 0.1 } }))
            assert(sideFlowIssue(0.5, 0.5, { baseShort: { backtest: '0.1', train: '0.1' } }) !== null)
        })

        it('節點文件之「下單之做空比例」一列:基準取 sideFlowCfgOf 之值(無效者寫預設,不寫 null / 原字串)', () => {
            let m = {
                op: { eqYr: { mean: 1, min: 0, byPhase: [1] }, monthlyOrders: { mean: 9 }, peakHold: { max: 3 }, winRate: 0.5, bySide: { long: { orders: 80, pnl: 1, winRate: 0.5 }, short: { orders: 20, pnl: 1, winRate: 0.5 } } },
                sel: { longRatio: 0.5, sizeMax: 4, sizeMean: 3 },
            }
            let train = { longRatio: 0.5, tags: [], shortShare: 0.2 }
            let line = (sf) => notesOf(m, null, train, null, false, sf).find((l) => l.startsWith('下單之做空比例'))
            assert(line(null).includes('全體隨機約 0.22 / 0.16'), line(null))
            for (let sf of [{ baseShort: { backtest: null, train: 'abc' } }, { baseShort: 'x' }, 'abc', { baseShort: { backtest: 0, train: 5 } }]) {
                assert(line(sf).includes('全體隨機約 0.22 / 0.16') && !line(sf).includes('null') && !line(sf).includes('abc'), `${JSON.stringify(sf)}: ${line(sf)}`)
            }
            assert(line({ baseShort: { backtest: '0.3', train: ' 0.4 ' } }).includes('全體隨機約 0.4 / 0.3'), line({ baseShort: { backtest: '0.3', train: ' 0.4 ' } }))
        })
    })

    describe('score.freqBands 之順序(b1 ≤ b2)', () => {
        let MSG = 'invalid score.freqBands: must be two non-negative numbers with b1 <= b2'
        let SC = { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 } }
        //專案根: 最小之 settings.json(getSettings 之必給節與路徑欄)
        let mkRoot = (name, score) => {
            let root = path.join(t.dir, name)
            fs.mkdirSync(root, { recursive: true })
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
                periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } },
                eval: { ledgerDir: './ledger/eval', phases: [0, 3], horizons: [7] },
                ...(score === undefined ? {} : { score }),
                rsi: { root: './rsi' },
                records: { workDir: './rsi/work' },
                dispatch: {},
            }), 'utf8')
            return root
        }
        let envOf = (root) => {
            let e = { ...process.env, ARSI_ROOT: root }
            for (let k of ['ARSI_HARNESS', 'ARSI_LEDGER_DIR', 'ARSI_EVAL_FROM', 'ARSI_AGENT_ROLE']) {
                delete e[k]
            }
            return e
        }
        //getSettings 之探測(行程之專案根為模組載入時決定 ⇒ 子行程)
        let probe = (root) => {
            let fp = path.join(root, 'probe.mjs')
            fs.writeFileSync(fp, `import { getSettings } from ${JSON.stringify(pathToFileURL(path.join(FD_ROOT, 'src', 'cfg.mjs')).href)}\ntry {\n    let s = getSettings()\n    console.log('OK ' + JSON.stringify(s.score && s.score.freqBands))\n}\ncatch (err) {\n    console.log('THROW ' + err.message)\n}\n`, 'utf8')
            let r = spawnSync(NODE, [fp], { cwd: root, env: envOf(root), windowsHide: true, encoding: 'utf8', timeout: 60000 })
            return `${r.stdout}`.trim()
        }

        it('getSettings: b1 > b2 ⇒ 拋固定訊息(不帶輸入值);b1 = b2、b1 < b2 合格;數字字串以轉換值比較(["9", "10"] 合格、["250", "100"] 不合);未給 / null 合格', () => {
            let cases = [
                [[250, 100], `THROW ${MSG}`],
                [['250', '100'], `THROW ${MSG}`],
                [[250, '100'], `THROW ${MSG}`],
                [[0.5, 0.25], `THROW ${MSG}`],
                [[100, 100], 'OK [100,100]'],
                [[100, 250], 'OK [100,250]'],
                [['9', '10'], 'OK ["9","10"]'],
                [[0, 0], 'OK [0,0]'],
                [undefined, 'OK undefined'],
                [null, 'OK null'],
            ]
            for (let [fb, want] of cases) {
                let root = mkRoot(`gs_${Math.random().toString(36).slice(2, 8)}`, fb === undefined ? SC : { ...SC, freqBands: fb })
                assert.strictEqual(probe(root), want, `freqBands = ${JSON.stringify(fb)}`)
            }
            //訊息為固定字串(不帶輸入值): 以不同之輸入顛倒者之訊息逐字相同
            let m1 = probe(mkRoot('gs_m1', { ...SC, freqBands: [777777, 11] }))
            let m2 = probe(mkRoot('gs_m2', { ...SC, freqBands: ['secret-token-xyz'.length * 1000, 3] }))
            assert.strictEqual(m1, `THROW ${MSG}`)
            assert.strictEqual(m2, m1)
        })

        it('inputMsgOf(讀設定失敗之固定訊息之判定): 認得 invalid score.freqBands: …(回其訊息);他種 invalid score.<鍵>(階梯門檻;屬組裝時之預檢 configMsgOf)不認', () => {
            assert.strictEqual(CFG.inputMsgOf(new Error(MSG)), MSG)
            for (let m of ['invalid score.ladder1.S: must be a finite number', 'invalid score.ladder3.peakHold: must be a non-negative number', 'invalid score: must be an object']) {
                assert.strictEqual(CFG.inputMsgOf(new Error(m)), null, m)
            }
        })

        it('他種之 score 無效維持既有處置: getSettings 不攔(留待組裝時之預檢,訊息與離開碼不變);b1 > b2 與他種無效並存者,不因本檢查而改變他種無效之訊息', () => {
            //freqBands 不是陣列、ladder1.S 非數字: getSettings 照常返回(OK),不拋 score 之訊息
            for (let sc of [{ ...SC, freqBands: 'abc' }, { ...SC, ladder1: { S: 'abc', nullP: 0.05 }, freqBands: [100, 250] }, { ...SC, ladder1: { S: 'abc', nullP: 0.05 }, freqBands: [250, 100] }]) {
                let root = mkRoot(`gs2_${Math.random().toString(36).slice(2, 8)}`, sc)
                assert(probe(root).startsWith('OK '), `${JSON.stringify(sc)}: ${probe(root)}`)
            }
        })

        it('各進入檔(實跑): g_eval(cli/eval.mjs)、g_rsi(cli/rsi.mjs)、g_backtest(cli/backtest.mjs)、tools/libCheck.mjs 於 b1 > b2 ⇒ `ERROR invalid score.freqBands: …`、離開碼 2(固定訊息; 先於任何寫入); 合格者不被本檢查擋下', () => {
            let root = mkRoot('ent_bad', { ...SC, freqBands: [250, 100] })
            let run = (rt, entry, args) => {
                //g_backtest.mjs 只供迴圈使用(須 ARSI_HARNESS = 1 才讀設定)
                let env = { ...envOf(rt), ...(entry === 'cli/backtest.mjs' ? { ARSI_HARNESS: '1' } : {}) }
                let r = spawnSync(NODE, [path.join(FD_ROOT, 'src', entry), ...args], { cwd: rt, env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
                return { status: r.status, out: `${r.stdout}`.split(/\r?\n/).filter(Boolean), err: `${r.stderr}` }
            }
            let entries = [
                ['cli/eval.mjs', ['--pick', 'x.mjs', '--mode', 'quick']],
                ['cli/rsi.mjs', ['--mode', 'status']],
                ['cli/backtest.mjs', ['--pick', 'x.mjs']],
                ['tools/libCheck.mjs', []],
            ]
            for (let [entry, args] of entries) {
                let r = run(root, entry, args)
                assert.strictEqual(r.status, 2, `${entry}: ${r.out.join('|').slice(0, 200)} ${r.err.slice(0, 200)}`)
                assert.deepEqual(r.out, [`ERROR ${MSG}`], entry)
            }
            assert.deepEqual(fs.readdirSync(root).sort(), ['probe.mjs', 'settings.json'].filter((f) => fs.existsSync(path.join(root, f))).sort(), '未寫任何檔')
            //對照: 合格之 freqBands 不被本檢查擋下(進入檔不印此訊息; 其後之結果不在本案)
            let ok = mkRoot('ent_ok', { ...SC, freqBands: [100, 250] })
            for (let [entry, args] of entries) {
                let r = run(ok, entry, args)
                assert(!r.out.some((l) => l.includes('freqBands')), `${entry}: ${r.out.join('|').slice(0, 200)}`)
            }
        })
    })
})
