import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import maskDiagText from 'wsemi/src/maskDiagText.mjs'
import { makeDispatch, checkQuota } from '../src/arsi/dispatchers.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//額度用盡之處置(Gitea #156; 規則 R-RUN-8): 派工套件以替身注入(inject.wda), 不起真實之子行程
//  契約(派工套件): 因額度而未完成之派工結果為 { ok: false, errorType: 'quota' }(派工套件已於數秒內終止子行程); 本套件只依此欄判定, 不自行偵測錯誤字樣、不終止行程
let K1 = 'oc_sk_TESTKEY00000001'
let K2 = 'oc_sk_TESTKEY00000002'

let RESULTS = {
    ok: { ok: true, stdout: 'done', durationMs: 5 },
    quota: { ok: false, errorType: 'quota', error: 'Exit code 1 [quota]: Free usage limit reached', stdout: '', durationMs: 7 },
    exec: { ok: false, errorType: 'exec', error: 'Exit code 1', stdout: '', durationMs: 5 },
    timeout: { ok: false, errorType: 'timeout', error: 'TIMEOUT after 60s', stdout: '', durationMs: 60000 },
}

//用量:三視窗之百分比與重置時刻(派工套件之 opencodeGoUsage 回 resetsAt)
let usageOf = (rolling, weekly, monthly) => ({
    rolling: { percent: rolling, resetsAt: '2026-01-01T05:00:00.000Z' },
    weekly: { percent: weekly, resetsAt: '2026-01-05T00:00:00.000Z' },
    monthly: { percent: monthly, resetsAt: '2026-02-01T00:00:00.000Z' },
})
let HOT = usageOf(0, 96, 80)
let COOL = usageOf(0, 40, 30)
let FULL = usageOf(0, 100, 100)

//fakeWda, 派工套件之替身; o.usage(全部金鑰同一份)或 o.usageOfKey(金鑰 → 用量物件)、o.behavior(模型, 第幾次呼叫 → RESULTS 之鍵或 'throw')、o.stderr(模型 → 逐塊送給 onStderr 之文字)
let fakeWda = (o = {}) => {
    let calls = []
    let wda = {
        providers: [
            { id: 'ocgo:opencode-go/m', kind: 'opencode', provider: 'opencode-go', model: 'opencode-go/m', envVar: 'OPENCODE_GO_KEYS' },
            { id: 'ocgo:opencode-go/m2', kind: 'opencode', provider: 'opencode-go', model: 'opencode-go/m2', envVar: 'OPENCODE_GO_KEYS' },
            { id: 'ocgo:opencode-go/m3', kind: 'opencode', provider: 'opencode-go', model: 'opencode-go/m3', envVar: 'OTHER_KEYS' },
            { id: 'oc:opencode/m-free', kind: 'opencode', provider: 'opencode', model: 'opencode/m-free' },
            { id: 'oc:opencode/n-free', kind: 'opencode', provider: 'opencode', model: 'opencode/n-free' },
        ],
        readEnvFile: () => o.env || ({ OPENCODE_GO_KEYS: `${K1},${K2}`, OTHER: 'short', FLAG: '1' }),
        opencodeGoUsage: async ({ key }) => {
            let u = o.usageOfKey ? o.usageOfKey[key] : (o.usage || HOT)
            return { ok: true, limited: o.limited === true, usage: u, ...(o.nextResetAt ? { nextResetAt: o.nextResetAt } : {}) }
        },
        getQuotaClaude: async () => ({ ok: true, windows: o.claudeWindows || [] }),
        dispatchOpencode: async (prompt, opts) => {
            let mode = (o.behavior || (() => 'ok'))(opts.model, calls.length)
            calls.push({
                model: opts.model,
                prompt,
                extraArgs: opts.extraArgs,
                key: opts.key,
                provider: opts.provider,
                useStoredAuth: opts.useStoredAuth,
                cwd: opts.cwd,
                cwdEmpty: typeof opts.cwd === 'string' && fs.existsSync(opts.cwd) && fs.readdirSync(opts.cwd).length === 0,
                timeoutMs: opts.timeoutMs,
                hasStderr: typeof opts.onStderr === 'function',
            })
            if (o.stderr && o.stderr[opts.model] && typeof opts.onStderr === 'function') {
                for (let c of o.stderr[opts.model]) {
                    opts.onStderr(c)
                }
            }
            if (mode === 'throw') {
                throw new Error('boom')
            }
            return RESULTS[mode]
        },
        dispatchClaude: async () => {
            calls.push({ model: 'claude' })
            return RESULTS[(o.claude || (() => 'ok'))()]
        },
    }
    return { wda, calls }
}

let agentsOf = (fallback, extra = {}) => ({ node: { kind: 'opencode', id: 'ocgo:opencode-go/m', variant: 'high', timeoutMin: 1, ...extra, ...(fallback ? { fallback } : {}) } })
let FREE = { kind: 'opencode', id: 'oc:opencode/m-free', variant: 'high' }
let FREE2 = { kind: 'opencode', id: 'oc:opencode/n-free' }


