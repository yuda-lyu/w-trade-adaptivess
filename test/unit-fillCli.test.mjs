import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { pathToFileURL } from 'url'
import { getSettings } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { specHash } from '../src/engineApi.mjs'
import * as FP from '../src/domain/fillPlan.mjs'
import * as FK from '../src/domain/fillKeys.mjs'
import { makeTmp, writeSynthLedger, FD_ROOT } from './tools/synthLedger.mjs'


//附算與補算之命令列(規則 R-REC-34): g_rsi.mjs --mode fill —— 子行程, 不用替身(合成帳本 + 真之評估入口 g_eval.mjs + 真之樹與共同儲存區)
//  合成專案之設定同 unit-evalPostfit 之命令列之案(帳本 2400 棒; 求解窗終點: 做多第 738 棒、做空 = 回測期起點 ⇒ 求解窗後段只留做多之席)
describe('附算與補算之命令列:g_rsi.mjs --mode fill(規則 R-REC-34)', function () {
    this.timeout(300000)
    let t
    before(() => {
        t = makeTmp('fillCli')
    })
    after(() => {
        t.cleanup()
    })
    let PICK = 'export default function pick(ctx) {\n    let ids = []\n    for (let s = 0; s < ctx.n; s += 2) {\n        ids.push(s)\n    }\n    return ids\n}\n'
    //opt.realSel: 以評估入口實跑一次完整評估, 節點之正本之選集指紋取其實值(擴充診斷之補算須與正本之選集指紋相同才併入; 預設為合成之值)
    //opt.diags: 共用工具區 metrics/ 之擴充診斷之名(皆為只回一行說明之最小診斷); 樹上無其值 ⇒ 待補
    let mkProject = (name, { realSel = false, diags = [] } = {}) => {
        let root = path.join(t.dir, name)
        writeSynthLedger(path.join(root, 'ledger', 'eval'), { n: 60, nBars: 2400, seed: 7 })
        fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
        fs.mkdirSync(path.join(root, 'arms'), { recursive: true })
        fs.copyFileSync(path.join(FD_ROOT, 'arms', 'base.json'), path.join(root, 'arms', 'base.json'))
        let st0 = JSON.parse(fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8'))
        let st = {
            ...st0,
            periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } },
            eval: { ledgerDir: './ledger/eval', warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws: 8, seed: 1, fitEnd: { long: '2022-11-01T00:00:00', short: '2023-02-01T00:00:00' }, limits: { monthlyOrders: 400, peakHold: 50 }, timeoutSec: 240 },
            //成員穩健性(規則 R-REC-51; 預設開啟)關閉: 本檔之範圍為求解窗後段與擴充診斷之命令列(--no-member 與成員穩健性之實跑見 unit-memberCheck)
            rsi: { ...st0.rsi, root: './rsi', fillParallel: 1, memberCheck: false },
            records: { nodeDir: './rsi/records/nodes', dreamDir: './rsi/records/dreams', trashDir: './rsi/records/trash', workDir: './rsi/work', toolboxDir: './rsi/toolbox' },
            dispatch: { skillsRoot: path.join(root, 'skills'), envFile: path.join(root, '.env') },
            resources: {},
        }
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(st, null, 1), 'utf8')
        //派工套件之最小替身(本命令列不派工; makeProject 組裝派工器時須載入得到)
        let sk = path.join(root, 'skills', 'node_modules', 'w-dispatch-ai')
        fs.mkdirSync(sk, { recursive: true })
        fs.writeFileSync(path.join(sk, 'package.json'), JSON.stringify({ name: 'w-dispatch-ai', main: 'index.cjs' }), 'utf8')
        fs.writeFileSync(path.join(sk, 'index.cjs'), 'module.exports = { providers: [], readEnvFile: () => ({}), dispatchOpencode: async () => ({ ok: false, error: \'stub\' }), dispatchClaude: async () => ({ ok: false, error: \'stub\' }) }\n', 'utf8')
        fs.writeFileSync(path.join(root, '.env'), '', 'utf8')
        //評估入口(同 initProject 所產生者之作用: 設專案根後載入本套件之評估器)
        fs.writeFileSync(path.join(root, 'g_eval.mjs'), `process.env.ARSI_ROOT = ${JSON.stringify(root)}\nawait import(${JSON.stringify(pathToFileURL(path.join(FD_ROOT, 'src', 'cli', 'eval.mjs')).href)})\n`, 'utf8')
        //樹: 1 個已執行之節點(正本之數字為合成; 求解窗後段由命令列實算)
        let s = getSettings()
        s.rsi.root = path.join(root, 'rsi')
        s.records = { nodeDir: path.join(root, 'rsi/records/nodes'), dreamDir: path.join(root, 'rsi/records/dreams'), trashDir: path.join(root, 'rsi/records/trash'), workDir: path.join(root, 'rsi/work'), toolboxDir: path.join(root, 'rsi/toolbox') }
        s.eval.ledgerDir = path.join(root, 'ledger', 'eval')
        let P = makeProject(s, { dispatch: async () => ({ ok: false, error: 'seed' }), gate: null, catalogFile: path.join(root, 'seed_catalog.json') })
        P.rsi.init()
        let spec = { arms: ['A01_nt'], base: null }
        let id = P.idOf(spec)
        let wd = path.join(s.records.workDir, id)
        fs.mkdirSync(wd, { recursive: true })
        fs.writeFileSync(path.join(wd, 'pick.mjs'), PICK, 'utf8')
        let selHash = 'sel-canon'
        if (realSel) {
            let fo = path.join(root, 'direct_full.json')
            let env = { ...process.env, ARSI_ROOT: root, ARSI_HARNESS: '1' }
            for (let k of ['ARSI_LEDGER_DIR', 'ARSI_EVAL_FROM']) {
                delete env[k]
            }
            let rd = spawnSync(process.execPath, [path.join(root, 'g_eval.mjs'), '--pick', path.join(wd, 'pick.mjs'), '--mode', 'full', '--out', fo, '--no-log'], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 240000 })
            assert.equal(rd.status, 0, `${rd.stdout}\n${rd.stderr}`.slice(0, 1500))
            selHash = JSON.parse(fs.readFileSync(fo, 'utf8')).metrics.selHash
        }
        for (let nm of diags) {
            fs.writeFileSync(path.join(root, 'rsi', 'toolbox', 'metrics', `${nm}.mjs`), `export default function (api) {\n    return { text: '診斷 ${nm}' }\n}\n`, 'utf8')
        }
        let metrics = { selHash, ext: {}, op: { eqYr: { mean: 1.5, min: -0.5, byPhase: [1, 2] }, monthlyOrders: { mean: 9 }, peakHold: { max: 3 }, winRate: 0.5 } }
        P.rsi.store.putNode({ id, spec, specHash: specHash(spec), status: 'executed', parents: [], round: 1, raw: { metrics, issues: [] }, score: { S: 3, ladder: 1, flags: { vetoed: false, why: [] } } })
        P.records.putNodeDoc({ nodeId: id, round: 1, attempt: 1, status: 'verified', spec, task: { goal: 'g', type: 'explore' }, plan: {}, code: {}, results: { claimed: {} }, conclusion: { outcome: 'neutral', summary: '合成' }, harness: { ok: true, summary: [], notes: [], checks: { issues: [] }, score: { S: 3, ladder: 1, flags: { vetoed: false, why: [] } }, raw: { metrics } } })
        return { root, id, wd }
    }
    //envExtra: 另加於父行程(命令列)之環境變數
    let rsiCli = (root, args, envExtra = {}) => {
        let env = { ...process.env, ARSI_ROOT: root }
        for (let k of ['ARSI_HARNESS', 'ARSI_LEDGER_DIR', 'ARSI_EVAL_FROM']) {
            delete env[k]
        }
        Object.assign(env, envExtra)
        let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'cli', 'rsi.mjs'), ...args], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 280000 })
        return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
    }

    //開啟專案(行程內; 以專案之 settings.json 為準, 路徑轉為絕對): 供「以 API 呼叫」之案(fillPlanOf、fill、extFill、writeBoard、writeSearchMap)用; 不派工、不起評估(本組案只驗拒絕與文字)
    let openP = (root) => {
        let st = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'))
        st.eval.ledgerDir = path.join(root, 'ledger', 'eval')
        st.rsi.root = path.join(root, 'rsi')
        for (let k of Object.keys(st.records)) {
            st.records[k] = path.join(root, st.records[k])
        }
        st.FD_ROOT = root
        return { st, P: makeProject(st, { dispatch: async () => ({ ok: false, error: 'stub' }), gate: null, catalogFile: path.join(root, 'seed_catalog2.json') }) }
    }

    //補算之停止檔(排程第 545 項; R-RUN-12): 命令列之入口 —— 狀態根之 STOP 存在 ⇒ 本次不補算(離開碼 3, 同輪次之 stop-file 慣例); 補算進行中才建立者之行為見 unit-fillStop
    it('--mode fill: 狀態根有停止檔 STOP ⇒ 不補算(離開碼 3、訊息固定、未取鎖、不建補算檔與狀態檔); --dry(只列計畫)不受影響; --mode round 對同一檔仍以「本次不啟動: 停止檔 … 存在」離開碼 3(同一個檔)', () => {
        let { root } = mkProject('stopCli', { diags: ['dA'] })
        let stop = path.join(root, 'rsi', 'STOP')
        fs.writeFileSync(stop, '', 'utf8')
        let r = rsiCli(root, ['--mode', 'fill'])
        assert.equal(r.status, 3, r.out.slice(0, 600))
        assert.equal(r.out.trim(), '未執行: 停止檔 rsi/STOP 存在;刪除後再補算')
        assert(!fs.existsSync(path.join(root, 'rsi', 'logs', 'round.lock')) && !fs.existsSync(path.join(root, 'rsi', 'fill_state.json')) && !fs.existsSync(path.join(root, 'rsi', 'fill')), '未取鎖、未寫任何檔')
        //--mode extfill(經 fill 執行而同承停止檔): 同一訊息與離開碼、未取鎖、未寫任何檔
        let ex = rsiCli(root, ['--mode', 'extfill'])
        assert.equal(ex.status, 3, ex.out.slice(0, 600))
        assert.equal(ex.out.trim(), '未執行: 停止檔 rsi/STOP 存在;刪除後再補算')
        assert(!fs.existsSync(path.join(root, 'rsi', 'logs', 'round.lock')) && !fs.existsSync(path.join(root, 'rsi', 'fill_state.json')) && !fs.existsSync(path.join(root, 'rsi', 'fill')), 'extfill: 未取鎖、未寫任何檔')
        let d = rsiCli(root, ['--mode', 'fill', '--dry'])
        assert.equal(d.status, 0, d.out.slice(0, 600))
        assert(d.out.includes('附算之計畫(--dry;未評估、未寫檔)'), d.out.slice(0, 600))
        let rd = rsiCli(root, ['--mode', 'round'])
        assert.equal(rd.status, 3, rd.out.slice(0, 600))
        assert(rd.out.includes('本次不啟動: 停止檔 rsi/STOP 存在'), rd.out.slice(0, 600))
        //刪除後 --dry 與取鎖之路徑照常(不再被擋): 以 --dry 核對計畫仍可列、且訊息不再為「未執行: 停止檔」
        fs.rmSync(stop)
        let d2 = rsiCli(root, ['--mode', 'fill', '--dry'])
        assert.equal(d2.status, 0, d2.out.slice(0, 600))
        assert(!d2.out.includes('停止檔'), d2.out.slice(0, 600))
    })

    //補算之虛無抽數(排程第 547 項①): 給了而不是正整數 ⇒ 拒絕(原: 靜默當成未給而依設定之抽數評估, 與使用者所要之縮減不同)
    //  規格之句: 命令列 --null 於 --mode fill / extfill 須為正整數(離開碼 2、固定訊息、於讀設定與任何寫入之前); API 之 fill / extFill / fillPlanOf 之 nullDraws 同(未給或 null = 設定之值、正整數與其數字字串採用、其餘拋 invalid opt.nullDraws)
    it('--mode fill / extfill 之 --null: 0、非數字、小數、負數 ⇒ 離開碼 2 與固定訊息、不建補算檔與狀態檔; 無值 ⇒ 通用之無值訊息; 正整數照常(選項列顯示所採之抽數)', () => {
        let { root } = mkProject('nullArg', { diags: ['dA'] })
        for (let mode of ['fill', 'extfill']) {
            for (let v of ['0', 'abc', '2.5', '-3', '1e2']) {
                let r = rsiCli(root, ['--mode', mode, '--null', v, ...(mode === 'fill' ? ['--dry'] : [])])
                assert.equal(r.status, 2, `${mode} --null ${v}: ${r.out.slice(0, 400)}`)
                assert.equal(r.out.trim(), 'invalid --null: must be a positive integer', `${mode} --null ${v}`)
            }
            let b = rsiCli(root, ['--mode', mode, '--null'])
            assert.equal(b.status, 2, `${mode}: ${b.out.slice(0, 400)}`)
            assert.equal(b.out.trim(), 'invalid --null: must be written as --null <N> (a value is required)')
        }
        assert(!fs.existsSync(path.join(root, 'rsi', 'fill_state.json')) && !fs.existsSync(path.join(root, 'rsi', 'fill')), '拒絕者不寫任何檔')
        let ok = rsiCli(root, ['--mode', 'fill', '--dry', '--null', '3'])
        assert.equal(ok.status, 0, ok.out.slice(0, 600))
        assert(ok.out.includes('虛無抽數 3;'), ok.out.slice(0, 600))
        let okStr = rsiCli(root, ['--mode', 'fill', '--dry', '--null', '03'])
        assert(okStr.out.includes('虛無抽數 3;'), `數字字串轉為數值: ${okStr.out.slice(0, 600)}`)
    })

    it('API: fillPlanOf、fill、extFill 之 nullDraws: 未給或 null = 設定之值; 正整數與其數字字串採用(計畫之鍵同); 0、負數、小數、非數字字串、布林、陣列、物件、NaN、Infinity ⇒ 拋 / reject invalid opt.nullDraws(不帶輸入值)', async () => {
        let { root } = mkProject('nullApi', { diags: ['dA'] })
        let { P } = openP(root)
        let keysOf = (nd) => JSON.stringify(P.fillPlanOf({ nullDraws: nd }).tasks.map((x) => x.keys))
        let base = keysOf(undefined)
        assert.equal(keysOf(null), base, 'null = 未給')
        //鑑別前提: 縮減之抽數併入擴充診斷之鍵(與未縮減者不同); 數字字串與其數字之計畫相同
        assert.notEqual(keysOf(3), base, '鑑別前提: nullDraws 3 之鍵與未給者不同')
        assert.equal(keysOf('3'), keysOf(3), '數字字串轉為數值')
        assert.equal(keysOf(' 3 '), keysOf(3))
        let SECRET = 'secret-token-xyz'
        let MSG = 'invalid opt.nullDraws: must be a positive integer'
        for (let bad of [0, -1, 2.5, 'abc', '', '0', true, false, [], {}, NaN, Infinity, 2 ** 53, SECRET]) {
            assert.throws(() => P.fillPlanOf({ nullDraws: bad }), (e) => e.message === MSG, `fillPlanOf ${String(bad)}`)
            await assert.rejects(() => P.fill({ nullDraws: bad, storeAfter: false }), (e) => e.message === MSG, `fill ${String(bad)}`)
            await assert.rejects(() => P.extFill({ nullDraws: bad }), (e) => e.message === MSG, `extFill ${String(bad)}`)
        }
        //extFill: nullDraws 之檢查先於診斷之名(給了而無效者不因名稱不存在而改報他錯); 對照: 名稱不存在者(nullDraws 合格)報名稱之錯
        await assert.rejects(() => P.extFill({ names: ['no_such_diag'], nullDraws: 0 }), (e) => e.message === MSG, 'extFill: nullDraws 先於名稱')
        await assert.rejects(() => P.extFill({ names: ['no_such_diag'] }), (e) => /無此擴充診斷/.test(e.message), '對照: 名稱不存在')
        //於任何寫入之前拒絕
        assert(!fs.existsSync(path.join(root, 'rsi', 'fill_state.json')) && !fs.existsSync(path.join(root, 'rsi', 'fill')), '拒絕者不寫任何檔')
    })

    //settings.backtest 之數值鍵無效(排程第 547 項①): 組裝專案之入口(g_rsi.mjs)印 ERROR invalid backtest.<鍵>、離開碼 2(不印堆疊; 不寫任何檔)
    it('settings.backtest.nullDraws 等無效 ⇒ g_rsi.mjs 以 ERROR invalid backtest.<鍵> 離開碼 2(組裝專案時; 同 invalid eval.*); 合格(數字字串)者照常', () => {
        let { root } = mkProject('btCfg')
        let fp = path.join(root, 'settings.json')
        let set0 = JSON.parse(fs.readFileSync(fp, 'utf8'))
        for (let [k, v, msg] of [['nullDraws', 'abc', 'a non-negative integer'], ['replicas', 2.5, 'a positive integer'], ['timeoutSec', 0, 'a positive number of seconds that is at most 2147483'], ['minLadder', -1, 'a non-negative integer']]) {
            fs.writeFileSync(fp, JSON.stringify({ ...set0, backtest: { ...(set0.backtest || {}), [k]: v } }, null, 1), 'utf8')
            let r = rsiCli(root, ['--mode', 'status'])
            assert.equal(r.status, 2, `${k}: ${r.out.slice(0, 400)}`)
            assert.equal(r.out.trim(), `ERROR invalid backtest.${k}: must be ${msg}`, k)
        }
        fs.writeFileSync(fp, JSON.stringify({ ...set0, backtest: { ...(set0.backtest || {}), nullDraws: '32', replicas: '2' } }, null, 1), 'utf8')
        let ok = rsiCli(root, ['--mode', 'status'])
        assert.equal(ok.status, 0, ok.out.slice(0, 400))
        fs.writeFileSync(fp, JSON.stringify(set0, null, 1), 'utf8')
    })

    //相位數之寫法(排程第 547 項②): 看板、搜尋地圖、共同儲存區之說明與總表、摘要與命令列之輸出取自 settings.eval.phases 之長度(原寫死「七相位」); 預設(未給 phases = 7)者與寫死時逐字相同
    it('看板(ARMS_BOARD.md)、搜尋地圖(SEARCH_MAP.md)、共同儲存區(README.md、INDEX.md、index.json 之欄說明)之相位數 = eval.phases 之長度(此專案 2 個 ⇒「二相位」、無「七相位」); 設定改為未給(預設 7 個)而各節點仍為 2 個相位所算 ⇒ 說明結果者仍寫實算之二相位、說明設定者(README 之保留期)寫七相位', async () => {
        let { root } = mkProject('phText')
        let rd = (...a) => fs.readFileSync(path.join(root, 'rsi', ...a), 'utf8')
        let { P } = openP(root)
        P.writeBoard()
        P.writeSearchMap()
        await P.pickStore()
        let files = { 'ARMS_BOARD.md': rd('ARMS_BOARD.md'), 'SEARCH_MAP.md': rd('SEARCH_MAP.md'), 'picks/README.md': rd('picks', 'README.md'), 'picks/INDEX.md': rd('picks', 'INDEX.md'), 'picks/index.json(欄說明)': JSON.stringify(JSON.parse(rd('picks', 'index.json')).fields) }
        for (let [nm, tx] of Object.entries(files)) {
            assert(!tx.includes('七相位'), `${nm}: 不得含「七相位」(設定為 2 個相位)`)
        }
        assert(files['ARMS_BOARD.md'].includes('| 二相位平均 |'), '看板之節點一覽之欄')
        assert(files['picks/INDEX.md'].includes('二相位 平均 / 最差 / 為正'), '總表之欄')
        assert(files['picks/README.md'].includes('二相位等效年化之平均'), 'README 之欄說明')
        assert(files['picks/index.json(欄說明)'].includes('二相位等效年化(%)之平均'), 'index.json 之欄說明')
        //改為未給(評估器之預設 7 個相位)而各節點仍是以 2 個相位算出者(設定改動後尚未重算; 排程第 547 項②之接續: 取實算):
        //  說明各節點之結果者(看板、總表之欄標)仍寫實算之二相位, 說明設定者(README 之保留期之說明)寫設定之七相位; 各節點皆算 7 個者之逐字同原文見 unit-phaseActual、unit-gaugeDual
        let set1 = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'))
        delete set1.eval.phases
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(set1, null, 1), 'utf8')
        let o2 = openP(root)
        o2.P.writeBoard()
        o2.P.writeSearchMap()
        await o2.P.pickStore()
        assert(rd('ARMS_BOARD.md').includes('| 二相位平均 |'), '各節點算 2 個相位 ⇒ 看板寫實算之二相位(不寫設定之七相位)')
        assert(rd('picks', 'INDEX.md').includes('二相位 平均 / 最差 / 為正') && rd('picks', 'README.md').includes('七相位等效年化之平均'), '總表之欄標 ⇒ 實算; README(保留期之說明)⇒ 設定')
        assert(!rd('ARMS_BOARD.md').includes('七相位'))
    })

    it('--dry 只列計畫(不評估、不寫檔);實跑:補算檔之值 = 以評估入口直接跑 --period postfit 之結果;共同儲存區帶 postfit;再跑不重算;有輪次之鎖 ⇒ 離開碼 3', () => {
        let { root, id, wd } = mkProject('main')
        let r0 = rsiCli(root, ['--mode', 'fill', '--dry'])
        assert.equal(r0.status, 0, r0.out.slice(0, 1500))
        assert(r0.out.includes('附算之計畫(--dry;未評估、未寫檔):待算 1 個成品(求解窗後段 1、擴充診斷 0 項);現行 0 個'), r0.out.slice(0, 1500))
        assert(r0.out.includes(`- ${id.slice(0, 8)}:求解窗後段`), r0.out.slice(0, 1500))
        assert(!fs.existsSync(FK.fillFileOf(path.join(root, 'rsi'), id)) && !fs.existsSync(path.join(root, 'rsi', 'fill_state.json')), '--dry 不寫任何檔')
        //參數不合 ⇒ 離開碼 2
        assert.equal(rsiCli(root, ['--mode', 'fill', '--only', 'abc']).status, 2)
        //--only 取原字串: 全數字之前綴不得被轉成數值而使範圍靜默擴為全樹 ⇒ 未命中即拒絕(離開碼 2、不寫); 命中者印其數
        for (let mode of ['fill', 'extfill', 'reverify']) {
            let rn = rsiCli(root, ['--mode', mode, '--only', '00000000', ...(mode === 'reverify' ? ['--why', 'x'] : [])])
            assert.equal(rn.status, 2, `${mode}: ${rn.out.slice(0, 800)}`)
            //排程第 611 項 ②: 訊息不帶輸入之前綴(K9; 原: `--only 未命中任何已執行之節點(00000000);未執行`)
            assert(rn.out.includes('--only 未命中任何已執行之節點;未執行'), rn.out.slice(0, 800))
            assert(!rn.out.includes('00000000'), `${mode}: 不回顯輸入之前綴`)
        }
        let rh = rsiCli(root, ['--mode', 'fill', '--dry', '--only', id.slice(0, 8)])
        assert.equal(rh.status, 0, rh.out.slice(0, 800))
        assert(rh.out.includes('--only 命中已執行之節點 1 個'), rh.out.slice(0, 800))
        //有輪次之鎖(存活之行程)⇒ 離開碼 3、不寫
        let fpLock = path.join(root, 'rsi', 'logs', 'round.lock')
        fs.mkdirSync(path.dirname(fpLock), { recursive: true })
        fs.writeFileSync(fpLock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), beatAt: new Date().toISOString() }), 'utf8')
        let rb = rsiCli(root, ['--mode', 'fill'])
        assert.equal(rb.status, 3, rb.out.slice(0, 800))
        assert(!fs.existsSync(FK.fillFileOf(path.join(root, 'rsi'), id)))
        fs.rmSync(fpLock, { force: true })
        //實跑: 父行程帶改帳本與改評估起點之環境變數 —— 附算之子行程不得收到(收到者 ⇒ 評估入口以 ARSI_HARNESS=1 讀之, 求解窗後段不與之併用而離開碼 2, 本次即失敗; 帳本夾亦不存在)
        let r1 = rsiCli(root, ['--mode', 'fill'], { ARSI_LEDGER_DIR: path.join(root, 'no-such-ledger'), ARSI_EVAL_FROM: '2099-01-01T00:00:00' })
        assert.equal(r1.status, 0, r1.out.slice(0, 3000))
        assert(r1.out.includes('附算與補算:待算 1 個成品、現行 0 個') && r1.out.includes('共同儲存區 已重產(1 個)'), r1.out.slice(0, 3000))
        let f = JSON.parse(fs.readFileSync(FK.fillFileOf(path.join(root, 'rsi'), id), 'utf8'))
        //以評估入口直接跑同一段(同設定、同亂數種子)⇒ 值逐位相同
        let fo = path.join(root, 'direct.json')
        let env = { ...process.env, ARSI_ROOT: root }
        for (let k of ['ARSI_HARNESS', 'ARSI_LEDGER_DIR', 'ARSI_EVAL_FROM']) {
            delete env[k]
        }
        let rd = spawnSync(process.execPath, [path.join(root, 'g_eval.mjs'), '--pick', path.join(wd, 'pick.mjs'), '--mode', 'full', '--period', 'postfit', '--out', fo, '--no-log'], { cwd: root, env: { ...env, ARSI_HARNESS: '1' }, windowsHide: true, encoding: 'utf8', timeout: 240000 })
        assert.equal(rd.status, 0, `${rd.stdout}\n${rd.stderr}`.slice(0, 1500))
        let o = JSON.parse(fs.readFileSync(fo, 'utf8'))
        assert.deepEqual(f.postfit.row, FP.postfitRowOf(o))
        assert(f.postfit.row.seatsDropped > 0, '鑑別前提: 有所捨之席(只留做多)')
        //完整結果檔與直接跑者除時刻與耗時外相同
        let strip = (x) => {
            let c = JSON.parse(JSON.stringify(x)); delete c.at; delete c.loadMs; delete c.pick; if (c.metrics) {
                delete c.metrics.ms
            } return c
        }
        assert.deepEqual(strip(JSON.parse(fs.readFileSync(FK.postfitFileOf(path.join(root, 'rsi'), id), 'utf8'))), strip(o))
        let idx = JSON.parse(fs.readFileSync(path.join(root, 'rsi', 'picks', 'index.json'), 'utf8'))
        assert.deepEqual(idx.items[0].postfit, { ...f.postfit.row, at: f.postfit.at, current: true })
        assert(!fs.readFileSync(path.join(root, 'rsi', 'picks', 'INDEX.md'), 'utf8').includes('求解窗後段'))
        //節點之評估紀錄不記附算(--no-log)
        assert(!fs.existsSync(path.join(wd, '.evals.log')), '附算不記入節點之評估紀錄')
        //再跑: 現行 ⇒ 不評估
        let r2 = rsiCli(root, ['--mode', 'fill', '--dry'])
        assert(r2.out.includes('待算 0 個成品(求解窗後段 0、擴充診斷 0 項);現行 1 個'), r2.out.slice(0, 1500))
        //狀態檔未寫成(其位置被一個資料夾占住)⇒ 已算之結果照留、訊息如實、離開碼 5(不是「未執行」之離開碼 2)
        let fpState = path.join(root, 'rsi', 'fill_state.json')
        fs.rmSync(fpState, { force: true })
        fs.mkdirSync(fpState)
        let r3 = rsiCli(root, ['--mode', 'fill', '--force'])
        assert.equal(r3.status, 5, r3.out.slice(0, 1500))
        assert(r3.out.includes('附算之狀態檔未寫成') && r3.out.includes('本次已算 1 個成品') && !r3.out.includes('未執行'), r3.out.slice(0, 1500))
        assert(r3.out.includes('共同儲存區 已重產(1 個)'), r3.out.slice(0, 1500))
        assert.notEqual(JSON.parse(fs.readFileSync(FK.fillFileOf(path.join(root, 'rsi'), id), 'utf8')).postfit.at, f.postfit.at, '已算之結果照常寫入補算檔')
        fs.rmSync(fpState, { recursive: true, force: true })
    })

    //旗標之解析(Gitea #178 §7 第 5 點之主控裁定): --dry 與實跑皆印「選項(解析後)」一列, 維護者與測試可直接看到旗標實際解析成什麼; 計畫之各項隨旗標改變
    let OPT = (o) => `選項(解析後):範圍 ${o.scope || '全樹'};求解窗後段 ${o.pf || '算'};擴充診斷 ${o.ext || '全部'};強制重算 ${o.force || '否'};虛無抽數 ${o.nulls || '依設定'};併行 ${o.par || '1'}`
    it('--mode fill --dry 之旗標解析:--no-postfit、--ext(名單 / none / 不存在之名)、--only、--null、--par 與設定之 fillParallel(數字字串轉型、無效用預設、上限 8)', () => {
        let { root, id } = mkProject('flags', { diags: ['dA', 'dB'] })
        let id8 = id.slice(0, 8)
        let dry = (...a) => rsiCli(root, ['--mode', 'fill', '--dry', ...a])
        let optOf = (r) => (r.out.split('\n').find((l) => l.startsWith('選項(解析後):')) || '').trim()
        let taskOf = (r) => (r.out.split('\n').find((l) => l.startsWith(`- ${id8}:`)) || '').trim()
        //預設: 全樹、求解窗後段與兩個診斷皆待算(樹上無其值)、併行 = 設定之 1
        let r0 = dry()
        assert.equal(r0.status, 0, r0.out.slice(0, 1200))
        assert.equal(optOf(r0), OPT({}))
        assert.equal(taskOf(r0), `- ${id8}:求解窗後段;擴充診斷 dA、dB`)
        //--no-postfit: 不算求解窗後段
        let r1 = dry('--no-postfit')
        assert.equal(optOf(r1), OPT({ pf: '不算(--no-postfit)' }))
        assert.equal(taskOf(r1), `- ${id8}:擴充診斷 dA、dB`)
        //--ext none: 不補診斷
        let r2 = dry('--ext', 'none')
        assert.equal(optOf(r2), OPT({ ext: '不補(--ext none)' }))
        assert.equal(taskOf(r2), `- ${id8}:求解窗後段`)
        //--ext <名,…>: 只列所指之診斷(dB 不在)
        let r3 = dry('--ext', 'dA')
        assert.equal(optOf(r3), OPT({ ext: 'dA' }))
        assert.equal(taskOf(r3), `- ${id8}:求解窗後段;擴充診斷 dA`)
        let r3b = dry('--ext', 'dB, dA', '--no-postfit')
        assert.equal(optOf(r3b), OPT({ ext: 'dB、dA', pf: '不算(--no-postfit)' }), '逗號分隔、去空白')
        assert.equal(taskOf(r3b), `- ${id8}:擴充診斷 dA、dB`, '計畫依名排序')
        //--ext 之名不存在 ⇒ 未執行(離開碼 2)
        let r3c = dry('--ext', 'dZ')
        assert.equal(r3c.status, 2, r3c.out.slice(0, 800))
        assert(r3c.out.includes('未執行: invalid opt.ext: must name existing diagnostics'), r3c.out.slice(0, 800))
        //--only: 範圍與命中數
        let r4 = dry('--only', id8)
        assert.equal(r4.status, 0, r4.out.slice(0, 800))
        assert.equal(optOf(r4), OPT({ scope: '1 個節點(--only)' }))
        assert(r4.out.includes('--only 命中已執行之節點 1 個'), r4.out.slice(0, 800))
        //--only 之前綴不足 6 碼 ⇒ 拒絕(離開碼 2; 即使該前綴命中節點; 訊息指明原因)
        let r4b = dry('--only', id.slice(0, 5))
        assert.equal(r4b.status, 2, r4b.out.slice(0, 600))
        assert(r4b.out.includes('--only 須給節點 id 前綴(至少 6 碼;逗號分隔)'), r4b.out.slice(0, 600))
        //--null: 正整數才採; 給了而不是正整數(0、非數字、小數、負數)⇒ 拒絕(離開碼 2; 固定訊息; 排程第 547 項; 原: 靜默依設定; 另見下方之專案案)
        for (let [v, want] of [['2', '2'], ['16', '16'], ['03', '3']]) {
            assert.equal(optOf(dry('--null', v)), OPT({ nulls: want }), `--null ${v}`)
        }
        for (let v of ['0', 'abc', '2.5', '-3']) {
            let rn = dry('--null', v)
            assert.equal(rn.status, 2, `--null ${v}: ${rn.out.slice(0, 300)}`)
            assert.equal(rn.out.trim(), 'invalid --null: must be a positive integer', `--null ${v}`)
        }
        //--par: 正整數(含數字字串)才採、上限 8; 給了而無效(0、小數、負數、非數字)⇒ 拒收(離開碼 2; 排程第 607 項、R-EV-54; 原: 靜默改用設定之 fillParallel, 此處為 1)
        for (let [v, want] of [['3', '3'], ['8', '8'], ['99', '8']]) {
            assert.equal(optOf(dry('--par', v)), OPT({ par: want }), `--par ${v}`)
        }
        for (let v of ['0', 'abc', '2.5', '-1']) {
            let rp = dry('--par', v)
            assert.equal(rp.status, 2, `--par ${v}: ${rp.out.slice(0, 300)}`)
            assert.equal(rp.out.trim(), 'invalid --par: must be a positive integer', `--par ${v}`)
        }
        //只有旗標無值 ⇒ 拒絕(通用之帶值旗標無值之訊息; 排程第 547 項; 原: 依設定)
        let rpb = dry('--par')
        assert.equal(rpb.status, 2, rpb.out.slice(0, 300))
        assert.equal(rpb.out.trim(), 'invalid --par: must be written as --par <N> (a value is required)')
        //設定之 fillParallel: 數字字串轉型(K7)、無效用預設 3(K3)、上限 8; --par 優先於設定
        let fpSet = path.join(root, 'settings.json')
        let set0 = fs.readFileSync(fpSet, 'utf8')
        let withPar = (v) => {
            let o = JSON.parse(set0)
            if (v === undefined) {
                delete o.rsi.fillParallel
            }
            else {
                o.rsi.fillParallel = v
            }
            fs.writeFileSync(fpSet, JSON.stringify(o, null, 1), 'utf8')
        }
        for (let [v, want] of [['2', '2'], [' 4 ', '4'], [5, '5'], [20, '8'], ['100', '8'], [undefined, '3'], ['abc', '3'], [0, '3'], [2.5, '3'], [true, '3'], [null, '3']]) {
            withPar(v)
            assert.equal(optOf(dry()), OPT({ par: want }), `設定 fillParallel ${JSON.stringify(v)}`)
        }
        withPar('2')
        assert.equal(optOf(dry('--par', '6')), OPT({ par: '6' }), '--par 優先')
        //--par 給了而無效 ⇒ 拒收(排程第 607 項、R-EV-54; 原: 改用設定之 fillParallel); 設定之 fillParallel 無效者仍依 K3 用預設(上列各案)
        let rpa = dry('--par', 'abc')
        assert.equal(rpa.status, 2, rpa.out.slice(0, 300))
        assert.equal(rpa.out.trim(), 'invalid --par: must be a positive integer', '--par 無效 ⇒ 拒收(不再改用設定)')
        fs.writeFileSync(fpSet, set0, 'utf8')
        //--dry 不寫任何檔
        assert(!fs.existsSync(path.join(root, 'rsi', 'fill_state.json')) && !fs.existsSync(path.join(root, 'rsi', 'fill')))
    })

    it('--mode fill 實跑之旗標:--no-postfit、--ext、--null、--par 作用於實際之評估(補算檔之鍵、所算之項目、併行);--force(本次範圍內不論是否現行皆重算)與 --only', () => {
        let { root, id, wd } = mkProject('real', { realSel: true, diags: ['dA', 'dB'] })
        let id8 = id.slice(0, 8)
        let rsiRoot = path.join(root, 'rsi')
        let dry = (...a) => rsiCli(root, ['--mode', 'fill', '--dry', ...a])
        let taskOf = (r) => (r.out.split('\n').find((l) => l.startsWith(`- ${id8}:`)) || '').trim()
        //--no-postfit --ext dA --null 2 --par 3: 只補 dA(不算求解窗後段、不補 dB)、鍵帶 nulls: 2、併行 3
        let r1 = rsiCli(root, ['--mode', 'fill', '--no-postfit', '--ext', 'dA', '--null', '2', '--par', '3'])
        assert.equal(r1.status, 0, r1.out.slice(0, 2500))
        assert(r1.out.includes(OPT({ pf: '不算(--no-postfit)', ext: 'dA', nulls: '2', par: '3' })), r1.out.slice(0, 1500))
        assert(r1.out.includes('附算與補算:待算 1 個成品、現行 0 個;併行 3;'), `實際使用之併行數 = 解析後之值: ${r1.out.slice(0, 1500)}`)
        let f1 = JSON.parse(fs.readFileSync(FK.fillFileOf(rsiRoot, id), 'utf8'))
        assert.deepEqual(Object.keys(f1.ext), ['dA'], '只補 dA')
        assert.equal(f1.postfit, null, '不算求解窗後段')
        assert.equal(f1.ext.dA.key.nulls, 2, '--null 作用於評估(補算檔之鍵帶虛無抽數)')
        assert.equal(f1.ext.dA.value.text, '診斷 dA')
        assert(!fs.existsSync(FK.postfitFileOf(rsiRoot, id)))
        let node1 = JSON.parse(fs.readFileSync(path.join(rsiRoot, 'records', 'nodes', `${id}.json`), 'utf8'))
        assert(node1.harness.raw.metrics.ext.dA && !node1.harness.raw.metrics.ext.dB, '併入樹與節點文件者只有 dA')
        //--ext none: 只算求解窗後段(dB 仍缺但不補)
        let r2 = rsiCli(root, ['--mode', 'fill', '--ext', 'none'])
        assert.equal(r2.status, 0, r2.out.slice(0, 2500))
        assert(r2.out.includes(OPT({ ext: '不補(--ext none)' })), r2.out.slice(0, 1500))
        let f2 = JSON.parse(fs.readFileSync(FK.fillFileOf(rsiRoot, id), 'utf8'))
        assert(f2.postfit && f2.postfit.row, '求解窗後段已算')
        assert.deepEqual(Object.keys(f2.ext), ['dA'], 'dB 未補')
        //預設: 補 dB(dA 之鍵帶 nulls: 2 而本次未縮減, 但樹上有其值且診斷未改寫 ⇒ 現行不重算)
        let r3 = rsiCli(root, ['--mode', 'fill'])
        assert.equal(r3.status, 0, r3.out.slice(0, 2500))
        assert(r3.out.includes('附算與補算:待算 1 個成品、現行 0 個;併行 1;'), r3.out.slice(0, 1500))
        let f3 = JSON.parse(fs.readFileSync(FK.fillFileOf(rsiRoot, id), 'utf8'))
        assert.deepEqual(Object.keys(f3.ext), ['dA', 'dB'])
        assert.equal(f3.ext.dA.at, f1.ext.dA.at, 'dA 未重算')
        assert.equal(f3.postfit.at, f2.postfit.at, '求解窗後段未重算')
        //全部現行 ⇒ --dry 無待算; --force 之範圍內者不論是否現行皆待算
        assert(dry().out.includes('待算 0 個成品(求解窗後段 0、擴充診斷 0 項);現行 1 個'))
        let d1 = dry('--force')
        assert(d1.out.includes(OPT({ force: '是' })), d1.out.slice(0, 800))
        assert(d1.out.includes('待算 1 個成品(求解窗後段 1、擴充診斷 2 項)'), d1.out.slice(0, 800))
        assert.equal(taskOf(d1), `- ${id8}:求解窗後段;擴充診斷 dA、dB`)
        assert.equal(taskOf(dry('--force', '--no-postfit', '--ext', 'dB')), `- ${id8}:擴充診斷 dB`)
        assert.equal(taskOf(dry('--force', '--ext', 'none')), `- ${id8}:求解窗後段`)
        //--only 指向他者(不存在之前綴)⇒ 拒絕; 指向本節點 + --force ⇒ 實跑強制重算 dB(其餘不動)
        let r4 = rsiCli(root, ['--mode', 'fill', '--force', '--only', id8, '--no-postfit', '--ext', 'dB'])
        assert.equal(r4.status, 0, r4.out.slice(0, 2500))
        assert(r4.out.includes('--only 命中已執行之節點 1 個') && r4.out.includes(OPT({ scope: '1 個節點(--only)', pf: '不算(--no-postfit)', ext: 'dB', force: '是' })), r4.out.slice(0, 1500))
        let f4 = JSON.parse(fs.readFileSync(FK.fillFileOf(rsiRoot, id), 'utf8'))
        assert.notEqual(f4.ext.dB.at, f3.ext.dB.at, '--force: dB 已現行而仍重算')
        assert.equal(f4.ext.dA.at, f3.ext.dA.at, '範圍外之項目不動')
        assert.equal(f4.postfit.at, f3.postfit.at)
        assert(!fs.existsSync(path.join(wd, '.evals.log')))
    })

    it('--mode extfill 於狀態檔未寫成時離開碼為 5(已算之結果照留、訊息如實);狀態檔可寫時為 0', () => {
        let { root, id } = mkProject('ext5', { realSel: true, diags: ['dA'] })
        let rsiRoot = path.join(root, 'rsi')
        //狀態檔之位置被一個資料夾占住 ⇒ 寫不成(其餘之寫入照常)
        let fpState = path.join(rsiRoot, 'fill_state.json')
        fs.mkdirSync(fpState, { recursive: true })
        let r1 = rsiCli(root, ['--mode', 'extfill'])
        assert(r1.out.includes('補算擴充診斷(dA):已執行節點 1 個;補入 1 個、失敗 0 個、其餘已有值'), `補入成功(鑑別前提: 失敗者為 0, 離開碼 5 只因狀態檔): ${r1.out.slice(0, 2500)}`)
        assert(r1.out.includes('**附算之狀態檔未寫成**'), r1.out.slice(0, 2500))
        assert.equal(r1.status, 5, r1.out.slice(0, 2500))
        assert(JSON.parse(fs.readFileSync(FK.fillFileOf(rsiRoot, id), 'utf8')).ext.dA, '已算之結果照留(補算檔)')
        assert(JSON.parse(fs.readFileSync(path.join(rsiRoot, 'records', 'nodes', `${id}.json`), 'utf8')).harness.raw.metrics.ext.dA, '已併入節點文件')
        //對照: 狀態檔可寫 ⇒ 同一指令(強制重算)離開碼 0、無該訊息
        fs.rmSync(fpState, { recursive: true, force: true })
        let r2 = rsiCli(root, ['--mode', 'extfill', '--force'])
        assert.equal(r2.status, 0, r2.out.slice(0, 2500))
        assert(r2.out.includes('補入 1 個、失敗 0 個') && !r2.out.includes('狀態檔未寫成'), r2.out.slice(0, 1500))
        assert(fs.statSync(fpState).isFile(), '狀態檔已寫成')
    })
})
