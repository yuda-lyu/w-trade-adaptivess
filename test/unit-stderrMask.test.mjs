import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import maskDiagText from 'wsemi/src/maskDiagText.mjs'
import { makeDispatch } from '../src/arsi/dispatchers.mjs'
import { FD_ROOT, makeTmp } from './tools/synthLedger.mjs'


//派工之 opencode 條目之錯誤輸出之留存改用 wsemi 之串流遮罩器(genDiagStreamMasker; 排程第 486 項之使用端; 診斷輸出與遮罩規格 §2; R-RUN-8 ⑥)
//  規格之句 ⇒ 案:
//    ① 「跨塊之秘密不被切開;每列之輸出 = maskDiagText(該列);輸出與切塊無關」= 逐字(1 字元一塊)、二分、全塊之切法所得之檔逐位相同,且等於逐列 maskDiagText 之串接(含引號值跨列者)
//    ② 「網址帳密、憑證鍵值對、Bearer 一併遮;長列分段時切點避開整段命中」= user:pass@ 之各形(含長列且切點恰落在帳密內)、超長之 token= 值(整列其餘 ***,不留明文)
//    ③ 「結尾無換行之一段於 flush 交出」「有輸出時才建檔、標頭只寫一次」「寫檔失敗不拋」
//    ④ 「二進位塊以 UTF-8 串流解碼(多位元組字元跨塊不變 U+FFFD);不可檢查之塊 fail-closed 為 ***、不執行其 toString」
//  修前(tadm8 之工作樹): 自寫之 makeStderrSink(STDERR_PIECE、safeCut、RE_CRED): 逐塊 String(chunk) 與整批完整列合成一塊遮、切點只避秘密與 RE_CRED、無 user:pass@ 之切點判定、長 token 值明文輸出
let K1 = 'oc_sk_TESTKEY00000001'
let K2 = 'oc_sk_TESTKEY00000002'
let HOT = {
    rolling: { percent: 0, resetsAt: '2026-01-01T05:00:00.000Z' },
    weekly: { percent: 96, resetsAt: '2026-01-05T00:00:00.000Z' },
    monthly: { percent: 80, resetsAt: '2026-02-01T00:00:00.000Z' },
}
//派工套件之替身(只供 opencode 之備援條目): 逐塊送給 onStderr; 主模型(訂閱)之用量達門檻 ⇒ 走備援(免費)條目
let fakeWda = (chunks, opt = {}) => ({
    providers: [
        { id: 'ocgo:opencode-go/m', kind: 'opencode', provider: 'opencode-go', model: 'opencode-go/m', envVar: 'OPENCODE_GO_KEYS' },
        { id: 'oc:opencode/m-free', kind: 'opencode', provider: 'opencode', model: 'opencode/m-free' },
    ],
    readEnvFile: () => ({ OPENCODE_GO_KEYS: `${K1},${K2}`, OTHER: 'short', FLAG: '1' }),
    opencodeGoUsage: async () => ({ ok: true, limited: false, usage: HOT }),
    getQuotaClaude: async () => ({ ok: true, windows: [] }),
    dispatchOpencode: async (prompt, opts) => {
        if (opts.model === 'opencode/m-free' && typeof opts.onStderr === 'function') {
            for (let c of chunks) {
                opts.onStderr(c)
            }
        }
        if (opt.throwAfter === true && opts.model === 'opencode/m-free') {
            throw new Error('boom')
        }
        return { ok: false, errorType: 'quota', error: 'x', stdout: '', durationMs: 1 }
    },
    dispatchClaude: async () => ({ ok: true, stdout: 'ok', durationMs: 1 }),
})
let FREE = { kind: 'opencode', id: 'oc:opencode/m-free', variant: 'high' }
let agents = { node: { kind: 'opencode', id: 'ocgo:opencode-go/m', variant: 'high', timeoutMin: 1, fallback: [FREE] } }
//切塊: 每塊 n 字元(字串)
let cut = (s, n) => {
    let a = []
    for (let i = 0; i < s.length; i += n) {
        a.push(s.slice(i, i + n))
    }
    return a
}