describe('派工:額度造成之失敗帶 quota(Gitea #156)', function () {
    let t
    let envFile
    let logFile
    beforeEach(() => {
        t = makeTmp('dq')
        envFile = path.join(t.dir, '.env')
        fs.writeFileSync(envFile, 'X=1\n')
        logFile = path.join(t.dir, 'w', 'agent_a1.log')
    })
    afterEach(() => {
        t.cleanup()
    })
    let make = (f, agents, o = {}) => makeDispatch({ agents, skillsRoot: t.dir, envFile, cwd: t.dir, ...o, inject: { wda: f.wda } })
    let run = (f, agents, o = {}) => make(f, agents, o)('node', { prompt: 'p', tag: 'r001_n_a1', logFile })

    it('主模型之用量達門檻而不派、備援之派工結果 errorType 為 quota ⇒ 結果 quota: true(鏈上每一家皆因額度)', async () => {
        //任務書 §本輪範圍 2: 主模型達門檻而不派 ⇒ 該條目 quota; 派工套件回 errorType quota ⇒ 該條目 quota; 每一家皆因額度 ⇒ 整體 quota
        let f = fakeWda({ behavior: () => 'quota' })
        let r = await run(f, agentsOf([FREE]))
        assert.equal(f.calls.length, 1, '主模型不派(用量守門), 只派備援')
        assert.deepEqual([r.ok, r.quota], [false, true])
        assert.deepEqual(r.tried.map((x) => [x.model, x.quota]), [['ocgo:opencode-go/m', true], ['oc:opencode/m-free', true]])
        assert(/用量已達 95%/.test(r.error) && /Free usage limit reached/.test(r.error) && !/TIMEOUT/.test(r.error), r.error)
        assert.equal(r.agent.model, 'ocgo:opencode-go/m')
        //派工套件負責偵測與終止: 本套件不追加命令列參數(只帶使用者之 variant)、不自行判讀錯誤字樣
        assert.deepEqual(f.calls[0].extraArgs, ['--variant', 'high'])
        assert.deepEqual([f.calls[0].model, f.calls[0].key, f.calls[0].useStoredAuth], ['opencode/m-free', undefined, false])
    })

    it('主模型未達門檻 ⇒ 照常派主模型(帶金鑰);成功結果不帶 quota', async () => {
        let f = fakeWda({ usage: COOL })
        let r = await run(f, agentsOf([FREE]))
        assert.deepEqual([r.ok, r.quota, r.agent.model], [true, undefined, 'ocgo:opencode-go/m'])
        assert.deepEqual([f.calls.length, f.calls[0].model, f.calls[0].key, f.calls[0].provider], [1, 'opencode-go/m', K1, 'opencode-go'])
        assert.deepEqual(f.calls[0].extraArgs, ['--variant', 'high'])
    })

    it('多把金鑰:前一把達門檻、後一把未達 ⇒ 以後一把派工', async () => {
        let f = fakeWda({ usageOfKey: { [K1]: HOT, [K2]: COOL } })
        let r = await run(f, agentsOf(null))
        assert.deepEqual([r.ok, f.calls[0].key], [true, K2])
    })

    it('主模型已派出而派工套件回 errorType quota(訂閱到頂)⇒ 無備援時 quota: true;備援為其他原因之失敗 ⇒ 不標', async () => {
        let f = fakeWda({ usage: COOL, behavior: () => 'quota' })
        let r = await run(f, agentsOf(null))
        assert.deepEqual([r.ok, r.quota, f.calls.length], [false, true, 1])
        let g = fakeWda({ usage: COOL, behavior: (m) => (m === 'opencode-go/m' ? 'quota' : 'exec') })
        let r2 = await run(g, agentsOf([FREE]))
        assert.deepEqual([r2.ok, r2.quota], [false, undefined])
        assert.deepEqual(r2.tried.map((x) => x.quota), [true, undefined])
    })

    it('備援為其他原因之失敗(離開碼、逾時、派工例外)⇒ 不標 quota(任一家為其他原因者照既有流程處理)', async () => {
        for (let [mode, re] of [['exec', /exec Exit code 1/], ['timeout', /timeout TIMEOUT after 60s/], ['throw', /派工例外: boom/]]) {
            let f = fakeWda({ behavior: () => mode })
            let r = await run(f, agentsOf([FREE]))
            assert.deepEqual([r.ok, r.quota], [false, undefined], mode)
            assert(re.test(r.error), r.error)
            assert.deepEqual(r.tried.map((x) => x.quota), [true, undefined], '主模型達門檻 = quota; 備援為其他原因')
        }
    })

    it('第一個備援因額度未完成、第二個可用 ⇒ 改派第二個並成功(不標 quota)', async () => {
        let f = fakeWda({ behavior: (m) => (m === 'opencode/m-free' ? 'quota' : 'ok') })
        let r = await run(f, agentsOf([FREE, FREE2]))
        assert.deepEqual([r.ok, r.quota, r.agent.model], [true, undefined, 'oc:opencode/n-free'])
        assert.deepEqual(f.calls.map((c) => c.model), ['opencode/m-free', 'opencode/n-free'])
        assert.deepEqual(r.tried.map((x) => x.quota), [true, true])
    })

    it('claude 條目之派工結果 errorType 為 quota ⇒ 同樣標 quota: true', async () => {
        let f = fakeWda({ claude: () => 'quota' })
        let r = await makeDispatch({ agents: { node: { kind: 'claude', model: 'c', timeoutMin: 1 } }, skillsRoot: t.dir, envFile, cwd: t.dir, inject: { wda: f.wda } })('node', { prompt: 'p', tag: 'x', logFile })
        assert.deepEqual([r.ok, r.quota], [false, true])
        let g = fakeWda({ claude: () => 'exec' })
        let r2 = await makeDispatch({ agents: { node: { kind: 'claude', model: 'c' } }, skillsRoot: t.dir, envFile, cwd: t.dir, inject: { wda: g.wda } })('node', { prompt: 'p', tag: 'x', logFile })
        assert.deepEqual([r2.ok, r2.quota], [false, undefined])
    })

    it('role 未設定 ⇒ 失敗且不標 quota', async () => {
        let r = await make(fakeWda(), {})('node', { prompt: 'p', tag: 'x', logFile })
        assert.deepEqual([r.ok, r.quota], [false, undefined])
    })

    it('用量守門之門檻可設定(makeDispatch 之 maxPercent = 專案設定 rsi.preflight.quotaMaxPercent):週用量 96% 而門檻 98 ⇒ 仍派主模型;門檻 96、未給、非有限數 ⇒ 不派(預設 95)', async () => {
        let go = async (maxPercent) => {
            let f = fakeWda()
            let r = await run(f, agentsOf([FREE]), maxPercent === 'unset' ? {} : { maxPercent })
            return [r.agent.model, f.calls[0].model, ((/用量已達 (\d+)%/.exec((r.tried[0] || {}).error || '')) || [])[1] || null]
        }
        assert.deepEqual(await go(98), ['ocgo:opencode-go/m', 'opencode-go/m', null])
        assert.deepEqual(await go(96), ['oc:opencode/m-free', 'opencode/m-free', '96'])
        assert.deepEqual(await go('unset'), ['oc:opencode/m-free', 'opencode/m-free', '95'])
        assert.deepEqual((await go(NaN))[0], 'oc:opencode/m-free')
        assert.deepEqual((await go('x'))[0], 'oc:opencode/m-free')
    })

    it('門檻可按角色設定(agents.<role>.quotaMaxPercent;優先於 maxPercent):大於 100 = 不以用量守門、讀到 100% 仍派主模型;備援條目沿用該門檻;被限流者仍不派', async () => {
        let ag = agentsOf([{ kind: 'opencode', id: 'ocgo:opencode-go/m2' }], { quotaMaxPercent: 101 })
        let f = fakeWda({ usage: FULL })
        let r = await run(f, ag, { maxPercent: 50 })
        assert.deepEqual([r.ok, r.agent.model, f.calls.map((c) => c.model).join()], [true, 'ocgo:opencode-go/m', 'opencode-go/m'], '角色之門檻優先於 maxPercent')
        //備援(同為訂閱)沿用角色之門檻: 主模型執行失敗後備援仍派出(讀到 100% 而門檻 101)
        let g = fakeWda({ usage: FULL, behavior: (m) => (m === 'opencode-go/m' ? 'exec' : 'ok') })
        let r2 = await run(g, ag)
        assert.deepEqual([r2.ok, g.calls.map((c) => c.model).join()], [true, 'opencode-go/m,opencode-go/m2'])
        //備援條目自己之門檻為 undefined(程式化組設定時)視同未給 ⇒ 仍沿用角色之門檻
        let g2 = fakeWda({ usage: FULL, behavior: (m) => (m === 'opencode-go/m' ? 'exec' : 'ok') })
        let r2b = await run(g2, agentsOf([{ kind: 'opencode', id: 'ocgo:opencode-go/m2', quotaMaxPercent: undefined }], { quotaMaxPercent: 101 }))
        assert.deepEqual([r2b.ok, g2.calls.map((c) => c.model).join()], [true, 'opencode-go/m,opencode-go/m2'])
        //角色之門檻非有限數 ⇒ 取 maxPercent
        let h = fakeWda({ usage: FULL })
        let r3 = await run(h, agentsOf([FREE], { quotaMaxPercent: 'abc' }), { maxPercent: 98 })
        assert.deepEqual([r3.agent.model, h.calls[0].model], ['oc:opencode/m-free', 'opencode/m-free'])
        //被限流者不論門檻皆不派
        let k = fakeWda({ usage: FULL, limited: true })
        let r4 = await run(k, ag)
        assert.deepEqual([r4.ok, r4.quota, k.calls.length], [false, true, 0])
    })
})


