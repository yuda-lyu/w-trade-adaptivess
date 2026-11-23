import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import * as CFG from '../src/cfg.mjs'
import { makeTmp, writeSynthLedger, FD_ROOT } from './tools/synthLedger.mjs'
//具名匯出以命名空間取得(修前之複本無此二匯出時, 本檔仍可載入, 各案以斷言失敗呈現而非整檔載入失敗)
let { CLI_FLAGS, eqFlagMsgOf } = CFG


//命令列旗標之等號寫法(排程第 590 項; 1.0.42 先處理 --subset=、--member=): 命令列只認 --key value(空白分隔); argOf 不識 --key=value 而視為旗標未給, 被靜默忽略者使結果與使用者之意圖不同
//  (--period=postfit 退回回測期之評估而記為正本列、--null=8 / --phases=0,3 / --mode=full 之設定被忽略、--ref= / --ext-test= 不執行、--no-log=1 不生效、g_rsi.mjs 之 --mode=round 被當成 status、g_build.mjs 之 --limit=5 建成全庫之帳本)
//  規格(主控之裁定): 凡帶等號之寫法一律拒收, 處置同 1.0.42: 離開碼 2、於載入模組與資源閘之前(讀設定之前)、不寫結果檔、不記評估紀錄、訊息指明須以空白分隔且不帶輸入值(K9);
//  本套件各進入檔(src/cli/*.mjs)之旗標以 cfg.mjs 之 CLI_FLAGS 為單一定義, 以原始碼之盤點核對: 進入檔讀取之旗標 = 該表之鍵
let NODE = process.execPath
let SECRET = 'secret-token-xyz'
let CLI_DIR = path.join(FD_ROOT, 'src', 'cli')

