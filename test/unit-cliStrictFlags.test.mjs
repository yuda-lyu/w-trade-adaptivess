import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import * as CFG from '../src/cfg.mjs'
import { SUBSET_MSG, SUBSET_MEMBER_MSG } from '../src/eval/subsetRule.mjs'
import { makeTmp, writeSynthLedger, FD_ROOT } from './tools/synthLedger.mjs'
//具名匯出以命名空間取得(修前之複本無此匯出時, 本檔仍可載入, 各案以斷言失敗呈現而非整檔載入失敗)
let { CLI_FLAGS, CLI_ENUMS, CLI_OWN, cliMsgOf } = CFG


//命令列旗標之嚴格檢查(排程第 547、590 項之接續; 主控已定: g_eval.mjs 其他靜默之寫法一律拒收, 與等號寫法同一檢查點)
//  命令列只認 --key value(空白分隔)與 CLI_FLAGS 內之旗標; 下列原被 argOf 靜默忽略、只取第一個或落入預設者, 一律不執行(離開碼 2、固定單行訊息不帶輸入值、於讀設定與任何寫入之前):
//    未列之旗標(含拼錯 --perod、冒號寫法 --period:postfit)、單值旗標重複、帶值旗標無值、--mode / --period(eval)與 --mode(rsi)與 --match-sides(backtest)之值不在列舉、
//    多餘之值(--phases 0 3、--ref a.mjs b.mjs、--no-log 1)與多餘之位置引數、g_build.mjs --limit 之值非正整數
//  規格之句(逐句對應下列各案): 「凡帶等號之寫法」(既有)先於「未列之旗標」「重複」「無值」「列舉之值」「多餘之值」; 訊息不帶輸入值(K9); 旗標名只在其為表所列者(程式常數)才寫出
let NODE = process.execPath
let SECRET = 'secret-token-xyz'
let CLI_DIR = path.join(FD_ROOT, 'src', 'cli')
let ENTRIES = ['eval', 'backtest', 'build', 'rsi', 'toolbox', 'launch']

