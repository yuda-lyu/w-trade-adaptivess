import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { makeDispatch } from '../src/arsi/dispatchers.mjs'
import { FD_ROOT, makeTmp } from './tools/synthLedger.mjs'
import { K1, K2, leaksOf } from './tools/errMaskKit.mjs'


//派工結果之 error 欄之遮罩(R-RUN-8 ⑧; 排程第 622 項 ⓪): 派工套件取 stderr 尾段為 error、只遮當次所用之金鑰;
//  金鑰檔所列之其他金鑰若出現於該尾段,原樣寫入節點文件與事件 ⇒ 本庫另以自己之秘密清單(secretsOf)遮一次,先遮再截(截斷不得切開金鑰而漏遮)
//  規格之句 ⇒ 案:
//    ① 「金鑰檔含兩把、當次用第一把、stderr 尾段含第二把 ⇒ 結果之 error 與 tried[].error 皆不含任何一把」(主模型、備援、claude、派工例外各一路徑)
//    ② 「先遮再截」= 金鑰跨 300 字元之截斷邊界(起點自 270 至 305)時結果仍不含該金鑰之任何 6 字元以上之前段(截斷先於遮罩者留下前段)
//    ③ 「其餘不變」= 無秘密之錯誤文字原樣(至多 300 字元)、成功之結果 error 為 null、鏈上之串接格式不變、quota 之判定不受影響
//  修前(tadm9 之工作樹): `String(r.error || '').slice(0, 300)`,不經本庫之秘密清單
let LOW = {
    rolling: { percent: 0, resetsAt: '2026-01-01T05:00:00.000Z' },
    weekly: { percent: 10, resetsAt: '2026-01-05T00:00:00.000Z' },
}
//派工套件之替身: 模擬真實之派工套件 —— 只遮「當次所用之金鑰」(opts.key)、其餘照留; 錯誤文字(stderr 尾段)由 tail(opts) 給
//  readEnvFile 回兩把金鑰(OPENCODE_GO_KEYS)與一個用途不明之長值(OTHER_TOKEN_VALUE)
let fakeWda = ({ tail, claudeError = null, throws = null }) => {
    let used = []
    let wda = {
        used,
        providers: [
            { id: 'ocgo:opencode-go/m', kind: 'opencode', provider: 'opencode-go', model: 'opencode-go/m', envVar: 'OPENCODE_GO_KEYS' },
            { id: 'oc:opencode/m-free', kind: 'opencode', provider: 'opencode', model: 'opencode/m-free' },
        ],
        readEnvFile: () => ({ OPENCODE_GO_KEYS: `${K1},${K2}`, OTHER: 'OTHER_TOKEN_VALUE', FLAG: '1' }),
        opencodeGoUsage: async ({ key }) => ({ ok: true, limited: false, usage: LOW, key }),
        getQuotaClaude: async () => ({ ok: true, windows: [] }),
        dispatchOpencode: async (prompt, opts) => {
            used.push(opts.key || null)
            if (throws) {
                throw new Error(throws(opts))
            }
            //真實之派工套件: error 取 stderr 尾段, 其中當次所用之金鑰已被遮成 ***(其他金鑰照留)
            let text = tail(opts)
            if (opts.key) {
                text = text.split(opts.key).join('***')
            }
            return { ok: false, errorType: 'error', error: text, stdout: '', durationMs: 1 }
        },
        dispatchClaude: async () => ({ ok: false, errorType: 'error', error: claudeError, stdout: '', durationMs: 1 }),
    }
    return wda
}
let FREE = { kind: 'opencode', id: 'oc:opencode/m-free' }
let MAIN = { kind: 'opencode', id: 'ocgo:opencode-go/m', timeoutMin: 1 }

