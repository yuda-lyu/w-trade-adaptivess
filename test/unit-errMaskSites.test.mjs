/* eslint-disable quotes, no-template-curly-in-string -- 允許表之 has 為「原始碼之片段」(含單引號、反引號與 ${…}), 以雙引號或單引號書寫以免逐一跳脫 */
import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { checkQuota, errTextOf, makeErrText } from '../src/arsi/dispatchers.mjs'
import { FD_ROOT, makeTmp } from './tools/synthLedger.mjs'
import { makeSynthProject, runEntry } from './tools/synthProject.mjs'
import { K1, K2, OTHER, leaksOf } from './tools/errMaskKit.mjs'
import { messageSitesOf, unmaskedOf, staleAllowOf } from './tools/auditErrMask.mjs'


//與派工結果 error 欄同源之未遮路徑(R-RUN-8 ⑨; 排程第 655 項 ②; 承 unit-errMask 之 ⑧): 起跑前額度查詢失敗之 row.note(印於 g_rsi.mjs 與 tools/quota.mjs)、
//  額度查詢失敗與 Claude 用量查詢失敗之印出、g_rsi.mjs 之輪次失敗(事件 run-failed 之 error、狀態檔、日誌)—— 皆經 dispatchers.mjs 之 errTextOf(單一定義; 先遮再截, 截斷長度各依原值)
//  規格之句 ⇒ 案:
//    ① 「金鑰檔含兩把、錯誤訊息含第二把 ⇒ row.note 不含任何一把」(opencode 與 claude 兩條查詢路徑各一案)
//    ② 「先遮再截」= 金鑰跨 120 字元之截斷邊界(起點 80 ~ 125)時 row.note 不含該金鑰之任何 6 字元以上之前段 / 後段; 長度仍不超過 120; 遮罩後縮短者截斷之窗內移(逐字等於「先換成 *** 再截」)
//    ③ 「其餘不變」= 無秘密之文字原樣(至多 120 字元)、空值之寫法、errTextOf 之 firstLine 與 max
//    ④ 「命令列之輸出亦遮」= tools/quota.mjs(--all)之兩處、g_rsi.mjs --mode round 之額度查詢失敗之印出與輪次失敗(事件、狀態檔、日誌; 全部狀態根之檔不含金鑰)
//    ⑤ 「遮罩函數只一處定義、新增未遮之 .message 輸出即紅」= 原始碼盤點(dispatchers.mjs、g_rsi.mjs、tools/quota.mjs; 盤點器自身以合成原始碼驗)
//    ⑥ 「失敗之路徑不再因遮罩而失敗」= makeErrText 於派工套件載不入、金鑰檔讀不了、opt 無效時不拋(只用內建之樣式)
//  修前(1.0.56 之工作樹): row.note 為 `String(…).slice(0, 120)`、run-failed 之 error 為 `…split('\n')[0].slice(0, 300)`, 皆不經秘密清單; 狀態檔與日誌原樣寫入堆疊
let LOW = { rolling: { percent: 0, resetsAt: '2026-01-01T05:00:00.000Z' }, weekly: { percent: 10, resetsAt: '2026-01-05T00:00:00.000Z' } }
let ENTRY = { id: 'ocgo:opencode-go/m', kind: 'opencode', provider: 'opencode-go', model: 'opencode-go/m', envVar: 'OPENCODE_GO_KEYS' }
//額度查詢之替身: 金鑰檔列兩把金鑰與一個用途不明之長值; 兩條查詢路徑(opencodeGoUsage、getQuotaClaude)之失敗文字由呼叫端給
let fakeWda = ({ usageMsg = null, claudeMsg = null } = {}) => ({
    providers: [ENTRY],
    readEnvFile: () => ({ OPENCODE_GO_KEYS: `${K1},${K2}`, OTHER, FLAG: '1' }),
    opencodeGoUsage: async ({ key }) => {
        if (usageMsg !== null) {
            throw new Error(usageMsg(key))
        }
        return { ok: true, limited: false, usage: LOW }
    },
    getQuotaClaude: async () => {
        if (claudeMsg !== null) {
            throw new Error(claudeMsg())
        }
        return { ok: true, windows: [] }
    },
})
let NOTE_HEAD = '用量查詢失敗(不擋): '
let OC = { node: { kind: 'opencode', id: ENTRY.id } }
let CL = { dream: { kind: 'claude', model: 'claude-opus-5-5' } }

