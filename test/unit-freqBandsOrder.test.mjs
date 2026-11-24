import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { pathToFileURL } from 'url'
import { getSettings, inputMsgOf } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { scoreOf } from '../src/eval/score.mjs'
import * as CN from '../src/eval/cfgNum.mjs'
import { checkEvalSettings, configMsgOf } from '../src/eval/barGrid.mjs'
import { FD_ROOT, makeTmp } from './tools/synthLedger.mjs'


//score.freqBands 之順序(b1 ≤ b2)之單一來源(排程第 614 項之餘、tadm6〈需你決定〉3; 規則 R-EV-57 ③): 檢查在評估器之 evalScoreOf, 讀設定處(getSettings)只攔它之一種錯誤
//  規格之句 ⇒ 案:
//    ① 「檢查在 evalScoreOf(單一來源)」= evalScoreOf 之輸入表(順序顛倒者拋固定訊息且帶 code; 合格者不拋; 數字字串依轉換值比較; who 可改; 他種之無效先於本檢查拋出且不帶此 code)
//    ② 「API 直呼 scoreOf / makeProject / checkEvalSettings 亦涵蓋」= 三者於順序顛倒者拋同一訊息、合格者不拋(原: 只有讀設定處檢查, API 自組 st 者不經)
//    ③ 「讀設定處之訊息與拒收之輸入集合不變」= getSettings 之輸入表之結果與原相同(拋 / 不拋與其訊息; 他種之 score 無效不攔)
//    ④ 「單一來源」= 原始碼只有一處定義該訊息與比較(src/cfg.mjs 之 freqBandsCheck 已刪)
//  修前(1.0.50 + tadm8): 檢查在 src/cfg.mjs 之 freqBandsCheck(getSettings 呼叫); evalScoreOf、scoreOf、makeProject、checkEvalSettings 不檢順序
//  新增之具名匯出以命名空間取得(修前之複本無此匯出時, 本檔仍可載入, 各案以斷言失敗呈現)
let { evalScoreOf, FREQ_BANDS_ORDER_CODE } = CN
let MSG = 'invalid score.freqBands: must be two non-negative numbers with b1 <= b2'
let SC = { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 } }
let LIM = { monthlyOrders: 400, peakHold: 50 }
let mkM = () => ({
    op: { eqYr: { mean: 40, min: 30 }, monthlyOrders: { mean: 80 }, peakHold: { max: 25 } },
    fresh: { 7: { eqYr: { mean: 20 } }, 30: { eqYr: { mean: 20 } } },
    sel: { sizeMax: 40 },
    null: { p: 0.0154 },
})
//輸入表(各列之值逐列相異): [freqBands, 是否順序顛倒]
let ROWS = [
    [[250, 100], true],
    [['250', '100'], true],
    [[250, '100'], true],
    [['250', 100], true],
    [[0.5, 0.25], true],
    [[1e6 + 7, 11], true],
    [[101, 100], true],
    [[100, 100], false],
    [[100, 250], false],
    [['9', '10'], false],
    [[0, 0], false],
    [[0, 1e9], false],
    [[' 99 ', '100'], false],
    [undefined, false],
    [null, false],
]

