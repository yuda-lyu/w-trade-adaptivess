import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { getSettings, inputMsgOf } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { makeTexts } from '../src/domain/texts.mjs'
import { planGateOf } from '../src/arsi/runner.mjs'
import { specHash } from '../src/engineApi.mjs'
import { FD_ROOT, makeTmp, writeSynthLedger } from './tools/synthLedger.mjs'


//補位之開關(規則 R-RUN-9 ④、R-RUN-13)
//  規格: ①只做夢輪次不排補位(恆改):起跑前之乾跑與正式起輪之計畫皆不含補位之載體 ⇒ 前緣無待執行之方向、無待重審、無認領中者受理並只跑做夢(正式起輪之計畫 0 個節點);
//          前緣有 proposed 者仍 dream-only-busy;不以預算歸零(引擎之策略把 arms: 0 當成預設 8)
//        ②settings.rsi.backfill(布林;未給或 true = 現行;false = 一般輪次亦不排補位 ⇒ 計畫只含前緣之方向;前緣為空 ⇒ frontier-empty);給了而不是布林 ⇒ invalid rsi.backfill: must be boolean
//        ③做夢任務書之「補位與提案之關係」於 false 時改述;--mode dry 照實(false 時另印一句)
//  與本案有關之設定(formGate、backfill、exposure、rankBy)於夾具明設
describe('補位之開關(規則 R-RUN-9 ④、R-RUN-13)', function () {
    this.timeout(180000)
    let t
    before(() => {
        t = makeTmp('backfill')
    })
    after(() => {
        t.cleanup()
    })
    let mk = ({ backfill, inject = {} } = {}) => {
        let st = getSettings()
        let d = path.join(t.dir, `proj_${Math.random().toString(36).slice(2, 8)}`)
        st.resources = {}
        st.rsi = { ...st.rsi, root: path.join(d, 'rsi'), docLimits: false, autoFill: false, maxArmsPerNode: 4, formGate: false, exposure: true, rankBy: 'key', ...(backfill === 'unset' ? {} : { backfill }) }
        if (backfill === 'unset') {
            delete st.rsi.backfill
        }
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synthFill' }), 'utf8')
        let P = makeProject(st, { dispatch: async () => ({ ok: false }), gate: null, catalogFile: path.join(d, 'catalog.json'), ...inject })
        P.rsi.init()
        return { P, st }
    }
    let pushDir = (P, spec, why) => P.rsi.store.pushFrontier([{ spec, specHash: specHash(spec), kind: 'arm', reason: `做夢 r001:${why}`, origin: { topic: 'dream', operator: 'dream', round: 1 }, priority: 1 }])

    it('設定:未給 / null / true / false 照組裝(P.backfill);給了而不是布林 ⇒ 拋 invalid rsi.backfill: must be boolean(不帶輸入值;inputMsgOf 認得)', () => {
        for (let [v, want] of [['unset', true], [null, true], [true, true], [false, false]]) {
            assert.equal(mk({ backfill: v }).P.backfill, want, String(v))
        }
        for (let bad of ['false', 'true', 0, 1, '', 'off', [], {}]) {
            let err = null
            try {
                mk({ backfill: bad })
            }
            catch (e) {
                err = e
            }
            assert(err && err.message === 'invalid rsi.backfill: must be boolean', `${JSON.stringify(bad)}: ${err && err.message}`)
            assert.equal(inputMsgOf(err), 'invalid rsi.backfill: must be boolean')
        }
    })

    it('載體:backfill = false 或組裝時注入 backfill: false(只做夢輪次)⇒ {};其餘(未給、true;注入 true 或未注入)⇒ 未試之臂之載體', () => {
        assert.deepEqual(mk({ backfill: false }).P.domain.carriers(), {})
        assert.deepEqual(mk({ backfill: true, inject: { backfill: false } }).P.domain.carriers(), {})
        assert.deepEqual(mk({ backfill: 'unset', inject: { backfill: false } }).P.domain.carriers(), {})
        for (let P of [mk({ backfill: true }).P, mk({ backfill: 'unset' }).P, mk({ backfill: true, inject: { backfill: true } }).P]) {
            let cs = P.domain.carriers()
            assert(Object.keys(cs).length > 30, `未試之臂之載體 ${Object.keys(cs).length} 個`)
            assert.deepEqual(cs.A01_nt, { arms: ['A01_nt'], base: null })
        }
    })

    it('乾跑之計畫:前緣有 1 條方向而有未試之臂 ⇒ 開啟者補位至每輪之節點數、關閉者只含該方向;前緣為空而關閉 ⇒ 0 個節點(閘門 frontier-empty);引擎之策略不因此展開算子之子節點', async () => {
        let on = mk({ backfill: true }).P
        let off = mk({ backfill: false }).P
        for (let P of [on, off]) {
            pushDir(P, { arms: ['C22_calendar'], base: null }, '新資訊源')
        }
        let a = await on.rsi.explore({ dry: true, arms: 3, novelty: 3 })
        let b = await off.rsi.explore({ dry: true, arms: 3, novelty: 3 })
        assert.equal(a.items.length, 3)
        assert.equal(a.items.filter((x) => /^載體 /.test(x.reason)).length, 2)
        assert.deepEqual(b.items.map((x) => x.spec), [{ arms: ['C22_calendar'], base: null }])
        assert(/^前緣:/.test(b.items[0].reason))
        let empty = mk({ backfill: false }).P
        let c = await empty.rsi.explore({ dry: true, arms: 3, novelty: 3 })
        assert.deepEqual([c.items.length, c.rejected.length], [0, 0])
        assert.equal(planGateOf({ nItems: c.items.length, nRejected: c.rejected.length, nReaudit: 0, nClaimed: 0 }).reason, 'frontier-empty')
        //有已執行之節點(引擎之策略之可展開之父)時亦不展開算子(arms = novelty ⇒ 展開額度 0)
        let spec = { arms: ['A01_nt'], base: null }
        empty.rsi.store.putNode({ id: empty.idOf(spec), spec, specHash: specHash(spec), status: 'executed', parents: [], round: 1, raw: { selHash: 'x', metrics: null }, score: { S: 20, ladder: 1, flags: { vetoed: false, why: [] } }, evidence: { trust: 'trusted' } })
        let e2 = await empty.rsi.explore({ dry: true, arms: 3, novelty: 3 })
        assert.equal(e2.items.length, 0, JSON.stringify(e2.items.map((x) => x.reason)))
    })

    it('做夢任務書之「補位與提案之關係」:false ⇒ 改述為不補位(每輪之節點數 = 方向數);未給與 true ⇒ 原句', () => {
        let st0 = getSettings()
        let ctx = (st) => ({ round: 2, nodeIds: ['n1'], reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r002'), context: { nodes: [{ nodeId: 'n1', arms: ['A04_act'], base: null, S: 1, worst: 0, excess: 0, ladder: 0, vetoed: false, claimedS: 1, nEvals: 1, nFull: 1, nFullSel: 1, issues: [], from: null, type: 'explore', docMd: 'd.md', workDir: 'rsi/work/n1' }], failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '', toolbox: null } })
        let OLD = '  - **補位與提案之關係**:你給之方向不足每輪之節點數時,迴圈只以**尚未試過之臂**補位(取法 / 執行層之臂以樹上最佳之可信成品為底、對照即該成品;其餘為單臂);未試之臂用完後不再補位 —— 屆時每輪之節點數 = 你給之方向數,向外探勘之空間要靠新臂之提案補充。'
        let NEW = '  - **補位與提案之關係**:補位已關閉(設定 `rsi.backfill` = `false`):迴圈不以未試之臂補位 —— 每輪之節點數 = 你給之方向數(至多每輪之節點數);未試之臂只經你之方向試,向外探勘之空間要靠你之方向與新臂之提案。'
        for (let [v, want] of [[false, NEW], [true, OLD], ['unset', OLD]]) {
            let rsi = { ...st0.rsi, guides: false, formGate: false, exposure: true, rankBy: 'key', backfill: v }
            if (v === 'unset') {
                delete rsi.backfill
            }
            let st = { ...st0, rsi }
            let ls = makeTexts({ st, FD_ROOT: st.FD_ROOT, nStrategies: 70000 }).dreamBrief(ctx(st)).split('\n')
            assert.equal(ls.filter((l) => l.startsWith('  - **補位與提案之關係**')).length, 1)
            assert(ls.includes(want), String(v))
        }
    })
})

//命令列之接線(合成專案根、替身派工套件; 同 unit-dreamOnly 之作法)
describe('補位之開關:命令列 g_rsi.mjs(只做夢輪次之受理、backfill = false 之一般輪次與乾跑)', function () {
    this.timeout(300000)
    let t
    before(() => {
        t = makeTmp('backfillCli')
    })
    after(() => {
        t.cleanup()
    })
    let STUB = `
const fs = require('fs')
const path = require('path')
const rec = (x) => fs.appendFileSync(process.env.QSTUB_LOG, JSON.stringify(x) + '\\n')
module.exports = {
    providers: [{ id: 'ocgo:opencode-go/m', kind: 'opencode', provider: 'opencode-go', model: 'opencode-go/m', envVar: 'OPENCODE_GO_KEYS' }],
    readEnvFile: () => ({ OPENCODE_GO_KEYS: 'oc_sk_TESTKEY00000002' }),
    opencodeGoUsage: async () => ({ ok: true, limited: false, usage: { rolling: { percent: 0, resetsAt: '2026-01-01T05:00:00.000Z' }, weekly: { percent: 10, resetsAt: '2026-01-05T00:00:00.000Z' } } }),
    dispatchOpencode: async (prompt, opts) => {
        rec({ fn: 'dispatchOpencode' })
        return { ok: false, errorType: 'exec', error: 'Exit code 1', stdout: '', durationMs: 5 }
    },
    dispatchClaude: async (prompt, opts) => {
        const m = /請閱讀 (\\S+)\\/brief\\.md/.exec(prompt)
        const wd = path.resolve(opts.cwd, m[1])
        const tpl = JSON.parse(fs.readFileSync(path.join(wd, 'dream.template.json'), 'utf8'))
        rec({ fn: 'dispatchClaude', nAudits: tpl.audits.length })
        fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify({ audits: [], synthesis: { summary: '替身做夢', worked: [], failed: [], patterns: [], prevDirections: [] }, guidance: { directions: [], avoid: [], openQuestions: [], improvements: [], armProposals: [] }, expansion: [], docsUpdated: [] }))
        for (const f of ['sgud/state/state.md', 'sgud/exp/experience.md']) {
            fs.mkdirSync(path.dirname(path.join(opts.cwd, f)), { recursive: true })
            fs.writeFileSync(path.join(opts.cwd, f), '替身做夢所更新\\n')
        }
        return { ok: true, stdout: 'DONE', durationMs: 5 }
    },
    getQuotaClaude: async () => ({ ok: true, windows: [{ label: 'week', usedPercent: 10, resetAt: '' }] }),
}
`
    //mkProject, 合成專案根: 臂目錄之可選臂皆未試(補位有載體); backfill 依參數(明設); 與本案有關之其餘設定明設
    let mkProject = (name, { backfill }) => {
        let dir = path.join(t.dir, name)
        fs.mkdirSync(path.join(dir, 'skills', 'node_modules', 'w-dispatch-ai'), { recursive: true })
        fs.mkdirSync(path.join(dir, 'arms'), { recursive: true })
        fs.copyFileSync(path.join(FD_ROOT, 'arms', 'base.json'), path.join(dir, 'arms', 'base.json'))
        writeSynthLedger(path.join(dir, 'ledger'), { n: 6, nBars: 400, seed: 7 })
        let st = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
        st.eval.ledgerDir = './ledger'
        st.dispatch = { skillsRoot: path.join(dir, 'skills'), envFile: path.join(dir, '.env') }
        st.rsi = { ...st.rsi, nodesPerRound: 2, parallelNodes: 1, formGate: false, exposure: true, rankBy: 'key', backfill, docLimits: false }
        st.resources = {}
        st.agents = { node: { kind: 'opencode', id: 'ocgo:opencode-go/m', variant: 'high', timeoutMin: 1 }, dream: { kind: 'claude', model: 'claude-opus-5-5', effort: 'xhigh', timeoutMin: 1 } }
        fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(st, null, 1))
        fs.writeFileSync(path.join(dir, '.env'), 'OPENCODE_GO_KEYS=oc_sk_TESTKEY00000002\n')
        fs.writeFileSync(path.join(dir, 'skills', 'node_modules', 'w-dispatch-ai', 'package.json'), JSON.stringify({ name: 'w-dispatch-ai', main: 'index.cjs' }))
        fs.writeFileSync(path.join(dir, 'skills', 'node_modules', 'w-dispatch-ai', 'index.cjs'), STUB)
        fs.writeFileSync(path.join(dir, 'why.txt'), '工具已更新\n請重新彙整\n', 'utf8')
        return dir
    }
    let seedFrontier = (dir, spec) => {
        let st = getSettings()
        st.rsi = { ...st.rsi, root: path.join(dir, 'rsi'), docLimits: false, formGate: false, backfill: true, exposure: true, rankBy: 'key' }
        st.records = { nodeDir: path.join(dir, 'rsi/records/nodes'), dreamDir: path.join(dir, 'rsi/records/dreams'), trashDir: path.join(dir, 'rsi/records/trash'), workDir: path.join(dir, 'rsi/work'), toolboxDir: path.join(dir, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(dir, 'ledger')
        let P = makeProject(st, { dispatch: async () => ({ ok: false, error: 'seed' }), gate: null, catalogFile: path.join(dir, 'seed_catalog.json') })
        P.rsi.init()
        P.rsi.store.pushFrontier([{ spec, specHash: specHash(spec), kind: 'arm', reason: '做夢 r000:測試用之方向', origin: { topic: 'dream', operator: 'dream', round: 0 }, priority: 1 }])
    }
    let runCli = (dir, args) => {
        let fpLog = path.join(dir, 'calls.log')
        fs.rmSync(fpLog, { force: true })
        let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'rsi.mjs'), ...args], { cwd: t.dir, env: { ...process.env, ARSI_ROOT: dir, QSTUB_LOG: fpLog }, windowsHide: true, encoding: 'utf8', timeout: 240000 })
        let lines = (fp) => (fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8').split(/\r?\n/).filter(Boolean).map((s) => JSON.parse(s)) : [])
        return { status: r.status, out: `${r.stdout}\n${r.stderr}`, calls: lines(fpLog), events: lines(path.join(dir, 'rsi', 'logs', 'events.jsonl')) }
    }
    let roundDirs = (dir) => (fs.existsSync(path.join(dir, 'rsi', 'rounds')) ? fs.readdirSync(path.join(dir, 'rsi', 'rounds')) : [])

    it('只做夢輪次、前緣無方向而有未試之臂(補位有載體)⇒ 受理:做夢一次(審計 0)、正式起輪之計畫 0 個節點(不只閘門放行)、不派節點、round-done(ok、dreamOnly)', () => {
        let dir = mkProject('dreamOnlyUntried', { backfill: true })
        let r = runCli(dir, ['--mode', 'round', '--dream-only', '--file', path.join(dir, 'why.txt')])
        assert.equal(r.status, 0, r.out)
        assert.deepEqual(r.events.map((e) => e.event), ['run-start', 'round-done', 'run-done'], r.out)
        assert.deepEqual([r.events[1].ok, r.events[1].dreamOnly, r.events[1].nExecuted], [true, true, 0], JSON.stringify(r.events[1]))
        assert.deepEqual(r.calls, [{ fn: 'dispatchClaude', nAudits: 0 }], '只派做夢、不派節點')
        let plan = JSON.parse(fs.readFileSync(path.join(dir, 'rsi', 'rounds', 'r001', 'plan.json'), 'utf8'))
        assert.deepEqual(plan.items, [], '正式起輪之計畫 0 個節點')
        //其後之一般輪次(補位開啟)照常補位起輪
        let d2 = runCli(dir, ['--mode', 'dry'])
        assert(/計畫\(2 個節點/.test(d2.out) && /\| 載體 /.test(d2.out), d2.out)
    })

    it('只做夢輪次而前緣有待執行之方向 ⇒ 仍 dream-only-busy(不起、不派工)', () => {
        let dir = mkProject('dreamOnlyBusy', { backfill: true })
        seedFrontier(dir, { arms: ['C22_calendar'], base: null })
        let r = runCli(dir, ['--mode', 'round', '--dream-only', '--file', path.join(dir, 'why.txt')])
        assert.equal(r.status, 0, r.out)
        assert.deepEqual(r.events.map((e) => e.event), ['run-start', 'run-done'], r.out)
        assert.deepEqual([r.events[1].rounds, r.events[1].reason], [0, 'dream-only-busy'])
        assert(/下一輪之計畫有 1 個節點/.test(r.events[1].stopped), r.events[1].stopped)
        assert.deepEqual(roundDirs(dir), [])
        assert.deepEqual(r.calls, [])
    })

    it('backfill = false:前緣為空之一般輪次 ⇒ frontier-empty(不起、不耗輪號);乾跑照實(0 個節點、另印一句);前緣有方向 ⇒ 計畫只含該方向', () => {
        let dir = mkProject('noFill', { backfill: false })
        let r = runCli(dir, ['--mode', 'round'])
        assert.equal(r.status, 0, r.out)
        assert.deepEqual(r.events.map((e) => e.event), ['run-start', 'run-done'], r.out)
        assert.equal(r.events[1].reason, 'frontier-empty')
        assert.deepEqual(roundDirs(dir), [])
        assert.deepEqual(r.calls, [])
        let d = runCli(dir, ['--mode', 'dry'])
        assert.equal(d.status, 0, d.out)
        assert(/計畫\(0 個節點/.test(d.out), d.out)
        assert(d.out.includes('  (補位已關閉:settings.rsi.backfill = false;計畫只含前緣之方向)'), d.out)
        seedFrontier(dir, { arms: ['C22_calendar'], base: null })
        let d2 = runCli(dir, ['--mode', 'dry'])
        assert(/計畫\(1 個節點/.test(d2.out) && /C22_calendar/.test(d2.out) && !/\| 載體 /.test(d2.out), d2.out)
        //補位開啟之乾跑不印該句(逐字不變)
        let dirOn = mkProject('withFill', { backfill: true })
        let d3 = runCli(dirOn, ['--mode', 'dry'])
        assert(!d3.out.includes('補位已關閉'), d3.out)
    })
})