describe('額度查詢失敗之訊息經遮罩(R-RUN-8 ⑨;排程第 655 項 ②)', function () {
    this.timeout(300000)
    let t
    let envFile
    beforeEach(() => {
        t = makeTmp('errMaskSites')
        envFile = path.join(t.dir, '.env')
        fs.writeFileSync(envFile, 'X=1\n')
    })
    afterEach(() => {
        t.cleanup()
    })
    let noteOf = async (agents, wda) => {
        let q = await checkQuota({ agents, skillsRoot: t.dir, envFile, inject: { wda } })
        assert.equal(q.rows.length, 1)
        return q.rows[0].note
    }

    it('金鑰檔含兩把、錯誤訊息含第二把(opencode 路徑: 當次查詢用第一把)⇒ row.note 不含任何一把(修前: 原樣留下)', async () => {
        let note = await noteOf(OC, fakeWda({ usageMsg: (key) => `usage request failed for key ${key}: upstream rejected fallback ${K2} (and ${OTHER})` }))
        assert.ok(note.startsWith(NOTE_HEAD), note)
        assert.ok(!note.includes(K1) && !note.includes(K2) && !note.includes(OTHER), `row.note 不含金鑰: ${note}`)
        assert.equal(note, `${NOTE_HEAD}usage request failed for key ***: upstream rejected fallback *** (and ***)`, '其餘文字逐字')
    })

    it('claude 路徑: getQuotaClaude 失敗而訊息含兩把金鑰 ⇒ row.note 不含任何一把', async () => {
        let note = await noteOf(CL, fakeWda({ claudeMsg: () => `claude usage failed: token ${K2} then ${K1}` }))
        assert.equal(note, `${NOTE_HEAD}claude usage failed: token *** then ***`)
    })

    it('先遮再截: 第二把金鑰跨 120 字元之截斷邊界(起點 80 ~ 125,每一格)⇒ row.note 不含該金鑰之任何 6 字元以上之前段 / 後段; 逐字等於「先換成 *** 再截至 120」; 修前於跨界者留下前段', async () => {
        let nCross = 0
        let starts = []
        for (let start = 80; start <= 125; start++) {
            let raw = `${'x'.repeat(start)}${K2}TAIL${'y'.repeat(60)}`
            let note = await noteOf(OC, fakeWda({ usageMsg: () => raw }))
            assert.ok(note.startsWith(NOTE_HEAD))
            let body = note.slice(NOTE_HEAD.length)
            assert.ok(body.length <= 120, `起點 ${start}: 長度 ${body.length}`)
            assert.deepEqual(leaksOf(body), [], `起點 ${start}: 金鑰之前段或後段殘留於「…${body.slice(-40)}」`)
            assert.equal(body, raw.split(K2).join('***').slice(0, 120), `起點 ${start}: 先遮再截`)
            if (start < 120 && start + K2.length > 120) {
                nCross++
                starts.push(start)
            }
        }
        assert.ok(nCross >= 15, `前提: 跨界之起點有 ${nCross} 個`)
        assert.deepEqual([starts[0], starts[starts.length - 1]], [100, 119])
    })

    it('先遮再截: 遮罩後文字短於 120 者不再截斷(金鑰縮成 *** 後,原本在 120 之外之文字進入窗內)', async () => {
        //全文 = 110 個 x + K2(21)+ 'END_MARK_OK'(11)= 142 字元; 遮罩後 = 110 + 3 + 11 = 124 ⇒ 截至 120(尾端 'END_MAR')
        //  若先截再遮: 前 120 字元 = 110 個 x + K2 之前 10 字元 ⇒ 不被辨認而留下 'oc_sk_TEST'
        let note = await noteOf(OC, fakeWda({ usageMsg: () => `${'x'.repeat(110)}${K2}END_MARK_OK` }))
        let body = note.slice(NOTE_HEAD.length)
        assert.equal(body.length, 120)
        assert.ok(body.endsWith('x***END_MAR'), `遮罩在先、截斷在後: …${body.slice(-12)}`)
        assert.ok(!body.includes('oc_sk_'), '金鑰之前段不留')
    })

    it('其餘不變: 無秘密之訊息原樣(至多 120 字元)、非 Error 之拋出值照 String()、固定文字之 note 不受影響', async () => {
        let plain = `plain upstream message ${'z'.repeat(200)}`
        assert.equal(await noteOf(OC, fakeWda({ usageMsg: () => plain })), `${NOTE_HEAD}${plain.slice(0, 120)}`)
        let w = fakeWda()
        w.getQuotaClaude = async () => ({ ok: false })
        assert.equal(await noteOf(CL, w), '用量查詢失敗(不擋)', '查詢回 ok: false 者之固定文字照舊')
        let w2 = fakeWda()
        w2.getQuotaClaude = () => Promise.reject(`string thrown ${K1}`)
        assert.equal(await noteOf(CL, w2), `${NOTE_HEAD}string thrown ***`, '拋出非 Error 者亦遮')
    })
})