describe('score.freqBands 之順序之單一來源(R-EV-57 ③)', function () {
    this.timeout(300000)
    let t = makeTmp('freqBandsOrder')
    after(() => t.cleanup())

    describe('evalScoreOf: 輸入表', () => {
        it('順序顛倒(依轉換值比較)⇒ 拋固定訊息(不帶輸入值)與 code; b1 = b2、b1 < b2、數字字串、未給 / null ⇒ 不拋; 合格者之 freqBands 為轉換後之數值', () => {
            let nBad = 0
            for (let [fb, bad] of ROWS) {
                let score = fb === undefined ? SC : { ...SC, freqBands: fb }
                if (bad) {
                    nBad++
                    let err = null
                    try {
                        evalScoreOf(score)
                    }
                    catch (e) {
                        err = e
                    }
                    assert.ok(err !== null && err.message === MSG, `${JSON.stringify(fb)}: 應拋 ${MSG}`)
                    assert.ok(err.code === 'SCORE_FREQ_BANDS_ORDER' && err.code === FREQ_BANDS_ORDER_CODE, `${JSON.stringify(fb)}: code`)
                }
                else {
                    let r = evalScoreOf(score)
                    assert.ok(r.freqBands.every((x) => typeof x === 'number'), `${JSON.stringify(fb)}: 轉為數值`)
                    assert.ok(r.freqBands[0] <= r.freqBands[1], `${JSON.stringify(fb)}`)
                }
            }
            assert.equal(nBad, 7, '顛倒之列數(防空表)')
            assert.deepEqual(evalScoreOf({ ...SC, freqBands: ['9', '10'] }).freqBands, [9, 10])
            assert.deepEqual(evalScoreOf({ ...SC, freqBands: [' 99 ', '100'] }).freqBands, [99, 100])
            assert.deepEqual(evalScoreOf(undefined).freqBands, [100, 250], '未給 = 預設')
        })

        it('訊息為固定字串(以不同之輸入顛倒者逐字相同、不含輸入值); who 可改(位置名稱隨之); 先於本檢查之無效者維持原訊息且不帶此 code', () => {
            let msgOf = (score, who) => {
                try {
                    evalScoreOf(score, who)
                }
                catch (e) {
                    return e
                }
                return null
            }
            let e1 = msgOf({ freqBands: [777777, 11] })
            let e2 = msgOf({ freqBands: [31337, 5] })
            assert.ok(e1 !== null && e2 !== null && e1.message === MSG && e2.message === e1.message)
            assert.ok(!e1.message.includes('777777') && !e2.message.includes('31337'), '不含輸入值')
            let e3 = msgOf({ freqBands: [250, 100] }, 'cfg.score')
            assert.ok(e3 !== null && e3.message === 'invalid cfg.score.freqBands: must be two non-negative numbers with b1 <= b2', 'who 隨之')
            //先於本檢查之無效: 型別 / 元素 / 其他鍵(ladder)之無效仍為原訊息, 且不帶此 code(getSettings 只攔順序之一種)
            let others = [
                [{ freqBands: [250, null] }, 'invalid score.freqBands[1]: must be a non-negative number'],
                [{ freqBands: [250, 'x'] }, 'invalid score.freqBands[1]: must be a non-negative number'],
                [{ freqBands: [-1, -5] }, 'invalid score.freqBands[0]: must be a non-negative number'],
                [{ freqBands: [250] }, 'invalid score.freqBands: must be an array of two non-negative numbers'],
                [{ freqBands: 'abc' }, 'invalid score.freqBands: must be an array of two non-negative numbers'],
                [{ ...SC, ladder1: { S: 'abc', nullP: 0.05 }, freqBands: [250, 100] }, 'invalid score.ladder1.S: must be a finite number'],
                [{ ...SC, ladder3: { monthlyOrders: -1, peakHold: 30 }, freqBands: [250, 100] }, 'invalid score.ladder3.monthlyOrders: must be a non-negative number'],
            ]
            for (let [score, want] of others) {
                let e = msgOf(score)
                assert.ok(e !== null && e.message === want, want)
                assert.ok(e.code === undefined, `${want}: 不帶順序之 code`)
            }
        })
    })

    describe('API 直呼亦涵蓋(原: 只有讀設定處檢查)', () => {
        it('scoreOf(raw, { score }): 順序顛倒者拋 invalid score.freqBands: …(原: 不檢查, 「中」段恆空); 合格者不拋且與數字之寫法逐位相同', () => {
            for (let [fb, bad] of ROWS) {
                let score = fb === undefined ? SC : { ...SC, freqBands: fb }
                if (bad) {
                    assert.throws(() => scoreOf(mkM(), { limits: LIM, score, layer: 'L1' }), (e) => e.message === MSG, JSON.stringify(fb))
                }
                else {
                    assert.doesNotThrow(() => scoreOf(mkM(), { limits: LIM, score, layer: 'L1' }), JSON.stringify(fb))
                }
            }
            //數字字串 ≡ 數字(['9', '10'] 與 [9, 10])
            assert.deepEqual(scoreOf(mkM(), { limits: LIM, score: { ...SC, freqBands: ['9', '10'] } }), scoreOf(mkM(), { limits: LIM, score: { ...SC, freqBands: [9, 10] } }))
        })

        it('checkEvalSettings(st, meta): 順序顛倒者拋同一訊息, configMsgOf 認得(命令列與迴圈之預檢皆經此); 合格者不拋', () => {
            let meta = { time0: '2022-01-01T00:00:00', barHours: 24 }
            let st = (score) => ({ periods: { train: { start: '2022-01-01T00:00:00', end: '2022-06-01T00:00:00' }, backtest: { start: '2022-07-01T00:00:00', end: '2022-12-01T00:00:00' } }, eval: {}, score })
            assert.doesNotThrow(() => checkEvalSettings(st({ ...SC, freqBands: [100, 250] }), meta))
            let err = null
            try {
                checkEvalSettings(st({ ...SC, freqBands: [250, 100] }), meta)
            }
            catch (e) {
                err = e
            }
            assert.ok(err !== null && err.message === MSG)
            assert.equal(configMsgOf(err), MSG)
        })

        it('makeProject(st): st 為 API 自組(不經 getSettings)而順序顛倒者拋同一訊息、不建任何狀態檔; 合格者可組裝', () => {
            let mk = (score, tag) => {
                let st = getSettings()
                let d = path.join(t.dir, `proj_${tag}`)
                st.resources = {}
                st.rsi = { ...st.rsi, root: path.join(d, 'rsi'), docLimits: false, maxArmsPerNode: 4, autoFill: false }
                st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
                st.eval.ledgerDir = path.join(d, 'ledger')
                fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
                fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthFB' }), 'utf8')
                st.score = score
                return { st, d, build: () => makeProject(st, { dispatch: async () => ({ ok: false, error: 'fake' }), gate: null, catalogFile: path.join(d, 'catalog.json') }) }
            }
            let bad = mk({ ...SC, freqBands: ['250', '100'] }, 'bad')
            assert.throws(() => bad.build(), (e) => e.message === MSG)
            assert.equal(fs.existsSync(path.join(bad.d, 'rsi')), false, '拒收先於任何狀態檔之建立')
            let ok = mk({ ...SC, freqBands: ['9', '10'] }, 'ok')
            let P = ok.build()
            assert.equal(typeof P, 'object')
        })
    })

    describe('讀設定處(getSettings): 訊息與拒收之輸入集合不變', () => {
        //getSettings 讀 FD_ROOT/settings.json(參考設定)後, 以替身置換 score 再呼叫 ⇒ 同一行程之探測: 以 ARSI_ROOT 另指專案根之子行程見 unit-sideFlowCfg
        //  本案以專案根為暫存夾之 settings.json 逐列重寫後呼叫(getSettings 每次呼叫皆重讀檔案)
        it('輸入表: 順序顛倒 ⇒ 拋同一訊息(帶 code); 其餘不拋(含他種之 score 無效: 留待組裝時之預檢); inputMsgOf 認得', async () => {
            let root = path.join(t.dir, 'gs')
            fs.mkdirSync(root, { recursive: true })
            let write = (score) => {
                fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
                    periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } },
                    eval: { ledgerDir: './ledger/eval', phases: [0, 3], horizons: [7] },
                    ...(score === undefined ? {} : { score }),
                    rsi: { root: './rsi' },
                    records: { workDir: './rsi/work' },
                    dispatch: {},
                }), 'utf8')
            }
            //單一子行程內逐列重寫後呼叫 getSettings(每次呼叫重讀檔案), 回各列之結果
            let cases = [
                ...ROWS.map(([fb]) => (fb === undefined ? SC : { ...SC, freqBands: fb })),
                { ...SC, freqBands: 'abc' },
                { ...SC, ladder1: { S: 'abc', nullP: 0.05 }, freqBands: [100, 250] },
                { ...SC, ladder1: { S: 'abc', nullP: 0.05 }, freqBands: [250, 100] },
                { ...SC, freqBands: [250, null] },
                { ...SC, freqBands: [250] },
            ]
            let script = path.join(root, 'probe.mjs')
            fs.writeFileSync(script, `import fs from 'node:fs'\nimport { getSettings, inputMsgOf } from ${JSON.stringify(pathToFileURL(path.join(FD_ROOT, 'src', 'cfg.mjs')).href)}\nlet cases = JSON.parse(fs.readFileSync('cases.json', 'utf8'))\nlet out = []\nfor (let c of cases) {\n    let o = JSON.parse(fs.readFileSync('settings.json', 'utf8'))\n    if (c === null) { delete o.score } else { o.score = c }\n    fs.writeFileSync('settings.json', JSON.stringify(o))\n    try {\n        getSettings()\n        out.push('OK')\n    }\n    catch (err) {\n        out.push('THROW ' + err.message + ' | inputMsg=' + inputMsgOf(err))\n    }\n}\nconsole.log(JSON.stringify(out))\n`, 'utf8')
            write(SC)
            fs.writeFileSync(path.join(root, 'cases.json'), JSON.stringify(cases), 'utf8')
            let e = { ...process.env, ARSI_ROOT: root }
            for (let k of ['ARSI_HARNESS', 'ARSI_LEDGER_DIR', 'ARSI_EVAL_FROM', 'ARSI_AGENT_ROLE']) {
                delete e[k]
            }
            let r = spawnSync(process.execPath, [script], { cwd: root, env: e, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            assert.equal(r.status, 0, `${r.stderr}`.slice(0, 300))
            let got = JSON.parse(`${r.stdout}`.trim())
            assert.equal(got.length, cases.length)
            let nThrow = 0
            for (let i = 0; i < cases.length; i++) {
                let bad = i < ROWS.length && ROWS[i][1]
                if (bad) {
                    nThrow++
                    assert.equal(got[i], `THROW ${MSG} | inputMsg=${MSG}`, `列 ${i}`)
                }
                else {
                    assert.equal(got[i], 'OK', `列 ${i}: 合格或他種之無效皆不於讀設定處拋`)
                }
            }
            assert.equal(nThrow, 7)
        })

        it('inputMsgOf: 認得此訊息(回其訊息); 他種 invalid score.<鍵> 不認', () => {
            assert.equal(inputMsgOf(new Error(MSG)), MSG)
            assert.equal(inputMsgOf(new Error('invalid score.ladder1.S: must be a finite number')), null)
        })
    })

    describe('單一來源(原始碼)', () => {
        it('順序之訊息與比較只在 src/eval/cfgNum.mjs 一處定義; src 無 freqBandsCheck(原在 src/cfg.mjs)', () => {
            let walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(path.join(d, x.name)) : x.name.endsWith('.mjs') ? [path.join(d, x.name)] : []))
            let files = walk(path.join(FD_ROOT, 'src'))
            assert.ok(files.length > 50, '防空集合')
            let rel = (f) => path.relative(FD_ROOT, f).replace(/\\/g, '/')
            let hits = (re) => files.filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map(rel)
            assert.deepEqual(hits(/must be two non-negative numbers with b1 <= b2/), ['src/eval/cfgNum.mjs'])
            assert.deepEqual(hits(/freqBands\[0\]\s*(?:>|>=|<)\s*\S*freqBands\[1\]/), ['src/eval/cfgNum.mjs'])
            assert.deepEqual(hits(/freqBandsCheck|FREQ_BANDS_MSG/), [])
            //getSettings 取單一來源之 code(cfg.mjs 匯入之)
            assert.ok(/FREQ_BANDS_ORDER_CODE/.test(fs.readFileSync(path.join(FD_ROOT, 'src', 'cfg.mjs'), 'utf8')))
        })
    })
})