describe('命令列旗標之等號寫法(排程第 590 項)', function () {
    this.timeout(300000)
    let t = makeTmp('cliEqFlags')
    after(() => t.cleanup())

    describe('eqFlagMsgOf(純函數)', () => {
        let F = { 'pick': '<module.mjs>', 'member': '<salt>:<half>', 'subset': '<rule>', 'no-log': null }

        it('帶值之旗標之等號寫法 ⇒ 固定訊息(指明旗標名、值之格式、須以空白分隔); 布林旗標 ⇒ 須單獨書寫; 空值(--pick=)亦拒', () => {
            //對應規格:「訊息指明須以空白分隔、不帶輸入值」
            assert.strictEqual(eqFlagMsgOf(F, ['--pick=a.mjs']), 'invalid --pick: must be written as --pick <module.mjs> (a space, not =)')
            assert.strictEqual(eqFlagMsgOf(F, ['--pick=']), 'invalid --pick: must be written as --pick <module.mjs> (a space, not =)')
            assert.strictEqual(eqFlagMsgOf(F, ['--no-log=1']), 'invalid --no-log: must be written as --no-log alone (a flag without a value, not =)')
            assert.strictEqual(eqFlagMsgOf(F, ['--member=1:0']), 'invalid --member: must be written as --member <salt>:<half> (a space, not =)')
            assert.strictEqual(eqFlagMsgOf(F, ['--subset=side:long']), 'invalid --subset: must be written as --subset <rule> (a space, not =)')
        })

        it('合格之寫法不拒: 空白分隔之值(值內含 = 亦可)、無旗標、布林旗標單獨書寫、單橫線之引數', () => {
            //對照: 上列被拒者之空白分隔寫法照常
            assert.strictEqual(eqFlagMsgOf(F, []), null)
            assert.strictEqual(eqFlagMsgOf(F, ['--pick', 'a.mjs', '--no-log']), null)
            assert.strictEqual(eqFlagMsgOf(F, ['--pick', 'a=b.mjs']), null, '值內含 = 者不是旗標之等號寫法(其前不以 -- 起首)')
            assert.strictEqual(eqFlagMsgOf(F, ['--pick', 'x', '-x=1', 'y=2']), null, '只認 -- 起首之引數')
            assert.strictEqual(eqFlagMsgOf(F, [1, null, undefined, {}]), null, '非字串之元素不處理')
        })

        it('未列之旗標(含拼錯者、原型之名稱)帶等號亦拒, 訊息為通稱、不寫出該名稱(輸入值之一部分; K9)', () => {
            let GEN = 'invalid option: must be written as --<key> <value> (a space, not =; a flag without a value is written alone)'
            for (let a of ['--foo=bar', '--perod=postfit', '--=x', '--constructor=1', '--__proto__=1', '--hasOwnProperty=1', '--toString=1', `--${SECRET}=1`]) {
                let m = eqFlagMsgOf(F, [a])
                assert.strictEqual(m, GEN, a)
                assert(!m.includes(SECRET), `${a}: 不回顯`)
            }
        })

        it('值不回顯(K9): 值為獨特字串時訊息不含它; 多個帶等號者之先後: first 所列者優先、其餘依命令列之次序', () => {
            for (let a of [`--pick=${SECRET}`, `--member=${SECRET}`, `--no-log=${SECRET}`]) {
                assert(!eqFlagMsgOf(F, [a]).includes(SECRET), a)
            }
            assert.strictEqual(eqFlagMsgOf(F, ['--subset=a', '--member=b']), 'invalid --subset: must be written as --subset <rule> (a space, not =)', '無 first: 依命令列之次序')
            assert.strictEqual(eqFlagMsgOf(F, ['--subset=a', '--member=b'], ['member', 'subset']), 'invalid --member: must be written as --member <salt>:<half> (a space, not =)', 'first: member 先')
            assert.strictEqual(eqFlagMsgOf(F, ['--pick=a', '--subset=b'], ['member', 'subset']), 'invalid --subset: must be written as --subset <rule> (a space, not =)', 'first 所列者先於其他')
        })
    })

    describe('旗標之盤點(原始碼 ⇒ CLI_FLAGS; 單一定義)', () => {
        //進入檔讀取旗標之寫法: argOf('x'、argStrOf('x'、cliInt('x')、list('x')(g_rsi.mjs 之輔助函數)與字串字面 '--x'(process.argv.includes / indexOf / filter)
        //  輪末摘要工具之呼叫(spawnSync([FP_DIGEST, <輪>, '--out']): 他程式之引數, 不是本進入檔讀取之旗標)之行不計
        let flagsRead = (src0) => {
            let src = src0.split('\n').filter((l) => !l.includes('FP_DIGEST')).join('\n')
            let s = new Set()
            for (let re of [/argOf\('([a-z][\w-]*)'/g, /argStrOf\('([a-z][\w-]*)'/g, /argNumOf\('([a-z][\w-]*)'/g, /cliInt\('([a-z][\w-]*)'\)/g, /\blist\('([a-z][\w-]*)'\)/g, /'--([a-z][\w-]*)'/g]) {
                for (let m of src.matchAll(re)) {
                    s.add(m[1])
                }
            }
            return [...s].sort()
        }
        for (let entry of ['eval', 'backtest', 'build', 'rsi', 'toolbox', 'launch']) {
            it(`${entry}.mjs: 讀取之旗標 = CLI_FLAGS.${entry} 之鍵(新增旗標須同時加於表; 表內不留未讀之旗標)`, () => {
                let src = fs.readFileSync(path.join(CLI_DIR, `${entry}.mjs`), 'utf8')
                assert.deepEqual(flagsRead(src), Object.keys(CLI_FLAGS[entry]).sort())
            })
            it(`${entry}.mjs: 以 cliMsgOf('${entry}'…)(先 eqFlagMsgOf 檢查帶等號之旗標, 再檢查未列之旗標等; 見 unit-cliStrictFlags)檢查, 且於讀設定(getSettings)與任何寫入之前`, () => {
                let src = fs.readFileSync(path.join(CLI_DIR, `${entry}.mjs`), 'utf8')
                let i = src.indexOf(`cliMsgOf('${entry}'`)
                assert(i > 0, '有檢查')
                let j = src.search(/=\s*getSettings\(\)|\bP\('rsi', 'logs'\)/)
                assert(j < 0 || i < j, '檢查在讀設定之前')
            })
        }
        it('布林旗標(其後不接值: 原始碼以 === true 或 includes 判定)之清單釘死於表(null); 其餘皆為帶值之旗標(格式說明)', () => {
            //對應規格:「訊息指明須以空白分隔」之對象為帶值者; 布林旗標改寫為「須單獨書寫」
            let BOOL = { eval: ['no-log'], backtest: ['show'], build: ['train'], rsi: ['dream-only', 'dry', 'force', 'keep-flags', 'no-member', 'no-postfit'], toolbox: [], launch: [] }
            for (let [entry, tbl] of Object.entries(CLI_FLAGS)) {
                assert.deepEqual(Object.keys(tbl).filter((k) => tbl[k] === null).sort(), BOOL[entry], entry)
            }
        })

        it('CLI_FLAGS 之各表只有字串(格式說明)或 null(布林旗標); 帶值之格式說明為程式常數', () => {
            for (let [entry, tbl] of Object.entries(CLI_FLAGS)) {
                for (let [k, v] of Object.entries(tbl)) {
                    assert(v === null || (typeof v === 'string' && v.length > 0), `${entry}.${k}`)
                }
            }
            assert.deepEqual(Object.keys(CLI_FLAGS), ['eval', 'backtest', 'build', 'rsi', 'toolbox', 'launch'])
        })
    })

    //空之專案根(無 settings.json): 檢查於讀設定之前 ⇒ 離開碼 2 與訊息; 讀設定者會以 ENOENT 之堆疊離開(離開碼 1), 故離開碼 2 即證明「於讀設定之前」
    describe('各進入檔(空之專案根: 於讀設定之前拒收)', () => {
        let emptyRoot = path.join(t.dir, 'empty')
        fs.mkdirSync(emptyRoot, { recursive: true })
        let runIn = (root, entry, args, env = {}) => {
            let e = { ...process.env, ARSI_ROOT: root, ...env }
            delete e.ARSI_AGENT_ROLE
            if (!('ARSI_HARNESS' in env)) {
                delete e.ARSI_HARNESS
            }
            let r = spawnSync(NODE, [path.join(CLI_DIR, `${entry}.mjs`), ...args], { cwd: root, env: e, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            return { status: r.status, out: `${r.stdout}`.split(/\r?\n/).filter(Boolean), err: r.stderr }
        }
        let expectMsg = (entry, name) => {
            let v = CLI_FLAGS[entry][name]
            return v === null ? `invalid --${name}: must be written as --${name} alone (a flag without a value, not =)` : `invalid --${name}: must be written as --${name} ${v} (a space, not =)`
        }

        for (let entry of ['eval', 'backtest', 'build', 'rsi']) {
            it(`${entry}.mjs: CLI_FLAGS.${entry} 之每一個旗標以 --旗標=值 書寫 ⇒ 離開碼 2、只一行之固定訊息、不回顯值`, () => {
                //對應規格:「凡帶等號之寫法一律拒收」「訊息不帶輸入值(K9)」; backtest 須有 ARSI_HARNESS=1(未授權者離開碼 4 在先)
                let env = entry === 'backtest' ? { ARSI_HARNESS: '1' } : {}
                for (let name of Object.keys(CLI_FLAGS[entry])) {
                    let r = runIn(emptyRoot, entry, [`--${name}=${SECRET}`], env)
                    assert.strictEqual(r.status, 2, `--${name}=: ${r.out.join(' | ').slice(0, 200)} ${r.err.slice(0, 200)}`)
                    assert.deepEqual(r.out, [expectMsg(entry, name)], `--${name}=`)
                    assert(!r.out.join('\n').includes(SECRET) && !r.err.includes(SECRET), `--${name}=: 不回顯`)
                    //空值與帶有效值者亦同; 與合格之旗標併用、置於其後者亦同
                    let r2 = runIn(emptyRoot, entry, ['--x', '1', `--${name}=`], env)
                    assert.strictEqual(r2.status, 2, `--${name}= 空值`)
                    assert.deepEqual(r2.out, [expectMsg(entry, name)])
                }
            })
        }

        it('backtest.mjs: 未授權(無 ARSI_HARNESS)者離開碼 4 在先(授權之檢查先於旗標之檢查; 不洩漏旗標之訊息)', () => {
            let r = runIn(emptyRoot, 'backtest', ['--seed=7'])
            assert.strictEqual(r.status, 4)
            assert(/只供迴圈使用/.test(r.out.join('\n')) && !/invalid/.test(r.out.join('\n')))
        })

        it('toolbox.mjs、launch.mjs(無旗標): 任何 --key=value 皆拒(離開碼 2、通稱之訊息); launch 之 `--` 之後(子行程之引數)原樣轉交、不在此拒', () => {
            let GEN = 'invalid option: must be written as --<key> <value> (a space, not =; a flag without a value is written alone)'
            let a = runIn(emptyRoot, 'toolbox', ['--quiet=1'])
            assert.strictEqual(a.status, 2)
            assert.deepEqual(a.out, [GEN])
            //launch: 日誌名之前之 --name=x 拒收(未建日誌夾); `--` 之後之 --mode=round 不屬 launch 之旗標(由子行程之進入檔自行拒收)
            let b = runIn(emptyRoot, 'launch', ['--name=x', '--', 'g_rsi.mjs'])
            assert.strictEqual(b.status, 2)
            assert.deepEqual(b.out, [GEN])
            assert(!fs.existsSync(path.join(emptyRoot, 'rsi')), 'launch 未建日誌夾')
        })

        it('合格之寫法(空白分隔; 值內含 =)不被拒: 以 eval 之 --pick 為例, 通過旗標之檢查後依其餘之處理(此處因專案根無設定而於讀設定時離開, 離開碼不是 2 之固定訊息)', () => {
            //對照: 若旗標之檢查誤拒空白分隔者, 離開碼 2 與固定訊息會出現
            let r = runIn(emptyRoot, 'eval', ['--pick', 'a=b.mjs', '--mode', 'full', '--no-log'])
            assert(!r.out.some((l) => l.startsWith('invalid')), r.out.join('|'))
            assert.notStrictEqual(r.status, 2)
        })
    })

    describe('g_eval.mjs(有帳本之專案根): 不評估、不寫結果檔、不記評估紀錄; 空白分隔之寫法照常評估', () => {
        let N = 40
        let root = path.join(t.dir, 'proj')
        let W = path.join(root, 'rsi', 'work', 'w1')
        let setup = () => {
            writeSynthLedger(path.join(root, 'ledger', 'eval'), { n: N, nBars: 2400, seed: 5 })
            fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
            fs.mkdirSync(W, { recursive: true })
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
                periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } },
                eval: { ledgerDir: './ledger/eval', warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws: 4, seed: 1, limits: { monthlyOrders: 400, peakHold: 50 }, fitEnd: { long: '2022-12-01T00:00:00', short: '2023-01-17T00:00:00' } },
                score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] },
                rsi: { root: './rsi' },
                records: { workDir: './rsi/work' },
                dispatch: {},
            }), 'utf8')
            fs.writeFileSync(path.join(W, 'pick.mjs'), 'export default function pick(ctx) {\n    let ids = []\n    for (let s = 0; s < ctx.n; s += 3) ids.push(s)\n    return ids\n}\n', 'utf8')
        }
        setup()
        let run = (args, env = {}) => {
            let e = { ...process.env, ARSI_ROOT: root, ...env }
            delete e.ARSI_HARNESS
            let fpOut = path.join(root, 'out.json')
            fs.rmSync(fpOut, { force: true })
            let r = spawnSync(NODE, [path.join(CLI_DIR, 'eval.mjs'), '--pick', path.join(W, 'pick.mjs'), '--out', fpOut, ...args], { cwd: root, env: e, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            let o = null
            try {
                o = JSON.parse(fs.readFileSync(fpOut, 'utf8'))
            }
            catch (err) {}
            return { status: r.status, out: `${r.stdout}`.split(/\r?\n/).filter(Boolean), o }
        }
        let logOf = () => {
            let fp = path.join(W, '.evals.log')
            return fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
        }

        it('原靜默忽略者: --period=postfit / --period=train、--mode=full、--null=8、--phases=0,3、--ref=…、--ext-test=…、--no-log=1、--out=…、--seed=7、--tie-salt=1、--ext-only=…、--pick=… ⇒ 離開碼 2、固定訊息、不寫結果檔、不記評估紀錄', () => {
            //對應規格:「--period=postfit 退回回測期之正本且記為正本列 ⇒ 統一拒收」; 不論其前其後有無合格之旗標
            let before = logOf()
            assert.deepEqual(before, [])
            let cases = [
                ['--mode', 'full', '--period=postfit', 'period'],
                ['--period=train', 'period'],
                ['--mode=full', 'mode'],
                ['--mode', 'full', '--null=8', 'null'],
                ['--phases=0,3', 'phases'],
                ['--ref=x.mjs', 'ref'],
                ['--ext-test=x.mjs', 'ext-test'],
                ['--no-log=1', 'no-log'],
                ['--no-log=true', 'no-log'],
                ['--out=o.json', 'out'],
                ['--seed=7', 'seed'],
                ['--tie-salt=1', 'tie-salt'],
                ['--ext-only=a', 'ext-only'],
                ['--pick=p.mjs', 'pick'],
                ['--mode', 'full', '--period', 'train', '--null=8', 'null'],
                //同時帶 --subset= 與 --member=: 先報 --member(沿用 1.0.42; 與命令列之先後無關)
                ['--subset=side:long', '--member=1:0', 'member'],
                ['--member=1:0', '--subset=side:long', 'member'],
                //帶等號之旗標在先、合格之空白分隔寫法在後(不被後者遮蔽)
                ['--subset=side:long', '--subset', 'side:short', 'subset'],
            ]
            for (let c of cases) {
                let name = c[c.length - 1]
                let args = c.slice(0, -1)
                let r = run(args)
                let v = CLI_FLAGS.eval[name]
                let msg = v === null ? `invalid --${name}: must be written as --${name} alone (a flag without a value, not =)` : `invalid --${name}: must be written as --${name} ${v} (a space, not =)`
                assert.strictEqual(r.status, 2, `${args.join(' ')}: ${r.out.join('|').slice(0, 200)}`)
                assert.deepEqual(r.out, [msg], args.join(' '))
                assert.strictEqual(r.o, null, `${args.join(' ')}: 不寫結果檔`)
            }
            assert.deepEqual(logOf(), [], '不記評估紀錄')
        })

        it('於載入模組之前: 挑選模組不存在時, 旗標之訊息先於載入錯誤(ERROR PICK_LOAD)', () => {
            let e = { ...process.env, ARSI_ROOT: root }
            delete e.ARSI_HARNESS
            let r = spawnSync(NODE, [path.join(CLI_DIR, 'eval.mjs'), '--pick', path.join(W, 'nonexistent.mjs'), '--period=train'], { cwd: root, env: e, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            assert.strictEqual(r.status, 2)
            assert.deepEqual(`${r.stdout}`.split(/\r?\n/).filter(Boolean), ['invalid --period: must be written as --period <backtest|train|postfit> (a space, not =)'])
        })

        it('對照(同一組引數之空白分隔寫法照常評估; 被拒者若被靜默忽略則離開碼會是 0): --period train、--mode full --null 4、--phases 0,3、--no-log、--ref', () => {
            let a = run(['--mode', 'quick', '--period', 'train'])
            assert.strictEqual(a.status, 0, a.out.join('|').slice(0, 300))
            assert.strictEqual(a.o.ok, true)
            assert.strictEqual(a.o.period.name, 'train')
            let b = run(['--mode', 'full', '--null', '4', '--phases', '0,3'])
            assert.strictEqual(b.status, 0, b.out.join('|').slice(0, 300))
            assert.deepEqual(b.o.metrics.phases, [0, 3])
            assert.strictEqual(b.o.metrics.null.draws, 4)
            let c = run(['--mode', 'quick', '--no-log'])
            assert.strictEqual(c.status, 0)
            let log = logOf()
            assert.strictEqual(log.length, 3, '三次評估各記一列(--no-log 於非迴圈照記並標記)')
            assert.strictEqual(log[2].noLogIgnored, true)
            assert.strictEqual(log[0].period, 'train')
        })
    })

    describe('g_eval.mjs 之 --phases、--seed、--tie-salt(排程第 595 項之命令列部分): 與設定同一口徑', () => {
        let root = path.join(t.dir, 'proj3')
        let W = path.join(root, 'rsi', 'work', 'w1')
        fs.mkdirSync(path.join(root, 'rsi', 'toolbox', 'metrics'), { recursive: true })
        fs.mkdirSync(W, { recursive: true })
        writeSynthLedger(path.join(root, 'ledger', 'eval'), { n: 40, nBars: 2400, seed: 5 })
        let mkSettings = (evOver) => fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
            periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' } },
            eval: { ledgerDir: './ledger/eval', warmupDays: 60, cadenceDays: 7, phases: [0, 3], horizons: [7], nullDraws: 4, seed: 1, limits: { monthlyOrders: 400, peakHold: 50 }, ...evOver },
            score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] },
            rsi: { root: './rsi' },
            records: { workDir: './rsi/work' },
            dispatch: {},
        }), 'utf8')
        fs.writeFileSync(path.join(W, 'pick.mjs'), 'export default function pick(ctx) {\n    let ids = []\n    for (let s = 0; s < ctx.n; s++) {\n        if (ctx.rand() < 0.3) ids.push(s)\n    }\n    return ids\n}\n', 'utf8')
        let run = (args, env = {}) => {
            let e = { ...process.env, ARSI_ROOT: root, ...env }
            if (!('ARSI_HARNESS' in env)) {
                delete e.ARSI_HARNESS
            }
            let fpOut = path.join(root, 'out.json')
            fs.rmSync(fpOut, { force: true })
            fs.rmSync(path.join(W, '.evals.log'), { force: true })
            let r = spawnSync(NODE, [path.join(CLI_DIR, 'eval.mjs'), '--pick', path.join(W, 'pick.mjs'), '--out', fpOut, ...args], { cwd: root, env: e, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            let o = null
            try {
                o = JSON.parse(fs.readFileSync(fpOut, 'utf8'))
            }
            catch (err) {}
            return { status: r.status, out: `${r.stdout}`.split(/\r?\n/).filter(Boolean), o, logged: fs.existsSync(path.join(W, '.evals.log')) }
        }

        it('--phases: 各項須為非負數(數字或數字字串), 與每日棒數之積須為整數; 不合 ⇒ 離開碼 2、固定訊息(不帶輸入值)、不寫結果檔、不記評估紀錄(原: Number(x) 之隱式轉換, 非數字為 NaN ⇒ 該相位無決策棒而靜默算錯、空項當 0)', () => {
            mkSettings({})
            for (let [arg, want] of [
                ['abc', 'invalid --phases[0]: must be a non-negative number'],
                ['0,x', 'invalid --phases[1]: must be a non-negative number'],
                ['0,', 'invalid --phases[1]: must be a non-negative number'],
                [',3', 'invalid --phases[0]: must be a non-negative number'],
                ['0,-1', 'invalid --phases[1]: must be a non-negative number'],
                ['0,Infinity', 'invalid --phases[1]: must be a non-negative number'],
                ['0.1,3', 'invalid --phases[0]: must be a non-negative number of days that is a whole number of bars'],
                [SECRET, 'invalid --phases[0]: must be a non-negative number'],
            ]) {
                let r = run(['--mode', 'quick', '--phases', arg])
                assert.strictEqual(r.status, 2, `--phases ${arg}: ${r.out.join('|').slice(0, 200)}`)
                assert.deepEqual(r.out, [want], arg)
                assert.strictEqual(r.o, null, `${arg}: 不寫結果檔`)
                assert.strictEqual(r.logged, false, `${arg}: 不記評估紀錄`)
            }
            //合格: 數字字串、含空白之項、0.5 日(每日 6 根 = 3 根)
            let ok = run(['--mode', 'quick', '--phases', '0, 3'])
            assert.strictEqual(ok.status, 0, ok.out.join('|').slice(0, 200))
            assert.deepEqual(ok.o.metrics.phases, [0, 3])
            let half = run(['--mode', 'quick', '--phases', '0,0.5'])
            assert.strictEqual(half.status, 0, half.out.join('|').slice(0, 200))
            assert.deepEqual(half.o.metrics.phases, [0, 0.5])
            //只給旗標(無值): 拒收(離開碼 2、通用之無值訊息、不寫結果檔、不記評估紀錄; 排程第 547 項; 原: 忽略而沿用設定)
            let bare = run(['--mode', 'quick', '--phases'])
            assert.strictEqual(bare.status, 2)
            assert.deepEqual(bare.out, ['invalid --phases: must be written as --phases <days,days,…> (a value is required)'])
            assert.strictEqual(bare.o, null, '不寫結果檔')
            assert.strictEqual(bare.logged, false, '不記評估紀錄')
        })

        it('設定之 eval.* 無效 ⇒ 離開碼 2、ERROR invalid eval.<鍵>、結果檔 { ok: false, code: CONFIG_INVALID }、不記評估紀錄; 以數字字串給者照常評估且與數字者之結果檔相同', () => {
            for (let [ev, want] of [
                [{ seed: 'abc' }, 'ERROR invalid eval.seed: must be an integer'],
                [{ geoTp: 0 }, 'ERROR invalid eval.geoTp: must be a positive integer'],
                [{ phases: [0, 'x'] }, 'ERROR invalid eval.phases[1]: must be a non-negative number'],
                [{ limits: { peakHold: 'x' } }, 'ERROR invalid eval.limits.peakHold: must be a non-negative number'],
                [{ timeoutSec: -1 }, 'ERROR invalid eval.timeoutSec: must be a positive number of seconds that is at most 2147483'],
                [{ timeoutSec: 3000000 }, 'ERROR invalid eval.timeoutSec: must be a positive number of seconds that is at most 2147483'],
                [{ tieSalt: 0.5 }, 'ERROR invalid eval.tieSalt: must be an integer'],
            ]) {
                mkSettings(ev)
                let r = run(['--mode', 'quick'])
                assert.strictEqual(r.status, 2, `${JSON.stringify(ev)}: ${r.out.join('|').slice(0, 200)}`)
                assert.deepEqual(r.out, [want], JSON.stringify(ev))
                assert.strictEqual(r.o.code, 'CONFIG_INVALID')
                assert.strictEqual(r.o.error, want.slice(6))
                assert.strictEqual(r.logged, false)
            }
            mkSettings({ seed: 20261110, geoTp: 3, tieSalt: 0, phases: [0, 3] })
            let a = run(['--mode', 'full'])
            mkSettings({ seed: '20261110', geoTp: '3', tieSalt: '0', phases: ['0', '3'] })
            let b = run(['--mode', 'full'])
            assert.strictEqual(a.status, 0)
            assert.strictEqual(b.status, 0, b.out.join('|').slice(0, 200))
            let strip = (o) => JSON.stringify(o, (k, v) => (k === 'ms' || k === 'loadMs' || k === 'at' ? undefined : v))
            assert.strictEqual(strip(b.o), strip(a.o), '字串之設定 ≡ 數字之設定(結果檔; 含 seed 欄為數值)')
            assert.strictEqual(b.o.seed, 20261110)
        })

        it('--seed、--tie-salt 只在迴圈之重放(ARSI_HARNESS=1)時生效且須為(安全)整數: 小數、非數字者忽略並印說明(沿用設定之值); 整數者採用', () => {
            mkSettings({ seed: 77 })
            let plain = run(['--mode', 'quick', '--seed', '5'])
            assert.strictEqual(plain.status, 0)
            assert(plain.out.includes('--seed 只供迴圈之重放使用,已忽略(沿用設定之亂數種子)'))
            assert.strictEqual(plain.o.seed, 77, '非迴圈 ⇒ 沿用設定')
            let H = { ARSI_HARNESS: '1' }
            let ok = run(['--mode', 'quick', '--seed', '5', '--tie-salt', '2', '--no-log'], H)
            assert.strictEqual(ok.status, 0, ok.out.join('|').slice(0, 200))
            assert.strictEqual(ok.o.seed, 5)
            assert.strictEqual(ok.o.tieSalt, 2)
            //迴圈之重放而旗標之值不合(小數、非數字、超出安全整數之整數): 說明原因(須為整數)、沿用設定之值; 非迴圈者一律說「只供迴圈之重放使用」(上)
            for (let sd of ['1.5', 'abc', '1000000000000000000000']) {
                let r = run(['--mode', 'quick', '--seed', sd, '--tie-salt', sd, '--no-log'], H)
                assert.strictEqual(r.status, 0, `${sd}: ${r.out.join('|').slice(0, 200)}`)
                assert(r.out.includes('--seed 須為整數(安全整數之範圍內),已忽略(沿用設定之亂數種子)'), `${sd}: 不合之種子不採用(評估器之種子須為整數)`)
                assert(r.out.includes('--tie-salt 須為整數(安全整數之範圍內),已忽略(沿用正本之同分次序)'), `${sd}: 不合之鹽不採用`)
                assert(!r.out.some((l) => l.includes('只供迴圈之重放使用')), `${sd}: 迴圈之重放不再誤稱「只供迴圈之重放使用」`)
                assert.strictEqual(r.o.seed, 77)
                assert.strictEqual(r.o.tieSalt, undefined)
            }
        })
    })

    describe('g_build.mjs / g_rsi.mjs(有設定之專案根): 不建帳本、不建狀態根', () => {
        it('g_build.mjs --limit=5 / --train=1 ⇒ 離開碼 2、未建任何帳本夾; g_rsi.mjs --mode=round / --dry=1 / --nodes=2 ⇒ 離開碼 2、未建狀態根(原: --mode=round 被當 status、--limit=5 建成全庫之帳本)', () => {
            let root = path.join(t.dir, 'proj2')
            fs.mkdirSync(root, { recursive: true })
            fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
                source: { libraryRoot: './data/library', keyOhlc: 'X', barHours: 4 },
                periods: { train: { start: '2022-07-01T00:00:00', end: '2023-01-17T00:00:00' }, backtest: { start: '2023-02-01T00:00:00', end: '2023-08-05T00:00:00' }, holdoutFrom: '2023-09-01T00:00:00' },
                eval: { ledgerDir: './ledger/eval' },
                rsi: { root: './rsi' },
                records: { workDir: './rsi/work' },
                dispatch: {},
            }), 'utf8')
            let before = fs.readdirSync(root).sort()
            let run = (entry, args) => {
                let e = { ...process.env, ARSI_ROOT: root }
                delete e.ARSI_AGENT_ROLE
                delete e.ARSI_HARNESS
                let r = spawnSync(NODE, [path.join(CLI_DIR, `${entry}.mjs`), ...args], { cwd: root, env: e, windowsHide: true, encoding: 'utf8', timeout: 120000 })
                return { status: r.status, out: `${r.stdout}`.split(/\r?\n/).filter(Boolean) }
            }
            for (let [entry, args, name] of [['build', ['--limit=5'], 'limit'], ['build', ['--train=1'], 'train'], ['rsi', ['--mode=round'], 'mode'], ['rsi', ['--dry=1'], 'dry'], ['rsi', ['--mode', 'round', '--nodes=2'], 'nodes'], ['rsi', ['--mode', 'fill', '--only=abcdef'], 'only']]) {
                let r = run(entry, args)
                let v = CLI_FLAGS[entry][name]
                assert.strictEqual(r.status, 2, `${entry} ${args.join(' ')}: ${r.out.join('|').slice(0, 200)}`)
                assert.deepEqual(r.out, [v === null ? `invalid --${name}: must be written as --${name} alone (a flag without a value, not =)` : `invalid --${name}: must be written as --${name} ${v} (a space, not =)`])
            }
            assert.deepEqual(fs.readdirSync(root).sort(), before, '未建任何檔或夾(帳本夾、狀態根、日誌夾)')
        })
    })
})