describe('errTextOf / makeErrText(單一定義之遮罩函數;R-RUN-8 ⑨)', function () {
    this.timeout(60000)
    it('errTextOf: 先遮再截; max 預設 300; firstLine 先遮罩整段再取第一列再截; 空值為空字串', () => {
        assert.equal(errTextOf(`a ${K1} b ${K2}`, [K1, K2]), 'a *** b ***')
        assert.equal(errTextOf(`${'x'.repeat(10)}${K2}`, [K2], { max: 14 }), `${'x'.repeat(10)}***`.slice(0, 13), '金鑰跨界時先遮罩, 不留前段')
        assert.equal(errTextOf(`${'x'.repeat(295)}${K2}`, [K2]).length, 298, '遮罩後 298 字元, 不再補截')
        assert.equal(errTextOf(`first ${K1}\nsecond ${K2}`, [K1, K2], { firstLine: true }), 'first ***')
        assert.equal(errTextOf(`1234567890\nsecond`, [], { firstLine: true, max: 4 }), '1234')
        for (let v of [undefined, null, '', 0, false]) {
            assert.equal(errTextOf(v, [K1]), '')
        }
        assert.equal(errTextOf(`line ${K1}`, [K1], { max: Infinity }), 'line ***', 'max 為 Infinity 者不截')
        for (let o of [null, undefined, 'x', 5, []]) {
            assert.equal(errTextOf(`line ${K1}`, [K1], o), 'line ***', '第三引數無效者視為未給(不拋)')
        }
    })

    it('makeErrText: 秘密清單同 makeDispatch(金鑰檔所列之全部金鑰、用途不明之長值), 首次呼叫才讀、之後留用; 短值(旗標)不遮', () => {
        let n = 0
        let readEnvFile = () => {
            n++
            return { OPENCODE_GO_KEYS: `${K1};${K2}`, OTHER, FLAG: '1' }
        }
        let wda = { providers: [ENTRY], readEnvFile }
        let tmp = makeTmp('errMaskSitesMk')
        try {
            let envFile = path.join(tmp.dir, '.env')
            fs.writeFileSync(envFile, 'X=1\n')
            let f = makeErrText({ skillsRoot: tmp.dir, envFile, inject: { wda } })
            assert.equal(n, 0, '建立時不讀')
            assert.equal(f(`k1 ${K1} k2 ${K2} other ${OTHER} flag 1`), 'k1 *** k2 *** other *** flag 1')
            assert.equal(n, 1)
            assert.equal(f(`again ${K2}`, { max: 9 }), 'again ***')
            assert.equal(n, 1, '留用, 不重讀')
        }
        finally {
            tmp.cleanup()
        }
    })

    it('makeErrText: 讀到空清單(金鑰檔暫時讀不到 ⇒ readEnvFile 回 {})不留用 —— 下次呼叫重讀; 之後讀到金鑰者即辨認(長時間行程內一次讀不到不致使其後皆不遮)', () => {
        let n = 0
        let readEnvFile = () => {
            n++
            return n === 1 ? {} : { OPENCODE_GO_KEYS: K2 }
        }
        let tmp = makeTmp('errMaskSitesRe')
        try {
            let envFile = path.join(tmp.dir, '.env')
            fs.writeFileSync(envFile, 'X=1\n')
            let f = makeErrText({ skillsRoot: tmp.dir, envFile, inject: { wda: { providers: [ENTRY], readEnvFile } } })
            assert.equal(typeof f('first call reads an empty list'), 'string', '第一次讀到空清單(此時僅內建之樣式; 不拋)')
            assert.equal(n, 1)
            assert.equal(f(`second ${K2}`), 'second ***', '第二次重讀而辨認')
            assert.equal(f(`third ${K2}`), 'third ***')
            assert.equal(n, 2, '讀到非空清單後留用')
        }
        finally {
            tmp.cleanup()
        }
    })

    it('makeErrText 永不拋(失敗之路徑不再因遮罩而失敗): 派工套件載不入 / 金鑰檔讀不了 / opt 無效 / 第二引數無效 ⇒ 空清單(內建之樣式照遮: Bearer、網址帳密)', () => {
        let tmp = makeTmp('errMaskSitesNf')
        try {
            let envFile = path.join(tmp.dir, '.env')
            fs.writeFileSync(envFile, 'X=1\n')
            let readFails = () => {
                throw new Error('env read failed')
            }
            let bad = [
                { skillsRoot: path.join(tmp.dir, 'none'), envFile },
                { skillsRoot: tmp.dir, envFile, inject: { wda: { providers: [], readEnvFile: readFails } } },
                undefined,
                null,
                'x',
                5,
                { skillsRoot: 5 },
            ]
            for (let o of bad) {
                let f = makeErrText(o)
                let s = f(`auth Authorization: Bearer abcdef0123456789 and https://user:pw123456@host/x ${K2}`)
                assert.ok(!s.includes('abcdef0123456789') && !s.includes('pw123456'), `內建之樣式照遮: ${s}`)
                assert.equal(typeof f('x'), 'string')
                assert.equal(typeof f('x', null), 'string', '第二引數為 null 亦不拋')
            }
        }
        finally {
            tmp.cleanup()
        }
    })
})