describe('派工:結果之 error 欄經本庫之秘密清單遮罩(R-RUN-8 ⑧;排程第 622 項 ⓪)', function () {
    this.timeout(60000)
    let t
    let envFile
    let logFile
    beforeEach(() => {
        t = makeTmp('errMask')
        envFile = path.join(t.dir, '.env')
        fs.writeFileSync(envFile, 'X=1\n')
        logFile = path.join(t.dir, 'w', 'agent_a1.log')
    })
    afterEach(() => {
        t.cleanup()
    })
    let run = async (agents, wda, role = 'node') => makeDispatch({ agents, skillsRoot: t.dir, envFile, cwd: t.dir, inject: { wda } })(role, { prompt: 'p', tag: 'r001_n_a1', logFile })

    it('金鑰檔含兩把、當次用第一把、stderr 尾段含第二把 ⇒ 結果之 error 與 tried[].error 皆不含任何一把(修前: 第二把原樣留下)', async () => {
        let wda = fakeWda({ tail: (o) => `ERROR provider rejected key ${K1} and fallback ${K2} at upstream` })
        let r = await run({ node: MAIN }, wda)
        assert.deepEqual(wda.used, [K1], '前提: 當次用第一把金鑰(派工套件之替身只遮該把)')
        assert.equal(r.ok, false)
        assert.ok(r.error.includes('provider rejected key') && r.error.includes('upstream'), `其餘文字原樣: ${r.error}`)
        assert.ok(!r.error.includes(K1) && !r.error.includes(K2), `結果之 error 不含金鑰: ${r.error}`)
        assert.equal(r.tried.length, 1)
        assert.ok(!r.tried[0].error.includes(K1) && !r.tried[0].error.includes(K2), `tried[].error 不含金鑰: ${r.tried[0].error}`)
        assert.equal(r.tried[0].error, `error ERROR provider rejected key *** and fallback *** at upstream`, '當次之金鑰由派工套件遮、另一把由本庫遮; 其餘逐字')
    })

    it('金鑰檔內用途不明之長值(其他變數)亦在秘密清單 ⇒ 出現於尾段者遮; 短值(旗標)不遮', async () => {
        let wda = fakeWda({ tail: () => 'boom OTHER_TOKEN_VALUE and flag 1 end' })
        let r = await run({ node: MAIN }, wda)
        assert.equal(r.tried[0].error, 'error boom *** and flag 1 end')
    })

    it('先遮再截: 第二把金鑰跨 300 字元之截斷邊界(起點 270 ~ 305,每一格)⇒ 結果不含該金鑰之任何 6 字元以上之前段 / 後段; 長度不超過 300; 修前於跨界者留下前段', async () => {
        let overs = []
        let nCross = 0
        for (let start = 270; start <= 305; start++) {
            //錯誤之全文 = 「error 」(派工器所接之前綴 6 字元 `error `)+ 填充 + K2 + 尾; 使 K2 之起點落在全文之第 start 個字元
            let pad = 'x'.repeat(start - 'error '.length)
            let wda = fakeWda({ tail: () => `${pad}${K2}TAIL${'y'.repeat(40)}` })
            let r = await run({ node: MAIN }, wda)
            let e = r.tried[0].error
            assert.ok(e.length <= 300, `起點 ${start}: 長度 ${e.length}`)
            assert.deepEqual(leaksOf(e), [], `起點 ${start}: 金鑰之前段或後段殘留於「…${e.slice(-40)}」`)
            assert.ok(!r.error.includes(K2) && leaksOf(r.error).length === 0, `起點 ${start}: 結果之 error`)
            if (start < 300 && start + K2.length > 300) {
                nCross++
                overs.push(start)
            }
        }
        assert.ok(nCross >= 15, `前提: 跨界之起點有 ${nCross} 個(須涵蓋整段 280 ~ 299)`)
        assert.deepEqual([overs[0], overs[overs.length - 1]], [280, 299])
    })

    it('先遮再截: 遮罩後文字短於 300 者不再截斷(金鑰縮成 *** 後,原本在 300 之外之文字進入窗內)', async () => {
        //全文 = 6(前綴)+ 285 個 x + K2(21)+ 'END_MARK_OK'(11)= 323 字元; 遮罩後 = 6 + 285 + 3 + 11 = 305 ⇒ 截至 300(尾端 'END_MA')
        //  若先截再遮: 前 300 字元 = 前綴 + 285 個 x + K2 之前 9 字元 ⇒ 不被辨認而留下 'oc_sk_TES'
        let wda = fakeWda({ tail: () => `${'x'.repeat(285)}${K2}END_MARK_OK` })
        let r = await run({ node: MAIN }, wda)
        let e = r.tried[0].error
        assert.equal(e.length, 300)
        assert.ok(e.endsWith('x***END_MA'), `遮罩在先、截斷在後: …${e.slice(-12)}`)
        assert.ok(!e.includes('oc_sk_'), '金鑰之前段不留')
    })

    it('備援鏈: 主模型與備援各失敗而文字含另一把金鑰 ⇒ 兩條 tried 與串接後之 error 皆不含金鑰; 串接格式「<模型>: <文字> | <模型>: <文字>」不變', async () => {
        let wda = fakeWda({ tail: (o) => `provider says ${K2} is bad (${o.model})` })
        let r = await run({ node: { ...MAIN, fallback: [FREE] } }, wda)
        assert.equal(r.tried.length, 2)
        for (let x of r.tried) {
            assert.ok(!x.error.includes(K1) && !x.error.includes(K2), x.error)
        }
        assert.equal(r.error, 'ocgo:opencode-go/m: error provider says *** is bad (opencode-go/m) | oc:opencode/m-free: error provider says *** is bad (opencode/m-free)')
        assert.deepEqual(wda.used, [K1, null], '前提: 主模型用第一把金鑰、備援(免費池)無金鑰')
    })

    it('claude 條目之失敗文字、派工例外之文字(含 stderr 尾段之金鑰)亦遮', async () => {
        let wC = fakeWda({ tail: () => '', claudeError: `claude failed with token ${K1} and ${K2}` })
        let rC = await run({ node: { kind: 'claude', model: 'm', timeoutMin: 1 } }, wC)
        assert.equal(rC.ok, false)
        assert.equal(rC.tried[0].error, 'error claude failed with token *** and ***')
        let wE = fakeWda({ tail: () => '', throws: (o) => `spawn failed near ${K2} (${o.model})` })
        let rE = await run({ node: MAIN }, wE)
        assert.equal(rE.tried[0].error, '派工例外: spawn failed near *** (opencode-go/m)')
        assert.ok(!rE.error.includes(K2))
    })

    it('其餘不變: 無秘密之文字原樣(至多 300 字元)、空 / 未給之 error 為空字串、成功之結果 error 為 null、額度之判定不受影響', async () => {
        let plain = `plain upstream message ${'z'.repeat(400)}`
        let wda = fakeWda({ tail: () => plain })
        let r = await run({ node: MAIN }, wda)
        assert.equal(r.tried[0].error, `error ${plain}`.slice(0, 300))
        assert.equal(r.tried[0].error.length, 300)
        let wN = fakeWda({ tail: () => '' })
        let rN = await run({ node: MAIN }, wN)
        assert.equal(rN.tried[0].error, 'error', '空之尾段 ⇒ 只有 errorType')
        //成功: error 為 null、不經遮罩
        let wOk = fakeWda({ tail: () => '' })
        wOk.dispatchOpencode = async () => ({ ok: true, stdout: 'done', durationMs: 1 })
        let rOk = await run({ node: MAIN }, wOk)
        assert.equal(rOk.ok, true)
        assert.equal(rOk.error, null)
        assert.deepEqual(rOk.tried, [])
        //額度: errorType 'quota' ⇒ quota: true(不受遮罩影響)
        let wQ = fakeWda({ tail: () => `quota exhausted ${K2}` })
        let base = wQ.dispatchOpencode
        wQ.dispatchOpencode = async (p, o) => ({ ...(await base(p, o)), errorType: 'quota' })
        let rQ = await run({ node: MAIN }, wQ)
        assert.equal(rQ.quota, true)
        assert.equal(rQ.tried[0].quota, true)
        assert.ok(!rQ.error.includes(K2))
    })

    it('結構: 記入 errs 之處經 errTextOf(模組之單一定義; 排程第 655 項 ② 自 makeDispatch 之區域函數改為模組層級,與額度查詢等同源輸出共用);先遮(maskDiagText)再截(.slice);src 內不再有「先截再遮」之寫法', () => {
        let src = fs.readFileSync(path.join(FD_ROOT, 'src', 'arsi', 'dispatchers.mjs'), 'utf8')
        assert.equal((src.match(/errs\.push\(/g) || []).length, 1, '記入 errs 之處只有一處')
        assert.ok(/errs\.push\(\{ model: info\.model, error: errTextOf\(r\.error, secrets\)/.test(src))
        assert.ok(/let errTextOf = \(e, secrets, opt\) => \{\s*let \{ max = 300, firstLine = false \} = isPlain\(opt\) \? opt : \{\}\s*let s = maskDiagText\(String\(e \|\| ''\), secrets\)\s*return \(firstLine \? s\.split\('\\n'\)\[0\] : s\)\.slice\(0, max\)/.test(src), '先遮(maskDiagText)再截(.slice)')
        assert.ok(!/String\(r\.error \|\| ''\)\.slice\(0, 300\)/.test(src), '舊寫法(先截,不遮)不再出現')
    })
})
