import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { spawnSync } from 'child_process'
import { FD_ROOT, makeTmp, writeSynthLedger } from './tools/synthLedger.mjs'
import { AGENT_ROLE_ENV, AGENT_ROLES, agentRoleOf, agentEnvOf } from '../src/arsi/agentRole.mjs'
import { ENTRY_RULES, entryWrites, guardEntry } from '../src/domain/agentEntries.mjs'


//進入檔之拒跑(規則 R-RUN-11): 派工器於節點與做夢之 agent 子行程設 ARSI_AGENT_ROLE = node / dream; 寫專案之檔或起行程之進入檔與模式見之即拒跑
//  (印一行理由、離開碼 2、不做任何寫入); 唯讀之模式與任務書要 agent 執行之指令(g_eval.mjs、g_toolbox.mjs)照常; 未設此變數者行為逐位不變
//  派工器之接線與假 agent 之整輪見 unit-agentDispatchEnv.test.mjs; 操作掃描之判定見 unit-scanEntryExec.test.mjs

let READ_CASES = [
    ['rsi', []],
    ['rsi', ['--mode', 'status']],
    ['rsi', ['--mode', 'dry']],
    ['rsi', ['--mode=round']],
    ['rsi', ['--mode', 'frontier']],
    ['rsi', ['--mode', 'frontier', '--close']],
    ['rsi', ['--mode', 'frontier', '--close', '0', '--why', 'w']],
    ['rsi', ['--mode', 'frontier', '--close', '', '--rearm', '--to', 'B']],
    ['rsi', ['--mode', 'fill', '--dry', '--only', 'abcdef']],
    //成員穩健性(規則 R-REC-51)之 --no-member 只少算、不改「是否寫檔」之判定: --dry 者仍唯讀
    ['rsi', ['--mode', 'fill', '--dry', '--no-member']],
    ['armDecide', []],
    ['armInactive', []],
    ['exposure', []],
    //成品之形式之補記(規則 R-REC-53): 無引數 = 列出(唯讀)
    ['formSet', []],
    ['rankCompare', []],
    ['briefPreview', []],
    ['quota', ['--max', '90', '--all']],
    ['roundDigest', ['3']],
    ['initProject', ['--root', 'p', '--dry']],
    ['eval', ['--pick', 'p.mjs', '--mode', 'full', '--out', 'o.json']],
    ['toolbox', []],
    ['logEvals', ['a.log']],
    ['scanCheck', []],
    ['nodeAudit', ['--nodes']],
    ['waitEvent', []],
    ['improveTrend', []],
    ['dreamProfile', []],
]
let WRITE_CASES = [
    ['rsi', ['--mode', 'init']],
    ['rsi', ['--mode', 'round', '--nodes', '2']],
    ['rsi', ['--mode', 'round', '--dream-only', '--file', 'x.txt']],
    ['rsi', ['--mode', 'board']],
    ['rsi', ['--mode', 'validate']],
    ['rsi', ['--mode', 'reverify', '--why', 'w']],
    ['rsi', ['--mode', 'extfill']],
    ['rsi', ['--mode', 'fill']],
    //--no-member(規則 R-REC-51)只少算成員穩健性, 其餘之求解窗後段與擴充診斷照寫 ⇒ 仍為寫檔之模式(agent 拒跑)
    ['rsi', ['--mode', 'fill', '--no-member']],
    ['rsi', ['--mode', 'fill', '--no-member', '--only', 'abcdef', '--force']],
    ['rsi', ['--mode', 'frontier', '--close', 'A01_nt', '--why', 'w']],
    ['rsi', ['--mode', 'frontier', '--close', '7']],
    ['rsi', ['--mode', 'frontier', '--rearm', 'A01_nt']],
    ['rsi', ['--mode', 'annotate', '--round', '1', '--file', 'x.txt']],
    ['rsi', ['--mode', 'dirtype', '--round', '1', '--file', 'x.json']],
    ['rsi', ['--mode', 'nosuchmode']],
    ['rsi', ['--mode']],
    ['rsi', ['--mode', '--nodes', '1']],
    ['launch', []],
    ['launch', ['round', '--', 'g_rsi.mjs', '--mode', 'status']],
    ['build', []],
    ['build', ['--train']],
    ['backtest', []],
    ['archiveDocs', []],
    ['buildCatalog', []],
    ['pickStore', []],
    ['searchMap', ['--quiet']],
    ['smokeDispatch', ['node']],
    ['fakeRound', []],
    ['replayCheck', ['abcdef12']],
    ['initProject', ['--root', 'p']],
    ['armDecide', ['--id', 'P001', '--reject', '--why', 'w']],
    ['armInactive', ['--node', 'abcdef', '--arms', 'none', '--why', 'w']],
    ['exposure', ['--node', 'abcdef', '--why', 'w']],
    ['exposure', ['--undo', '--node', 'abcdef', '--why', 'w']],
    ['formSet', ['--node', 'abcdef', '--form', 'mechanism', '--why', 'w']],
    ['formSet', ['--node', 'abcdef', '--form', 'none', '--why', 'w']],
    ['briefPreview', ['--out', 'd']],
    ['quota', ['--probe']],
    ['roundDigest', ['--out']],
]