describe('命令列旗標之嚴格檢查(未列之旗標、重複、無值、列舉之值、多餘之值; 與等號寫法同一檢查點)', function () {
    this.timeout(300000)
    let t = makeTmp('cliStrictFlags')
    after(() => t.cleanup())

    describe('cliMsgOf(純函數)', () => {
        let eval0 = (a) => cliMsgOf('eval', a)
        let ONE_OF_EVAL = `invalid option: must be one of ${Object.keys(CLI_FLAGS.eval).map((x) => `--${x}`).join(', ')}`

        it('合格之寫法不拒: 空白分隔之值、布林旗標單獨、負數之值(單橫線起首非旗標)、列舉內之值、own 旗標(null / member / subset)之無值交由進入檔自己之解析', () => {
            //對照: 下列各案之違規版皆被拒
            assert.strictEqual(eval0([]), null)
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--mode', 'full', '--period', 'postfit', '--null', '8', '--phases', '0,3', '--no-log']), null)
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--null', '-3']), null, '單橫線起首之值是值, 不是旗標')
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--phases', '0, 3']), null, '單一值內含空白與逗號: 一個值')
            assert.strictEqual(eval0(['--pick', 'a=b.mjs']), null, '值內含 = 者不是旗標之等號寫法')
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--null']), null, '--null 無值: 由 g_eval.mjs 自己之解析回 invalid --null: must be a non-negative integer')
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--member']), null, '--member 無值: 由其自己之解析回固定訊息')
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--subset', '--null', '4']), null)
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--member', '0:0', '--member', '0:1']), null, '--member 重複: 由其自己之解析回固定訊息')
            assert.strictEqual(cliMsgOf('rsi', ['--mode', 'round', '--dream-only', '--file']), null, 'rsi --file 無值: 只做夢輪次之解析自己回固定訊息')
        })

        it('未列之旗標(拼錯、冒號寫法、單獨之 --、他進入檔之旗標、原型之名稱)⇒ 固定訊息, 列出本進入檔之全部旗標(程式常數), 不回顯該引數', () => {
            for (let a of ['--perod', '--period:postfit', '--mode:full', '--', '--constructor', '--__proto__', '--toString', `--${SECRET}`, '--dry', '--nodes']) {
                let m = eval0(['--pick', 'a.mjs', a, 'x'])
                assert.strictEqual(m, ONE_OF_EVAL, a)
                assert(!m.includes(SECRET), `${a}: 不回顯`)
            }
            //旗標名依表: 他進入檔之旗標對本進入檔為未列(--dry 屬 rsi)
            assert.strictEqual(cliMsgOf('rsi', ['--limit', '5']), `invalid option: must be one of ${Object.keys(CLI_FLAGS.rsi).map((x) => `--${x}`).join(', ')}`)
        })

        it('單值旗標重複 ⇒ invalid --<名>: must be given at most once(帶值與布林皆然; 值相同亦拒)', () => {
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--pick', 'b.mjs']), 'invalid --pick: must be given at most once')
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--pick', 'a.mjs']), 'invalid --pick: must be given at most once')
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--mode', 'quick', '--mode', 'full']), 'invalid --mode: must be given at most once')
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--null', '4', '--null', '5']), 'invalid --null: must be given at most once')
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--no-log', '--no-log']), 'invalid --no-log: must be given at most once')
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--ref', 'x.mjs', '--ref', 'y.mjs']), 'invalid --ref: must be given at most once')
        })

        it('帶值旗標無值(置末或其後接另一旗標)⇒ invalid --<名>: must be written as --<名> <格式> (a value is required)', () => {
            for (let name of Object.keys(CLI_FLAGS.eval).filter((k) => CLI_FLAGS.eval[k] !== null && !CLI_OWN.eval.noValue.includes(k) && !(k in CLI_ENUMS.eval))) {
                let want = `invalid --${name}: must be written as --${name} ${CLI_FLAGS.eval[name]} (a value is required)`
                assert.strictEqual(eval0([`--${name}`]), want, `${name} 置末`)
                assert.strictEqual(eval0([`--${name}`, '--no-log']), want, `${name} 後接旗標`)
            }
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--phases']), 'invalid --phases: must be written as --phases <days,days,…> (a value is required)')
        })

        it('帶值旗標之值為空字串或只有空白 ⇒ 視同無值(原: 被當成值而下游靜默忽略 —— `--out ""` 不寫結果檔、`--dir ""` 落入正式之結果夾); 列舉旗標同; own 旗標(null / member / subset / file)之空值由進入檔自己之解析處理(此處只消耗該值)', () => {
            for (let name of Object.keys(CLI_FLAGS.eval).filter((k) => CLI_FLAGS.eval[k] !== null && !CLI_OWN.eval.noValue.includes(k) && !(k in CLI_ENUMS.eval))) {
                let want = `invalid --${name}: must be written as --${name} ${CLI_FLAGS.eval[name]} (a value is required)`
                for (let v of ['', ' ', '\t ']) {
                    assert.strictEqual(eval0([`--${name}`, v]), want, `${name} = ${JSON.stringify(v)}`)
                    assert.strictEqual(eval0([`--${name}`, v, '--no-log']), want, `${name} = ${JSON.stringify(v)}(其後接旗標)`)
                }
            }
            assert.strictEqual(eval0(['--mode', '']), 'invalid --mode: must be one of quick, full')
            assert.strictEqual(eval0(['--period', ' ']), 'invalid --period: must be one of backtest, train, postfit')
            assert.strictEqual(cliMsgOf('backtest', ['--dir', '']), 'invalid --dir: must be written as --dir <result-dir> (a value is required)')
            assert.strictEqual(cliMsgOf('rsi', ['--mode', 'fill', '--null', '']), 'invalid --null: must be written as --null <N> (a value is required)')
            //own: 空值由進入檔自己之解析處理(其後之旗標照常檢查; 空值被消耗而不被當成多餘之值)
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--null', '']), null)
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--member', '', '--no-log']), null)
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--subset', ' ', '--no-log']), null)
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--member', '', '--perod']), ONE_OF_EVAL, '空值被消耗後, 其後之未列旗標仍被拒')
            assert.strictEqual(cliMsgOf('rsi', ['--mode', 'round', '--dream-only', '--file', '']), null)
            //對照: 非空之值不受影響
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--out', 'o.json', '--tie-salt', '0']), null)
        })

        it('列舉之旗標(eval 之 --mode、--period; rsi 之 --mode; backtest 之 --match-sides): 值不在集合或無值 ⇒ invalid --<名>: must be one of <集合>; 集合內之值不拒', () => {
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--mode', 'ful']), 'invalid --mode: must be one of quick, full')
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--mode']), 'invalid --mode: must be one of quick, full')
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--mode', 'FULL']), 'invalid --mode: must be one of quick, full', '大小寫相異者亦拒')
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--period', 'other']), 'invalid --period: must be one of backtest, train, postfit')
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--period']), 'invalid --period: must be one of backtest, train, postfit')
            assert.strictEqual(eval0(['--pick', 'a.mjs', '--mode', '1']), 'invalid --mode: must be one of quick, full', '數字之值不在集合')
            for (let m of ['quick', 'full']) {
                assert.strictEqual(eval0(['--pick', 'a.mjs', '--mode', m]), null, m)
            }
            for (let p of ['backtest', 'train', 'postfit']) {
                assert.strictEqual(eval0(['--pick', 'a.mjs', '--period', p]), null, p)
            }
            assert.strictEqual(cliMsgOf('rsi', ['--mode', 'nosuch']), `invalid --mode: must be one of ${CLI_ENUMS.rsi.mode.join(', ')}`)
            for (let m of CLI_ENUMS.rsi.mode) {
                assert.strictEqual(cliMsgOf('rsi', ['--mode', m]), null, m)
            }
            assert.strictEqual(cliMsgOf('backtest', ['--match-sides', 'yes']), 'invalid --match-sides: must be one of 0, 1')
            assert.strictEqual(cliMsgOf('backtest', ['--match-sides']), 'invalid --match-sides: must be one of 0, 1')
            assert.strictEqual(cliMsgOf('backtest', ['--match-sides', '0']), null)
            assert.strictEqual(cliMsgOf('backtest', ['--match-sides', '1']), null)
        })

        it('多餘之值: 帶值旗標之值之後再接值(--phases 0 3、--ref a.mjs b.mjs、--ext-only a b)、布林旗標之後接值(--no-log 1)、多餘之位置引數 ⇒ 固定訊息(不回顯)', () => {
            let STRAY = 'invalid argument: must be the value of the preceding option (--<key> <value>; a flag without a value is written alone)'
            for (let a of [['--phases', '0', '3'], ['--ref', 'a.mjs', 'b.mjs'], ['--ext-only', 'a', 'b'], ['--no-log', '1'], ['--no-log', SECRET], [SECRET], ['--mode', 'quick', SECRET], ['--seed', '1', '2']]) {
                let m = eval0(['--pick', 'a.mjs', ...a])
                assert.strictEqual(m, STRAY, a.join(' '))
                assert(!m.includes(SECRET), '不回顯')
            }
            assert.strictEqual(eval0(['x']), STRAY, '位置引數')
        })

        it('檢查之次序: 帶等號者先(沿用 1.0.42 之 first); 其後自左至右第一個違規者(未列之旗標先於其後之重複)', () => {
            assert.strictEqual(eval0(['--perod', '--mode=full']), 'invalid --mode: must be written as --mode <quick|full> (a space, not =)', '等號寫法先於未列之旗標')
            assert.strictEqual(cliMsgOf('eval', ['--subset=a', '--member=b'], { first: ['member', 'subset'] }), 'invalid --member: must be written as --member <salt>:<half> (a space, not =)')
            assert.strictEqual(eval0(['--perod', 'x', '--pick', 'a', '--pick', 'b']), ONE_OF_EVAL, '自左至右: 未列之旗標在先')
            assert.strictEqual(eval0(['--pick', 'a', '--pick', 'b', '--perod']), 'invalid --pick: must be given at most once', '自左至右: 重複在先')
        })

        it('toolbox(無旗標、無位置引數)、launch(日誌名一個、無旗標): 任何旗標與多餘之引數皆拒; launch 之日誌名(位置引數 1 個)合格', () => {
            assert.strictEqual(cliMsgOf('toolbox', []), null)
            assert.strictEqual(cliMsgOf('toolbox', ['--x']), 'invalid option: must be none (this command takes no options)')
            assert.strictEqual(cliMsgOf('toolbox', ['x']), 'invalid argument: must be the value of the preceding option (--<key> <value>; a flag without a value is written alone)')
            assert.strictEqual(cliMsgOf('launch', ['round'], { positional: 1 }), null)
            assert.strictEqual(cliMsgOf('launch', ['round', 'x'], { positional: 1 }), 'invalid argument: must be the value of the preceding option (--<key> <value>; a flag without a value is written alone)')
            assert.strictEqual(cliMsgOf('launch', ['--round'], { positional: 1 }), 'invalid option: must be none (this command takes no options)')
            assert.strictEqual(cliMsgOf('launch', ['round'], { positional: 0 }), 'invalid argument: must be the value of the preceding option (--<key> <value>; a flag without a value is written alone)', '未允許位置引數者拒')
        })
    })

    describe('列舉與 own 之單一定義(CLI_ENUMS、CLI_OWN)與 CLI_FLAGS 及原始碼一致', () => {
        it('CLI_ENUMS: 列舉之旗標在 CLI_FLAGS 內且為帶值旗標, 其格式說明 = <集合以 | 相接>; 集合內之值皆為字串且不重複', () => {
            for (let [entry, tbl] of Object.entries(CLI_ENUMS)) {
                for (let [name, vals] of Object.entries(tbl)) {
                    assert(CLI_FLAGS[entry][name] !== undefined && CLI_FLAGS[entry][name] !== null, `${entry}.${name} 為帶值旗標`)
                    assert.strictEqual(CLI_FLAGS[entry][name], `<${vals.join('|')}>`, `${entry}.${name} 之格式說明 = 集合`)
                    assert(vals.every((v) => typeof v === 'string' && v.length > 0) && new Set(vals).size === vals.length)
                }
            }
            assert.deepEqual(Object.keys(CLI_ENUMS), ['eval', 'backtest', 'rsi'])
        })

        it('rsi 之 mode 之集合 = src/cli/rsi.mjs 內 `mode === \'…\'` 之全部字面值(新增模式須同時加於集合)', () => {
            let src = fs.readFileSync(path.join(CLI_DIR, 'rsi.mjs'), 'utf8')
            let lits = new Set([...src.matchAll(/\bmode === '([a-z]+)'/g)].map((m) => m[1]))
            assert.deepEqual([...lits].sort(), [...CLI_ENUMS.rsi.mode].sort())
        })

        it('CLI_OWN: 所列之旗標在 CLI_FLAGS 內(帶值者); 進入檔自己之解析之固定訊息存在於原始碼(eval: --null、--member、--subset; rsi: --file)', () => {
            for (let [entry, o] of Object.entries(CLI_OWN)) {
                for (let name of [...o.noValue, ...o.dup]) {
                    assert(CLI_FLAGS[entry][name] !== undefined && CLI_FLAGS[entry][name] !== null, `${entry}.${name}`)
                }
            }
            let ev = fs.readFileSync(path.join(CLI_DIR, 'eval.mjs'), 'utf8')
            assert(ev.includes('\'invalid --null: must be a non-negative integer\''))
            assert(ev.includes('\'invalid --member: must be <salt>:<half>'))
            assert(ev.includes('SUBSET_MSG'))
            let rs = fs.readFileSync(path.join(CLI_DIR, 'rsi.mjs'), 'utf8')
            assert(rs.includes('\'invalid --file: must be the path of a readable, non-empty UTF-8 text file'))
        })

        it('各進入檔以 cliMsgOf(\'<名>\'…) 檢查, 且於讀設定(getSettings)與任何寫入之前', () => {
            for (let entry of ENTRIES) {
                let src = fs.readFileSync(path.join(CLI_DIR, `${entry}.mjs`), 'utf8')
                let i = src.indexOf(`cliMsgOf('${entry}'`)
                assert(i > 0, `${entry}: 有檢查`)
                let j = src.search(/=\s*getSettings\(\)|\bP\('rsi', 'logs'\)/)
                assert(j < 0 || i < j, `${entry}: 檢查在讀設定之前`)
            }
            //launch: 只檢 `--` 之前、日誌名一個(位置引數 1 個); 進入檔會起 detached 之子行程與建日誌夾 ⇒ 以原始碼核對接線(行為由上之純函數案驗)
            let ln = fs.readFileSync(path.join(CLI_DIR, 'launch.mjs'), 'utf8')
            assert(ln.includes('cliMsgOf(\'launch\', argv.slice(0, k), { positional: 1 })'), 'launch.mjs: 只檢 -- 之前之引數、日誌名一個')
        })
    })

    describe('各進入檔(空之專案根: 於讀設定之前拒收; 離開碼 2、只一行之固定訊息、不寫任何檔)', () => {
        let emptyRoot = path.join(t.dir, 'empty')
        fs.mkdirSync(emptyRoot, { recursive: true })
        let runIn = (entry, args, env = {}) => {
            let e = { ...process.env, ARSI_ROOT: emptyRoot, ...env }
            delete e.ARSI_AGENT_ROLE
            if (!('ARSI_HARNESS' in env)) {
                delete e.ARSI_HARNESS
            }
            let r = spawnSync(NODE, [path.join(CLI_DIR, `${entry}.mjs`), ...args], { cwd: emptyRoot, env: e, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            return { status: r.status, out: `${r.stdout}`.split(/\r?\n/).filter(Boolean), err: r.stderr }
        }
        let first = (entry) => Object.keys(CLI_FLAGS[entry]).find((k) => CLI_FLAGS[entry][k] !== null && !(k in (CLI_ENUMS[entry] || {})) && !(CLI_OWN[entry] && CLI_OWN[entry].noValue.includes(k)))
        for (let entry of ['eval', 'backtest', 'build', 'rsi']) {
            it(`${entry}.mjs: 未列之旗標、單值旗標重複、帶值旗標無值、多餘之值 ⇒ 離開碼 2、與 cliMsgOf 相同之固定訊息、專案根仍為空`, () => {
                let env = entry === 'backtest' ? { ARSI_HARNESS: '1' } : {}
                let f = first(entry)
                let cases = [[`--${SECRET}`, 'x'], ['--perod', 'x'], ['--period:postfit'], [`--${f}`, 'v', `--${f}`, 'w'], [`--${f}`], [`--${f}`, 'v', 'extra']]
                for (let args of cases) {
                    let want = cliMsgOf(entry, args)
                    assert(typeof want === 'string' && want.startsWith('invalid '), `${args.join(' ')}: 規格上應被拒`)
                    let r = runIn(entry, args, env)
                    assert.strictEqual(r.status, 2, `${args.join(' ')}: ${r.out.join(' | ').slice(0, 200)} ${r.err.slice(0, 200)}`)
                    assert.deepEqual(r.out, [want], args.join(' '))
                    assert(!r.out.join('\n').includes(SECRET) && !r.err.includes(SECRET), `${args.join(' ')}: 不回顯`)
                    assert.deepEqual(fs.readdirSync(emptyRoot), [], `${args.join(' ')}: 不寫任何檔`)
                }
            })
        }

        it('eval: --mode / --period 之值不在列舉(含無值)⇒ 固定訊息(離開碼 2; 原: --mode ful 被當成 quick)', () => {
            for (let [args, want] of [[['--mode', 'ful'], 'invalid --mode: must be one of quick, full'], [['--mode'], 'invalid --mode: must be one of quick, full'], [['--period', 'train2'], 'invalid --period: must be one of backtest, train, postfit'], [['--period'], 'invalid --period: must be one of backtest, train, postfit']]) {
                let r = runIn('eval', ['--pick', 'p.mjs', ...args])
                assert.strictEqual(r.status, 2, args.join(' '))
                assert.deepEqual(r.out, [want])
            }
        })

        it('rsi: --mode 之值不在列舉(原: 用法訊息; 於 rsi.init 之前以 ARSI_ROOT 之空根證明未建狀態根)、backtest: --match-sides 之值不在 0 / 1', () => {
            let r = runIn('rsi', ['--mode', 'nosuchmode'])
            assert.strictEqual(r.status, 2)
            assert.deepEqual(r.out, [`invalid --mode: must be one of ${CLI_ENUMS.rsi.mode.join(', ')}`])
            assert.deepEqual(fs.readdirSync(emptyRoot), [])
            let b = runIn('backtest', ['--pick', 'p.mjs', '--name', 'n', '--match-sides', 'yes'], { ARSI_HARNESS: '1' })
            assert.strictEqual(b.status, 2)
            assert.deepEqual(b.out, ['invalid --match-sides: must be one of 0, 1'])
        })

        it('rsi: --mode fill / extfill 之 --null 須為正整數(排程第 547 項①; 於讀設定之前): 0、小數、負數、非數字 ⇒ 離開碼 2 與固定訊息; 正整數與其數字字串通過檢查(其後於讀設定時離開); 其他模式不檢(--null 只作用於補算)', () => {
            for (let mode of ['fill', 'extfill']) {
                for (let v of ['0', '2.5', '-3', 'abc', '1e2']) {
                    let r = runIn('rsi', ['--mode', mode, '--null', v])
                    assert.strictEqual(r.status, 2, `${mode} --null ${v}: ${r.out.join(' | ').slice(0, 200)}`)
                    assert.deepEqual(r.out, ['invalid --null: must be a positive integer'], `${mode} --null ${v}`)
                }
                for (let v of ['3', '03']) {
                    let r = runIn('rsi', ['--mode', mode, '--null', v])
                    assert(!r.out.some((l) => l.includes('invalid --null')), `${mode} --null ${v}: 通過檢查`)
                    //到達讀設定 ⇒ settingsOrExit 之固定訊息(排程第 611 項 ①; 原以離開碼不是 2 為證)
                    assert(r.out.some((l) => l.startsWith('ERROR 無法讀取專案設定')), `${mode} --null ${v}`)
                }
            }
            //其他模式: --null 不屬該模式(排程第 595 項之接續「模式 × 旗標」; 原: 靜默忽略)⇒ 以模式表之固定訊息拒收(值之檢查只在 fill / extfill)
            let other = runIn('rsi', ['--mode', 'status', '--null', '0'])
            assert.strictEqual(other.status, 2)
            assert.deepEqual(other.out, ['invalid --null: must be used with --mode extfill or fill'], '其他模式拒收(模式 × 旗標)')
            assert.deepEqual(fs.readdirSync(emptyRoot), [], '不寫任何檔')
        })

        it('rsi: --dream-only 只用於 --mode round; --file 只用於 --mode annotate、dirtype 與 round --dream-only(原: 靜默忽略 —— `--mode round --file <檔>` 忘了 --dream-only 者起一個完整之輪次〔會派工〕而忽略該檔)', () => {
            let DREAM = 'invalid --dream-only: must be used with --mode round'
            let FILE = 'invalid --file: must be used with --mode annotate, --mode dirtype or --mode round --dream-only'
            for (let [args, want] of [
                [['--mode', 'status', '--dream-only'], DREAM],
                [['--dream-only'], DREAM],
                [['--mode', 'fill', '--dream-only', '--file', 'x.txt'], DREAM],
                [['--mode', 'round', '--file', 'x.txt'], FILE],
                [['--mode', 'status', '--file', 'x.txt'], FILE],
                [['--mode', 'fill', '--file', 'x.txt'], FILE],
                [['--file', 'x.txt'], FILE],
            ]) {
                let r = runIn('rsi', args)
                assert.strictEqual(r.status, 2, `${args.join(' ')}: ${r.out.join(' | ').slice(0, 200)}`)
                assert.deepEqual(r.out, [want], args.join(' '))
            }
            //合格之組合通過此檢查(其後之處置依各模式自己之解析: 只做夢輪次之檔不可讀 ⇒ 其固定訊息; annotate / dirtype 於讀設定時離開)
            let dream = runIn('rsi', ['--mode', 'round', '--dream-only', '--file', 'no-such.txt'])
            assert.strictEqual(dream.status, 2)
            assert(dream.out[0].startsWith('invalid --file: must be the path of a readable, non-empty UTF-8 text file'), dream.out.join('|').slice(0, 200))
            for (let m of ['annotate', 'dirtype']) {
                let r = runIn('rsi', ['--mode', m, '--round', '1', '--file', 'x.json'])
                assert(!r.out.some((l) => l.startsWith('invalid --file')), `${m}: ${r.out.join('|').slice(0, 200)}`)
            }
            assert.deepEqual(fs.readdirSync(emptyRoot), [], '不寫任何檔')
        })

        it('eval: 進入檔自己處理之旗標(--null、--member、--subset、--phases、--period)之不合亦於讀設定之前(空之專案根仍離開碼 2 與其固定訊息; 原: 先讀設定而離開碼 1)', () => {
            let MEMBER = 'invalid --member: must be <salt>:<half>, where salt is an integer from 0 to 4294967295 (decimal or 0x hexadecimal) and half is 0 or 1'
            for (let [args, want] of [
                [['--null'], 'invalid --null: must be a non-negative integer'],
                [['--null', '-1'], 'invalid --null: must be a non-negative integer'],
                [['--null', 'abc'], 'invalid --null: must be a non-negative integer'],
                [['--phases', 'abc'], 'invalid --phases[0]: must be a non-negative number'],
                [['--member'], MEMBER],
                [['--member', '0:2'], MEMBER],
                [['--member', '0:0', '--member', '0:1'], MEMBER],
                [['--subset'], SUBSET_MSG],
                [['--subset', 'nosuchrule'], SUBSET_MSG],
                [['--subset', 'side:long', '--member', '0:0'], SUBSET_MEMBER_MSG],
            ]) {
                let r = runIn('eval', ['--pick', 'p.mjs', ...args])
                assert.strictEqual(r.status, 2, `${args.join(' ')}: ${r.out.join(' | ').slice(0, 200)} ${r.err.slice(0, 200)}`)
                assert.deepEqual(r.out, [want], args.join(' '))
            }
            assert.deepEqual(fs.readdirSync(emptyRoot), [], '不寫任何檔')
        })

        it('build: --limit 之值須為正整數(0、負數、小數、非數字、無值皆拒; 原: 非正數與非數字被當成未給而建成全庫之評估帳本); 正整數不拒', () => {
            for (let v of ['0', '-1', '2.5', 'abc', '1e3']) {
                let r = runIn('build', ['--limit', v])
                assert.strictEqual(r.status, 2, v)
                assert.deepEqual(r.out, ['invalid --limit: must be a positive integer'], v)
            }
            let bare = runIn('build', ['--limit'])
            assert.strictEqual(bare.status, 2)
            assert.deepEqual(bare.out, ['invalid --limit: must be written as --limit <N> (a value is required)'])
            let ok = runIn('build', ['--limit', '5'])
            assert(!ok.out.some((l) => l.startsWith('invalid ')), '合格者通過檢查(其後於讀設定時離開)')
            assert(ok.out.some((l) => l.startsWith('ERROR 無法讀取專案設定')), '到達讀設定 ⇒ settingsOrExit 之固定訊息(排程第 611 項 ①; 原以離開碼不是 2 為證)')
            //--limit 與 --train 不併用(原: --train 時 --limit 靜默被丟掉而建成完整之訓練期帳本)
            let both = runIn('build', ['--limit', '5', '--train'])
            assert.strictEqual(both.status, 2)
            assert.deepEqual(both.out, ['invalid --limit: must not be used with --train'])
            let trainOnly = runIn('build', ['--train'])
            assert(!trainOnly.out.some((l) => l.startsWith('invalid ')), '--train 單獨通過檢查')
            assert.deepEqual(fs.readdirSync(emptyRoot), [], '不建任何檔')
        })

        it('rsi: --claim 只用於 --mode frontier 且須為 8 個十六進位字(原: 不合者靜默視為未給 ——「--close <臂> --claim zz」把該臂之全部 proposed 提案結案); --base 取原字串(全數字之 id 前綴不被轉成數值)', () => {
            let FRONT = 'invalid --claim: must be an 8-digit hexadecimal claim key (as listed after 主張 or 鍵)'
            for (let v of ['zz', '1234567', '123456789', 'ABCDEF12', '0xabcdef1', 'abcdef1g']) {
                //--close 須隨 --why(排程第 614 項 ③; 缺者先被 cliMsgOf 之模式內相依拒收)⇒ 本案給 --why, 只驗 --claim 之值
                let r = runIn('rsi', ['--mode', 'frontier', '--close', 'A02', '--why', 'w', '--claim', v])
                assert.strictEqual(r.status, 2, v)
                assert.deepEqual(r.out, [FRONT], v)
            }
            let other = runIn('rsi', ['--mode', 'status', '--claim', 'abcdef12'])
            assert.strictEqual(other.status, 2)
            assert.deepEqual(other.out, ['invalid --claim: must be used with --mode frontier'])
            let bare = runIn('rsi', ['--mode', 'frontier', '--close', 'A02', '--claim'])
            assert.deepEqual(bare.out, ['invalid --claim: must be written as --claim <claim-key> (a value is required)'])
            //合格者通過此檢查(其後於讀設定時離開)
            for (let v of ['abcdef12', '12345678']) {
                let r = runIn('rsi', ['--mode', 'frontier', '--close', 'A02', '--why', 'w', '--claim', v])
                assert(!r.out.some((l) => l.startsWith('invalid --claim')), `${v}: 通過檢查`)
            }
            assert.deepEqual(fs.readdirSync(emptyRoot), [], '不寫任何檔')
            //--base: 取原字串(argStrOf; 全數字者 argOf 會轉成 Number 而 typeof 非字串被丟掉 ⇒ 改掛之起點靜默不限定)
            let rs = fs.readFileSync(path.join(CLI_DIR, 'rsi.mjs'), 'utf8')
            assert(rs.includes('argStrOf(\'base\''), 'rsi.mjs 以 argStrOf 讀 --base')
            assert(!/argOf\('base'/.test(rs), 'rsi.mjs 不以 argOf 讀 --base')
        })

        it('toolbox: 任何引數皆拒; launch: 日誌名之前之旗標與多餘之引數拒、`--` 之後原樣轉交(不在此拒)', () => {
            assert.deepEqual(runIn('toolbox', ['x']).out, ['invalid argument: must be the value of the preceding option (--<key> <value>; a flag without a value is written alone)'])
            assert.deepEqual(runIn('toolbox', ['--x']).out, ['invalid option: must be none (this command takes no options)'])
            let a = runIn('launch', ['--x', '--', 'g_rsi.mjs'])
            assert.strictEqual(a.status, 2)
            assert.deepEqual(a.out, ['invalid option: must be none (this command takes no options)'])
            let b = runIn('launch', ['round', 'extra', '--', 'g_rsi.mjs'])
            assert.strictEqual(b.status, 2)
            assert.deepEqual(b.out, ['invalid argument: must be the value of the preceding option (--<key> <value>; a flag without a value is written alone)'])
            assert.deepEqual(fs.readdirSync(emptyRoot), [], 'launch 未建日誌夾')
        })
    })

    describe('g_eval.mjs(有帳本之專案根): 原靜默之寫法不評估、不寫結果檔、不記評估紀錄; 對照之合格寫法照常評估', () => {
        let root = path.join(t.dir, 'proj')
        let W = path.join(root, 'rsi', 'work', 'w1')
        writeSynthLedger(path.join(root, 'ledger', 'eval'), { n: 40, nBars: 2400, seed: 5 })
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
        let fpOut = path.join(root, 'out.json')
        //run: 全部引數由呼叫端給(含 --pick、--out; 以測試檔自己控制重複與否)
        let run = (args) => {
            let e = { ...process.env, ARSI_ROOT: root }
            delete e.ARSI_HARNESS
            fs.rmSync(fpOut, { force: true })
            let r = spawnSync(NODE, [path.join(CLI_DIR, 'eval.mjs'), ...args], { cwd: root, env: e, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            let o = null
            try {
                o = JSON.parse(fs.readFileSync(fpOut, 'utf8'))
            }
            catch (err) {}
            return { status: r.status, out: `${r.stdout}`.split(/\r?\n/).filter(Boolean), o }
        }
        let P = path.join(W, 'pick.mjs')
        let base = ['--pick', P, '--out', fpOut]
        let logOf = () => {
            let fp = path.join(W, '.evals.log')
            return fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
        }

        it('原靜默者: 未列之旗標(--perod、--period:postfit)、--mode ful、--mode / --period 無值、重複之 --pick / --mode / --null、--phases 無值與 0 3、--ref / --ext-test / --ext-only 無值、--ref a b、--no-log 1、--seed / --tie-salt 無值 ⇒ 離開碼 2、固定訊息、不寫結果檔、不記評估紀錄', () => {
            assert.deepEqual(logOf(), [])
            let cases = [
                [['--perod', 'x'], 'invalid option: must be one of'],
                [['--period:postfit'], 'invalid option: must be one of'],
                [['--mode', 'ful'], 'invalid --mode: must be one of quick, full'],
                [['--mode'], 'invalid --mode: must be one of quick, full'],
                [['--period'], 'invalid --period: must be one of backtest, train, postfit'],
                [['--pick', P], 'invalid --pick: must be given at most once'],
                [['--mode', 'quick', '--mode', 'full'], 'invalid --mode: must be given at most once'],
                [['--null', '4', '--null', '5'], 'invalid --null: must be given at most once'],
                [['--phases'], 'invalid --phases: must be written as --phases <days,days,…> (a value is required)'],
                [['--phases', '0', '3'], 'invalid argument: must be the value of the preceding option'],
                [['--ref'], 'invalid --ref: must be written as --ref <module.mjs>[,<module.mjs>…] (a value is required)'],
                [['--ref', 'a.mjs', 'b.mjs'], 'invalid argument: must be the value of the preceding option'],
                [['--ext-test'], 'invalid --ext-test: must be written as --ext-test <file.mjs> (a value is required)'],
                [['--ext-only'], 'invalid --ext-only: must be written as --ext-only <name>[,<name>…] (a value is required)'],
                [['--no-log', '1'], 'invalid argument: must be the value of the preceding option'],
                [['--seed'], 'invalid --seed: must be written as --seed <N> (a value is required)'],
                [['--tie-salt'], 'invalid --tie-salt: must be written as --tie-salt <N> (a value is required)'],
                [['stray'], 'invalid argument: must be the value of the preceding option'],
                //空字串或只有空白之值視同無值(原: 被當成值; --ref "" 不算重疊率、--ext-test "" 改跑一般評估而記一列正本評估紀錄、--seed "" 無效之種子)
                [['--ref', ''], 'invalid --ref: must be written as --ref <module.mjs>[,<module.mjs>…] (a value is required)'],
                [['--ext-test', ' '], 'invalid --ext-test: must be written as --ext-test <file.mjs> (a value is required)'],
                [['--ext-only', ''], 'invalid --ext-only: must be written as --ext-only <name>[,<name>…] (a value is required)'],
                [['--seed', ''], 'invalid --seed: must be written as --seed <N> (a value is required)'],
            ]
            for (let [extra, msg] of cases) {
                let r = run([...base, ...extra])
                assert.strictEqual(r.status, 2, `${extra.join(' ')}: ${r.out.join('|').slice(0, 200)}`)
                assert.strictEqual(r.out.length, 1, `${extra.join(' ')}: 只一行`)
                assert(r.out[0].startsWith(msg), `${extra.join(' ')}: ${r.out[0]}`)
                assert.strictEqual(r.o, null, `${extra.join(' ')}: 不寫結果檔`)
            }
            //--out "": 原被當成值而不寫結果檔(評估照做、離開碼 0)
            let o0 = run(['--pick', P, '--out', ''])
            assert.strictEqual(o0.status, 2, o0.out.join('|').slice(0, 200))
            assert.deepEqual(o0.out, ['invalid --out: must be written as --out <result.json> (a value is required)'])
            assert.deepEqual(logOf(), [], '不記評估紀錄')
        })

        it('own 旗標之無值 / 重複沿用自己之固定訊息(--null 無值、--member 無值與重複、--subset 無值): 離開碼 2、不寫結果檔', () => {
            for (let [extra, msg] of [[['--null'], 'invalid --null: must be a non-negative integer'], [['--member'], 'invalid --member: must be <salt>:<half>'], [['--member', '0:0', '--member', '0:1'], 'invalid --member: must be <salt>:<half>'], [['--subset'], null]]) {
                let r = run([...base, ...extra])
                assert.strictEqual(r.status, 2, extra.join(' '))
                assert.strictEqual(r.o, null)
                if (msg !== null) {
                    assert(r.out[0].startsWith(msg), `${extra.join(' ')}: ${r.out[0]}`)
                }
            }
            assert.deepEqual(logOf(), [])
        })

        it('對照(合格之寫法照常評估; 被拒者若被靜默忽略則離開碼會是 0): --mode quick --period backtest、--mode full --null 2 --phases 0,3 --no-log、--period train', () => {
            let a = run([...base, '--mode', 'quick', '--period', 'backtest'])
            assert.strictEqual(a.status, 0, a.out.join('|').slice(0, 300))
            let b = run([...base, '--mode', 'full', '--null', '2', '--phases', '0,3', '--no-log'])
            assert.strictEqual(b.status, 0, b.out.join('|').slice(0, 300))
            assert.deepEqual(b.o.metrics.phases, [0, 3])
            assert.strictEqual(b.o.metrics.null.draws, 2)
            let c = run([...base, '--mode', 'quick', '--period', 'train'])
            assert.strictEqual(c.status, 0)
            assert.strictEqual(c.o.period.name, 'train')
            assert.strictEqual(logOf().length, 3, '三次評估各記一列')
        })
    })

    describe('本套件自己之文字與程式內出現之呼叫: 其旗標全在 CLI_FLAGS 內(盤點守門; 新增之文字若寫了不在表內之旗標即失敗)', () => {
        let walk = (dir, exts, out = []) => {
            for (let f of fs.readdirSync(dir, { withFileTypes: true })) {
                if (['node_modules', 'dist', 'docs', 'tmp', '_tmp', 'testPending', 'sgud'].includes(f.name)) {
                    continue
                }
                let fp = path.join(dir, f.name)
                if (f.isDirectory()) {
                    walk(fp, exts, out)
                }
                else if (exts.some((e) => f.name.endsWith(e))) {
                    out.push(fp)
                }
            }
            return out
        }
        let files = [
            ...walk(path.join(FD_ROOT, 'src'), ['.mjs']),
            ...walk(path.join(FD_ROOT, 'contract'), ['.md']),
            ...walk(path.join(FD_ROOT, 'examples'), ['.mjs', '.md', '.json']),
            ...walk(path.join(FD_ROOT, 'arms'), ['.json']),
            path.join(FD_ROOT, 'README.md'),
            path.join(FD_ROOT, 'settings.json'),
        ].filter((f) => fs.existsSync(f)) //變異檢查之複本(test/tools/mutateBar.mjs)不含 README.md 等
        //各行內 `g_<名>.mjs` 之後至下一個 `g_<名>.mjs` 或行末之片段屬該進入檔; 片段內之 --旗標 須在其表內(以反引號、引號、右括號為界; 後接等號者〔說明舊行為被拒之文字〕不計)
        let scan = () => {
            let bad = []
            let nSeg = 0
            let nFlag = 0
            for (let fp of files) {
                let lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/)
                lines.forEach((line, li) => {
                    let ms = [...line.matchAll(/g_(eval|backtest|build|rsi|toolbox|launch)\.mjs/g)]
                    ms.forEach((m, k) => {
                        let seg = line.slice(m.index + m[0].length, k + 1 < ms.length ? ms[k + 1].index : line.length)
                        seg = seg.split(/[`'"”)）]/)[0]
                        nSeg++
                        for (let f of seg.matchAll(/(?:^|\s|\[)--([A-Za-z][\w-]*)(?=[\s\]|,.;:]|$)/g)) {
                            //「-- 之後」(g_launch 之子行程之引數)不屬 launch
                            nFlag++
                            let entry = m[1]
                            if (entry === 'launch') {
                                continue
                            }
                            if (!(f[1] in CLI_FLAGS[entry])) {
                                bad.push(`${path.relative(FD_ROOT, fp)}:${li + 1} g_${entry}.mjs --${f[1]}`)
                            }
                        }
                    })
                })
            }
            return { bad, nSeg, nFlag }
        }
        it('文字與註解內 `g_<名>.mjs` 之後所寫之旗標皆在該進入檔之 CLI_FLAGS 內', () => {
            let { bad, nSeg, nFlag } = scan()
            //鑑別前提: 掃描確實找到呼叫之片段與旗標(掃描範圍壞掉時之空結果不算數)
            assert(nSeg >= 60 && nFlag >= 100, `掃描之範圍: ${nSeg} 個片段、${nFlag} 個旗標`)
            assert.deepEqual(bad, [])
        })

        it('以陣列寫出之呼叫(src 內 `g_eval.mjs` / `g_backtest.mjs` 之同一行之 \'--旗標\')之旗標皆在表內, 且各旗標不重複', () => {
            let bad = []
            let nLine = 0
            for (let fp of files.filter((f) => f.endsWith('.mjs'))) {
                fs.readFileSync(fp, 'utf8').split(/\r?\n/).forEach((line, li) => {
                    let m = /g_(eval|backtest)\.mjs'/.exec(line)
                    if (!m || !line.includes('\'--')) {
                        return
                    }
                    nLine++
                    let toks = [...line.matchAll(/'--([a-z][\w-]*)'/g)].map((x) => x[1])
                    for (let f of toks) {
                        if (!(f in CLI_FLAGS[m[1]])) {
                            bad.push(`${path.relative(FD_ROOT, fp)}:${li + 1} --${f}`)
                        }
                    }
                    assert.strictEqual(new Set(toks).size, toks.length, `${path.relative(FD_ROOT, fp)}:${li + 1}: 旗標重複`)
                })
            }
            assert(nLine >= 6, `掃描之範圍: ${nLine} 行`)
            assert.deepEqual(bad, [])
        })

        it('鑑別力: 掃描能抓到植入之違規(不在表內之旗標、拼錯之旗標)', () => {
            let seg = 'node g_eval.mjs --pick a.mjs --perod x'
            let m = /g_(eval)\.mjs/.exec(seg)
            let rest = seg.slice(m.index + m[0].length)
            let flags = [...rest.matchAll(/(?:^|\s|\[)--([A-Za-z][\w-]*)(?=[\s\]|,.;:]|$)/g)].map((x) => x[1])
            assert.deepEqual(flags.filter((f) => !(f in CLI_FLAGS.eval)), ['perod'])
        })
    })
})