describe('派工:錯誤輸出留存與遮罩(規則 R-RUN-8)', function () {
    let t
    let envFile
    let logFile
    let fpErr
    beforeEach(() => {
        t = makeTmp('dqe')
        envFile = path.join(t.dir, '.env')
        fs.writeFileSync(envFile, 'X=1\n')
        logFile = path.join(t.dir, 'w', 'agent_a1.log')
        fpErr = path.join(t.dir, 'w', 'agent_a1.stderr.log')
    })
    afterEach(() => {
        t.cleanup()
    })
    let run = (f, agents) => makeDispatch({ agents, skillsRoot: t.dir, envFile, cwd: t.dir, inject: { wda: f.wda } })('node', { prompt: 'p', tag: 'r001_n_a1', logFile })

    it('全部 opencode 條目之 stderr 附寫到派工紀錄檔同夾之 <主檔名>.stderr.log(備援為例);每個條目前有標頭;沒有 stderr 之條目不產生檔', async () => {
        let L = 'level=ERROR message="stream error" agent=build error.error="Free usage limit reached"'
        let f = fakeWda({ behavior: () => 'quota', stderr: { 'opencode/m-free': [' > build · m-free\n', `${L}\n`] } })
        await run(f, agentsOf([FREE]))
        let s = fs.readFileSync(fpErr, 'utf8')
        assert(s.includes('oc:opencode/m-free') && s.includes(' > build · m-free\n') && s.includes(`${L}\n`), s)
        assert(f.calls[0].hasStderr, '派工時給 onStderr')
        //主模型(訂閱)亦留存: 先留存之內容保留、附寫其後
        let g = fakeWda({ usage: COOL, behavior: (m) => (m === 'opencode-go/m' ? 'exec' : 'ok'), stderr: { 'opencode-go/m': ['main err\n'], 'opencode/m-free': ['free err\n'] } })
        fs.rmSync(fpErr)
        await run(g, agentsOf([FREE]))
        let s2 = fs.readFileSync(fpErr, 'utf8')
        assert(s2.indexOf('main err') >= 0 && s2.indexOf('free err') > s2.indexOf('main err'), s2)
        assert(s2.indexOf('oc:opencode/m-free') > s2.indexOf('main err') && s2.indexOf('ocgo:opencode-go/m') < s2.indexOf('main err'), '各條目有標頭')
        //無 stderr ⇒ 不建檔
        fs.rmSync(fpErr)
        await run(fakeWda({ usage: COOL }), agentsOf(null))
        assert(!fs.existsSync(fpErr))
        //logFile 不以 .log 結尾 ⇒ 附 .stderr.log
        let lf2 = path.join(t.dir, 'w', 'agent_b')
        await makeDispatch({ agents: agentsOf(null), skillsRoot: t.dir, envFile, cwd: t.dir, inject: { wda: fakeWda({ usage: COOL, stderr: { 'opencode-go/m': ['x\n'] } }).wda } })('node', { prompt: 'p', tag: 'x', logFile: lf2 })
        assert(fs.existsSync(`${lf2}.stderr.log`))
    })

    it('留存前以共用遮罩函數(wsemi 之 maskDiagText;秘密 = 本次自金鑰檔讀到之金鑰)遮罩:金鑰被切在兩個區塊之間、Bearer 值、無換行之尾段皆遮;逐位與 maskDiagText 之結果相同', async () => {
        //D1(診斷輸出與遮罩): 不自寫遮罩; 逐列處理 ⇒ 區塊邊界不影響
        let chunks = [
            ' > build · m-free\n',
            `level=ERROR message="auth failed" apiKey=${K1.slice(0, 10)}`,
            `${K1.slice(10)} detail="x"\n`,
            'Authorization: Bearer TOPSECRETTOKEN\n',
            'plain line mentioning short and 1 stays\n',
            `tail ${K2} no newline`,
        ]
        let f = fakeWda({ behavior: () => 'quota', stderr: { 'opencode/m-free': chunks } })
        await run(f, agentsOf([FREE]))
        let s = fs.readFileSync(fpErr, 'utf8')
        assert(!s.includes(K1) && !s.includes(K2) && !s.includes('TESTKEY') && !s.includes('TOPSECRETTOKEN'), s)
        assert(s.includes('auth failed') && s.includes('tail ***'), s)
        //未登錄為秘密之短值(長度 < 8)不被遮成亂碼: 其行原樣
        assert(s.includes('plain line mentioning short and 1 stays\n'), s)
        let want = maskDiagText(['level=ERROR message="auth failed" apiKey=', K1, ' detail="x"\n'].join(''), [K1, K2])
        assert(s.includes(want), `${want} 不在 ${s}`)
        assert(s.includes(maskDiagText('Authorization: Bearer TOPSECRETTOKEN\n', [K1, K2])))
    })

    it('過長之列分段遮罩:金鑰橫跨分段之切點、或無換行而累積過長之輸出被強制吐出時,金鑰仍遮得到(切點避開橫跨之金鑰);被分段之內容不遺失', async () => {
        //maskDiagText 對單一輸入逾 20000 字元者會截斷 ⇒ 本套件分段(16000 字元); 金鑰恰橫跨切點者不得漏遮
        let long1 = `${'x'.repeat(15990)}${K1}${'y'.repeat(200)}\n`
        let f = fakeWda({ behavior: () => 'quota', stderr: { 'opencode/m-free': [long1] } })
        await run(f, agentsOf([FREE]))
        let s = fs.readFileSync(fpErr, 'utf8')
        assert(!s.includes(K1) && !s.includes('TESTKEY'), '橫跨切點之金鑰已遮')
        assert(s.includes(`${'x'.repeat(15990)}***${'y'.repeat(200)}\n`), '前後內容完整(未被截斷)')
        //無換行之長輸出(強制吐出之路徑)與收尾
        fs.rmSync(fpErr)
        let long2 = `${'z'.repeat(63990)}${K1}${'w'.repeat(7000)}`
        let g = fakeWda({ behavior: () => 'quota', stderr: { 'opencode/m-free': [long2] } })
        await run(g, agentsOf([FREE]))
        let s2 = fs.readFileSync(fpErr, 'utf8')
        assert(!s2.includes(K1) && !s2.includes('TESTKEY'), '強制吐出之切點亦避開金鑰')
        assert(s2.includes(`${'z'.repeat(63990)}***${'w'.repeat(7000)}`), '內容完整')
    })

    it('分段之切點:前段空白落在已登錄金鑰(含空白)之內而退到 0 時,仍避開橫跨切點之另一把金鑰;切點不落在 Bearer 與其值之間(未登錄之憑證亦遮)', async () => {
        //金鑰本身含空白(不尋常)⇒ 空白切點退到 0, 須改以長度上限為切點重新避開
        let kSp = 'sp ace key1'
        let line1 = `${kSp}${'x'.repeat(15980)}${K2}${'y'.repeat(100)}\n`
        let f = fakeWda({ behavior: () => 'quota', env: { OPENCODE_GO_KEYS: `${kSp},${K2}` }, stderr: { 'opencode/m-free': [line1] } })
        await run(f, agentsOf([FREE]))
        let s = fs.readFileSync(fpErr, 'utf8')
        assert(!s.includes(K2) && !s.includes('TESTKEY') && !s.includes(kSp), s.slice(15900, 16100))
        assert(s.includes(`${'x'.repeat(15980)}***${'y'.repeat(100)}\n`), '內容完整')
        //Bearer 之值未登錄為秘密: 空白切點恰在 Bearer 與其值之間 ⇒ 切點移到 Bearer 之前
        fs.rmSync(fpErr)
        let line2 = `${'X'.repeat(15992)} Bearer unregistered_bearer_secret_xyz123 trailing\n`
        let g = fakeWda({ behavior: () => 'quota', stderr: { 'opencode/m-free': [line2] } })
        await run(g, agentsOf([FREE]))
        let s2 = fs.readFileSync(fpErr, 'utf8')
        assert(!s2.includes('unregistered_bearer_secret_xyz123'), s2.slice(15950, 16100))
        assert(s2.includes(`${'X'.repeat(15992)} Bearer ***`) && s2.endsWith(' trailing\n'), '內容完整')
    })

    it('寫留存檔失敗(路徑被占用為資料夾)不影響派工結果;金鑰以「,」「;」拆開皆遮;條目表所列之其他金鑰變數亦為秘密,非金鑰變數之短值不遮', async () => {
        fs.mkdirSync(fpErr, { recursive: true })
        let f = fakeWda({ behavior: () => 'quota', stderr: { 'opencode/m-free': ['some stderr\n'] } })
        let r = await run(f, agentsOf([FREE]))
        assert.deepEqual([r.ok, r.quota], [false, true], '寫檔失敗不拋、不改變結果')
        fs.rmSync(fpErr, { recursive: true })
        let g = fakeWda({ usage: COOL, env: { OPENCODE_GO_KEYS: 'aaaa1111;bbbb2222', OTHER_KEYS: 'xk99', NOTKEY: 'zz11' }, stderr: { 'opencode-go/m': ['a aaaa1111 b bbbb2222 c xk99 d zz11\n'] } })
        await run(g, agentsOf(null))
        assert.equal(g.calls[0].key, 'aaaa1111')
        assert(fs.readFileSync(fpErr, 'utf8').includes('a *** b *** c *** d zz11\n'))
    })

    it('金鑰變數(金鑰檔內派工套件條目表所列之 envVar)之值長度 ≥ 4 即視為秘密(短金鑰亦遮);其他變數之短值不遮', async () => {
        let f = fakeWda({ usage: COOL, env: { OPENCODE_GO_KEYS: 'k5Zq9', OTHER: 'short', FLAG: '1' }, stderr: { 'opencode-go/m': ['line k5Zq9 and short and 1 stay\n'] } })
        await run(f, agentsOf(null))
        assert.equal(f.calls[0].key, 'k5Zq9')
        let s = fs.readFileSync(fpErr, 'utf8')
        assert(s.includes('line *** and short and 1 stay\n'), s)
    })
})


