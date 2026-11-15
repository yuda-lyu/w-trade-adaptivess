import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { FD_ROOT, makeTmp, writeSynthLedger } from './tools/synthLedger.mjs'


//額度用盡之處置之接線(Gitea #156; 規則 R-RUN-8): 以套件之命令列程式(src/cli/rsi.mjs、src/tools/quota.mjs)於合成之專案根實跑
//  派工套件為替身(技能根下之假 w-dispatch-ai; 其回應與用量由環境變數 QSTUB 給定, 呼叫紀錄寫到 QSTUB_LOG); 不起真實之 CLI 子行程
//  驗: 起跑前之檢查與連跑時之每輪檢查皆帶 probe、輪末之用量快照不探測、事件 skipped 帶 retryAt、重置時刻讀 resetsAt、
//      門檻(settings.rsi.preflight.quotaMaxPercent 與 agents.<role>.quotaMaxPercent)經領域層傳到派工器、額度造成之失敗不以半成品入樹
let STUB = `
const fs = require('fs')
const cfg = JSON.parse(process.env.QSTUB || '{}')
const RESULTS = {
    ok: { ok: true, stdout: 'done', durationMs: 5 },
    quota: { ok: false, errorType: 'quota', error: 'Exit code 1 [quota]: Free usage limit reached', stdout: '', durationMs: 7 },
    exec: { ok: false, errorType: 'exec', error: 'Exit code 1', stdout: '', durationMs: 5 },
}
let n = 0
const rec = (x) => fs.appendFileSync(process.env.QSTUB_LOG, JSON.stringify(x) + '\\n')
module.exports = {
    providers: [
        { id: 'ocgo:opencode-go/m', kind: 'opencode', provider: 'opencode-go', model: 'opencode-go/m', envVar: 'OPENCODE_GO_KEYS' },
        { id: 'oc:opencode/m-free', kind: 'opencode', provider: 'opencode', model: 'opencode/m-free' },
    ],
    readEnvFile: () => ({ OPENCODE_GO_KEYS: 'oc_sk_TESTKEY00000001' }),
    opencodeGoUsage: async () => ({ ok: true, limited: false, usage: cfg.usage }),
    dispatchOpencode: async (prompt, opts) => {
        const results = cfg.results || ['exec']
        const mode = results[Math.min(n, results.length - 1)]
        n += 1
        rec({ fn: 'dispatchOpencode', model: opts.model, promptLen: String(prompt).length, hasKey: typeof opts.key === 'string', mode })
        return RESULTS[mode]
    },
    dispatchClaude: async () => {
        rec({ fn: 'dispatchClaude' })
        return RESULTS.exec
    },
    getQuotaClaude: async () => ({ ok: true, windows: [{ label: 'week', usedPercent: 10, resetAt: '' }] }),
}
`

let usageOf = (weekly) => ({ rolling: { percent: 0, resetsAt: '2026-01-01T05:00:00.000Z' }, weekly: { percent: weekly, resetsAt: '2026-01-05T00:00:00.000Z' } })