describe('進入檔之拒跑:角色之環境變數與判定表', function () {
    it('agentRoleOf / agentEnvOf:只認 node 與 dream(大小寫須相符);其他值、空字串、未設皆為 null', () => {
        assert.equal(AGENT_ROLE_ENV, 'ARSI_AGENT_ROLE')
        assert.deepEqual(AGENT_ROLES, ['node', 'dream'])
        assert.equal(agentRoleOf({ ARSI_AGENT_ROLE: 'node' }), 'node')
        assert.equal(agentRoleOf({ ARSI_AGENT_ROLE: 'dream' }), 'dream')
        for (let v of ['', 'NODE', 'Dream', 'audit', '1', ' node']) {
            assert.strictEqual(agentRoleOf({ ARSI_AGENT_ROLE: v }), null, JSON.stringify(v))
        }
        assert.strictEqual(agentRoleOf({}), null)
        assert.strictEqual(agentRoleOf(null), null)
        assert.deepEqual(agentEnvOf('node'), { ARSI_AGENT_ROLE: 'node' })
        assert.deepEqual(agentEnvOf('dream'), { ARSI_AGENT_ROLE: 'dream' })
        for (let r of ['audit', 'probe', '', undefined, 'NODE']) {
            assert.strictEqual(agentEnvOf(r), null, String(r))
        }
    })

    it('entryWrites:寫檔或起行程者為真(g_rsi 之寫入模式、g_launch、g_build、g_backtest、寫檔之工具與旗標);唯讀之模式、任務書之指令與表外之名稱為假', () => {
        for (let [name, args] of WRITE_CASES) {
            assert.equal(entryWrites(name, args), true, `${name} ${args.join(' ')}`)
        }
        for (let [name, args] of READ_CASES) {
            assert.equal(entryWrites(name, args), false, `${name} ${args.join(' ')}`)
        }
        //表之鍵 = 4 個命令列 + 16 個工具(只列出內容之工具與 g_eval、g_toolbox 不在表內; libCheck 為主控專用之唯讀工具〔hindsight〕, 規則 R-EV-48; formSet 為規則 R-REC-53 所加)
        assert.deepEqual(Object.keys(ENTRY_RULES).sort(), ['archiveDocs', 'armDecide', 'armInactive', 'backtest', 'briefPreview', 'build', 'buildCatalog', 'exposure', 'fakeRound', 'formSet', 'initProject', 'launch', 'libCheck', 'pickStore', 'quota', 'replayCheck', 'roundDigest', 'rsi', 'searchMap', 'smokeDispatch'])
        //非陣列之引數視為無引數; 數字引數照字串判
        assert.equal(entryWrites('rsi', null), false)
        assert.equal(entryWrites('armDecide', [5]), true)
        assert.equal(entryWrites('constructor', []), false, '原型鏈上之名稱不算在表內')
    })

    it('guardEntry:角色 + 寫入 ⇒ 印一行理由(不帶輸入值)、以 2 呼叫 exit;唯讀或未設角色 ⇒ 不印、不結束、回 false', () => {
        let run = (name, args, env) => {
            let logs = []
            let codes = []
            let r = guardEntry(name, args, { env, log: (s) => logs.push(s), exit: (c) => codes.push(c) })
            return { r, logs, codes }
        }
        let a = run('rsi', ['--mode', 'validate', '--why', 'SECRET_INPUT_VALUE'], { ARSI_AGENT_ROLE: 'node' })
        assert.deepEqual([a.r, a.codes, a.logs.length], [true, [2], 1])
        assert.equal(a.logs[0], '拒跑: g_rsi.mjs 之此模式 會寫入專案之檔或起行程, 不得由 agent 執行(ARSI_AGENT_ROLE=node; 評估用 g_eval.mjs, 共用工具區之自檢用 g_toolbox.mjs)')
        assert(!a.logs[0].includes('SECRET_INPUT_VALUE') && !a.logs[0].includes('validate'), '理由不帶輸入值')
        let b = run('pickStore', [], { ARSI_AGENT_ROLE: 'dream' })
        assert.deepEqual([b.r, b.codes], [true, [2]])
        assert(/^拒跑: tools\/pickStore\.mjs .*ARSI_AGENT_ROLE=dream;/.test(b.logs[0]), b.logs[0])
        for (let [name, args, env] of [['rsi', ['--mode', 'status'], { ARSI_AGENT_ROLE: 'node' }], ['quota', [], { ARSI_AGENT_ROLE: 'dream' }], ['rsi', ['--mode', 'round'], {}], ['build', [], { ARSI_AGENT_ROLE: 'audit' }], ['eval', ['--mode', 'full'], { ARSI_AGENT_ROLE: 'node' }]]) {
            let c = run(name, args, env)
            assert.deepEqual([c.r, c.logs, c.codes], [false, [], []], `${name} ${args.join(' ')} ${JSON.stringify(env)}`)
        }
    })

    it('接線:表內每個名稱之入口於開頭(讀設定與組裝專案之前)呼叫 guardEntry 一次;g_eval、g_toolbox 與只列出內容之工具不呼叫', () => {
        let fileOf = (k) => (['rsi', 'launch', 'build', 'backtest'].includes(k) ? path.join(FD_ROOT, 'src', 'cli', `${k}.mjs`) : path.join(FD_ROOT, 'src', 'tools', `${k}.mjs`))
        for (let k of Object.keys(ENTRY_RULES)) {
            //去掉註解列(說明文字內之函數名不算)
            let s = fs.readFileSync(fileOf(k), 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n')
            let calls = s.match(/guardEntry\('([A-Za-z]+)'\)/g) || []
            assert.deepEqual(calls, [`guardEntry('${k}')`], k)
            let at = s.indexOf(`guardEntry('${k}')`)
            for (let late of ['settingsOrExit(', 'makeProjectOrExit(', 'initProject({', 'writeFileSync(']) {
                let j = s.indexOf(late)
                //initProject.mjs: 函數本身之定義在前, 直接執行之區塊內先呼叫 guardEntry 再呼叫 initProject
                let from = k === 'initProject' ? s.indexOf('if (process.argv[1]') : 0
                let j2 = s.indexOf(late, from)
                assert(k === 'initProject' ? (j2 < 0 || j2 > at) : (j < 0 || j > at), `${k}: guardEntry 須先於 ${late}`)
            }
        }
        for (let f of ['src/cli/eval.mjs', 'src/cli/toolbox.mjs', ...fs.readdirSync(path.join(FD_ROOT, 'src', 'tools')).filter((f) => !Object.prototype.hasOwnProperty.call(ENTRY_RULES, f.replace(/\.mjs$/, ''))).map((f) => `src/tools/${f}`)]) {
            assert(!/agentEntries|guardEntry/.test(fs.readFileSync(path.join(FD_ROOT, f), 'utf8')), f)
        }
    })
})

describe('進入檔之拒跑:合成專案實跑(命令列程式與工具)', function () {
    this.timeout(300000)
    let t
    let root
    let H0
    //hashTree, 專案夾內全部檔之(相對路徑, 內容雜湊)之總雜湊
    let hashTree = (dir) => {
        let out = []
        let walk = (d) => {
            for (let e of fs.readdirSync(d, { withFileTypes: true })) {
                let fp = path.join(d, e.name)
                if (e.isDirectory()) {
                    walk(fp)
                }
                else {
                    out.push(`${path.relative(dir, fp).replace(/\\/g, '/')}:${crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex')}`)
                }
            }
        }
        walk(dir)
        return crypto.createHash('sha256').update(out.sort().join('\n')).digest('hex')
    }
    //run, 以 root 為專案根(ARSI_ROOT)執行 src 下之程式; role 為 null 者不帶角色之變數(並移除外部環境之同名變數)
    let run = (rel, args, role, extra = {}) => {
        let env = { ...process.env, ARSI_ROOT: root }
        delete env.ARSI_AGENT_ROLE
        Object.assign(env, extra)
        if (role) {
            env.ARSI_AGENT_ROLE = role
        }
        let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', ...rel), ...args], { cwd: t.dir, env, windowsHide: true, encoding: 'utf8', timeout: 150000 })
        return { status: r.status, stdout: r.stdout, stderr: r.stderr }
    }
    before(() => {
        t = makeTmp('agentGuard')
        root = path.join(t.dir, 'proj')
        fs.mkdirSync(path.join(root, 'skills', 'node_modules', 'w-dispatch-ai'), { recursive: true })
        fs.mkdirSync(path.join(root, 'arms'), { recursive: true })
        fs.copyFileSync(path.join(FD_ROOT, 'arms', 'base.json'), path.join(root, 'arms', 'base.json'))
        fs.mkdirSync(path.join(root, 'examples'), { recursive: true })
        fs.copyFileSync(path.join(FD_ROOT, 'examples', 'pick_example.mjs'), path.join(root, 'examples', 'pick_example.mjs'))
        //合成帳本: 2400 根(4 小時一根; 起點 2022-07-01); 期間與評估之設定縮小(同 unit-evalCli)使評估數秒內完成
        writeSynthLedger(path.join(root, 'ledger'), { n: 60, nBars: 2400, seed: 7 })
        let st = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
        st.periods = { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } }
        st.eval = { ...st.eval, ledgerDir: './ledger', warmupDays: 60, phases: [0, 3], horizons: [7], nullDraws: 4 }
        delete st.eval.fitEnd
        st.dispatch = { skillsRoot: path.join(root, 'skills'), envFile: path.join(root, '.env') }
        st.rsi = { ...st.rsi, nodesPerRound: 1, parallelNodes: 1 }
        st.resources = {}
        st.agents = { node: { kind: 'opencode', id: 'oc:opencode/m-free', variant: 'high', timeoutMin: 1 }, dream: { kind: 'claude', model: 'claude-opus-5-5', effort: 'xhigh', timeoutMin: 1 } }
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(st, null, 1))
        fs.writeFileSync(path.join(root, '.env'), 'X=1\n')
        //假派工套件(只供 tools/quota.mjs 讀用量; 本檔不派工)
        fs.writeFileSync(path.join(root, 'skills', 'node_modules', 'w-dispatch-ai', 'package.json'), JSON.stringify({ name: 'w-dispatch-ai', main: 'index.cjs' }))
        fs.writeFileSync(path.join(root, 'skills', 'node_modules', 'w-dispatch-ai', 'index.cjs'), 'module.exports = { providers: [{ id: \'oc:opencode/m-free\', kind: \'opencode\', provider: \'opencode\', model: \'opencode/m-free\' }], readEnvFile: () => ({}), opencodeGoUsage: async () => ({ ok: true, usage: {} }), dispatchOpencode: async () => ({ ok: false, error: \'stub\' }), dispatchClaude: async () => ({ ok: false, error: \'stub\' }), getQuotaClaude: async () => ({ ok: true, windows: [] }) }\n')
        fs.writeFileSync(path.join(root, 'x.txt'), '註記\n')
        let r = run(['cli', 'rsi.mjs'], ['--mode', 'init'], null)
        assert.equal(r.status, 0, r.stdout + r.stderr)
        H0 = hashTree(root)
    })
    after(() => {
        t.cleanup()
    })

    it('寫入之模式與工具:帶角色(node / dream)⇒ 離開碼 2、只印一行理由、無錯誤輸出;專案夾(含狀態根)之全部檔逐位不變', () => {
        let cases = [
            [['cli', 'rsi.mjs'], ['--mode', 'round']],
            [['cli', 'rsi.mjs'], ['--mode', 'validate']],
            [['cli', 'rsi.mjs'], ['--mode', 'init']],
            [['cli', 'rsi.mjs'], ['--mode', 'board']],
            [['cli', 'rsi.mjs'], ['--mode', 'reverify', '--why', 'w']],
            [['cli', 'rsi.mjs'], ['--mode', 'extfill']],
            [['cli', 'rsi.mjs'], ['--mode', 'fill']],
            [['cli', 'rsi.mjs'], ['--mode', 'fill', '--no-member']],
            [['cli', 'rsi.mjs'], ['--mode', 'frontier', '--close', 'A01_nt', '--why', 'w']],
            [['cli', 'rsi.mjs'], ['--mode', 'frontier', '--rearm', 'A01_nt', '--to', 'A01_nt', '--why', 'w']],
            [['cli', 'rsi.mjs'], ['--mode', 'annotate', '--round', '1', '--file', path.join(root, 'x.txt')]],
            [['cli', 'rsi.mjs'], ['--mode', 'dirtype', '--round', '1', '--file', path.join(root, 'x.txt')]],
            [['cli', 'rsi.mjs'], ['--mode', 'round', '--dream-only', '--file', path.join(root, 'x.txt')]],
            [['cli', 'rsi.mjs'], ['--mode', 'nosuchmode']],
            [['cli', 'launch.mjs'], ['round', '--', 'g_rsi.mjs', '--mode', 'round']],
            [['cli', 'build.mjs'], []],
            [['cli', 'backtest.mjs'], ['--pick', 'examples/pick_example.mjs', '--name', 'n']],
            [['tools', 'archiveDocs.mjs'], []],
            [['tools', 'buildCatalog.mjs'], []],
            [['tools', 'pickStore.mjs'], []],
            [['tools', 'searchMap.mjs'], ['--quiet']],
            [['tools', 'smokeDispatch.mjs'], ['node']],
            [['tools', 'fakeRound.mjs'], []],
            [['tools', 'replayCheck.mjs'], ['abcdef12']],
            [['tools', 'armDecide.mjs'], ['--id', 'P001', '--reject', '--why', 'w']],
            [['tools', 'armInactive.mjs'], ['--node', 'abcdef', '--arms', 'none', '--why', 'w']],
            [['tools', 'exposure.mjs'], ['--node', 'abcdef', '--why', 'w']],
            [['tools', 'formSet.mjs'], ['--node', 'abcdef', '--form', 'clue', '--why', 'w']],
            [['tools', 'briefPreview.mjs'], ['--out', path.join(root, 'prev')]],
            [['tools', 'quota.mjs'], ['--probe']],
            [['tools', 'roundDigest.mjs'], ['--out']],
            [['tools', 'initProject.mjs'], ['--root', path.join(root, 'sub')]],
        ]
        cases.forEach(([rel, args], i) => {
            let role = i % 2 ? 'dream' : 'node'
            //g_backtest: agent 自設迴圈專用之環境變數者亦拒(先於其授權之檢查)
            let r = run(rel, args, role, rel[1] === 'backtest.mjs' ? { ARSI_HARNESS: '1' } : {})
            let what = `${rel.join('/')} ${args.join(' ')}`
            assert.equal(r.status, 2, `${what}: ${r.stdout}${r.stderr}`)
            assert.equal(r.stderr, '', what)
            let lines = r.stdout.split('\n').filter(Boolean)
            assert.equal(lines.length, 1, `${what}: ${r.stdout}`)
            assert(lines[0].startsWith('拒跑: ') && lines[0].includes(`ARSI_AGENT_ROLE=${role}`), `${what}: ${lines[0]}`)
            assert(!args.some((a) => a.length > 2 && !a.startsWith('-') && !AGENT_ROLES.includes(a) && lines[0].includes(a)), `${what}: 理由不帶輸入值`)
        })
        assert.equal(hashTree(root), H0, '專案夾之檔不變')
        assert(!fs.existsSync(path.join(root, 'sub')) && !fs.existsSync(path.join(root, 'prev')))
    })

    it('唯讀之模式與工具:帶角色與不帶者之輸出與離開碼逐字相同,專案夾不變(g_rsi 之 status / dry / frontier / fill --dry、只列出內容之工具、initProject --dry)', () => {
        let cases = [
            [['cli', 'rsi.mjs'], []],
            [['cli', 'rsi.mjs'], ['--mode', 'status']],
            [['cli', 'rsi.mjs'], ['--mode', 'dry']],
            [['cli', 'rsi.mjs'], ['--mode', 'frontier']],
            [['cli', 'rsi.mjs'], ['--mode', 'fill', '--dry']],
            [['cli', 'rsi.mjs'], ['--mode', 'fill', '--dry', '--no-member']],
            [['tools', 'quota.mjs'], []],
            [['tools', 'armDecide.mjs'], []],
            [['tools', 'armInactive.mjs'], []],
            [['tools', 'exposure.mjs'], []],
            [['tools', 'formSet.mjs'], []],
            [['tools', 'rankCompare.mjs'], []],
            [['tools', 'nodeAudit.mjs'], []],
            [['tools', 'scanCheck.mjs'], []],
            [['tools', 'initProject.mjs'], ['--root', path.join(root, 'sub'), '--dry']],
        ]
        for (let [rel, args] of cases) {
            let what = `${rel.join('/')} ${args.join(' ')}`
            let a = run(rel, args, null)
            //formSet 無引數 = 列出(規則 R-REC-53): 須真的執行成功(離開碼 0); 否則檔案不存在時兩邊皆為「找不到模組」而輸出相同, 本案於修前亦綠
            if (rel[1] === 'formSet.mjs') {
                assert.strictEqual(a.status, 0, `${what}: ${a.stdout}${a.stderr}`.slice(0, 300))
            }
            for (let role of ['node', 'dream']) {
                let b = run(rel, args, role)
                assert.deepEqual(b, a, `${what}(${role})`)
            }
            assert(!/拒跑/.test(a.stdout), what)
        }
        assert.equal(hashTree(root), H0, '唯讀者不寫檔')
    })

    it('未設角色之變數:行為與改前逐位相同(改前之輸出原文:g_backtest 未授權 ⇒ 離開碼 4;只做夢輪次缺文字檔 ⇒ 離開碼 2)', () => {
        let a = run(['cli', 'backtest.mjs'], ['--pick', 'examples/pick_example.mjs', '--name', 'n'], null)
        assert.deepEqual([a.status, a.stdout, a.stderr], [4, 'g_backtest.mjs 只供迴圈使用(回測期數字不對 agent 揭露); 節點與做夢任務請用 g_eval.mjs\n', ''])
        let b = run(['cli', 'rsi.mjs'], ['--mode', 'round', '--dream-only'], null)
        assert.deepEqual([b.status, b.stdout, b.stderr], [2, 'invalid --file: must be the path of a readable, non-empty UTF-8 text file (the request for the dream-only round)\n用法: node g_rsi.mjs --mode round --dream-only --file <文字檔>\n', ''])
        //其他值之角色(非 node / dream)= 未設
        let c = run(['cli', 'backtest.mjs'], ['--pick', 'examples/pick_example.mjs', '--name', 'n'], null, { ARSI_AGENT_ROLE: 'audit' })
        assert.deepEqual(c, a)
        assert.equal(hashTree(root), H0)
    })

    //本案寫入評估紀錄與結果檔(g_eval 照常寫入), 置於本組之末
    it('任務書要 agent 執行之指令(g_eval 之 quick / full --out / --ref、g_toolbox):帶角色照常執行,標準輸出與不帶者逐字相同', () => {
        let wd = path.join(root, 'rsi', 'work', 'aaaa111122223333')
        fs.mkdirSync(wd, { recursive: true })
        fs.copyFileSync(path.join(root, 'examples', 'pick_example.mjs'), path.join(wd, 'try_a.mjs'))
        fs.copyFileSync(path.join(root, 'examples', 'pick_example.mjs'), path.join(wd, 'control.mjs'))
        let cases = [
            [['cli', 'eval.mjs'], ['--pick', path.join(wd, 'try_a.mjs'), '--mode', 'quick']],
            [['cli', 'eval.mjs'], ['--pick', path.join(wd, 'try_a.mjs'), '--mode', 'quick', '--ref', path.join(wd, 'control.mjs')]],
            [['cli', 'eval.mjs'], ['--pick', path.join(wd, 'try_a.mjs'), '--mode', 'full', '--out', path.join(wd, 'full_a.json')]],
            [['cli', 'toolbox.mjs'], []],
        ]
        //耗時之毫秒數與結果檔之時刻每次不同(評估器之輸出本來就有), 比對前遮去; 其餘逐字
        let maskMs = (s) => (s === null ? null : s.replace(/耗時[^\n]*/g, '耗時 …').replace(/"(?:ms|elapsedMs|durationMs|[A-Za-z]*Ms)":\s*\d+(\.\d+)?/g, '"ms":0').replace(/"at":\s*"[^"]*"/g, '"at":""').replace(/"ms":\s*\{[^}]*\}/g, '"ms":{}'))
        for (let [rel, args] of cases) {
            let what = `${rel.join('/')} ${args.slice(0, 4).join(' ')}`
            let a = run(rel, args, null)
            assert.equal(a.status, 0, `${what}: ${a.stdout}${a.stderr}`)
            let outA = args.includes('--out') ? fs.readFileSync(path.join(wd, 'full_a.json'), 'utf8') : null
            let b = run(rel, args, 'node')
            let outB = args.includes('--out') ? fs.readFileSync(path.join(wd, 'full_a.json'), 'utf8') : null
            assert.equal(b.status, a.status, what)
            assert.equal(maskMs(b.stdout), maskMs(a.stdout), what)
            assert.strictEqual(maskMs(outB), maskMs(outA), `${what}: 結果檔`)
            assert(!/拒跑/.test(b.stdout), what)
        }
    })
})