describe('派工:錯誤輸出之串流遮罩(wsemi genDiagStreamMasker;第 486 項之使用端)', function () {
    this.timeout(240000)
    let t
    let envFile
    let logFile
    let fpErr
    let HEAD = /^\n===== \S+ stderr oc:opencode\/m-free =====\n/
    beforeEach(() => {
        t = makeTmp('stderrMask')
        envFile = path.join(t.dir, '.env')
        fs.writeFileSync(envFile, 'X=1\n')
        logFile = path.join(t.dir, 'w', 'agent_a1.log')
        fpErr = path.join(t.dir, 'w', 'agent_a1.stderr.log')
    })
    afterEach(() => {
        t.cleanup()
    })
    //跑一次派工並回留存檔之內容(不含標頭; 無檔回 null)
    let run = async (chunks) => {
        fs.rmSync(fpErr, { force: true })
        await makeDispatch({ agents, skillsRoot: t.dir, envFile, cwd: t.dir, inject: { wda: fakeWda(chunks) } })('node', { prompt: 'p', tag: 'r001_n_a1', logFile })
        if (!fs.existsSync(fpErr)) {
            return null
        }
        let s = fs.readFileSync(fpErr, 'utf8')
        assert.ok(HEAD.test(s), `標頭: ${s.slice(0, 80)}`)
        return s.replace(HEAD, '')
    }
    //期望: 逐列 maskDiagText 之串接(秘密 = 本次讀到之金鑰)
    let wantOf = (text) => text.split(/(?<=\n)/).map((l) => maskDiagText(l, [K1, K2])).join('')

    it('輸出與切塊無關且每列 = maskDiagText(該列):逐字、2、3、7、50 字元一塊與全塊所得之檔逐位相同(含秘密被切在塊間、引號值跨列、Bearer、user:pass@)', async () => {
        let text = [
            ' > build · m-free',
            `level=ERROR message="auth failed" apiKey=${K1} detail="x"`,
            `retry with ${K2} later`,
            'Authorization: Bearer TOPSECRETTOKEN',
            'connect https://svc:hunter2pw@host.example/x failed',
            'cfg={"token":"aaa',
            'bbb","k":1}',
            'plain line mentioning short and 1 stays',
            '',
        ].join('\n')
        let want = wantOf(text)
        assert.ok(!want.includes(K1) && !want.includes(K2) && !want.includes('TOPSECRETTOKEN') && !want.includes('hunter2pw'), '期望本身已遮罩')
        assert.ok(want.includes('plain line mentioning short and 1 stays\n') && want.includes('auth failed'), '未登錄之短值之列原樣')
        let sizes = [1, 2, 3, 7, 50, text.length]
        let outs = []
        for (let n of sizes) {
            outs.push(await run(cut(text, n)))
        }
        for (let i = 0; i < sizes.length; i++) {
            assert.equal(outs[i], want, `每塊 ${sizes[i]} 字元`)
        }
        assert.equal(new Set(outs).size, 1, '各切法逐位相同')
    })

    it('user:pass@ 之各形皆遮;長列(> 20000 字元)分段之切點恰落在帳密內者,帳密整段遮到(切點避開整段命中,不只避秘密與鍵值樣式)', async () => {
        let s1 = await run(['connect https://svc:hunter2pw@host.example/x failed\n'])
        assert.ok(s1 !== null && !s1.includes('hunter2pw') && s1.includes('connect ') && s1.includes('host.example/x failed\n'), s1)
        //長列: 前段無空白,帳密恰跨第 16000 字元; 後接長尾使整列逾 20000 字元(強制分段)
        let url = 'https://svc:SECRETPW99@host.example'
        let line = `${'x'.repeat(15990)}${url} ${'y'.repeat(30000)}\n`
        let s2 = await run(cut(line, 4096))
        assert.ok(s2 !== null)
        assert.ok(!s2.includes('SECR') && !s2.includes('ETPW99') && !s2.includes('PW99'), `帳密不得有任何片段殘留: ${s2.slice(15960, 16060)}`)
        assert.ok(s2.startsWith('x'.repeat(15990)) && s2.endsWith(' ' + 'y'.repeat(30000) + '\n'), '前後內容未遺失')
        assert.ok(s2.includes('https://***@host.example '), '帳密段以 *** 取代、其餘照留')
        //切法不同(每塊 997 字元、全塊)結果相同
        assert.equal(await run(cut(line, 997)), s2)
        assert.equal(await run([line]), s2)
        //網址之主機部分無分隔而延伸至超長(帳密之 @ 可能在窗外): fail-closed ⇒ 該列其餘以 *** 取代,不留任何片段;換行保留
        let line3 = `${'x'.repeat(15990)}${url}${'y'.repeat(30000)}\nafter\n`
        let s3 = await run(cut(line3, 4096))
        assert.ok(s3 !== null && !s3.includes('SECR') && !s3.includes('PW99') && s3.endsWith('\nafter\n') && s3.includes('***'), s3.slice(-60))
    })

    it('超長之憑證值(token= 之值 60000 字元):不得有明文之長段(整列其餘以 *** 取代);其後之列照常輸出;列尾之換行保留', async () => {
        let text = `token=${'A'.repeat(60000)}\nnext line ok\n`
        let s = await run(cut(text, 5000))
        assert.ok(s !== null)
        assert.ok(!/A{200}/.test(s), `不得留明文之長段: ${s.length} 字元,最長 A 連續 ${Math.max(...(s.match(/A+/g) || ['']).map((x) => x.length))}`)
        assert.ok(s.endsWith('\nnext line ok\n'), '其後之列照常')
        assert.ok(s.includes('***'))
    })

    it('結尾無換行之一段於 flush 交出(含被遮者);只有未完成之一列時,收尾前不建檔(有輸出時才建檔); 標頭只寫一次且在第一段內容之前', async () => {
        let s = await run([`tail ${K2} no newline`])
        assert.equal(s, 'tail *** no newline')
        //多列輸出: 標頭恰一個
        fs.rmSync(fpErr, { force: true })
        await makeDispatch({ agents, skillsRoot: t.dir, envFile, cwd: t.dir, inject: { wda: fakeWda(['a1\n', 'a2\n', 'a3 no newline']) } })('node', { prompt: 'p', tag: 'r001_n_a1', logFile })
        let raw = fs.readFileSync(fpErr, 'utf8')
        assert.equal(raw.split('stderr oc:opencode/m-free').length - 1, 1, '標頭恰一次')
        assert.ok(raw.endsWith('=====\na1\na2\na3 no newline'), raw)
        //空輸出(空字串之塊、只有 undefined / null) ⇒ 不建檔
        assert.equal(await run(['', '', undefined, null]), null)
        assert.equal(await run([]), null)
    })

    it('二進位塊(Buffer)以 UTF-8 串流解碼:多位元組字元被切在兩塊之間亦正確(原: String(chunk) 使之變 U+FFFD);秘密被切在兩塊之間亦遮', async () => {
        let b = Buffer.from(`錯誤中文 level=ERROR key=${K1} 結束\n`, 'utf8')
        let chunks = []
        for (let i = 0; i < b.length; i += 2) {
            chunks.push(b.subarray(i, i + 2))
        }
        let s = await run(chunks)
        assert.ok(s !== null && s.includes('錯誤中文') && s.includes('結束\n') && !s.includes('�'), s)
        assert.ok(!s.includes(K1), '秘密已遮')
        assert.equal(s, wantOf(b.toString('utf8')))
    })

    it('不可檢查之塊(一般物件、函數、Symbol)fail-closed 為 ***、不執行其 toString;數字與布林以字串轉換;undefined 與 null 視為空', async () => {
        let n = 0
        let evil = {
            toString() {
                n++
                return `leak ${K1}`
            },
        }
        let s = await run(['a\n', evil, '\n', 12, true, '\n', undefined, null, 'z\n'])
        assert.ok(s !== null)
        assert.equal(n, 0, '不執行其 toString')
        assert.ok(!s.includes('leak') && !s.includes(K1))
        assert.ok(s.includes('***'), '以 *** 取代')
        assert.ok(s.includes('12true'), s)
        assert.ok(s.endsWith('z\n'))
    })

    it('派工拋錯(子行程結束前之例外)之路徑:無換行之尾段與遮罩器內尚未交出之餘文於 finally 交出(遮罩後寫入),不遺失、不明文', async () => {
        //替身於送完 stderr 後拋錯 ⇒ makeDispatch 之結果依其既有之處置(本案不斷言其結果之形狀), 留存檔須含遮罩後之全部輸出
        let chunks = [`head line\n`, `tail ${K2} no newline`, ` and cfg ${'x'.repeat(30)} Bearer RAWTOKEN123`]
        fs.rmSync(fpErr, { force: true })
        try {
            await makeDispatch({ agents, skillsRoot: t.dir, envFile, cwd: t.dir, inject: { wda: fakeWda(chunks, { throwAfter: true }) } })('node', { prompt: 'p', tag: 'r001_n_a1', logFile })
        }
        catch (err) {}
        assert.ok(fs.existsSync(fpErr), '拋錯後仍建檔並寫入')
        let s = fs.readFileSync(fpErr, 'utf8').replace(HEAD, '')
        assert.equal(s, wantOf(chunks.join('')), '全部輸出(含無換行之尾段)遮罩後寫入')
        assert.ok(s.startsWith('head line\ntail *** no newline'), s)
        assert.ok(!s.includes(K2) && !s.includes('RAWTOKEN123'), '無明文')
    })

    it('已知限制(wsemi 之串流遮罩器之 JSDoc):未登錄之憑證值為引號內含換行者,輸出 = 逐列 maskDiagText(第二列起不被視為憑證值);已登錄之秘密(含切在塊間者)不受此限 —— wsemi 日後改善時本案轉紅,屆時改為斷言已遮並更新 R-RUN-8', async () => {
        let text = 'cfg={"token":"aaa\nbbb","k":1}\n'
        let s = await run(cut(text, 3))
        assert.equal(s, wantOf(text), '輸出 = 逐列 maskDiagText')
        assert.ok(!s.includes('aaa'), '第一列之憑證值已遮')
        assert.ok(s.includes('bbb'), '已知限制: 第二列之值不被視為憑證值')
        //已登錄之秘密(金鑰檔所列)被切在兩塊之間者仍遮
        let s2 = await run([`before ${K1.slice(0, 7)}`, `${K1.slice(7)} after\n`])
        assert.equal(s2, 'before *** after\n')
    })

    it('寫留存檔失敗(路徑被占用為資料夾)不拋、不改變派工之結果(對照: 修前亦然)', async () => {
        fs.mkdirSync(fpErr, { recursive: true })
        let r = await makeDispatch({ agents, skillsRoot: t.dir, envFile, cwd: t.dir, inject: { wda: fakeWda(['some stderr\n']) } })('node', { prompt: 'p', tag: 'r001_n_a1', logFile })
        assert.equal(r.ok, false)
        assert.equal(r.quota, true)
        fs.rmSync(fpErr, { recursive: true })
    })

    it('原始碼:自寫之切點與憑證樣式已刪(STDERR_PIECE、safeCut、RE_CRED、直接匯入 maskDiagText),改用 genDiagStreamMasker(單一實作;不重複實作遮罩)', () => {
        let src = fs.readFileSync(path.join(FD_ROOT, 'src', 'arsi', 'dispatchers.mjs'), 'utf8')
        assert.ok(/import genDiagStreamMasker from 'wsemi\/src\/genDiagStreamMasker\.mjs'/.test(src))
        assert.ok(/genDiagStreamMasker\(secrets\)/.test(src))
        for (let w of ['STDERR_PIECE', 'safeCut', 'RE_CRED']) {
            assert.ok(!src.includes(w), `不應再有 ${w}`)
        }
        //串流之留存(makeStderrSink)不直接呼叫 maskDiagText(遮罩由串流遮罩器負責); 排程第 622 項 ⓪ 另以 maskDiagText(一次性形式)遮派工結果之 error 欄 ⇒ 全檔之呼叫只有 errTextOf 一處(unit-errMask)
        let code = src.replace(/^\s*\/\/.*$/gm, '')
        let sink = code.slice(code.indexOf('let makeStderrSink'), code.indexOf('let isQuotaFail'))
        assert.ok(sink.includes('genDiagStreamMasker(secrets)') && !/maskDiagText/.test(sink), 'makeStderrSink 不直接用 maskDiagText(遮罩由串流遮罩器負責)')
        assert.equal((code.match(/maskDiagText\(/g) || []).length, 1, 'maskDiagText 之呼叫全檔只有 errTextOf 一處')
    })
})