//以命令列實跑(合成專案 + 派工套件替身; 不呼叫任何真實之 AI 服務)
let stubSrc = ({ claudeThrows, envThrowsInQuota }) => `
let ENV = { OPENCODE_GO_KEYS: ${JSON.stringify(`${K1},${K2}`)}, OTHER: ${JSON.stringify(OTHER)}, FLAG: '1' }
let LOW = { rolling: { percent: 0, resetsAt: '2026-01-01T05:00:00.000Z' }, weekly: { percent: 10, resetsAt: '2026-01-05T00:00:00.000Z' } }
module.exports = {
    providers: [
        { id: 'ocgo:opencode-go/deepseek-v4.1-flash', kind: 'opencode', provider: 'opencode-go', model: 'opencode-go/deepseek-v4.1-flash', envVar: 'OPENCODE_GO_KEYS' },
        { id: 'oc:opencode/deepseek-v4.1-flash-free', kind: 'opencode', provider: 'opencode', model: 'opencode/deepseek-v4.1-flash-free' },
    ],
    readEnvFile: () => {
        if (${envThrowsInQuota} && /checkQuota/.test(new Error().stack)) {
            throw new Error('env read failed near ' + ${JSON.stringify(K2)} + ' and ' + ${JSON.stringify(K1)})
        }
        return ENV
    },
    opencodeGoUsage: async () => ({ ok: true, limited: false, usage: LOW }),
    getQuotaClaude: async () => {
        if (${claudeThrows}) {
            throw new Error('claude usage failed: token ' + ${JSON.stringify(K2)} + ' then ' + ${JSON.stringify(K1)})
        }
        return { ok: true, windows: [] }
    },
    dispatchOpencode: async () => ({ ok: false, error: 'stub' }),
    dispatchClaude: async () => ({ ok: false, error: 'stub' }),
}
`
let walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : [])

