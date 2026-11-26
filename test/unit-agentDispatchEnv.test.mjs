import assert from 'assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import { FD_ROOT, makeTmp, writeSynthLedger } from './tools/synthLedger.mjs'
import { makeDispatch } from '../src/arsi/dispatchers.mjs'


//派工器設 agent 之角色之環境變數(規則 R-RUN-11)
//  ①接線(不用替身): 以真之 w-dispatch-ai 經 makeDispatch 派 node(opencode)、dream(claude)與其他角色; 外部 CLI(opencode、claude)以「記下所見環境」之程式代之
//    (置於 PATH 之首; 不連網、不讀帳號)—— 驗子行程看得到角色(且本行程之其他環境變數照常帶入)、其他角色不帶、本行程之環境不被改動
//    真之 w-dispatch-ai 不是本套件之相依: 取環境變數 WTA_TEST_WDA_DIR 所指之套件夾, 未給則取 dispatch.skillsRoot 之預設位置(家目錄下之 .claude/skills); 皆無則略過
//    (w-dispatch-ai 之 CLI 守門於系統暫存夾寫預約票: 本組把暫存夾之環境變數暫指到本測試之暫存夾)
//  ②整輪(假 agent): 合成專案以 g_rsi.mjs --mode round 起一輪; 派工套件為替身, 其 dispatchClaude 依 w-dispatch-ai 之語義(opt.env 併入子行程之環境; ①實證)
//    起「假 agent」子行程 —— 假節點執行 g_rsi.mjs --mode validate(被拒)後照常交付, 假做夢執行 --mode board(被拒); 驗節點文件之迴圈檢查列出該指令
let wdaSrc = process.env.WTA_TEST_WDA_DIR || path.join(os.homedir(), '.claude', 'skills', 'node_modules', 'w-dispatch-ai')

//mkFakeCli, 於 binDir 建名為 name 之假 CLI(Windows: npm 之 cmd-shim 之形, 由 wsemi 之 execCli 解析入口後以 node 執行; 其他平台: 可執行之 sh)
let mkFakeCli = (binDir, name, body) => {
    let jsDir = path.join(binDir, 'node_modules', 'fake')
    fs.mkdirSync(jsDir, { recursive: true })
    fs.writeFileSync(path.join(jsDir, `${name}.cjs`), body)
    if (process.platform === 'win32') {
        fs.writeFileSync(path.join(binDir, `${name}.cmd`), `@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\fake\\${name}.cjs" %*\r\n`)
    }
    else {
        let fp = path.join(binDir, name)
        fs.writeFileSync(fp, `#!/bin/sh\nexec "${process.execPath}" "${path.join(jsDir, `${name}.cjs`)}" "$@"\n`)
        fs.chmodSync(fp, 0o755)
    }
}
let recBody = (name) => `const fs = require('fs')
const path = require('path')
try { fs.readFileSync(0) } catch (err) {}
const v = (k) => (process.env[k] === undefined ? null : process.env[k])
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ cli: '${name}', role: v('ARSI_AGENT_ROLE'), sentinel: v('WTA_SEAM_SENTINEL') }) + '\\n')
process.stdout.write('ok\\n')
`