describe('起跑前之額度檢查:備援之探測(Gitea #156)', function () {
    let t
    let envFile
    beforeEach(() => {
        t = makeTmp('dq2')
        envFile = path.join(t.dir, '.env')
        fs.writeFileSync(envFile, 'X=1\n')
    })
    afterEach(() => {
        t.cleanup()
    })
    let check = (f, agents, o = {}) => checkQuota({ agents, skillsRoot: t.dir, envFile, inject: { wda: f.wda }, ...o })

    it('未給 probe ⇒ 舊行為:主模型達門檻而有備援即不擋、不探測;重置時刻取自 resetsAt', async () => {
        let f = fakeWda({ behavior: () => 'quota' })
        let q = await check(f, agentsOf([FREE]))
        assert.deepEqual([q.ok, q.retryAt, f.calls.length], [true, null, 0])
        assert(/改用 fallback/.test(q.rows[0].note))
        assert.deepEqual(q.rows[0].windows.find((w) => w.label === 'weekly'), { label: 'weekly', percent: 96, resetAt: '2026-01-05T00:00:00.000Z' })
        //舊欄名 resetAt 亦收
        let g = fakeWda({ usage: { weekly: { percent: 96, resetAt: '2026-03-01T00:00:00.000Z' } } })
        let q2 = await check(g, agentsOf(null))
        assert.deepEqual([q2.ok, q2.retryAt], [false, '2026-03-01T00:00:00.000Z'])
    })

    it('probe:備援之派工結果 errorType 為 quota ⇒ 擋下;原因含備援狀況與達門檻之視窗全部重置之時刻;探測用極小提示詞、短逾時、系統暫存夾下新建之空夾(用畢即刪)', async () => {
        let f = fakeWda({ behavior: () => 'quota' })
        let q = await check(f, agentsOf([FREE]), { probe: true, probeTimeoutMs: 1234 })
        assert.deepEqual([q.ok, q.rows[0].blocked, q.retryAt], [false, true, '2026-01-05T00:00:00.000Z'])
        assert(/weekly 96%/.test(q.why) && /≥ 95%/.test(q.why) && /備援/.test(q.why) && /額度/.test(q.why) && /2026-01-05T00:00:00\.000Z/.test(q.why), q.why)
        assert.equal(f.calls.length, 1)
        let c = f.calls[0]
        assert.deepEqual([c.model, c.timeoutMs, c.extraArgs, c.useStoredAuth, c.key], ['opencode/m-free', 1234, ['--variant', 'high'], false, undefined])
        assert(c.prompt.length > 0 && c.prompt.length <= 30, `提示詞極小: ${c.prompt}`)
        assert(c.cwdEmpty && path.dirname(path.resolve(c.cwd)) === path.resolve(os.tmpdir()) && /^arsi-probe-/.test(path.basename(c.cwd)), c.cwd)
        assert(!fs.existsSync(c.cwd), '用畢即刪')
        //預設之探測逾時
        let g = fakeWda({ behavior: () => 'ok' })
        await check(g, agentsOf([FREE]), { probe: true })
        assert.equal(g.calls[0].timeoutMs, 60000)
    })

    it('probe:備援可用、備援為其他原因之失敗(離開碼、逾時、例外)、第二個備援可用 ⇒ 皆不擋', async () => {
        for (let [behavior, fb, nCalls] of [[() => 'ok', [FREE], 1], [() => 'exec', [FREE], 1], [() => 'timeout', [FREE], 1], [() => 'throw', [FREE], 1], [(m) => (m === 'opencode/m-free' ? 'quota' : 'ok'), [FREE, FREE2], 2]]) {
            let f = fakeWda({ behavior })
            let q = await check(f, agentsOf(fb), { probe: true })
            assert.deepEqual([q.ok, q.rows[0].blocked, f.calls.length, q.retryAt], [true, false, nCalls, null], String(behavior))
            assert(/改用 fallback/.test(q.rows[0].note))
        }
        //全部備援皆因額度 ⇒ 擋下
        let g = fakeWda({ behavior: () => 'quota' })
        let q2 = await check(g, agentsOf([FREE, FREE2]), { probe: true })
        assert.deepEqual([q2.ok, g.calls.length], [false, 2])
    })

    it('probe:備援同為訂閱之條目(共用已達門檻之用量)⇒ 不可用而擋下、不探測;備援為其他種類 ⇒ 不探測、不擋;主模型未達門檻 ⇒ 不探測;無備援而達門檻 ⇒ 擋下(既有行為)', async () => {
        let f1 = fakeWda()
        let q1 = await check(f1, agentsOf([{ kind: 'opencode', id: 'ocgo:opencode-go/m2' }]), { probe: true })
        assert.deepEqual([q1.ok, f1.calls.length], [false, 0])
        assert(/備援/.test(q1.why), q1.why)
        let f2 = fakeWda()
        let q2 = await check(f2, agentsOf([{ kind: 'claude', model: 'c' }]), { probe: true })
        assert.deepEqual([q2.ok, f2.calls.length], [true, 0])
        let f3 = fakeWda({ usage: COOL, behavior: () => 'quota' })
        let q3 = await check(f3, agentsOf([FREE]), { probe: true })
        assert.deepEqual([q3.ok, q3.rows[0].note, f3.calls.length], [true, null, 0])
        let f4 = fakeWda()
        let q4 = await check(f4, agentsOf(null), { probe: true })
        assert.deepEqual([q4.ok, q4.retryAt, f4.calls.length], [false, '2026-01-05T00:00:00.000Z', 0])
    })

    it('retryAt:達門檻之視窗須全部重置(取最晚);多把金鑰取最早可用者;任一達門檻之視窗無重置時刻 ⇒ null;多個被擋之角色取最晚、任一未知 ⇒ null', async () => {
        let two = { rolling: { percent: 99, resetsAt: '2026-01-01T05:00:00.000Z' }, weekly: { percent: 97, resetsAt: '2026-01-05T00:00:00.000Z' }, monthly: { percent: 10, resetsAt: '2026-03-01T00:00:00.000Z' } }
        let q1 = await check(fakeWda({ usage: two }), agentsOf(null))
        assert.equal(q1.retryAt, '2026-01-05T00:00:00.000Z', '兩個視窗皆達門檻 ⇒ 取最晚')
        assert(/rolling 99%、weekly 97%/.test(q1.why), q1.why)
        //兩把金鑰皆達門檻: 任一把重置即可用 ⇒ 取最早
        let k2 = { rolling: { percent: 99, resetsAt: '2026-01-01T05:00:00.000Z' } }
        let k1 = { weekly: { percent: 97, resetsAt: '2026-01-05T00:00:00.000Z' } }
        let q2 = await check(fakeWda({ usageOfKey: { [K1]: k1, [K2]: k2 } }), agentsOf(null))
        assert.deepEqual([q2.ok, q2.retryAt], [false, '2026-01-01T05:00:00.000Z'])
        //達門檻之視窗查不到重置時刻
        let q3 = await check(fakeWda({ usage: { weekly: { percent: 97 } } }), agentsOf(null))
        assert.deepEqual([q3.ok, q3.retryAt], [false, null])
        assert(!/全部重置/.test(q3.why), q3.why)
        //多個角色被擋
        let ag = { node: agentsOf(null).node, dream: { ...agentsOf(null).node, id: 'ocgo:opencode-go/m2' } }
        let f4 = fakeWda({ usageOfKey: { [K1]: HOT, [K2]: HOT } })
        let q4 = await check(f4, ag)
        assert.deepEqual([q4.ok, q4.retryAt, q4.rows.filter((r) => r.blocked).length], [false, '2026-01-05T00:00:00.000Z', 2])
        let q5 = await check(fakeWda({ usage: { weekly: { percent: 97 } } }), ag)
        assert.equal(q5.retryAt, null)
        //兩個被擋之角色之可用時刻不同(以角色之門檻區分): 全部皆可用之時刻 = 較晚者
        let two2 = { rolling: { percent: 99, resetsAt: '2026-01-01T05:00:00.000Z' }, weekly: { percent: 50, resetsAt: '2026-01-05T00:00:00.000Z' } }
        let ag2 = { node: agentsOf(null).node, dream: { ...agentsOf(null).node, quotaMaxPercent: 40 } }
        let q6 = await check(fakeWda({ usage: two2 }), ag2)
        assert.deepEqual([q6.rows.map((r) => r.retryAt), q6.retryAt], [['2026-01-01T05:00:00.000Z', '2026-01-05T00:00:00.000Z'], '2026-01-05T00:00:00.000Z'])
    })

    it('被限流:無達門檻之視窗者 retryAt 取派工套件之 nextResetAt(與達門檻之視窗取最晚;任一查不到 ⇒ null);原因寫「被限流」', async () => {
        let f = fakeWda({ usage: COOL, limited: true, nextResetAt: '2026-01-02T00:00:00.000Z' })
        let q = await check(f, agentsOf(null))
        assert.deepEqual([q.ok, q.retryAt, q.rows[0].limited], [false, '2026-01-02T00:00:00.000Z', true])
        assert(/被限流 ≥ 95%/.test(q.why) && /2026-01-02T00:00:00\.000Z/.test(q.why), q.why)
        //同時有達門檻之視窗 ⇒ 兩者皆須解除(取最晚)
        let g = fakeWda({ usage: HOT, limited: true, nextResetAt: '2026-01-02T00:00:00.000Z' })
        assert.equal((await check(g, agentsOf(null))).retryAt, '2026-01-05T00:00:00.000Z')
        let h = fakeWda({ usage: COOL, limited: true })
        assert.equal((await check(h, agentsOf(null))).retryAt, null, '限流而無解除時刻')
        //未被限流之行不帶 limited
        assert.equal((await check(fakeWda({ usage: HOT }), agentsOf(null))).rows[0].limited, false)
    })

    it('probe:同為訂閱之備援依「金鑰變數與門檻」判定 —— 金鑰變數不同、門檻較高者視為可用(不探測、不擋);同金鑰變數且門檻較高但全部金鑰被限流者仍不可用', async () => {
        let f1 = fakeWda()
        let q1 = await check(f1, agentsOf([{ kind: 'opencode', id: 'ocgo:opencode-go/m3' }]), { probe: true })
        assert.deepEqual([q1.ok, f1.calls.length], [true, 0], '另一組金鑰變數 ⇒ 無從得知其用量, 視為可用')
        let f2 = fakeWda()
        let q2 = await check(f2, agentsOf([{ kind: 'opencode', id: 'ocgo:opencode-go/m2', quotaMaxPercent: 101 }]), { probe: true })
        assert.deepEqual([q2.ok, f2.calls.length], [true, 0], '同金鑰變數而門檻較高 ⇒ 視為可用')
        let f3 = fakeWda({ limited: true })
        let q3 = await check(f3, agentsOf([{ kind: 'opencode', id: 'ocgo:opencode-go/m2', quotaMaxPercent: 101 }]), { probe: true })
        assert.deepEqual([q3.ok, f3.calls.length], [false, 0], '全部金鑰被限流 ⇒ 門檻再高亦不可用')
    })

    it('claude 之角色:帶 scope 之視窗只在模型相符時計入(不相符之視窗不擋);相符且達門檻 ⇒ 擋下並帶 retryAt', async () => {
        let cw = [{ label: 'week-opus', usedPercent: 99, scope: 'opus', resetAt: '2026-02-01T00:00:00.000Z' }, { label: 'all', usedPercent: 10, resetAt: '2026-01-09T00:00:00.000Z' }]
        let f = fakeWda({ claudeWindows: cw })
        let q1 = await check(f, { dream: { kind: 'claude', model: 'claude-sonnet-5-5' } })
        assert.deepEqual([q1.ok, q1.rows[0].windows.map((w) => w.label)], [true, ['all']])
        let q2 = await check(f, { dream: { kind: 'claude', model: 'claude-opus-5-5' } })
        assert.deepEqual([q2.ok, q2.rows[0].windows.map((w) => w.label), q2.retryAt], [false, ['week-opus', 'all'], '2026-02-01T00:00:00.000Z'])
    })

    it('多把金鑰一熱一冷:不擋、列上之視窗取未達門檻者(冷)之用量', async () => {
        let f = fakeWda({ usageOfKey: { [K1]: HOT, [K2]: COOL } })
        let q = await check(f, agentsOf(null))
        assert.deepEqual([q.ok, q.rows[0].windows.find((w) => w.label === 'weekly').percent], [true, 40])
    })

    it('門檻可設定:角色之 quotaMaxPercent 優先於 maxPercent(列上帶所用之門檻);大於 100 ⇒ 不以用量守門,不探測', async () => {
        let f = fakeWda({ usage: FULL, behavior: () => 'quota' })
        let ag = agentsOf([FREE], { quotaMaxPercent: 101 })
        let q = await check(f, ag, { probe: true, maxPercent: 50 })
        assert.deepEqual([q.ok, q.rows[0].maxPercent, q.rows[0].note, f.calls.length], [true, 101, null, 0])
        let g = fakeWda({ usage: usageOf(0, 70, 0) })
        let q2 = await check(g, agentsOf(null, { quotaMaxPercent: 60 }), { maxPercent: 95 })
        assert.deepEqual([q2.ok, q2.rows[0].maxPercent], [false, 60])
        let q3 = await check(g, agentsOf(null), { maxPercent: 80 })
        assert.deepEqual([q3.ok, q3.rows[0].maxPercent], [true, 80])
        let q4 = await check(g, agentsOf(null), {})
        assert.deepEqual([q4.ok, q4.rows[0].maxPercent], [true, 95], '未給 ⇒ 95')
        let q5 = await check(g, agentsOf(null), { maxPercent: NaN })
        assert.equal(q5.rows[0].maxPercent, 95, '非有限數 ⇒ 95')
    })
})