describe('命令列之輸出經遮罩(tools/quota.mjs、g_rsi.mjs --mode round;排程第 655 項 ②)', function () {
    this.timeout(300000)
    let t
    let n = 0
    before(() => {
        t = makeTmp('errMaskCli')
    })
    after(() => {
        t.cleanup()
    })
    let mk = (opt) => {
        let p = makeSynthProject(t.dir, `p${n++}`)
        fs.writeFileSync(path.join(p.root, 'skills', 'node_modules', 'w-dispatch-ai', 'index.cjs'), stubSrc(opt), 'utf8')
        return p
    }

    it('tools/quota.mjs --all: 各角色之 note(claude 查詢失敗)與「Claude 訂閱之全部視窗」之查詢失敗皆不含金鑰(修前: 原樣印出)', () => {
        let { root } = mk({ claudeThrows: true, envThrowsInQuota: false })
        let r = runEntry(root, ['src', 'tools', 'quota.mjs'], ['--all'])
        let text = `${r.out.join('\n')}\n${r.err}`
        assert.equal(r.status, 0, text.slice(0, 400))
        assert.ok(!text.includes(K1) && !text.includes(K2) && !text.includes(OTHER), `輸出不含金鑰: ${text.slice(0, 600)}`)
        let dream = r.out.find((l) => l.startsWith('dream('))
        assert.ok(dream && dream.includes(`${NOTE_HEAD}claude usage failed: token *** then ***`), `dream 之 note: ${dream}`)
        let all = r.out.find((l) => l.startsWith('Claude 訂閱之全部視窗: 查詢失敗('))
        assert.equal(all, 'Claude 訂閱之全部視窗: 查詢失敗(claude usage failed: token *** then ***)')
    })

    it('g_rsi.mjs --mode round: 額度查詢拋錯之印出、輪次失敗之事件 run-failed、狀態檔與日誌皆不含金鑰; 狀態根之全部檔不含金鑰(修前: 事件、狀態檔、日誌原樣記入)', () => {
        let { root } = mk({ claudeThrows: false, envThrowsInQuota: true })
        //策略檔載入時拋錯, 訊息含兩把金鑰 ⇒ 探索拋錯 ⇒ 輪次失敗(事件 run-failed、離開碼 1)
        let fpPolicy = path.join(root, 'rsi', 'policies', 'current.mjs')
        assert.ok(fs.existsSync(fpPolicy), '前提: 策略檔存在')
        fs.writeFileSync(fpPolicy, `throw new Error('policy load failed near ${K2} and ${K1}\\nsecond line ${OTHER}')\n`, 'utf8')
        let r = runEntry(root, ['src', 'cli', 'rsi.mjs'], ['--mode', 'round'])
        let text = `${r.out.join('\n')}\n${r.err}`
        assert.equal(r.status, 1, text.slice(0, 800))
        assert.ok(!text.includes(K1) && !text.includes(K2) && !text.includes(OTHER), `標準輸出與標準錯誤不含金鑰: ${text.slice(0, 800)}`)
        assert.ok(r.out.includes('額度查詢失敗(不擋): env read failed near *** and ***'), `額度查詢拋錯之印出: ${r.out.slice(0, 6).join(' | ')}`)
        let evs = fs.readFileSync(path.join(root, 'rsi', 'logs', 'events.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
        let failed = evs.find((e) => e.event === 'run-failed')
        assert.ok(failed, `事件: ${evs.map((e) => e.event).join(',')}`)
        //策略檔載入之錯誤由領域加前綴「<檔名> 載入失敗:」; 只取第一列(第二列之 OTHER 不入)
        assert.equal(failed.error, 'current.mjs 載入失敗:policy load failed near *** and ***', 'run-failed 之 error: 先遮、再取第一列')
        //(策略檔 current.mjs 為本案自寫之輸入、其內容即含金鑰,不計)
        let leaked = walk(path.join(root, 'rsi')).filter((fp) => fp !== fpPolicy).filter((fp) => {
            let s = fs.readFileSync(fp, 'utf8')
            return s.includes(K1) || s.includes(K2) || s.includes(OTHER)
        }).map((fp) => path.relative(root, fp))
        assert.deepEqual(leaked, [], '狀態根之檔(狀態檔、日誌、事件)皆不含金鑰')
        //狀態檔與日誌確有記錄失敗(被遮罩而非未寫: 否則上一斷言無鑑別力)
        let logged = walk(path.join(root, 'rsi', 'logs')).some((fp) => /輪次失敗: .*policy load failed near \*\*\* and \*\*\*/s.test(fs.readFileSync(fp, 'utf8')))
        assert.ok(logged, '日誌記有遮罩後之輪次失敗')
        let st = walk(path.join(root, 'rsi')).filter((fp) => /status/i.test(path.basename(fp)))
        assert.ok(st.some((fp) => /policy load failed near \*\*\* and \*\*\*/.test(fs.readFileSync(fp, 'utf8'))), `狀態檔記有遮罩後之 error: ${st.map((x) => path.basename(x)).join(',')}`)
    })
})

describe('遮罩函數只一處定義、新增未遮之 .message 輸出即紅(原始碼盤點;排程第 655 項 ②)', function () {
    this.timeout(60000)
    let read = (...p) => fs.readFileSync(path.join(FD_ROOT, ...p), 'utf8')
    let walk2 = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk2(path.join(d, e.name)) : [path.join(d, e.name)]))
    //盤點之範圍 = 金鑰所經之三個檔(派工器與額度查詢; 命令列之額度與輪次之輸出): 其 .message 之輸出須已遮或列於允許表(附理由)
    //  不在此三檔之 err.message 輸出(領域之計算、評估器之錯誤訊息等)不在金鑰之資料路徑上(金鑰只由派工器與額度查詢讀取、只傳給派工套件之子行程), 不盤點
    let FILES = {
        'src/arsi/dispatchers.mjs': [
            { has: "error: `派工例外: ${String((err && err.message) || err)}`", why: '併入 r.error 後於記入 errs 之處經 errTextOf(unit-errMask 之派工例外案)' },
        ],
        'src/cli/rsi.mjs': [
            { has: "console.log(`未執行: ${String((err && err.message) || err).split('\\n')[0]}`)", why: 'P.extFill / P.fillPlanOf / P.fill 之錯誤(領域對自有資料之計算; 不經派工器與額度查詢)' },
            { has: 'console.log(`未結案: ${err.message}`)', why: '前緣之結案錯誤(BASE_AMBIGUOUS; 本庫自組之固定文字、不含輸入值)' },
        ],
        'src/tools/quota.mjs': [],
    }
    let COUNT = { 'src/arsi/dispatchers.mjs': { masked: 1, allowed: 1 }, 'src/cli/rsi.mjs': { masked: 5, allowed: 5 }, 'src/tools/quota.mjs': { masked: 1, allowed: 0 } }

    for (let [rel, allow] of Object.entries(FILES)) {
        it(`${rel}: 每一處錯誤文字之取得(.message、.stack、String(err)、\${err})皆經 errText / errTextOf 或列於允許表(附理由); 允許表無失效之項; 已遮 ${COUNT[rel].masked} 處、允許 ${COUNT[rel].allowed} 處`, () => {
            let src = read(...rel.split('/'))
            let un = unmaskedOf(src, allow)
            assert.deepEqual(un.map((s) => `${s.n}: ${s.t.slice(0, 120)}`), [], '未遮且不在允許表之錯誤文字輸出(新增者須經 errText / errTextOf, 或於本表附理由)')
            assert.deepEqual(staleAllowOf(src, allow).map((a) => a.has), [], '允許表之項已對不到原始碼(改動後失效者須更新)')
            let sites = messageSitesOf(src)
            assert.equal(sites.filter((s) => s.masked).length, COUNT[rel].masked, '已遮之處數')
            assert.equal(sites.filter((s) => !s.masked).length, COUNT[rel].allowed, '允許之處數')
        })
    }

    it('g_rsi.mjs 之 run-failed 事件(補做夢失敗、輪次失敗各一處)之 error 欄皆經 errText(補做夢失敗者之 hk.errors 另有來源: 領域之回傳,見下之已知); errText 於 g_rsi.mjs 與 tools/quota.mjs 皆賦值自 makeErrText', () => {
        let lines = read('src', 'cli', 'rsi.mjs').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
        let failed = lines.filter((l) => /event: 'run-failed'/.test(l))
        assert.equal(failed.length, 2, 'run-failed 事件之寫入處')
        for (let l of failed) {
            assert.ok(/error: errText\(/.test(l), `error 欄經 errText: ${l.trim().slice(0, 120)}`)
        }
        for (let rel of [['src', 'cli', 'rsi.mjs'], ['src', 'tools', 'quota.mjs']]) {
            let src = read(...rel)
            assert.equal((src.match(/^\s*let errText = makeErrText\(\{ skillsRoot: st\.dispatch\.skillsRoot, envFile: st\.dispatch\.envFile \}\)$/gm) || []).length, 1, `${rel.join('/')}: errText 賦值自 makeErrText(同一組 skillsRoot 與 envFile)`)
            assert.equal((src.match(/\blet errText\b/g) || []).length, 1, `${rel.join('/')}: errText 只一處定義`)
        }
    })

    it('遮罩函數只一處定義: src 內 maskDiagText 之呼叫只有 dispatchers.mjs 之 errTextOf 一處; errTextOf 之定義全 src 只一處; makeErrText 之呼叫只在 g_rsi.mjs 與 tools/quota.mjs', () => {
        let files = walk2(path.join(FD_ROOT, 'src')).filter((fp) => fp.endsWith('.mjs'))
        let code = (fp) => fs.readFileSync(fp, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n')
        let calls = files.map((fp) => [path.relative(FD_ROOT, fp).replace(/\\/g, '/'), (code(fp).match(/\bmaskDiagText\(/g) || []).length]).filter((x) => x[1] > 0)
        assert.deepEqual(calls, [['src/arsi/dispatchers.mjs', 1]])
        let defs = files.map((fp) => [path.relative(FD_ROOT, fp).replace(/\\/g, '/'), (code(fp).match(/\blet errTextOf = /g) || []).length]).filter((x) => x[1] > 0)
        assert.deepEqual(defs, [['src/arsi/dispatchers.mjs', 1]])
        let mk = files.map((fp) => [path.relative(FD_ROOT, fp).replace(/\\/g, '/'), (code(fp).match(/\bmakeErrText\(/g) || []).length]).filter((x) => x[1] > 0)
        assert.deepEqual(mk, [['src/cli/rsi.mjs', 1], ['src/tools/quota.mjs', 1]], 'makeErrText 之呼叫端 g_rsi.mjs 與 tools/quota.mjs 各一處(定義於 dispatchers.mjs)')
        //秘密清單之組法(金鑰變數 = OPENCODE_GO_KEYS 與條目表之 envVar)只在 secretsOfWda 一處: makeDispatch、checkQuota、makeErrText 皆經之
        let d = code(path.join(FD_ROOT, 'src', 'arsi', 'dispatchers.mjs'))
        assert.equal((d.match(/\bsecretsOf\(/g) || []).length, 1, 'secretsOf 只在 secretsOfWda 內被呼叫一次')
        assert.equal((d.match(/\bsecretsOfWda\(/g) || []).length, 3, 'secretsOfWda 之呼叫: makeDispatch、checkQuota、makeErrText 各一處')
    })

    it('盤點器自身之鑑別力(合成原始碼): 新增未遮之輸出、遮罩括號外之 .message、註解內之寫法', () => {
        let ok = ['console.log(errText(String((err && err.message) || err), { max: 160 }))', 'row.note = errTextOf(err.message, secrets, { max: 120 })', 'P.setStatus({ error: errText(String((err && err.stack) || err), { max: 2000 }) })']
        for (let s of ok) {
            assert.equal(messageSitesOf(s).length, 1)
            assert.equal(messageSitesOf(s)[0].masked, true, s)
        }
        let bad = [
            'console.log(err.message)',
            'console.log(`x ${String((err && err.message) || err)}`)',
            'console.log(errText(x) + err.message)', //遮罩之括號外
            'console.log(errText(err.message), err.message)', //其中一個在括號外
            'ev({ error: String(err.message).slice(0, 300) })',
            'P.log(`輪次失敗: ${String((err && err.stack) || err)}`)', //堆疊亦是錯誤文字(首列即訊息)
            'console.log(String(err))',
            'console.log(`failed: ${err}`)',
        ]
        for (let s of bad) {
            assert.equal(unmaskedOf(s).length, 1, s)
        }
        //整列之註解不計
        assert.equal(messageSitesOf('    //console.log(err.message)\n    /* err.message */\n * err.message').length, 0)
        //允許表: 所列之字出現於該列者放行; 對不到者列為失效
        let src = 'console.log(`未結案: ${err.message}`)'
        assert.equal(unmaskedOf(src, [{ has: '未結案', why: 'x' }]).length, 0)
        assert.deepEqual(staleAllowOf(src, [{ has: '未結案', why: 'x' }, { has: '不存在', why: 'y' }]).map((a) => a.has), ['不存在'])
    })
})