describe('派工器之接線:真 w-dispatch-ai 把角色之環境變數交給 agent 子行程(外部 CLI 以記錄環境之程式代之)', function () {
    this.timeout(900000)
    let t
    before(function () {
        if (!fs.existsSync(path.join(wdaSrc, 'package.json'))) {
            this.skip()
        }
        t = makeTmp('agentDispatchEnv')
    })
    after(() => {
        if (t) {
            t.cleanup()
        }
    })

    it('node(opencode)⇒ 子行程見 ARSI_AGENT_ROLE=node;dream(claude)⇒ dream;其他角色不帶;本行程之其他環境變數照常帶入;派工後本行程之環境不變', async () => {
        let skills = path.join(t.dir, 'skills')
        fs.cpSync(wdaSrc, path.join(skills, 'node_modules', 'w-dispatch-ai'), { recursive: true, filter: (p) => !path.relative(wdaSrc, p).split(path.sep).includes('node_modules') })
        let binDir = path.join(t.dir, 'bin')
        fs.mkdirSync(binDir, { recursive: true })
        mkFakeCli(binDir, 'opencode', recBody('opencode'))
        mkFakeCli(binDir, 'claude', recBody('claude'))
        let osTmp = path.join(t.dir, 'ostmp')
        fs.mkdirSync(osTmp, { recursive: true })
        let keys = ['PATH', 'TEMP', 'TMP', 'TMPDIR', 'WTA_SEAM_SENTINEL', 'ARSI_AGENT_ROLE']
        let saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
        process.env.PATH = `${binDir}${path.delimiter}${saved.PATH || ''}`
        for (let k of ['TEMP', 'TMP', 'TMPDIR']) {
            process.env[k] = osTmp
        }
        process.env.WTA_SEAM_SENTINEL = 'seam-1'
        delete process.env.ARSI_AGENT_ROLE
        let calls = () => fs.readFileSync(path.join(binDir, 'node_modules', 'fake', 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s))
        try {
            let wda = createRequire(import.meta.url)(path.join(skills, 'node_modules', 'w-dispatch-ai'))
            let oc = wda.providers.find((p) => p.kind === 'opencode' && p.provider === 'opencode')
            assert(oc, '真 w-dispatch-ai 之條目表須有免金鑰之 opencode 條目')
            let d = makeDispatch({ agents: { node: { kind: 'opencode', id: oc.id, timeoutMin: 5 }, dream: { kind: 'claude', model: 'claude-x', effort: 'low', timeoutMin: 5, trace: false }, audit: { kind: 'claude', model: 'claude-x', effort: 'low', timeoutMin: 5, trace: false } }, skillsRoot: skills, envFile: null, cwd: binDir })
            let rn = await d('node', { prompt: 'p', tag: 't1', logFile: path.join(t.dir, 'logs', 'node.log') })
            assert.equal(rn.ok, true, JSON.stringify(rn))
            let rd = await d('dream', { prompt: 'p', tag: 't2', logFile: path.join(t.dir, 'logs', 'dream.log') })
            assert.equal(rd.ok, true, JSON.stringify(rd))
            let ra = await d('audit', { prompt: 'p', tag: 't3', logFile: path.join(t.dir, 'logs', 'audit.log') })
            assert.equal(ra.ok, true, JSON.stringify(ra))
            assert.deepStrictEqual(calls(), [{ cli: 'opencode', role: 'node', sentinel: 'seam-1' }, { cli: 'claude', role: 'dream', sentinel: 'seam-1' }, { cli: 'claude', role: null, sentinel: 'seam-1' }])
            assert.strictEqual(process.env.ARSI_AGENT_ROLE, undefined, '本行程之環境不帶角色(迴圈其後起之評估與驗證之子行程不繼承)')
        }
        finally {
            for (let k of keys) {
                if (saved[k] === undefined) {
                    delete process.env[k]
                }
                else {
                    process.env[k] = saved[k]
                }
            }
        }
    })
})