describe('額度用盡之處置:命令列之接線(替身派工套件、合成專案根)', function () {
    this.timeout(180000)
    let t
    let root
    before(() => {
        t = makeTmp('quotaCli')
    })
    after(() => {
        t.cleanup()
    })

    //mkProject, 於 t.dir/<name> 建合成專案根: 設定(自套件之參考設定改)、合成帳本、臂目錄基底、金鑰檔、假派工套件
    let mkProject = (name, mod = (st) => st) => {
        let dir = path.join(t.dir, name)
        fs.mkdirSync(path.join(dir, 'skills', 'node_modules', 'w-dispatch-ai'), { recursive: true })
        fs.mkdirSync(path.join(dir, 'arms'), { recursive: true })
        fs.copyFileSync(path.join(FD_ROOT, 'arms', 'base.json'), path.join(dir, 'arms', 'base.json'))
        writeSynthLedger(path.join(dir, 'ledger'), { n: 6, nBars: 400 })
        let st = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
        st.eval.ledgerDir = './ledger'
        //金鑰檔給絕對路徑: settings.dispatch.envFile 不經專案根解析(相對於工作目錄), 而本測試之工作目錄刻意不是專案根
        st.dispatch = { skillsRoot: path.join(dir, 'skills'), envFile: path.join(dir, '.env') }
        st.rsi = { ...st.rsi, nodesPerRound: 1, parallelNodes: 1 }
        st.resources = {}
        st.agents = {
            node: { kind: 'opencode', id: 'ocgo:opencode-go/m', variant: 'high', timeoutMin: 1, fallback: [{ kind: 'opencode', id: 'oc:opencode/m-free', variant: 'high' }] },
            dream: { kind: 'claude', model: 'claude-opus-5-5', effort: 'xhigh', timeoutMin: 1 },
        }
        st = mod(st) || st
        fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(st, null, 1))
        fs.writeFileSync(path.join(dir, '.env'), 'OPENCODE_GO_KEYS=oc_sk_TESTKEY00000001\n')
        fs.writeFileSync(path.join(dir, 'skills', 'node_modules', 'w-dispatch-ai', 'package.json'), JSON.stringify({ name: 'w-dispatch-ai', main: 'index.cjs' }))
        fs.writeFileSync(path.join(dir, 'skills', 'node_modules', 'w-dispatch-ai', 'index.cjs'), STUB)
        return dir
    }
    //runCli, 以 dir 為專案根(ARSI_ROOT)執行 src 下之命令列程式; 工作目錄刻意不是專案根; 回 { status, out, calls(假派工套件之呼叫紀錄), events(事件檔) }
    let runCli = (dir, rel, args, stub) => {
        let fpLog = path.join(dir, 'calls.log')
        fs.rmSync(fpLog, { force: true })
        let env = { ...process.env, ARSI_ROOT: dir, QSTUB: JSON.stringify(stub), QSTUB_LOG: fpLog }
        let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', ...rel), ...args], { cwd: t.dir, env, windowsHide: true, encoding: 'utf8', timeout: 150000 })
        let lines = (fp) => (fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8').split(/\r?\n/).filter(Boolean).map((s) => JSON.parse(s)) : [])
        return { status: r.status, out: `${r.stdout}\n${r.stderr}`, calls: lines(fpLog), events: lines(path.join(dir, 'rsi', 'logs', 'events.jsonl')) }
    }

    it('起跑前:主模型達門檻且備援(免費池)因額度不可用 ⇒ 試一次備援(極小提示詞)、不啟動(離開碼 3)、事件 skipped 帶 reason: quota 與 retryAt(取自 resetsAt)', () => {
        root = mkProject('start')
        let r = runCli(root, ['cli', 'rsi.mjs'], ['--mode', 'round'], { usage: usageOf(97), results: ['quota'] })
        assert.equal(r.status, 3, r.out)
        assert(/本次不啟動/.test(r.out) && /備援/.test(r.out) && /2026-01-05T00:00:00\.000Z/.test(r.out), r.out)
        assert.deepEqual(r.events.map((e) => e.event), ['skipped'])
        assert.deepEqual([r.events[0].reason, r.events[0].retryAt], ['quota', '2026-01-05T00:00:00.000Z'])
        assert.equal(r.calls.length, 1, '只探測一次, 未起節點')
        assert.deepEqual([r.calls[0].fn, r.calls[0].model, r.calls[0].hasKey], ['dispatchOpencode', 'opencode/m-free', false])
        assert(r.calls[0].promptLen <= 30, `提示詞極小: ${r.calls[0].promptLen}`)
    })

    it('起跑前:備援可用 ⇒ 照常起跑(探測一次);連跑時第 2 輪起每輪開始前再探測;額度造成之失敗之節點不重跑驗證、不入樹;輪末之用量快照不探測', () => {
        root = mkProject('rounds')
        let r = runCli(root, ['cli', 'rsi.mjs'], ['--mode', 'round', '--rounds', '2'], { usage: usageOf(97), results: ['ok', 'quota', 'quota'] })
        assert.equal(r.status, 0, r.out)
        //呼叫序: 起跑前之探測(ok)→ 第 1 輪節點(備援; 因額度而未完成)→ 第 2 輪前之探測(quota ⇒ 停止); 輪末快照若亦探測則會多出呼叫
        assert.deepEqual(r.calls.map((c) => c.fn), ['dispatchOpencode', 'dispatchOpencode', 'dispatchOpencode'], JSON.stringify(r.calls))
        assert.deepEqual(r.calls.map((c) => c.promptLen <= 30), [true, false, true], '探測 / 節點 / 探測')
        assert.deepEqual(r.calls.map((c) => c.model), ['opencode/m-free', 'opencode/m-free', 'opencode/m-free'])
        let done = r.events.find((e) => e.event === 'run-done')
        assert(done && /額度已達起跑門檻/.test(done.stopped) && /備援/.test(done.stopped), JSON.stringify(r.events))
        assert.equal(r.events.find((e) => e.event === 'run-start').event, 'run-start')
        //R-RUN-8: 額度造成之失敗 ⇒ 節點文件記 failed、不入樹(不當成已執行)
        let docs = fs.readdirSync(path.join(root, 'rsi', 'records', 'nodes')).filter((f) => /\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(root, 'rsi', 'records', 'nodes', f), 'utf8')))
        assert.equal(docs.length, 1)
        assert.deepEqual([docs[0].status, docs[0].harness.ok], ['failed', false])
        assert(/額度用盡/.test(docs[0].harness.error), docs[0].harness.error)
        assert(!/未交付可評估之成品|未交付 pick/.test(r.out), '未重跑驗證')
    })

    it('門檻設定經領域層傳到派工器:settings.rsi.preflight.quotaMaxPercent = 98 而用量 97% ⇒ 主模型照派(帶金鑰);未設則取 95 而改派備援', () => {
        let a = mkProject('thr98', (st) => {
            st.rsi.preflight = { quotaMaxPercent: 98 }
        })
        let r = runCli(a, ['cli', 'rsi.mjs'], ['--mode', 'round'], { usage: usageOf(97), results: ['ok'] })
        assert.equal(r.status, 0, r.out)
        assert.deepEqual(r.calls.filter((c) => c.fn === 'dispatchOpencode').map((c) => [c.model, c.hasKey]), [['opencode-go/m', true]], '主模型照派; 備援未用')
        let b = mkProject('thr95')
        let r2 = runCli(b, ['cli', 'rsi.mjs'], ['--mode', 'round'], { usage: usageOf(97), results: ['ok'] })
        assert.deepEqual(r2.calls.filter((c) => c.fn === 'dispatchOpencode' && c.promptLen > 30).map((c) => [c.model, c.hasKey]), [['opencode/m-free', false]], '節點改派備援(另有起跑前之一次探測)')
    })

    it('角色之門檻(agents.node.quotaMaxPercent)優先:大於 100 ⇒ 用量 100% 仍派主模型、起跑前之檢查不擋', () => {
        let a = mkProject('role101', (st) => {
            st.agents.node.quotaMaxPercent = 101
        })
        let r = runCli(a, ['cli', 'rsi.mjs'], ['--mode', 'round'], { usage: usageOf(100), results: ['ok'] })
        assert.equal(r.status, 0, r.out)
        assert(!r.events.some((e) => e.event === 'skipped'), JSON.stringify(r.events))
        assert.deepEqual(r.calls.filter((c) => c.fn === 'dispatchOpencode').map((c) => c.model), ['opencode-go/m'])
    })

    it('tools/quota.mjs:被擋之角色列印其自己之門檻(agents.<role>.quotaMaxPercent 優先於 --max);--max 覆寫預設門檻;未給時取 95', () => {
        let a = mkProject('quotaRole', (st) => {
            st.agents.node.quotaMaxPercent = 60
            delete st.agents.node.fallback
        })
        let r = runCli(a, ['tools', 'quota.mjs'], ['--max', '95'], { usage: usageOf(70), results: ['ok'] })
        assert(/【已達起跑門檻 60%】/.test(r.out) && !/【已達起跑門檻 95%】/.test(r.out), r.out)
        let b = mkProject('quotaMax', (st) => {
            delete st.agents.node.fallback
        })
        let r2 = runCli(b, ['tools', 'quota.mjs'], ['--max', '50'], { usage: usageOf(60), results: ['ok'] })
        assert(/【已達起跑門檻 50%】/.test(r2.out) && /此刻起跑: 會被擋下/.test(r2.out), r2.out)
        let r3 = runCli(b, ['tools', 'quota.mjs'], [], { usage: usageOf(60), results: ['ok'] })
        assert(/此刻起跑: 不會被額度擋下\(起跑門檻 95%\)/.test(r3.out) && !/【已達起跑門檻/.test(r3.out), r3.out)
    })

    it('tools/quota.mjs:印出重置時刻(resetsAt);未給 --probe 不探測;給 --probe 則探測備援並於不可用時回報會被擋下', () => {
        root = mkProject('quotaTool')
        let r = runCli(root, ['tools', 'quota.mjs'], [], { usage: usageOf(97), results: ['quota'] })
        assert(/weekly 97%\(重置 2026-01-05T00:00Z\)/.test(r.out) && /此刻起跑: 不會被額度擋下/.test(r.out), r.out)
        assert.equal(r.calls.filter((c) => c.fn === 'dispatchOpencode').length, 0)
        let r2 = runCli(root, ['tools', 'quota.mjs'], ['--probe'], { usage: usageOf(97), results: ['quota'] })
        assert(/此刻起跑: 會被擋下/.test(r2.out) && /備援/.test(r2.out), r2.out)
        assert.deepEqual(r2.calls.filter((c) => c.fn === 'dispatchOpencode').map((c) => c.model), ['opencode/m-free'])
        let r3 = runCli(root, ['tools', 'quota.mjs'], ['--probe'], { usage: usageOf(97), results: ['ok'] })
        assert(/此刻起跑: 不會被額度擋下/.test(r3.out), r3.out)
    })
})