describe('進入檔之拒跑:假 agent 之整輪(節點執行寫入模式被擋,節點文件之迴圈檢查列出之)', function () {
    this.timeout(900000)
    let t
    let root
    before(() => {
        t = makeTmp('agentRound')
    })
    after(() => {
        t.cleanup()
    })
    let STUB = `const { spawnSync } = require('child_process')
module.exports = {
    providers: [],
    readEnvFile: () => ({}),
    opencodeGoUsage: async () => ({ ok: true, usage: {} }),
    getQuotaClaude: async () => ({ ok: true, windows: [{ label: 'week', usedPercent: 1, resetAt: '' }] }),
    dispatchOpencode: async () => ({ ok: false, errorType: 'exec', error: 'unused', stdout: '', durationMs: 1 }),
    //w-dispatch-ai 之語義: opt.env 併入子行程之環境(以本行程之環境為底); prompt 走標準輸入; 標準輸出交 onStdout
    dispatchClaude: async (prompt, opts) => {
        const r = spawnSync(process.execPath, [process.env.WTA_AGENT_EMU], { cwd: opts.cwd, input: prompt, env: { ...process.env, ...(opts.env || {}) }, encoding: 'utf8', windowsHide: true, timeout: 600000 })
        if (opts.onStdout && r.stdout) {
            opts.onStdout(r.stdout)
        }
        return r.status === 0 ? { ok: true, stdout: r.stdout, durationMs: 1 } : { ok: false, errorType: 'exec', error: 'Exit code ' + r.status, stdout: '', durationMs: 1 }
    },
}
`
    //假 agent: 節點 —— 先執行 g_rsi.mjs --mode validate(應被拒), 再照範例交付(pick.mjs、完整評估、node.json); 做夢 —— 執行 --mode board(應被拒)後以失敗結束
    //  每個工具呼叫以 claude 之逐步事件之形寫到標準輸出(派工器併入 agent_a1.log, 迴圈之操作掃描讀它); 子指令之結果另記於 WTA_AGENT_REC
    let EMU = `const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const prompt = fs.readFileSync(0, 'utf8')
const root = process.cwd()
const out = []
const say = (command) => out.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } }))
const run = (args) => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true })
const rec = (o) => fs.appendFileSync(process.env.WTA_AGENT_REC, JSON.stringify({ ...o, role: process.env.ARSI_AGENT_ROLE === undefined ? null : process.env.ARSI_AGENT_ROLE }) + '\\n')
const wdRel = /請閱讀 (\\S+)\\/brief\\.md/.exec(prompt)[1]
const wd = path.resolve(root, wdRel)
if (/^dream_/.test(path.basename(wd))) {
    say('node g_rsi.mjs --mode board')
    const b = run([path.join(root, 'g_rsi.mjs'), '--mode', 'board'])
    rec({ who: 'dream', status: b.status, stdout: b.stdout })
    process.stdout.write(out.join('\\n') + '\\n')
    process.exit(1)
}
say('node g_rsi.mjs --mode validate 2>&1 | tail -40')
const v = run([path.join(root, 'g_rsi.mjs'), '--mode', 'validate'])
rec({ who: 'node', status: v.status, stdout: v.stdout })
say('ls -R rsi')
const brief = fs.readFileSync(path.join(wd, 'brief.md'), 'utf8')
const arms = /export const meta = \\{ arms: \\[([^\\]]*)\\]/.exec(brief)[1]
fs.writeFileSync(path.join(wd, 'pick.mjs'), fs.readFileSync(path.join(root, 'examples', 'pick_example.mjs'), 'utf8').replace(/arms: \\[\\]/, 'arms: [' + arms + ']'))
say('node g_eval.mjs --pick ' + wdRel + '/pick.mjs --mode full --out ' + wdRel + '/result_full.json')
const e = run([path.join(root, 'g_eval.mjs'), '--pick', path.join(wd, 'pick.mjs'), '--mode', 'full', '--out', path.join(wd, 'result_full.json')])
rec({ who: 'node-eval', status: e.status })
const r = JSON.parse(fs.readFileSync(path.join(wd, 'result_full.json'), 'utf8'))
const doc = {
    plan: { target: '假節點', approach: '套用範例挑選模組', hypotheses: ['流程可走完'] },
    code: { artifact: wdRel + '/pick.mjs', files: [], reused: ['g_eval.mjs'], notes: '中性預設', inactiveArms: [] },
    results: { claimed: { S: r.score.S, ladder: r.score.ladder, eqYrMean: r.metrics.op.eqYr.mean, eqYrMin: r.metrics.op.eqYr.min, monthlyOrders: r.metrics.op.monthlyOrders.mean, peakHold: r.metrics.op.peakHold.max, nullP: r.metrics.null.p, selHash: r.metrics.selHash }, experiments: [{ what: '範例參數', outcome: 'S ' + r.score.S }] },
    conclusion: { outcome: 'neutral', summary: '假節點', findings: [], limitations: [], nextIdeas: [] },
}
fs.writeFileSync(path.join(wd, 'node.json'), JSON.stringify(doc, null, 1))
process.stdout.write(out.join('\\n') + '\\n' + JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'DONE ' + wdRel + '/node.json' }) + '\\n')
`
    let shim = (cli) => `import path from 'path'\nimport { fileURLToPath } from 'url'\nprocess.env.ARSI_ROOT = path.dirname(fileURLToPath(import.meta.url))\nawait import(${JSON.stringify(pathToFileURL(path.join(FD_ROOT, 'src', 'cli', `${cli}.mjs`)).href)})\n`
    let run = (args, extra = {}) => {
        let env = { ...process.env, ARSI_ROOT: root, WTA_AGENT_EMU: path.join(t.dir, 'agent_emu.cjs'), WTA_AGENT_REC: path.join(t.dir, 'agent_rec.jsonl'), ...extra }
        delete env.ARSI_AGENT_ROLE
        let r = spawnSync(process.execPath, args, { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 800000 })
        return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
    }

    it('假節點之 g_rsi.mjs --mode validate 被拒(離開碼 2、角色 node);假做夢之 --mode board 被拒(角色 dream);節點文件(.json 與 .md)之迴圈檢查列出該指令;控制端之重掃與唯讀對照保留之', () => {
        root = path.join(t.dir, 'proj')
        fs.mkdirSync(path.join(root, 'skills', 'node_modules', 'w-dispatch-ai'), { recursive: true })
        fs.mkdirSync(path.join(root, 'arms'), { recursive: true })
        fs.copyFileSync(path.join(FD_ROOT, 'arms', 'base.json'), path.join(root, 'arms', 'base.json'))
        fs.mkdirSync(path.join(root, 'examples'), { recursive: true })
        fs.copyFileSync(path.join(FD_ROOT, 'examples', 'pick_example.mjs'), path.join(root, 'examples', 'pick_example.mjs'))
        writeSynthLedger(path.join(root, 'ledger'), { n: 60, nBars: 2400, seed: 7 })
        let st = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
        st.periods = { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } }
        st.eval = { ...st.eval, ledgerDir: './ledger', warmupDays: 60, phases: [0, 3], horizons: [7], nullDraws: 4, replicaSeeds: 1 }
        delete st.eval.fitEnd
        st.dispatch = { skillsRoot: path.join(root, 'skills'), envFile: path.join(root, '.env') }
        st.rsi = { ...st.rsi, nodesPerRound: 1, parallelNodes: 1, autoFill: false }
        st.resources = {}
        st.agents = { node: { kind: 'claude', model: 'claude-x', effort: 'low', timeoutMin: 10 }, dream: { kind: 'claude', model: 'claude-x', effort: 'low', timeoutMin: 10 } }
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(st, null, 1))
        fs.writeFileSync(path.join(root, 'skills', 'node_modules', 'w-dispatch-ai', 'package.json'), JSON.stringify({ name: 'w-dispatch-ai', main: 'index.cjs' }))
        fs.writeFileSync(path.join(root, 'skills', 'node_modules', 'w-dispatch-ai', 'index.cjs'), STUB)
        fs.writeFileSync(path.join(t.dir, 'agent_emu.cjs'), EMU)
        for (let c of ['rsi', 'eval']) {
            fs.writeFileSync(path.join(root, `g_${c}.mjs`), shim(c))
        }
        let r = run([path.join(root, 'g_rsi.mjs'), '--mode', 'round'])
        let recs = fs.readFileSync(path.join(t.dir, 'agent_rec.jsonl'), 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s))
        let nodeRec = recs.find((x) => x.who === 'node')
        assert(nodeRec, r.out)
        assert.deepEqual([nodeRec.role, nodeRec.status], ['node', 2], JSON.stringify(nodeRec))
        assert(/^拒跑: g_rsi\.mjs 之此模式 會寫入專案之檔或起行程, 不得由 agent 執行\(ARSI_AGENT_ROLE=node;/.test(nodeRec.stdout), nodeRec.stdout)
        assert.deepEqual(recs.filter((x) => x.who === 'node-eval').map((x) => [x.role, x.status]), [['node', 0]], '任務書之評估照常(agent 之子行程帶角色亦不擋)')
        let dreamRec = recs.find((x) => x.who === 'dream')
        assert(dreamRec && dreamRec.role === 'dream' && dreamRec.status === 2 && /^拒跑: g_rsi\.mjs 之此模式 /.test(dreamRec.stdout), JSON.stringify(dreamRec))
        let fdNodes = path.join(root, 'rsi', 'records', 'nodes')
        let docs = fs.readdirSync(fdNodes).filter((f) => /\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(fdNodes, f), 'utf8')))
        assert.equal(docs.length, 1, r.out)
        let want = '觸及禁區: 執行迴圈之寫檔入口(指令或路徑): node g_rsi.mjs --mode validate 2>&1 | tail -40'
        let wantR = '存取其他節點之工作夾(遞迴列出狀態根): ls -R rsi'
        let issues = docs[0].harness.checks.issues
        assert(issues.includes(want) && issues.includes(wantR), JSON.stringify(issues))
        assert(!issues.some((x) => /g_eval/.test(x)), '任務書之評估指令不列')
        let md = fs.readFileSync(path.join(fdNodes, `${docs[0].nodeId}.md`), 'utf8')
        assert(md.split('\n').some((l) => l.startsWith('- 迴圈檢查: ') && l.includes(want)), '節點文件(.md)之迴圈檢查列出')
        //控制端(不帶角色): 唯讀之對照與重掃保留此項
        let sc = run([path.join(FD_ROOT, 'src', 'tools', 'scanCheck.mjs')])
        assert(/ 相同 \| 現行規則 /.test(sc.out) && /與節點文件不同者 0 份/.test(sc.out), sc.out)
        //重掃(rescanTraces)以現行規則之結果取代掃描項(其餘檢查項排在前; 次序之改變為既有行為)⇒ 掃描項之集合不變、仍含此項
        let v = run([path.join(root, 'g_rsi.mjs'), '--mode', 'validate'])
        assert.equal(v.status, 0, v.out)
        let isScan = (s) => /^(觸及禁區|寫到工作夾外|存取其他節點之工作夾|規劃於評估後才寫)/.test(s)
        let doc2 = JSON.parse(fs.readFileSync(path.join(fdNodes, `${docs[0].nodeId}.json`), 'utf8'))
        assert.deepEqual(doc2.harness.checks.issues.filter(isScan).sort(), issues.filter(isScan).sort())
        assert(doc2.harness.checks.issues.includes(want) && doc2.harness.checks.issues.includes(wantR))
    })
})
